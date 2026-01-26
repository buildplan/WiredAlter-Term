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

// --- TERMINAL TAB CLASS ---
class TerminalTab {
    constructor(id, manager, name = null, savedContent = '') {
        this.id = id;
        this.manager = manager;
        this.name = name || `Terminal ${id}`;
        this.savedContent = savedContent; // Content to restore

        this.socket = null;
        this.term = null;
        this.fitAddon = null;
        this.serializeAddon = null;
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
            theme: themes[currentTheme],
            scrollback: 5000 // Remember more lines for persistence
        });

        // 2. Load Addons
        this.fitAddon = new FitAddon.FitAddon();
        this.term.loadAddon(this.fitAddon);

        // Serialize Addon for saving state
        this.serializeAddon = new SerializeAddon.SerializeAddon();
        this.term.loadAddon(this.serializeAddon);

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

        // Restore content if it exists (Visual Persistence)
        if (this.savedContent) {
            this.term.write(this.savedContent);
            this.term.write('\r\n\x1b[30;43m ⚡ Session Restored (Process Restarted) \x1b[0m\r\n');
        }

        // Listen for focus to update active tab
        if (this.term.textarea) {
            this.term.textarea.addEventListener('focus', () => {
                if (this.manager.activeTabId !== this.id) {
                    this.manager.setActiveTab(this.id);
                }
            });
        }

        // 5. Setup Input Handlers
        this.term.onData((data) => {
            this.socket.emit('terminal:input', data);
            // Save state on input
            this.manager.saveState();
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
        this.socket.on('terminal:output', (data) => {
            this.term.write(data);
        });

        this.socket.on('connect', () => {
            if(this.isActive()) {
                this.syncStatus();
                this.startLatencyCheck();
                this.resize();
            }
        });

        this.socket.on('disconnect', () => {
            if(this.isActive()) this.updateStatus('disconnected');
            clearInterval(this.pingInterval);
        });

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
            <span class="tab-title">${this.name}</span>
            <span class="tab-close">✕</span>
        `;

        // Tab Click
        this.tabElement.addEventListener('click', (e) => {
            if(!e.target.classList.contains('tab-close')) {
                this.manager.setActiveTab(this.id);
            }
        });

        // Double Click to Rename
        this.tabElement.addEventListener('dblclick', () => {
            this.startRenaming();
        });

        // Close Click
        this.tabElement.querySelector('.tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this.manager.closeTab(this.id);
        });

        document.getElementById('tabs-list').appendChild(this.tabElement);
    }

    startRenaming() {
        const titleSpan = this.tabElement.querySelector('.tab-title');
        const currentName = titleSpan.innerText;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.className = 'rename-input';

        titleSpan.replaceWith(input);
        input.focus();
        input.select();

        let isSaving = false;

        const saveName = () => {
            if (isSaving) return;
            isSaving = true;

            this.name = input.value || currentName;
            const newSpan = document.createElement('span');
            newSpan.className = 'tab-title';
            newSpan.innerText = this.name;

            if (input.parentNode) {
                input.replaceWith(newSpan);
            }

            this.manager.saveState();
        };

        input.addEventListener('blur', saveName);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            }
        });
    }

    getContent() {
        return this.serializeAddon ? this.serializeAddon.serialize() : '';
    }

    isActive() {
        return this.manager.activeTabId === this.id;
    }

    activate() {
        this.element.classList.add('active');
        this.tabElement.classList.add('active');
        this.term.focus();
        this.resize();
        this.syncStatus();
        setTimeout(() => {
            if (this.isActive()) this.syncStatus();
        }, 100);
    }

    syncStatus() {
        if (this.socket.connected) {
            this.updateStatus('connected');
        } else if (this.socket.io.engine.readyState === 'opening') {
            this.updateStatus('connecting');
        } else {
            this.updateStatus('disconnected');
        }
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
        } else if (state === 'connecting') {
            statusElem.innerHTML = '<span class="status-icon">🟡</span> <span class="status-text">Connecting...</span>';
            statusElem.style.color = '#e0af68';
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
        try {
            if (this.element) this.element.remove();
            if (this.tabElement) this.tabElement.remove();
        } catch(e) {
            console.error("DOM Cleanup error", e);
        }
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.resizeListener) window.removeEventListener('resize', this.resizeListener);
        try {
            if(this.socket) {
                this.socket.disconnect();
            }
        } catch(e) {
            console.warn("Socket cleanup error", e);
        }
        try {
            if(this.webglAddon) this.webglAddon.dispose();
            if(this.term) this.term.dispose();
        } catch (e) {
            console.warn("Terminal cleanup warning:", e);
        }
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
            this.saveState();
        });

        // Initialize Drag and Drop for Tabs (SortableJS)
        if(window.Sortable) {
            new Sortable(document.getElementById('tabs-list'), {
                animation: 150,
                ghostClass: 'tab-ghost',
                onEnd: () => this.saveState()
            });
        }

        // Initialize Global File Upload Handling
        this.setupFileUploads();

        // Restore State on Boot
        this.restoreState();

        // Auto-save periodically
        setInterval(() => this.saveState(), 5000);
    }

    createTab(name = null, content = '') {
        const id = this.nextId++;
        const tab = new TerminalTab(id, this, name, content);
        this.tabs.set(id, tab);
        this.setActiveTab(id);

        const termContainer = document.getElementById('terminals-container');
        if (termContainer.classList.contains('grid-mode')) {
            setTimeout(() => {
                this.tabs.forEach(t => t.resize());
            }, 100);
        }
        return tab;
    }

    saveState() {
        const state = {
            activeId: this.activeTabId,
            nextId: this.nextId,
            isGridMode: document.getElementById('terminals-container').classList.contains('grid-mode'),
            tabs: []
        };

        const tabElements = document.querySelectorAll('.tab');
        tabElements.forEach(el => {
            this.tabs.forEach(t => {
                if (t.tabElement === el) {
                    state.tabs.push({
                        id: t.id,
                        name: t.name,
                        content: t.getContent()
                    });
                }
            });
        });

        localStorage.setItem('wiredterm-state', JSON.stringify(state));
    }

    restoreState() {
        try {
            const raw = localStorage.getItem('wiredterm-state');
            if (!raw) {
                this.createTab();
                return;
            }

            const state = JSON.parse(raw);

            // Restore Grid Mode
            if (state.isGridMode) {
                document.getElementById('terminals-container').classList.add('grid-mode');
                document.getElementById('grid-mode-btn').style.color = '#7ee787';
            }

            // Restore Tabs
            if (state.tabs && state.tabs.length > 0) {
                state.tabs.forEach(t => {
                    this.createTab(t.name, t.content);
                });
            } else {
                this.createTab();
            }

        } catch (e) {
            console.error("Failed to restore state:", e);
            this.createTab();
        }
    }

    setActiveTab(id) {
        if (this.activeTabId && this.tabs.has(this.activeTabId)) {
            this.tabs.get(this.activeTabId).deactivate();
        }
        this.activeTabId = id;
        this.tabs.get(id).activate();
        this.saveState();
    }

    closeTab(id) {
        const tab = this.tabs.get(id);
        if (tab) {
            this.tabs.delete(id);
            if (this.activeTabId === id) {
                if (this.tabs.size > 0) {
                    const nextId = Array.from(this.tabs.keys()).pop();
                    this.setActiveTab(nextId);
                } else {
                    this.activeTabId = null;
                    this.createTab();
                }
            }
            try {
                tab.destroy();
            } catch (err) {
                console.error("Failed to destroy tab cleanly:", err);
            }
            this.saveState();
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

    setupFileUploads() {
        const dropOverlay = document.getElementById('drop-overlay');

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
            if (!activeTab) return;

            const files = e.dataTransfer.files;
            if (files.length === 0) return;

            const formData = new FormData();
            for (const file of files) formData.append('files', file);

            activeTab.term.write('\r\n\x1b[36m📤 Uploading ' + files.length + ' file(s)...\x1b[0m\r\n');

            try {
                const res = await fetch('/upload', { method: 'POST', body: formData });
                if (!res.ok) throw new Error('Upload failed');
                activeTab.socket.emit('terminal:input', '\r');
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

    // Wait for fonts BEFORE opening any terminal
    await waitForFonts();

    // --- GRID MODE TOGGLE ---
    const gridBtn = document.getElementById('grid-mode-btn');
    const termContainer = document.getElementById('terminals-container');
    if (gridBtn) {
        gridBtn.addEventListener('click', () => {
            const isGrid = termContainer.classList.toggle('grid-mode');
            gridBtn.style.color = isGrid ? '#7ee787' : 'inherit';
            if (window.tabManager) {
                window.tabManager.tabs.forEach(tab => {
                    setTimeout(() => {
                        tab.fitAddon.fit();
                        if (tab.socket && tab.socket.connected) {
                            tab.socket.emit('terminal:resize', {
                                cols: tab.term.cols,
                                rows: tab.term.rows
                            });
                        }
                    }, 50);
                });
                const active = window.tabManager.getActiveTab();
                if (active) active.term.focus();
                window.tabManager.saveState();
            }
        });
    }

    // Initialize
    window.tabManager = new TabManager();

    // Logout Handler
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            logoutBtn.innerHTML = '<span class="btn-text">Bye!</span> ⏻';
            window.location.href = '/logout';
        });
    }
});