// --- THEME CONFIGURATION ---
const themes = {
    dark: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#58a6ff33'
    },
    light: {
        background: '#ffffff',
        foreground: '#24292f',
        cursor: '#0969da',
        selectionBackground: '#0969da33'
    }
};

// Determine initial theme
const currentTheme = localStorage.getItem('wired-term-theme') === 'light' ? 'light' : 'dark';

// Initialize Socket
const socket = io({
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
});

// Initialize Terminal with CORRECT initial theme
const term = new Terminal({
    cursorBlink: true,
    fontFamily: "'TermFont', monospace",
    fontSize: 14,
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    allowTransparency: true,
    theme: themes[currentTheme] // Apply saved theme on start
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

// --- UI Elements ---
const statusElem = document.getElementById('connection-status');
const logoutBtn = document.getElementById('logout-btn');
const themeBtn = document.getElementById('theme-btn');
const iconSun = document.getElementById('icon-sun');
const iconMoon = document.getElementById('icon-moon');

// --- Theme Logic ---
function updateThemeIcons(isLight) {
    if (isLight) {
        iconSun.style.display = 'none';
        iconMoon.style.display = 'inline';
    } else {
        iconSun.style.display = 'inline';
        iconMoon.style.display = 'none';
    }
}

// Set initial icon state
updateThemeIcons(currentTheme === 'light');

themeBtn.addEventListener('click', () => {
    const html = document.documentElement;
    const isLight = html.classList.toggle('light');
    const newTheme = isLight ? 'light' : 'dark';
    localStorage.setItem('wired-term-theme', newTheme);
    term.options.theme = themes[newTheme];
    updateThemeIcons(isLight);
});

// --- Socket Event Handlers ---
socket.on('connect', () => {
    statusElem.innerHTML = '<span class="status-icon">🟢</span> <span class="status-text">Connected</span>';
    statusElem.style.color = '#7ee787';
    statusElem.style.opacity = '1';
});

socket.on('disconnect', () => {
    statusElem.innerHTML = '<span class="status-icon">🔴</span> <span class="status-text">Disconnected</span>';
    statusElem.style.color = '#ff5555';
    statusElem.style.opacity = '0.8';
});

socket.on('connect_error', () => {
    statusElem.innerHTML = '<span class="status-icon">⚠️</span> <span class="status-text">Error</span>';
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
    logoutBtn.innerHTML = '<span class="btn-text">Bye!</span> ⏻';
    window.location.href = '/logout';
});

// Start
initializeApp();