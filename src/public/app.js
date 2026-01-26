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

// Global State
let currentTheme = localStorage.getItem('wired-term-theme') === 'light' ? 'light' : 'dark';
const statusElem = document.getElementById('connection-status');
const signalElem = document.getElementById('signal-strength');
const themeBtn = document.getElementById('theme-btn');
const iconSun = document.getElementById('icon-sun');
const iconMoon = document.getElementById('icon-moon');
const logoutBtn = document.getElementById('logout-btn');

// --- THEME LOGIC ---
function updateThemeIcons(isLight) {
    if (isLight) {
        iconSun.style.display = 'none';
        iconMoon.style.display = 'inline';
    } else {
        iconSun.style.display = 'inline';
        iconMoon.style.display = 'none';
    }
    // Update body/html classes
    if (isLight) document.documentElement.classList.add('light');
    else document.documentElement.classList.remove('light');
}

// Initial Theme Setup
updateThemeIcons(currentTheme === 'light');

themeBtn.addEventListener('click', () => {
    const isLight = document.documentElement.classList.toggle('light');
    currentTheme = isLight ? 'light' : 'dark';
    localStorage.setItem('wired-term-theme', currentTheme);
    updateThemeIcons(isLight);

    // Update all open tabs immediately
    if (window.tabManager) {
        window.tabManager.applyThemeToAll(themes[currentTheme]);
    }
});

// Font Loading (Global)
async function waitForFonts() {
    try {
        console.log("⏳ Waiting for fonts...");
        const fontLoad = Promise.all([
            document.fonts.load("14px TermFont"),
            document.fonts.load("bold 14px TermFont"),
            document.fonts.load("italic 14px TermFont")
        ]);
        const timeout = new Promise(resolve => setTimeout(resolve, 1500));
        await Promise.race([fontLoad, timeout]);
        console.log("✅ Fonts active (or timed out)");
    } catch (e) {
        console.warn("⚠️ Font loading warning:", e);
    }
}

// TAB Class
class TerminalTab {
    constructor(id, manager) {
        this.id = id;
        this.manager = manager;
        this.socket = null;
        this.term = null;
        this.fitAddon = null;
        this.webglAddon = null;
        this.element = null;
        this.tabElement = null;
        this.pingInterval = null;

        this.init();
    }

    init() {
        this.createElements();

        // 1. Initialize XTerm
        this.term = new Terminal({
            cursorBlink: true,
            fontFamily: '"TermFont", monospace',
            fontSize: 14,
            fontWeight: 'normal',
            fontWeightBold: 'bold',
            allowTransparency: true,
            theme: themes[currentTheme]
        });

        // 2. Load Addons
        this.fitAddon = new FitAddon.FitAddon();
        this.term.loadAddon(this.fitAddon);

        // WebLinks (Clickable URLs)
        try {
            this.term.loadAddon(new WebLinksAddon.WebLinksAddon());
        } catch (e) { console.warn("WebLinks addon missing"); }

        // WebGL (Performance)
        try {
            this.webglAddon = new WebglAddon.WebglAddon();
            this.term.loadAddon(this.webglAddon);
            this.webglAddon.onContextLoss(() => this.webglAddon.dispose());
            console.log(`[Tab ${this.id}] 🚀 WebGL Renderer Active`);
        } catch (e) {
            console.warn(`[Tab ${this.id}] ⚠️ WebGL failed, falling back to Canvas`, e);
        }

        // 3. Connect Socket (New connection per tab)
        this.socket = io({
            forceNew: true,
            multiplex: false,
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000
        });

        this.setupSocketEvents();

        // 4. Attach to DOM & Fit
        this.term.open(this.element);
        this.fitAddon.fit();

        // 5. Setup Input Handlers (Restored Logic)
        this.term.onData((data) => {
            this.socket.emit('terminal:input', data);
        });

        // Initial Resize Request
        setTimeout(() => this.resize(), 50);

        // Global Resize Listener (Specific to this instance)
        this.resizeListener = () => {
            if(this.isActive()) this.resize();
        };
        window.addEventListener('resize', this.resizeListener);
    }

