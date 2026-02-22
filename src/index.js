import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pty from 'node-pty';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import session from 'express-session';
import BetterSqlite3 from 'better-sqlite3';
import rateLimit from 'express-rate-limit';
import multer from 'multer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_TEST = process.env.NODE_ENV === 'test';
const DATA_DIR = IS_TEST ? join(__dirname, '../test_data') : '/data';
const PUBLIC_DIR = join(__dirname, 'public');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3939;
const PIN = process.env.PIN || "123456";
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

process.env.STARSHIP_CONFIG = join(process.env.HOME, '.config', 'starship.toml');

// --- 0. PRE-FLIGHT CHECKS & DB INIT ---
const sessionsDir = join(DATA_DIR, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

const db = new BetterSqlite3(join(sessionsDir, 'sessions.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT,
    expiresAt INTEGER
  )
`);

// --- 1. SESSION STORE ---
class NativeSQLiteStore extends session.Store {
    constructor() {
        super();
        this.getStmt = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expiresAt > ?');
        this.setStmt = db.prepare('INSERT INTO sessions (sid, data, expiresAt) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expiresAt = excluded.expiresAt');
        this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
        this.touchStmt = db.prepare('UPDATE sessions SET expiresAt = ? WHERE sid = ?');
        this.clearStmt = db.prepare('DELETE FROM sessions WHERE expiresAt <= ?');

        setInterval(() => {
            try { this.clearStmt.run(Date.now()); } catch(e) { console.error('Session cleanup error:', e); }
        }, 15 * 60 * 1000).unref();
    }

    get(sid, cb) {
        try {
            const row = this.getStmt.get(sid, Date.now());
            cb(null, row ? JSON.parse(row.data) : null);
        } catch (err) { cb(err); }
    }

    set(sid, sessionData, cb) {
        try {
            const expires = sessionData.cookie?.expires ? new Date(sessionData.cookie.expires).getTime() : Date.now() + 86400000;
            this.setStmt.run(sid, JSON.stringify(sessionData), expires);
            cb(null);
        } catch (err) { cb(err); }
    }

    destroy(sid, cb) {
        try { this.destroyStmt.run(sid); cb(null); }
        catch (err) { cb(err); }
    }

    touch(sid, sessionData, cb) {
        try {
            const expires = sessionData.cookie?.expires ? new Date(sessionData.cookie.expires).getTime() : Date.now() + 86400000;
            this.touchStmt.run(expires, sid);
            if (cb) cb(null);
        } catch (err) { if(cb) cb(err); }
    }
}

// --- 2. SECURITY MIDDLEWARE SETUP ---

// Required for secure cookies behind Cloudflare/Nginx
app.set('trust proxy', 1);

app.use(session({
    store: new NativeSQLiteStore(),
    cookie: {
        secure: IS_PRODUCTION,
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000
    },
    secret: process.env.SESSION_SECRET || 'wired-alter-term-secret-key',
    resave: false,
    saveUninitialized: false
}));

app.use(express.json());

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

// Apply general limiter globally to all routes
app.use(generalLimiter);

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


// --- 3. AUTHENTICATION ROUTES ---

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

// --- 4. GENERAL MIDDLEWARE & ROUTES ---

// Upload Handler
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

// Logging & Favicon
app.use((req, res, next) => {
    if (req.url === '/favicon.ico') return next();
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
});
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use('/vendor', express.static(join(PUBLIC_DIR, 'vendor'), { maxAge: '1y', immutable: true }));

app.use(express.static(PUBLIC_DIR));

app.get('/fonts/font.ttf', (req, res) => {
    const fontPath = join(PUBLIC_DIR, 'fonts/font.ttf');
    if (!fs.existsSync(fontPath)) return res.status(404).send('Font not found');

    res.setHeader('Content-Type', 'font/ttf');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(fontPath);
});

// --- 5. PERSISTENCE SETUP ---
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
    const publicFonts = join(PUBLIC_DIR, 'fonts');
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
    seedAndLink('.tmux.conf', false, join(seedDir, 'config/tmux.conf'));
    seedAndLink('storage', true);

    if (!fs.existsSync('/data/sessions')) {
        fs.mkdirSync('/data/sessions', { recursive: true });
        console.log('   🌱 Created persistent session directory');
    }
};

setupPersistence();

// --- 6. TERMINAL LOGIC ---
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
    ptyProcess.on('exit', (code, signal) => { console.log(`PTY exited with code ${code}. Closing socket.`); socket.disconnect();});
    socket.on('terminal:input', (data) => { try { ptyProcess.write(data); } catch (err) { console.error("Failed to write to terminal:", err.message); }});
    socket.on('terminal:resize', ({ cols, rows }) => {
        const safeCols = Math.max(1, Math.min(1000, cols || 80));
        const safeRows = Math.max(1, Math.min(1000, rows || 30));
        try { ptyProcess.resize(safeCols, safeRows); }
            catch (err) { console.warn('Resize failed:', err.message); }});
    socket.on('disconnect', () => ptyProcess.kill());
    socket.on('latency:ping', (timestamp) => { socket.emit('latency:pong', timestamp); });
});

// --- EXPORT FOR TESTING ---
export { app };

// --- START SERVER ---
if (!IS_TEST) {
    httpServer.listen(PORT, () => {
        console.log(`🚀 WiredAlter-Term running on http://localhost:${PORT}`);
    });
}
