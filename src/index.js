import helmet from 'helmet';
import express from 'express';
import crypto from 'crypto';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pty from 'node-pty';
import { fileURLToPath } from 'url';
import { dirname, join, relative, isAbsolute, basename } from 'path';
import fs from 'fs';
import session from 'express-session';
import BetterSqlite3 from 'better-sqlite3';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import compression from 'compression';
import os from 'os';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { ServerE2EESession, computeTranscriptChallenge, E2EE_CONSTANTS } from './e2ee.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_TEST = process.env.NODE_ENV === 'test';
const DATA_DIR = IS_TEST ? join(__dirname, '../test_data') : '/data';
const PUBLIC_DIR = join(__dirname, 'public');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 50 * 1024 * 1024
});

const PORT = process.env.PORT || 3939;
const PIN = process.env.PIN || "123456";
const DISABLE_PIN = process.env.DISABLE_PIN === 'true';
if (!process.env.PIN && !DISABLE_PIN) {
    console.warn("⚠️  WARNING: Using default PIN '123456'. Please set a secure PIN in your environment variables.");
}
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    console.warn("⚠️  WARNING: No SESSION_SECRET provided. Generating a random session secret. Existing sessions will be invalidated on restart.");
}

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
  );
  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    publicKey TEXT,
    counter INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// --- E2EE CONFIGURATION & HELPERS ---
const E2EE_PBKDF2_ITERATIONS = parseInt(process.env.E2EE_PBKDF2_ITERATIONS, 10) || E2EE_CONSTANTS.PBKDF2_DEFAULT_ITERATIONS;

export function isForceE2EE() {
    if (process.env.FORCE_E2EE === 'true') return true;
    if (process.env.FORCE_E2EE === 'false') return false;
    const dbForce = db.prepare("SELECT value FROM settings WHERE key = 'force_e2ee'").get();
    return dbForce ? dbForce.value === 'true' : false;
}

export function getEffectiveE2EEPassphrase() {
    if (!process.env.E2EE_PASSPHRASE) return null;
    const dbDisable = db.prepare("SELECT value FROM settings WHERE key = 'disable_e2ee_passphrase'").get();
    if (dbDisable && dbDisable.value === 'true') return null;
    return process.env.E2EE_PASSPHRASE;
}

if (!IS_TEST) {
    const passkeyCount = db.prepare('SELECT COUNT(*) as c FROM passkeys').get()?.c || 0;
    const effectivePassphrase = getEffectiveE2EEPassphrase();
    if (process.env.FORCE_E2EE === 'true') {
        if (!process.env.E2EE_PASSPHRASE && passkeyCount === 0) {
            console.error("❌ FATAL: FORCE_E2EE=true is set, but neither E2EE_PASSPHRASE is configured nor are any passkeys registered in the database.");
            process.exit(1);
        }
    } else if (isForceE2EE() && !effectivePassphrase && passkeyCount === 0) {
        console.warn("⚠️ Resetting database force_e2ee=false because no passkeys or active passphrases exist.");
        db.prepare("INSERT INTO settings (key, value) VALUES ('force_e2ee', 'false') ON CONFLICT(key) DO UPDATE SET value = 'false'").run();
    }
}

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
            try { this.clearStmt.run(Date.now()); } catch (e) { console.error('Session cleanup error:', e); }
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
        } catch (err) { if (cb) cb(err); }
    }
}

// --- 2. SECURITY MIDDLEWARE SETUP ---

// Required for secure cookies behind Cloudflare/Nginx
app.set('trust proxy', 1);

// Add Helmet Security Headers
app.use(helmet({
    xFrameOptions: { action: "deny" },
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: ["'self'", "ws:", "wss:"],
            scriptSrc: ["'self'", "'unsafe-eval'", "'unsafe-inline'"],
            workerSrc: ["'self'", "blob:"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            fontSrc: ["'self'"],
            imgSrc: ["'self'", "data:"]
        },
    }
}));