    setupSocketEvents() {
        // Output Handler (Restored)
        this.socket.on('terminal:output', (data) => this.term.write(data));

        // Status Updates
        this.socket.on('connect', () => {
            if(this.isActive()) this.updateStatus('connected');
            this.startLatencyCheck();
            this.resize(); // Sync size on connect
        });

        this.socket.on('disconnect', () => {
            if(this.isActive()) this.updateStatus('disconnected');
            clearInterval(this.pingInterval);
        });

        // Error Handler
        this.socket.on('connect_error', () => {
            if(this.isActive()) this.updateStatus('error');
        });

        // Latency Pong
        this.socket.on('latency:pong', (timestamp) => {
            if (!this.isActive()) return; // Only show latency for active tab

            const latency = Date.now() - timestamp;
            signalElem.title = `Latency: ${latency}ms`;
            signalElem.className = 'signal-bars';
            if (latency < 100) signalElem.classList.add('signal-good');
            else if (latency < 300) signalElem.classList.add('signal-fair');
            else signalElem.classList.add('signal-poor');
        });
    }

    startLatencyCheck() {
        clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
            if(this.socket.connected) {
                this.socket.emit('latency:ping', Date.now());
            }
        }, 2000);
    }

    createElements() {
        // Create Terminal Container
        this.element = document.createElement('div');
        this.element.className = 'terminal-instance';
        this.element.id = `term-${this.id}`;
        document.getElementById('terminals-container').appendChild(this.element);

        // Create Tab UI
        this.tabElement = document.createElement('div');
        this.tabElement.className = 'tab';
        this.tabElement.innerHTML = `
            <span class="tab-title">Terminal ${this.id}</span>
            <span class="tab-close">✕</span>
        `;

        // Tab Click
        this.tabElement.addEventListener('click', (e) => {
            if(!e.target.classList.contains('tab-close')) {
                this.manager.setActiveTab(this.id);
            }
        });

        // Close Click
        this.tabElement.querySelector('.tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this.manager.closeTab(this.id);
        });

        document.getElementById('tabs-list').appendChild(this.tabElement);
    }

    isActive() {
        return this.element.classList.contains('active');
    }

    activate() {
        this.element.classList.add('active');
        this.tabElement.classList.add('active');
        this.term.focus();
        this.resize();

        // Update UI status immediately based on this socket's state
        if(this.socket.connected) this.updateStatus('connected');
        else if (this.socket.io.engine.readyState === 'closed') this.updateStatus('disconnected');
        else this.updateStatus('error');
    }

    deactivate() {
        this.element.classList.remove('active');
        this.tabElement.classList.remove('active');
    }

    resize() {
        try {
            this.fitAddon.fit();
            if (this.socket && this.socket.connected) {
                this.socket.emit('terminal:resize', {
                    cols: this.term.cols,
                    rows: this.term.rows
                });
            }
        } catch (e) { /* Ignore resize errors if hidden */ }
    }

    updateStatus(state) {
        if (state === 'connected') {
            statusElem.innerHTML = '<span class="status-icon">🟢</span> <span class="status-text">Connected</span>';
            statusElem.style.color = '#7ee787';
            statusElem.style.opacity = '1';
        } else if (state === 'disconnected') {
            statusElem.innerHTML = '<span class="status-icon">🔴</span> <span class="status-text">Disconnected</span>';
            statusElem.style.color = '#ff5555';
            statusElem.style.opacity = '0.8';
        } else {
            statusElem.innerHTML = '<span class="status-icon">⚠️</span> <span class="status-text">Error</span>';
            statusElem.style.color = '#e0af68';
        }
    }

    destroy() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.resizeListener) window.removeEventListener('resize', this.resizeListener);
        if(this.socket) {
            this.socket.disconnect();
            if(this.socket.io) this.socket.io.close(); 
        }
        try {
            if(this.webglAddon) this.webglAddon.dispose();
            if(this.term) this.term.dispose();
        } catch (e) {
            console.warn("Cleanup warning:", e);
        }
        if (this.element) this.element.remove();
        if (this.tabElement) this.tabElement.remove();
    }
}

