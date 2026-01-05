// Initialize Socket
const socket = io({
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
});

// Initialize Terminal
const term = new Terminal({
    cursorBlink: true,
    fontFamily: "'TermFont', monospace",
    fontSize: 14,
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    allowTransparency: true,
    theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#58a6ff33'
    }
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

// --- UI Elements ---
const statusElem = document.getElementById('connection-status');
const logoutBtn = document.getElementById('logout-btn');

// --- Socket Event Handlers ---
socket.on('connect', () => {
    statusElem.textContent = '🟢 Connected';
    statusElem.style.color = '#7ee787';
    statusElem.style.opacity = '1';
});

socket.on('disconnect', () => {
    statusElem.textContent = '🔴 Disconnected';
    statusElem.style.color = '#ff5555';
    statusElem.style.opacity = '0.8';
});

socket.on('connect_error', () => {
    statusElem.textContent = '⚠️ Connection Error';
    statusElem.style.color = '#e0af68';
});

socket.on('terminal:output', data => {
    term.write(data);
});

// --- App Initialization ---
async function initializeApp() {
    console.log("⏳ Starting App...");

    const terminalContainer = document.getElementById('terminal');
    term.open(terminalContainer);

    try {
        const fontLoad = Promise.all([
            document.fonts.load("14px TermFont"),
            document.fonts.load("bold 14px TermFont"),
            document.fonts.load("italic 14px TermFont")
        ]);

        const timeout = new Promise(resolve => setTimeout(resolve, 1000));

        await Promise.race([fontLoad, timeout]);
        console.log("✅ Fonts active (or timed out)");

        try {
            const webglAddon = new WebglAddon.WebglAddon();
            term.loadAddon(webglAddon);
            webglAddon.onContextLoss(() => {
                webglAddon.dispose();
            });
            console.log("🚀 WebGL Renderer Active");
        } catch (e) {
            console.warn("⚠️ WebGL failed (browser compatibility?), falling back to Canvas", e);
        }

    } catch (e) {
        console.error("Initialization error:", e);
    }

    fitAddon.fit();
    socket.emit('terminal:resize', { cols: term.cols, rows: term.rows });
}

// --- Interaction Handlers ---

// Resize
window.addEventListener('resize', () => {
    fitAddon.fit();
    socket.emit('terminal:resize', { cols: term.cols, rows: term.rows });
});

// Input
term.onData(data => {
    socket.emit('terminal:input', data);
});

// Logout
logoutBtn.addEventListener('click', () => {
    logoutBtn.textContent = 'Logging out...';
    window.location.href = '/logout';
});

// Start
initializeApp();