const sessionMiddleware = session({
    store: new NativeSQLiteStore(),
    cookie: {
        secure: IS_PRODUCTION,
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 4 * 60 * 60 * 1000 // 4 hours
    },
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use(compression());
app.use(express.json());

// Strict Limiter for Login (Brute Force Protection)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts
    message: { error: "⛔ SYSTEM LOCKDOWN: Too many failed attempts. Retry in 15m." },
    standardHeaders: true,
    legacyHeaders: false,
});

// Healthcheck endpoint
app.get('/health', (req, res) => res.status(200).send('OK'));

// General Limiter for Assets (DoS Protection)
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300, // 300 requests per 15m
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests. Please slow down.",
    skip: (req) => {
        const p = req.path;
        return p === '/health' || p.startsWith('/vendor') || p.startsWith('/fonts') || p.endsWith('.css') || p.endsWith('.js') || p === '/favicon.ico';
    }
});

// Apply general limiter globally to all routes
app.use(generalLimiter);

// --- UPLOAD CONFIGURATION ---
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/^.*[\\\/]/, '');
        cb(null, safeName || 'upload.bin');
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});


// --- 3. AUTHENTICATION ROUTES ---

app.get('/login', (req, res) => {
    if (req.session.authenticated) return res.redirect('/');
    res.sendFile(join(__dirname, 'public/login.html'));
});

// Use the stricter loginLimiter specifically for verification
app.post('/verify-pin', loginLimiter, (req, res) => {
    const dbDisablePin = db.prepare("SELECT value FROM settings WHERE key = 'disable_pin'").get();
    const isPinDisabled = DISABLE_PIN || (dbDisablePin ? dbDisablePin.value === 'true' : false);

    if (isPinDisabled) {
        return res.status(403).json({ error: "PIN LOGIN DISABLED" });
    }
    const { pin } = req.body;
    if (!pin || typeof pin !== 'string' || pin.length !== PIN.length) {
        return res.status(401).json({ error: "ACCESS DENIED: Invalid Passcode" });
    }
    const isMatch = crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(PIN));
    if (isMatch) {
        req.session.authenticated = true;
        req.session.save(() => {
            res.json({ success: true });
        });
    } else {
        res.status(401).json({ error: "ACCESS DENIED: Invalid Passcode" });
    }
});

app.get('/auth-methods', (req, res) => {
    const dbDisablePin = db.prepare("SELECT value FROM settings WHERE key = 'disable_pin'").get();
    const isPinDisabled = DISABLE_PIN || (dbDisablePin ? dbDisablePin.value === 'true' : false);
    res.json({ disablePin: isPinDisabled });
});

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) { console.error("⚠️ Logout Session Error:", err); }
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

// --- WEBAUTHN (PASSKEYS) ---
const rpName = 'WiredTerm';

const getRpID = (req) => {
    if (process.env.RP_ID) return process.env.RP_ID;
    if (req.hostname) return req.hostname;
    const hostHeader = (typeof req.get === 'function' ? (req.get('x-forwarded-host') || req.get('host')) : (req.headers?.['x-forwarded-host'] || req.headers?.host)) || '';
    try {
        return new URL('http://' + hostHeader).hostname || 'localhost';
    } catch {
        return hostHeader.split(':')[0] || 'localhost';
    }
};

const getOrigin = (req) => {
    if (process.env.ORIGIN) return process.env.ORIGIN;
    if (req.headers?.origin) return req.headers.origin;
    const host = (typeof req.get === 'function' ? (req.get('x-forwarded-host') || req.get('host')) : (req.headers?.['x-forwarded-host'] || req.headers?.host)) || 'localhost:3939';
    const proto = req.protocol || (req.connection?.encrypted || req.socket?.encrypted || req.headers?.['x-forwarded-proto'] === 'https' ? 'https' : 'http');
    return `${proto}://${host}`;
};

