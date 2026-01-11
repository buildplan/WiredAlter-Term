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
import { auth } from 'express-openid-connect';

const FileStore = sessionFileStore(session);
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3939;
const PIN = process.env.PIN; // If undefined, PIN login is disabled
const PUBLIC_URL = process.env.PUBLIC_URL;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Location for Starship config
process.env.STARSHIP_CONFIG = join(process.env.HOME, '.config', 'starship.toml');

// --- 0. PRE-FLIGHT CHECKS ---
if (!fs.existsSync('/data/sessions')) {
    fs.mkdirSync('/data/sessions', { recursive: true });
}

// --- 1. MIDDLEWARE & SECURITY ---
app.set('trust proxy', 1);

// Login Rate Limiter (Prevent Brute Force on PIN)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    message: { error: "⛔ SYSTEM LOCKDOWN: Too many failed attempts. Retry in 15m." },
    standardHeaders: true,
    legacyHeaders: false,
});

// General Limiter for Assets
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests. Please slow down."
});

app.use(generalLimiter);

// OIDC Configuration (Conditional)
const oidcConfigured = process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID;

if (oidcConfigured) {
    if (!PUBLIC_URL) {
        console.error("❌ OIDC Error: PUBLIC_URL is missing! Auth redirects will fail.");
        process.exit(1);
    }

    app.use(auth({
        authRequired: false,
        auth0Logout: true,
        secret: process.env.SESSION_SECRET,
        baseURL: PUBLIC_URL,
        clientID: process.env.OIDC_CLIENT_ID,
        issuerBaseURL: process.env.OIDC_ISSUER,
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        routes: {
            login: false, // trigger login manually via /auth/login
        }
    }));
}

// Session Setup
app.use(session({
    store: new FileStore({
        path: '/data/sessions',
        ttl: 86400,
        retries: 0
    }),
    secret: process.env.SESSION_SECRET || 'wired-alter-term-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: IS_PRODUCTION,
        httpOnly: true,
        sameSite: 'lax', // Relaxed for OIDC redirects
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(express.json());

// --- 2. ASSETS & ROUTES ---

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

// Serve Static Files
app.use(express.static(join(__dirname, 'public')));

// --- 3. AUTHENTICATION LOGIC ---

const requireAuth = (req, res, next) => {
    const publicPaths = ['/login', '/auth/login', '/verify-pin', '/style.css', '/login.js', '/fonts/font.ttf', '/favicon.ico', '/auth/config'];
    if (publicPaths.includes(req.path)) return next();

    // 1. Check OIDC
    if (oidcConfigured && req.oidc.isAuthenticated()) return next();

    // 2. Check Local PIN Session
    if (req.session && req.session.authenticated) return next();

    // 3. Not logged in -> Redirect
    res.redirect('/login');
};

app.use(requireAuth);

// Login Page
app.get('/login', (req, res) => {
    // If already logged in, go home
    if ((oidcConfigured && req.oidc.isAuthenticated()) || req.session.authenticated) {
        return res.redirect('/');
    }
    // Pure SSO Mode: Redirect immediately if no PIN is set
    if (oidcConfigured && !PIN) {
        return res.oidc.login({ returnTo: '/' });
    }
    res.sendFile(join(__dirname, 'public/login.html'));
});

// Auth Config Endpoint (Tells frontend what to show)
app.get('/auth/config', (req, res) => {
    res.json({
        hasPin: !!PIN,
        hasOidc: !!oidcConfigured
    });
});

// OIDC Trigger
app.get('/auth/login', (req, res) => {
    if (oidcConfigured) res.oidc.login({ returnTo: '/' });
    else res.status(500).send("OIDC not configured");
});

// PIN Verification
app.post('/verify-pin', loginLimiter, (req, res) => {
    if (!PIN) return res.status(403).json({ error: "PIN login is disabled." });

    if (req.body.pin === PIN) {
        req.session.authenticated = true;
        req.session.save(() => res.json({ success: true }));
    } else {
        res.status(401).json({ error: "ACCESS DENIED: Invalid Passcode" });
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        res.clearCookie('appSession');
        res.clearCookie('connect.sid');        
        res.redirect('/login');
    });
});

// --- 4. PERSISTENCE SETUP ---
const setupPersistence = () => {
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
    socket.on('terminal:resize', (size) => {
        if (size && size.cols && size.rows) {
            try { ptyProcess.resize(size.cols, size.rows); } catch (err) {}
        }
    });
    socket.on('disconnect', () => ptyProcess.kill());
});

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 WiredTerm running on port ${PORT}`);
    console.log(`🔐 Auth Mode: ${oidcConfigured ? (PIN ? 'Hybrid' : 'SSO Only') : 'PIN Only'}`);
});
