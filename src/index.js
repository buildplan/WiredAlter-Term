import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pty from 'node-pty';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3939;
process.env.STARSHIP_CONFIG = join(process.env.HOME, '.config', 'starship.toml');

// --- MIDDLEWARE ---
app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
});

app.use((req, res, next) => {
    if (req.url === '/favicon.ico') return next();
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// Serve Font from the SYMLINKED public folder
app.get('/fonts/font.ttf', (req, res) => {
    const fontPath = join(__dirname, 'public/fonts/font.ttf');
    if (!fs.existsSync(fontPath)) return res.status(404).send('Font not found');
    res.setHeader('Content-Type', 'font/ttf');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(fontPath);
});

app.use(express.static(join(__dirname, 'public')));

// --- PERSISTENCE SETUP ---
const setupPersistence = () => {
    const userHome = process.env.HOME; // /home/node
    const dataDir = '/data';           // Persistent volume
    const seedDir = '/usr/local/share/smart-term'; // defaults in Dockerfile

    console.log('🔌 SmartTerm: Initializing Persistence & Defaults...');

    // A generic function to Seed (Copy Default) -> Link (Symlink)
    const seedAndLink = (relPath, isFolder = false, seedSource = null) => {
        const containerPath = join(userHome, relPath); // e.g. /home/node/.config/starship.toml
        const persistentPath = join(dataDir, relPath); // e.g. /data/.config/starship.toml

        // Ensure /data parent dir exists
        fs.mkdirSync(dirname(persistentPath), { recursive: true });
        // Ensure container parent dir exists
        fs.mkdirSync(dirname(containerPath), { recursive: true });

        // SEEDING: If it doesn't exist in /data, create it
        if (!fs.existsSync(persistentPath)) {
            if (seedSource && fs.existsSync(seedSource)) {
                // Copy from defaults (Docker image)
                console.log(`   🌱 Seeding default: ${relPath}`);
                fs.cpSync(seedSource, persistentPath, { recursive: true });
            } else if (fs.existsSync(containerPath)) {
                // Copy from current container state (fallback)
                console.log(`   🌱 Seeding from container: ${relPath}`);
                fs.cpSync(containerPath, persistentPath, { recursive: true });
            } else {
                // Create empty if nothing else exists
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

    // --- Fonts Persistence ---
    const publicFonts = join(__dirname, 'public/fonts');
    const persistentFonts = join(dataDir, 'fonts');
    const seedFonts = join(seedDir, 'fonts');

    // Seed /data/fonts from /usr/local/share/smart-term/fonts
    if (!fs.existsSync(persistentFonts)) {
        console.log('   🌱 Seeding Default Fonts...');
        fs.cpSync(seedFonts, persistentFonts, { recursive: true });
    }
    // Link src/public/fonts -> /data/fonts
    if (fs.existsSync(publicFonts)) fs.rmSync(publicFonts, { recursive: true, force: true });
    fs.symlinkSync(persistentFonts, publicFonts);
    console.log('   🔗 Linked public/fonts -> /data/fonts');


    // --- Configuration Persistence ---
    seedAndLink('.ssh', true);
    seedAndLink('.bashrc', false);
    seedAndLink('.bash_history', false);

    // Starship from entrypoint default
    seedAndLink('.config/starship.toml', false, join(seedDir, 'config/starship.toml'));

     // --- 3. General Storage (NEW) ---
    // This creates ~/storage linked to /data/storage
    seedAndLink('storage', true);
};

setupPersistence();

// --- TERMINAL LOGIC ---
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
});

httpServer.listen(PORT, () => {
    console.log(`🚀 SmartTerm running on http://localhost:${PORT}`);
});