const toBuffer = (val) => {
    if (!val) return Buffer.alloc(0);
    if (Buffer.isBuffer(val)) return val;
    if (val instanceof ArrayBuffer) return Buffer.from(val);
    if (ArrayBuffer.isView(val)) return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
    return Buffer.from(val);
};

app.get('/webauthn/register-options', async (req, res) => {
    if (!req.session.authenticated) return res.status(401).json({ error: "Must be logged in to register passkey" });
    try {
        const options = await generateRegistrationOptions({
            rpName,
            rpID: getRpID(req),
            userID: new Uint8Array(Buffer.from("admin_user")),
            userName: "admin",
            attestationType: 'none',
            authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        });
        req.session.currentChallenge = options.challenge;
        req.session.save(() => {
            res.json(options);
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/webauthn/register-verify', async (req, res) => {
    if (!req.session.authenticated) return res.status(401).json({ error: "Unauthorized" });
    try {
        const verification = await verifyRegistrationResponse({
            response: req.body,
            expectedChallenge: req.session.currentChallenge,
            expectedOrigin: getOrigin(req),
            expectedRPID: getRpID(req),
        });
        if (verification.verified && verification.registrationInfo) {
            const { credential } = verification.registrationInfo;
            // credential.publicKey is Uint8Array in v10+, store as base64
            const pk = Buffer.from(credential.publicKey).toString('base64');
            db.prepare('INSERT INTO passkeys (id, publicKey, counter) VALUES (?, ?, ?)').run(
                credential.id, pk, credential.counter
            );
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false });
        }
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/webauthn/auth-options', async (req, res) => {
    const passkeys = db.prepare('SELECT id FROM passkeys').all();
    if (passkeys.length === 0) return res.status(400).json({ error: "No passkeys registered" });
    try {
        const options = await generateAuthenticationOptions({
            rpID: getRpID(req),
            allowCredentials: passkeys.map(pk => ({ id: pk.id, type: 'public-key' })),
            userVerification: 'preferred',
        });
        req.session.currentChallenge = options.challenge;
        req.session.save(() => {
            res.json(options);
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/webauthn/auth-verify', loginLimiter, async (req, res) => {
    const passkey = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(req.body.id);
    if (!passkey) return res.status(400).json({ error: "Passkey not found" });

    try {
        const verification = await verifyAuthenticationResponse({
            response: req.body,
            expectedChallenge: req.session.currentChallenge,
            expectedOrigin: getOrigin(req),
            expectedRPID: getRpID(req),
            credential: {
                id: passkey.id,
                publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64')),
                counter: passkey.counter,
            },
        });
        if (verification.verified) {
            db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(verification.authenticationInfo.newCounter, passkey.id);
            req.session.authenticated = true;
            req.session.save(() => { res.json({ success: true }); });
        } else {
            res.status(400).json({ success: false });
        }
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Auth Guard Middleware
const requireAuth = (req, res, next) => {
    const publicAllowlist = ['/login', '/style.css', '/login.js', '/fonts/font.ttf', '/favicon.ico', '/auth-methods'];
    if (publicAllowlist.includes(req.path) || req.path.startsWith('/vendor/')) return next();

    if (req.session && req.session.authenticated) {
        return next();
    }
    res.redirect('/login');
};

app.use(requireAuth);

// --- CSRF PROTECTION ---
app.get('/api/csrf-token', (req, res) => {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        req.session.save(() => {
            res.json({ token: req.session.csrfToken });
        });
    } else {
        res.json({ token: req.session.csrfToken });
    }
});

const csrfCheck = (req, res, next) => {
    const token = req.headers['x-csrf-token'];
    if (!token || token !== req.session.csrfToken) {
        return res.status(403).json({ error: 'CSRF token missing or invalid' });
    }
    next();
};

// --- SETTINGS ROUTES ---
app.get('/api/settings', (req, res) => {
    const disablePin = db.prepare("SELECT value FROM settings WHERE key = 'disable_pin'").get();
    const disablePassphrase = db.prepare("SELECT value FROM settings WHERE key = 'disable_e2ee_passphrase'").get();
    const passkeyCount = db.prepare('SELECT COUNT(*) as c FROM passkeys').get()?.c || 0;

    res.json({
        disablePin: disablePin ? disablePin.value === 'true' : false,
        envDisablePin: DISABLE_PIN,
        forceE2EE: isForceE2EE(),
        envForceE2EE: process.env.FORCE_E2EE === 'true',
        hasEnvPassphrase: Boolean(process.env.E2EE_PASSPHRASE),
        disablePassphrase: disablePassphrase ? disablePassphrase.value === 'true' : false,
        passkeyCount
    });
});

app.post('/api/settings', csrfCheck, (req, res) => {
    const { disablePin, forceE2EE, disablePassphrase } = req.body;
    const passkeyCount = db.prepare('SELECT COUNT(*) as c FROM passkeys').get()?.c || 0;

    if (typeof disablePin !== 'undefined') {
        if (disablePin && passkeyCount === 0) {
            return res.status(400).json({ error: "Cannot disable PIN login: no passkeys are registered. Register a passkey first." });
        }
        db.prepare("INSERT INTO settings (key, value) VALUES ('disable_pin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(disablePin ? 'true' : 'false');
    }

    if (typeof forceE2EE !== 'undefined') {
        if (process.env.FORCE_E2EE === 'true') {
            return res.status(400).json({ error: "Strict E2EE is locked by environment variable (FORCE_E2EE=true)." });
        }
        if (forceE2EE) {
            const effectivePassphrase = getEffectiveE2EEPassphrase();
            if (passkeyCount === 0 && !effectivePassphrase) {
                return res.status(400).json({ error: "Cannot enforce E2EE: no passkeys are registered and no active passphrase exists." });
            }
        }
        db.prepare("INSERT INTO settings (key, value) VALUES ('force_e2ee', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(forceE2EE ? 'true' : 'false');
    }

    if (typeof disablePassphrase !== 'undefined') {
        if (!process.env.E2EE_PASSPHRASE) {
            return res.status(400).json({ error: "No E2EE passphrase configured in environment." });
        }
        if (disablePassphrase && isForceE2EE() && passkeyCount === 0) {
            return res.status(400).json({ error: "Cannot disable passphrase: Strict E2EE is enabled and no passkeys are registered." });
        }
        db.prepare("INSERT INTO settings (key, value) VALUES ('disable_e2ee_passphrase', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(disablePassphrase ? 'true' : 'false');
    }

    res.json({ success: true });
});

// --- 4. GENERAL MIDDLEWARE & ROUTES ---

// Upload Handler
app.post('/upload', csrfCheck, upload.array('files'), (req, res) => {
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
    io.emit('terminal:output', `\r\n\x1b[32m✔ Uploaded to /data/uploads: ${fileList}\x1b[0m\r\n`);
    res.json({ success: true, count: req.files.length });
});

// Download Handler
app.get('/download', (req, res) => {
    const fileName = req.query.file;
    if (!fileName || typeof fileName !== 'string') return res.status(400).send('File required');

    if (fileName.includes('\0') || fileName.includes('../') || fileName.includes('..\\')) {
        return res.status(403).send('Forbidden');
    }

    const baseName = basename(fileName);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}"`);

    res.sendFile(fileName, { root: DATA_DIR, dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) {
            res.status(err.status || 404).send('File not found');
        }
    });
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
const activeTabSessions = new Map();
const DISCONNECT_GRACE_MS = 60000; // 60 seconds grace period for transient network drops

io.on('connection', (socket) => {
    const req = socket.request;
    if (!req.session || !req.session.authenticated) {
        console.warn("Unauthorized WebSocket connection attempt.");
        socket.disconnect(true);
        return;
    }

    // Telemetry handler socket (isolated from PTY)
    if (socket.handshake.query.type === 'telemetry' || !socket.handshake.query.tabId) {
        socket.on('telemetry:request', () => {
            const freeMem = os.freemem();
            const totalMem = os.totalmem();
            const loadAvg = os.loadavg();
            socket.emit('telemetry:update', {
                cpu: (loadAvg[0]).toFixed(2), // 1 min load avg
                mem: (((totalMem - freeMem) / totalMem) * 100).toFixed(1),
                totalMem: (totalMem / 1024 / 1024 / 1024).toFixed(1)
            });
        });
        return;
    }

    const tabId = String(socket.handshake.query.tabId);
    let sessionObj = activeTabSessions.get(tabId);

    const effectivePassphrase = getEffectiveE2EEPassphrase();
    const effectiveForceE2EE = isForceE2EE();
    // If this session previously established encryption, preserve encryption requirement!
    const isEncryptedTab = Boolean(sessionObj?.isEncrypted || effectiveForceE2EE);

    const e2ee = new ServerE2EESession(E2EE_PBKDF2_ITERATIONS);
    const passkeyRows = db.prepare('SELECT COUNT(*) as c FROM passkeys').get();
    const hasPasskeys = (passkeyRows?.c || 0) > 0;
    const availableModes = {
        passkey: hasPasskeys,
        passphrase: Boolean(effectivePassphrase)
    };

    // Emit initial status so client knows if E2EE is required, available, and iterations
    socket.emit('e2ee:status', {
        forceE2EE: isEncryptedTab,
        availableModes,
        iterations: E2EE_PBKDF2_ITERATIONS
    });

    const cleanEnv = { ...process.env, TERM: 'xterm-256color', WIRED_TAB_ID: tabId };
    delete cleanEnv.TMUX;
    delete cleanEnv.TMUX_PANE;

    const initCols = parseInt(socket.handshake.query.cols, 10) || 80;
    const initRows = parseInt(socket.handshake.query.rows, 10) || 30;

    const bindPtyOutput = (proc, sock, cipherSession) => {
        if (proc._wiredDataDisposable) {
            proc._wiredDataDisposable.dispose();
            proc._wiredDataDisposable = null;
        }
        proc._wiredDataDisposable = proc.onData((data) => {
            if (cipherSession.isVerified) {
                try {
                    const enc = cipherSession.encryptOutput(data);
                    sock.emit('terminal:output:enc', enc);
                } catch (err) {
                    console.error(`[Tab ${tabId}] Encryption output failed:`, err.message);
                }
            } else if (!isEncryptedTab) {
                sock.emit('terminal:output', data);
            }
        });
    };

    const startPtyProcess = () => {
        if (sessionObj?.ptyProcess) return;
        const ptyProcess = pty.spawn('bash', [], {
            name: 'xterm-256color',
            cols: initCols,
            rows: initRows,
            cwd: process.env.HOME,
            env: cleanEnv
        });
        sessionObj.ptyProcess = ptyProcess;

        bindPtyOutput(ptyProcess, socket, e2ee);

        ptyProcess.on('exit', (code, signal) => {
            console.log(`[Tab ${tabId}] PTY exited with code ${code}.`);
            if (sessionObj.disconnectTimer) {
                clearTimeout(sessionObj.disconnectTimer);
                sessionObj.disconnectTimer = null;
            }
            activeTabSessions.delete(tabId);
            try {
                sessionObj.socket?.emit('terminal:exit', { code, signal });
            } catch (e) { }
            setTimeout(() => {
                try { sessionObj.socket?.disconnect(true); } catch (e) { }
            }, 100);
        });
    };

    if (sessionObj && sessionObj.ptyProcess) {
        // Reconnection within grace period
        if (sessionObj.disconnectTimer) {
            clearTimeout(sessionObj.disconnectTimer);
            sessionObj.disconnectTimer = null;
            console.log(`[Tab ${tabId}] Reconnected within grace period. Re-attaching PTY.`);
        }
        if (sessionObj.socket && sessionObj.socket !== socket) {
            try { sessionObj.socket.disconnect(true); } catch (e) { }
        }
        sessionObj.socket = socket;

        // CRITICAL SECURITY FIX:
        // If this tab was encrypted, DO NOT bind plaintext output and DO NOT resume PTY yet!
        // The PTY remains paused until e2ee:verify succeeds with fresh keys.
        if (!isEncryptedTab) {
            bindPtyOutput(sessionObj.ptyProcess, socket, e2ee);
            try { sessionObj.ptyProcess.resume(); } catch (e) {}
            try { sessionObj.ptyProcess.resize(initCols, initRows); } catch (e) { }
        } else {
            console.log(`[Tab ${tabId}] Holding PTY output until E2EE re-authentication completes.`);
        }
    } else {
        sessionObj = {
            tabId,
            ptyProcess: null,
            e2ee,
            socket,
            disconnectTimer: null,
            isEncrypted: isEncryptedTab
        };
        activeTabSessions.set(tabId, sessionObj);

        // Delay PTY spawning in Strict Mode until e2ee:verify succeeds!
        if (!isEncryptedTab) {
            startPtyProcess();
        }
    }

    const touchSession = () => {
        if (req.session) {
            const now = Date.now();
            if (!socket.lastSessionSave || now - socket.lastSessionSave > 60 * 1000) {
                req.session.touch();
                req.session.save();
                socket.lastSessionSave = now;
            }
        }
    };

    // --- E2EE Handshake Handlers ---
    socket.on('e2ee:init', async (data) => {
        const mode = data?.mode || (hasPasskeys ? 'passkey' : 'passphrase');
        if (mode === 'passkey') {
            if (!hasPasskeys) {
                socket.emit('e2ee:error', 'No passkeys registered in database');
                return;
            }
            try {
                const passkeys = db.prepare('SELECT id FROM passkeys').all();
                const webauthnOptions = await generateAuthenticationOptions({
                    rpID: getRpID(req),
                    allowCredentials: passkeys.map(pk => ({ id: pk.id, type: 'public-key' })),
                    userVerification: 'preferred',
                });
                const challengePayload = e2ee.initChallenge('passkey', webauthnOptions);
                socket.emit('e2ee:challenge', challengePayload);
            } catch (err) {
                socket.emit('e2ee:error', err.message);
            }
        } else {
            const currentPassphrase = getEffectiveE2EEPassphrase();
            if (!currentPassphrase) {
                socket.emit('e2ee:error', 'Server has no active E2EE passphrase configured');
                return;
            }
            const challengePayload = e2ee.initChallenge('passphrase');
            socket.emit('e2ee:challenge', challengePayload);
        }
    });

    socket.on('e2ee:verify', async (data) => {
        if (!data) return;
        try {
            if (data.mode === 'passkey') {
                const { clientEcdhPub, webauthnAssertion, encryptedProof } = data;
                if (!clientEcdhPub || !webauthnAssertion || !encryptedProof) {
                    socket.emit('e2ee:error', 'Missing passkey verification parameters');
                    setTimeout(() => socket.disconnect(true), 500);
                    return;
                }
                const passkey = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(webauthnAssertion.id);
                if (!passkey) {
                    socket.emit('e2ee:error', 'Passkey not found');
                    setTimeout(() => socket.disconnect(true), 500);
                    return;
                }
                const boundChallenge = computeTranscriptChallenge(
                    e2ee.serverNonce,
                    e2ee.serverEcdhPub,
                    toBuffer(clientEcdhPub),
                    e2ee.salt
                );
                const verification = await verifyAuthenticationResponse({
                    response: webauthnAssertion,
                    expectedChallenge: boundChallenge,
                    expectedOrigin: getOrigin(req),
                    expectedRPID: getRpID(req),
                    credential: {
                        id: passkey.id,
                        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64')),
                        counter: passkey.counter,
                    },
                });
                if (!verification.verified) {
                    socket.emit('e2ee:error', 'Passkey verification failed');
                    setTimeout(() => socket.disconnect(true), 500);
                    return;
                }

                // Update counter in SQLite for cloned-authenticator detection
                db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(
                    verification.authenticationInfo.newCounter,
                    passkey.id
                );

                // Verify ECDH key and proof of key possession
                const okProof = await e2ee.verifyECDHKeyAndProof(
                    toBuffer(clientEcdhPub),
                    toBuffer(encryptedProof)
                );
                if (!okProof) {
                    socket.emit('e2ee:error', 'ECDH key proof failed');
                    setTimeout(() => socket.disconnect(true), 500);
                    return;
                }
            } else {
                const currentPassphrase = getEffectiveE2EEPassphrase();
                if (!currentPassphrase) {
                    socket.emit('e2ee:error', 'Passphrase E2EE is disabled on this server');
                    setTimeout(() => socket.disconnect(true), 500);
                    return;
                }
                const encryptedProof = data.encryptedProof || data;
                const ok = await e2ee.verifyPassphraseHandshake(
                    currentPassphrase,
                    toBuffer(encryptedProof)
                );
                if (!ok) {
                    socket.emit('e2ee:error', 'Invalid encryption passphrase');
                    setTimeout(() => socket.disconnect(true), 500);
                    return;
                }
            }

            sessionObj.e2ee = e2ee;
            sessionObj.isEncrypted = true;
            socket.emit('e2ee:ready', { mode: e2ee.mode });

            // If PTY not yet spawned (Strict Mode), spawn it now!
            if (!sessionObj.ptyProcess) {
                startPtyProcess();
            } else {
                // Transition existing PTY to encrypted output listener and resume
                bindPtyOutput(sessionObj.ptyProcess, socket, e2ee);
                try { sessionObj.ptyProcess.resume(); } catch (e) {}
                try { sessionObj.ptyProcess.resize(initCols, initRows); } catch (e) { }
            }
        } catch (err) {
            console.error(`[Tab ${tabId}] E2EE verification error:`, err);
            socket.emit('e2ee:error', err.message || 'Verification error');
            setTimeout(() => socket.disconnect(true), 500);
        }
    });

    // Encrypted terminal handlers (Unified multiplexed stream: 0x01 = input, 0x02 = resize)
    socket.on('terminal:input:enc', (wireBuffer) => {
        const proc = sessionObj?.ptyProcess;
        if (!e2ee.isVerified || !proc) return;
        try {
            const plaintextBuf = e2ee.decryptInput(wireBuffer);
            if (plaintextBuf.length > 0 && plaintextBuf[0] === 0x01) {
                // Opcode 0x01: Keystroke input
                proc.write(plaintextBuf.subarray(1).toString('utf8'));
                touchSession();
            } else if (plaintextBuf.length > 0 && plaintextBuf[0] === 0x02) {
                // Opcode 0x02: Terminal resize
                try {
                    const { cols, rows } = JSON.parse(plaintextBuf.subarray(1).toString('utf8'));
                    const safeCols = Math.max(1, Math.min(1000, cols || 80));
                    const safeRows = Math.max(1, Math.min(1000, rows || 30));
                    proc.resize(safeCols, safeRows);
                } catch (err) {
                    console.warn(`[Tab ${tabId}] Failed to parse resize payload:`, err.message);
                }
            } else {
                // Backward-compatible fallback for raw text or raw JSON
                const str = plaintextBuf.toString('utf8');
                try {
                    const parsed = JSON.parse(str);
                    if (parsed.cols && parsed.rows) {
                        proc.resize(Math.max(1, Math.min(1000, parsed.cols)), Math.max(1, Math.min(1000, parsed.rows)));
                        return;
                    }
                } catch (e) {}
                proc.write(str);
                touchSession();
            }
        } catch (err) {
            console.error(`[Tab ${tabId}] Failed to decrypt terminal input:`, err.message);
            socket.disconnect(true);
        }
    });

    socket.on('terminal:resize:enc', (wireBuffer) => {
        const proc = sessionObj?.ptyProcess;
        if (!e2ee.isVerified || !proc) return;
        try {
            const plaintextBuf = e2ee.decryptInput(wireBuffer);
            const raw = (plaintextBuf.length > 0 && plaintextBuf[0] === 0x02)
                ? plaintextBuf.subarray(1).toString('utf8')
                : plaintextBuf.toString('utf8');
            const { cols, rows } = JSON.parse(raw);
            const safeCols = Math.max(1, Math.min(1000, cols || 80));
            const safeRows = Math.max(1, Math.min(1000, rows || 30));
            proc.resize(safeCols, safeRows);
        } catch (err) {
            console.error(`[Tab ${tabId}] Failed to decrypt terminal resize:`, err.message);
            socket.disconnect(true);
        }
    });

    // Plaintext input (strictly prohibited if session was encrypted or isForceE2EE)
    socket.on('terminal:input', (data) => {
        const proc = sessionObj?.ptyProcess;
        if (isForceE2EE() || sessionObj?.isEncrypted || e2ee.isVerified) return;
        if (typeof data !== 'string' || !proc) return;
        try {
            proc.write(data);
            touchSession();
        } catch (err) {
            console.error(`[Tab ${tabId}] Failed to write to terminal:`, err.message);
        }
    });

    socket.on('terminal:resize', ({ cols, rows }) => {
        const proc = sessionObj?.ptyProcess;
        if (isForceE2EE() || sessionObj?.isEncrypted || e2ee.isVerified) return;
        if (!proc) return;
        const safeCols = Math.max(1, Math.min(1000, cols || 80));
        const safeRows = Math.max(1, Math.min(1000, rows || 30));
        try { proc.resize(safeCols, safeRows); }
        catch (err) { console.warn(`[Tab ${tabId}] Resize failed:`, err.message); }
    });

    // Explicit tab close from frontend
    socket.on('terminal:close', () => {
        console.log(`[Tab ${tabId}] Tab closed explicitly by user.`);
        if (sessionObj) {
            if (sessionObj.disconnectTimer) {
                clearTimeout(sessionObj.disconnectTimer);
                sessionObj.disconnectTimer = null;
            }
            if (sessionObj.ptyProcess) {
                sessionObj.ptyProcess.kill();
            }
            activeTabSessions.delete(tabId);
        }
    });

    socket.on('disconnect', (reason) => {
        if (!sessionObj || !sessionObj.ptyProcess) return;

        // Only start grace period if this socket was the active socket for the session
        if (sessionObj.socket === socket) {
            console.log(`[Tab ${tabId}] Disconnected (${reason}). Holding session for ${DISCONNECT_GRACE_MS / 1000}s grace period...`);
            // Pause PTY immediately upon disconnect to prevent leaking output or running unmonitored
            try { sessionObj.ptyProcess.pause(); } catch (e) {}

            if (sessionObj.disconnectTimer) clearTimeout(sessionObj.disconnectTimer);
            sessionObj.disconnectTimer = setTimeout(() => {
                console.log(`[Tab ${tabId}] Grace period expired. Terminating PTY process.`);
                if (sessionObj.ptyProcess) {
                    sessionObj.ptyProcess.kill();
                }
                activeTabSessions.delete(tabId);
            }, DISCONNECT_GRACE_MS);
        }
    });

    socket.on('latency:ping', (timestamp) => {
        socket.emit('latency:pong', timestamp);
        touchSession();
    });
});

// --- EXPORT FOR TESTING ---
export { app, httpServer, activeTabSessions, DISCONNECT_GRACE_MS };

// --- START SERVER ---
if (!IS_TEST) {
    httpServer.listen(PORT, () => {
        console.log(`🚀 WiredAlter-Term running on http://localhost:${PORT}`);
    });
}
