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
const PIN = process.env.PIN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

process.env.STARSHIP_CONFIG = join(process.env.HOME, '.config', 'starship.toml');

// --- PRE-FLIGHT CHECKS ---
if (!fs.existsSync('/data/sessions')) {
    fs.mkdirSync('/data/sessions', { recursive: true });
}

// --- MIDDLEWARE ---
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

// --- OIDC SETUP ---
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
            login: false, // Manual trigger
        },
        attemptSilentLogin: false,
        httpTimeout: 5000 // 5 second timeout for back-channel
    }));
}

// --- SESSION SETUP ---
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
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(express.json());

// --- DEBUG ERROR HANDLER ---
app.use((err, req, res, next) => {
    if (err) {
        // Only catch OIDC errors
        if (err.message && (err.message.includes('access_denied') || err.message.includes('id_token') || err.code)) {
            console.error("❌ OIDC AUTH FAILURE:", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
            return res.status(401).send(`
                <body style="background:#111; color:#f55; font-family:monospace; padding:20px;">
                    <h2>⚠️ AUTHENTICATION FAILED</h2>
                    <p><strong>Error:</strong> ${err.message}</p>
                    <p><strong>Code:</strong> ${err.code || 'N/A'}</p>
                    <hr style="border-color:#333">
                    <p>Check the container logs for full details.</p>
                    <a href="/login" style="color:#fff">Return to Login</a>
                </body>
            `);
        }
    }
    next(err);
});

// --- ASSETS & ROUTES ---
app.use((req, res, next) => {
    if (req.url === '/favicon.ico') return next();
    // console.log(`[HTTP] ${req.method} ${req.url}`); // Quiet logs for now
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

// --- AUTH LOGIC ---
const requireAuth = (req, res, next) => {
    const publicPaths = ['/login', '/auth/login', '/verify-pin', '/style.css', '/login.js', '/fonts/font.ttf', '/favicon.ico', '/auth/config'];
    if (publicPaths.includes(req.path)) return next();

    if (oidcConfigured && req.oidc.isAuthenticated()) return next();
    if (req.session && req.session.authenticated) return next();

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
    req.session.destroy(() => {
        res.clearCookie('appSession');
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

// --- PERSISTENCE ---
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