// --- TAB MANAGER CLASS ---
class TabManager {
    constructor() {
        this.tabs = new Map();
        this.activeTabId = null;
        this.nextId = 1;

        document.getElementById('new-tab-btn').addEventListener('click', () => {
            this.createTab();
        });

        // Initialize Drag and Drop for Tabs (SortableJS)
        if(window.Sortable) {
            new Sortable(document.getElementById('tabs-list'), {
                animation: 150,
                ghostClass: 'tab-ghost'
            });
        }

        // Initialize Global File Upload Handling
        this.setupFileUploads();
    }

    createTab() {
        const id = this.nextId++;
        const tab = new TerminalTab(id, this);
        this.tabs.set(id, tab);
        this.setActiveTab(id);
    }

    setActiveTab(id) {
        if (this.activeTabId && this.tabs.has(this.activeTabId)) {
            this.tabs.get(this.activeTabId).deactivate();
        }
        this.activeTabId = id;
        this.tabs.get(id).activate();
    }

    closeTab(id) {
        const tab = this.tabs.get(id);
        if (tab) {
            tab.destroy();
            this.tabs.delete(id);

            if (this.activeTabId === id) {
                if (this.tabs.size > 0) {
                    const nextId = this.tabs.keys().next().value;
                    this.setActiveTab(nextId);
                } else {
                    this.activeTabId = null;
                    this.createTab(); // Auto-create if empty
                }
            }
        }
    }

    getActiveTab() {
        return this.tabs.get(this.activeTabId);
    }

    applyThemeToAll(theme) {
        this.tabs.forEach(tab => {
            tab.term.options.theme = theme;
        });
    }

    // This replaces the global drag & drop logic
    setupFileUploads() {
        const dropOverlay = document.getElementById('drop-overlay');

        // Prevent default drag behaviors on window
        window.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dropOverlay.classList.add('active');
        });

        dropOverlay.addEventListener('dragenter', (e) => e.preventDefault());
        dropOverlay.addEventListener('dragover', (e) => e.preventDefault());
        dropOverlay.addEventListener('dragleave', (e) => {
            e.preventDefault();
            if (e.relatedTarget === null) dropOverlay.classList.remove('active');
        });

        dropOverlay.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropOverlay.classList.remove('active');

            const activeTab = this.getActiveTab();
            if (!activeTab) return; // No terminal to upload to

            const files = e.dataTransfer.files;
            if (files.length === 0) return;

            const formData = new FormData();
            for (const file of files) formData.append('files', file);

            activeTab.term.write('\r\n\x1b[36m📤 Uploading ' + files.length + ' file(s)...\x1b[0m\r\n');

            try {
                const res = await fetch('/upload', { method: 'POST', body: formData });
                if (!res.ok) throw new Error('Upload failed');
                activeTab.socket.emit('terminal:input', '\r'); // Refresh prompt
            } catch (err) {
                activeTab.term.write(`\r\n\x1b[31m❌ Upload Error: ${err.message}\x1b[0m\r\n`);
                activeTab.socket.emit('terminal:input', '\r');
            }
        });
    }
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    console.log("⏳ Starting App...");

    // 1. Wait for fonts BEFORE opening any terminal
    await waitForFonts();

    // 2. Initialize Manager
    window.tabManager = new TabManager();
    window.tabManager.createTab(); // Open the first tab

    // 3. Logout Handler
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            logoutBtn.innerHTML = '<span class="btn-text">Bye!</span> ⏻';
            window.location.href = '/logout';
        });
    }
});