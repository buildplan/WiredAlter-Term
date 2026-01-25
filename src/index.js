import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pty from 'node-pty';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import session from 'express-session';
import sessionFileStore from 'session-file-store';
import rateLimit from 'express-rate-limit';
import multer from 'multer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_TEST = process.env.NODE_ENV === 'test';
const DATA_DIR = IS_TEST ? join(__dirname, '../test_data') : '/data';
const FileStore = sessionFileStore(session);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3939;
const PIN = process.env.PIN || "123456";
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

process.env.STARSHIP_CONFIG = join(process.env.HOME, '.config', 'starship.toml');

// --- 0. PRE-FLIGHT CHECKS ---
const sessionsDir = join(DATA_DIR, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// --- 1. SECURITY MIDDLEWARE SETUP ---

// Required for secure cookies behind Cloudflare/Nginx
app.set('trust proxy', 1);

// Strict Limiter for Login (Brute Force Protection)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts
    message: { error: "⛔ SYSTEM LOCKDOWN: Too many failed attempts. Retry in 15m." },
    standardHeaders: true,
    legacyHeaders: false,
});

// General Limiter for Assets (DoS Protection)
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300, // 300 requests per 15m
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests. Please slow down."
});

// --- UPLOAD CONFIGURATION ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, DATA_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage });

// Apply general limiter globally to all routes
app.use(generalLimiter);

app.use(session({
    store: new FileStore({
        path: sessionsDir,
        ttl: 86400,
        retries: 0
    }),
    secret: process.env.SESSION_SECRET || 'wired-alter-term-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: IS_PRODUCTION,
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(express.json());

// --- 2. AUTHENTICATION ROUTES ---

app.get('/login', (req, res) => {
    if (req.session.authenticated) return res.redirect('/');
    res.sendFile(join(__dirname, 'public/login.html'));
});

// Use the stricter loginLimiter specifically for verification
app.post('/verify-pin', loginLimiter, (req, res) => {
    const { pin } = req.body;
    if (pin === PIN) {
        req.session.authenticated = true;
        req.session.save(() => {
            res.json({ success: true });
        });
    } else {
        res.status(401).json({ error: "ACCESS DENIED: Invalid Passcode" });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Auth Guard Middleware
const requireAuth = (req, res, next) => {
    const publicAllowlist = ['/login', '/style.css', '/login.js', '/fonts/font.ttf', '/favicon.ico'];
    if (publicAllowlist.includes(req.path)) return next();

    if (req.session && req.session.authenticated) {
        return next();
    }
    res.redirect('/login');
};

app.use(requireAuth);

// --- 3. GENERAL MIDDLEWARE ---
app.post('/upload', upload.array('files'), (req, res) => {
    if (!req.files || !Array.isArray(req.files)) {
        return res.status(400).json({ error: 'Invalid upload data received.' });
    }
    if (req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
    }
    const fileList = req.files
        .map(f => {
            return (f && typeof f.originalname === 'string') 
                ? f.originalname 
                : 'unknown_file'; 
        })
        .join(', ');
    io.emit('terminal:output', `\r\n\x1b[32m✔ Uploaded to /data: ${fileList}\x1b[0m\r\n`);
    res.json({ success: true, count: req.files.length });
});

app.use((req, res, next) => {
    if (req.url === '/favicon.ico') return next();
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// Serve Font
app.get('/fonts/font.ttf', (req, res) => {
    const fontPath = join(__dirname, 'public/fonts/font.ttf');
    if (!fs.existsSync(fontPath)) return res.status(404).send('Font not found');
    res.setHeader('Content-Type', 'font/ttf');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(fontPath);
});

app.use(express.static(join(__dirname, 'public')));

// --- 4. PERSISTENCE SETUP ---
const setupPersistence = () => {
    if (IS_TEST) return;
    const userHome = process.env.HOME;
    const dataDir = '/data';
    const seedDir = '/usr/local/share/smart-term';

    console.log('🔌 SmartTerm: Initializing Persistence & Defaults...');

    const seedAndLink = (relPath, isFolder = false, seedSource = null) => {
        const containerPath = join(userHome, relPath);
        const persistentPath = join(dataDir, relPath);

        fs.mkdirSync(dirname(persistentPath), { recursive: true });
        fs.mkdirSync(dirname(containerPath), { recursive: true });

        if (!fs.existsSync(persistentPath)) {
            if (seedSource && fs.existsSync(seedSource)) {
                console.log(`   🌱 Seeding default: ${relPath}`);
                fs.cpSync(seedSource, persistentPath, { recursive: true });
            } else if (fs.existsSync(containerPath)) {
                console.log(`   🌱 Seeding from container: ${relPath}`);
                fs.cpSync(containerPath, persistentPath, { recursive: true });
            } else {
                if (!isFolder) fs.writeFileSync(persistentPath, '');
                else fs.mkdirSync(persistentPath, { recursive: true });
            }
        } else {
            console.log(`   💾 Found persistent file: ${relPath}`);
        }

        try {
            fs.rmSync(containerPath, { recursive: true, force: true });
            fs.symlinkSync(persistentPath, containerPath);
            console.log(`   🔗 Linked ${relPath} -> /data/${relPath}`);
        } catch (e) {
            console.error(`   ❌ Link failed for ${relPath}:`, e.message);
        }
    };

    // Font Persistence
    const publicFonts = join(__dirname, 'public/fonts');
    const persistentFonts = join(dataDir, 'fonts');
    const seedFonts = join(seedDir, 'fonts');

    if (!fs.existsSync(persistentFonts)) {
        console.log('   🌱 Seeding Default Fonts...');
        fs.cpSync(seedFonts, persistentFonts, { recursive: true });
    }
    if (fs.existsSync(publicFonts)) fs.rmSync(publicFonts, { recursive: true, force: true });
    fs.symlinkSync(persistentFonts, publicFonts);
    console.log('   🔗 Linked public/fonts -> /data/fonts');

    // Config Persistence
    seedAndLink('.ssh', true);
    seedAndLink('.bashrc', false);
    seedAndLink('.bash_history', false);
    seedAndLink('.config/starship.toml', false, join(seedDir, 'config/starship.toml'));
    seedAndLink('storage', true);

    if (!fs.existsSync('/data/sessions')) {
        fs.mkdirSync('/data/sessions', { recursive: true });
        console.log('   🌱 Created persistent session directory');
    }
};

setupPersistence();

// --- 5. TERMINAL LOGIC ---
io.on('connection', (socket) => {
    const shell = process.env.SHELL || 'bash';
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
        cwd: process.env.HOME,
        env: { ...process.env, TERM: 'xterm-256color' }
    });
    ptyProcess.onData((data) => socket.emit('terminal:output', data));
    socket.on('terminal:input', (data) => ptyProcess.write(data));
    socket.on('terminal:resize', ({ cols, rows }) => {
        try { ptyProcess.resize(cols, rows); } catch (err) {}
    });
    socket.on('disconnect', () => ptyProcess.kill());
    socket.on('latency:ping', (timestamp) => {
        socket.emit('latency:pong', timestamp);
    });
});

// --- EXPORT FOR TESTING ---
export { app };

// --- START SERVER ---
if (process.env.NODE_ENV !== 'test') {
    httpServer.listen(PORT, () => {
        console.log(`🚀 WiredAlter-Term running on http://localhost:${PORT}`);
    });
}
httpServer.listen(PORT, () => {
    console.log(`🚀 WiredAlter-Term running on http://localhost:${PORT}`);
});
