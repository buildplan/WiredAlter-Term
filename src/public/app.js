// --- THEME CONFIGURATION ---
const themes = {
    dark: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: 'rgba(88, 166, 255, 0.2)',
        searchHighlightBg: '#d29922',
        searchHighlightFg: '#000000'
    },
    light: {
        background: '#ffffff',
        foreground: '#24292f',
        cursor: '#0969da',
        selectionBackground: 'rgba(9, 105, 218, 0.2)',
        searchHighlightBg: '#bf3989',
        searchHighlightFg: '#ffffff'
    }
};

// Global State
let currentTheme = localStorage.getItem('wired-term-theme') === 'light' ? 'light' : 'dark';
let mouseReportingEnabled = true;
const statusElem = document.getElementById('connection-status');
const signalElem = document.getElementById('signal-strength');
const themeBtn = document.getElementById('theme-btn');
const mouseBtn = document.getElementById('mouse-mode-btn');
const iconMouseOn = document.getElementById('icon-mouse-on');
const iconMouseOff = document.getElementById('icon-mouse-off');
const iconSun = document.getElementById('icon-sun');
const iconMoon = document.getElementById('icon-moon');
const logoutBtn = document.getElementById('logout-btn');

// --- E2EE STATE & MODAL (Held in closure memory) ---
let cachedSessionPassphrase = null;
let serverE2EEStatus = null;
let pendingE2EEResolve = null;
let pendingE2EEReject = null;

const e2eeBtn = document.getElementById('e2ee-status-btn');
const e2eeIconLocked = document.getElementById('e2ee-icon-locked');
const e2eeIconUnlocked = document.getElementById('e2ee-icon-unlocked');
const e2eeLabel = document.getElementById('e2ee-label');

const e2eeModal = document.getElementById('e2ee-modal');
const e2eePasskeyContainer = document.getElementById('e2ee-passkey-container');
const e2eePasskeyBtn = document.getElementById('e2ee-passkey-btn');
const e2eeOrDivider = document.getElementById('e2ee-or-divider');
const e2eePassphraseContainer = document.getElementById('e2ee-passphrase-container');
const e2eePassphraseInput = document.getElementById('e2ee-passphrase-input');
const e2eeFeedbackMsg = document.getElementById('e2ee-feedback-msg');
const e2eeModalCancel = document.getElementById('e2ee-modal-cancel');
const e2eeModalSubmit = document.getElementById('e2ee-modal-submit');

function updateE2EEUI(isEncrypted) {
    if (!e2eeBtn) return;
    if (isEncrypted) {
        e2eeBtn.className = 'icon-btn e2ee-btn e2ee-active';
        if (e2eeIconLocked) e2eeIconLocked.style.display = 'inline';
        if (e2eeIconUnlocked) e2eeIconUnlocked.style.display = 'none';
        if (e2eeLabel) e2eeLabel.textContent = 'E2EE';
        e2eeBtn.title = 'End-to-End Encryption: ACTIVE (Protected from proxy inspection)';
    } else {
        e2eeBtn.className = 'icon-btn e2ee-btn e2ee-plaintext';
        if (e2eeIconLocked) e2eeIconLocked.style.display = 'none';
        if (e2eeIconUnlocked) e2eeIconUnlocked.style.display = 'inline';
        if (e2eeLabel) e2eeLabel.textContent = 'E2EE Off';
        e2eeBtn.title = 'End-to-End Encryption: OFF (Plaintext WebSocket)';
    }
}

function promptE2EE(status = serverE2EEStatus) {
    return new Promise((resolve, reject) => {
        if (cachedSessionPassphrase) {
            return resolve({ mode: 'passphrase', passphrase: cachedSessionPassphrase });
        }

        const container = document.getElementById('terminals-container');
        if (container) container.classList.add('e2ee-shielded');

        pendingE2EEResolve = resolve;
        pendingE2EEReject = reject;

        if (e2eeFeedbackMsg) e2eeFeedbackMsg.textContent = '';
        if (e2eePassphraseInput) e2eePassphraseInput.value = '';

        const hasPasskeys = status?.availableModes?.passkey;
        const hasPassphrase = status?.availableModes?.passphrase;

        if (e2eePasskeyContainer) e2eePasskeyContainer.style.display = hasPasskeys ? 'block' : 'none';
        if (e2eePassphraseContainer) e2eePassphraseContainer.style.display = hasPassphrase ? 'block' : 'none';
        if (e2eeModalSubmit) e2eeModalSubmit.style.display = hasPassphrase ? 'inline-block' : 'none';
        if (e2eeOrDivider) e2eeOrDivider.style.display = (hasPasskeys && hasPassphrase) ? 'block' : 'none';
        if (e2eeModalCancel) e2eeModalCancel.style.display = status?.forceE2EE ? 'none' : 'inline-block';

        if (e2eeModal) {
            if (typeof e2eeModal.showModal === 'function') {
                if (!e2eeModal.open) e2eeModal.showModal();
            } else {
                e2eeModal.style.display = 'block';
            }
            if (hasPassphrase && !hasPasskeys && e2eePassphraseInput) {
                e2eePassphraseInput.focus();
            }
        }
    });
}

if (e2eePasskeyBtn) {
    e2eePasskeyBtn.addEventListener('click', () => {
        if (pendingE2EEResolve) {
            if (e2eeModal && typeof e2eeModal.close === 'function') e2eeModal.close();
            // Keep terminals container shielded while browser/OS passkey prompt is shown!
            const container = document.getElementById('terminals-container');
            if (container) container.classList.add('e2ee-shielded');
            const res = pendingE2EEResolve;
            pendingE2EEResolve = null;
            pendingE2EEReject = null;
            res({ mode: 'passkey' });
        }
    });
}

const submitPassphrase = () => {
    const val = e2eePassphraseInput?.value;
    if (!val) {
        if (e2eeFeedbackMsg) e2eeFeedbackMsg.textContent = 'Please enter a passphrase';
        return;
    }
    cachedSessionPassphrase = val;
    if (pendingE2EEResolve) {
        if (e2eeModal && typeof e2eeModal.close === 'function') e2eeModal.close();
        const res = pendingE2EEResolve;
        pendingE2EEResolve = null;
        pendingE2EEReject = null;
        res({ mode: 'passphrase', passphrase: val });
    }
};

if (e2eeModalSubmit) e2eeModalSubmit.addEventListener('click', submitPassphrase);
if (e2eePassphraseInput) {
    e2eePassphraseInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitPassphrase();
        }
    });
}
if (e2eeModalCancel) {
    e2eeModalCancel.addEventListener('click', () => {
        if (e2eeModal && typeof e2eeModal.close === 'function') e2eeModal.close();
        const activeTab = window.tabManager?.getActiveTab();
        if (!activeTab?.wasEncrypted && !serverE2EEStatus?.forceE2EE) {
            const container = document.getElementById('terminals-container');
            if (container) container.classList.remove('e2ee-shielded');
            if (activeTab?.element) activeTab.element.classList.remove('e2ee-shielded');
        }
        if (pendingE2EEReject) {
            const rej = pendingE2EEReject;
            pendingE2EEResolve = null;
            pendingE2EEReject = null;
            rej(new Error('User cancelled E2EE unlock'));
        }
    });
}
if (e2eeBtn) {
    e2eeBtn.addEventListener('click', async () => {
        const activeTab = window.tabManager?.getActiveTab();
        if (!activeTab) return;
        if (activeTab.e2ee && activeTab.e2ee.isReady) {
            const cipherInfo = activeTab.e2ee.mode === 'passkey'
                ? 'Passkey (P-256 ECDH + HKDF-SHA256 + AES-GCM-256)'
                : 'Passphrase (PBKDF2-HMAC-SHA256 + AES-GCM-256)';
            const msg = `This terminal tab is end-to-end encrypted (E2EE Active 🔒).\n\nCipher: ${cipherInfo}\n\nKeystrokes, passwords, and screen buffers are shielded from TLS proxy inspection.`;
            if (typeof window.showCustomAlert === 'function') {
                await window.showCustomAlert(msg, 'E2EE Status');
            } else {
                alert(msg);
            }
        } else {
            activeTab.initiateE2EE();
        }
    });
}

// --- THEME LOGIC ---
function updateThemeIcons(isLight) {
    if (isLight) {
        iconSun.style.display = 'none';
        iconMoon.style.display = 'inline';
    } else {
        iconSun.style.display = 'inline';
        iconMoon.style.display = 'none';
    }
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

    if (window.tabManager) {
        window.tabManager.applyThemeToAll(themes[currentTheme]);
    }
});

// Mouse toggle
function updateMouseIcon() {
    if (mouseReportingEnabled) {
        iconMouseOn.style.display = 'inline';
        iconMouseOff.style.display = 'none';
        mouseBtn.title = "Mouse Reporting: ON (Tmux handles scroll/click). Click to disable for copying.";
        mouseBtn.style.cssText = "color: #7ee787 !important; border-color: #7ee787 !important;";
    } else {
        iconMouseOn.style.display = 'none';
        iconMouseOff.style.display = 'inline';
        mouseBtn.title = "Mouse Reporting: OFF (Browser handles select/copy/paste).";
        mouseBtn.style.cssText = "color: #e0af68 !important; border-color: #e0af68 !important;";
    }
}

if (mouseBtn) {
    mouseBtn.addEventListener('click', () => {
        mouseReportingEnabled = !mouseReportingEnabled;
        updateMouseIcon();

        if (window.tabManager) {
            window.tabManager.tabs.forEach(tab => {
                tab.term.options.allowMouseReporting = mouseReportingEnabled;
                if (!mouseReportingEnabled) {
                    tab.term.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l');
                    tab.term.clearSelection();
                } else {
                    tab.term.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
                }
            });
            const active = window.tabManager.getActiveTab();
            if (active) active.term.focus();
        }
    });
}

updateMouseIcon();

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
    constructor(id, manager, name = null, savedContent = '', isEncrypted = false) {
        this.id = id;
        this.manager = manager;
        this.name = name || `Terminal ${id}`;
        this.savedContent = savedContent;
        this.altBuffer = false;
        this.wasEncrypted = Boolean(isEncrypted);

        this.socket = null;
        this.term = null;
        this.fitAddon = null;
        this.serializeAddon = null;
        this.webglAddon = null;
        this.element = null;
        this.tabElement = null;
        this.pingInterval = null;
        this.resizeObserver = null;

        this.init();
    }

    init() {
        this.createElements();

        this.term = new Terminal({
            cursorBlink: true,
            fontFamily: '"TermFont", monospace',
            fontSize: 14,
            lineHeight: 1.2,
            fontWeight: 'normal',
            fontWeightBold: 'bold',
            allowTransparency: true,
            theme: themes[currentTheme],
            scrollback: 5000,
            allowMouseReporting: mouseReportingEnabled
        });

        this.fitAddon = new FitAddon.FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.serializeAddon = new SerializeAddon.SerializeAddon();
        this.term.loadAddon(this.serializeAddon);
        this.searchAddon = new SearchAddon.SearchAddon();
        this.term.loadAddon(this.searchAddon);
        this.webLinksAddon = new WebLinksAddon.WebLinksAddon();
        this.term.loadAddon(this.webLinksAddon);

        try {
            const unicode11Addon = new Unicode11Addon.Unicode11Addon();
            this.term.loadAddon(unicode11Addon);
            this.term.unicode.activeVersion = '11';
        } catch (e) {
            console.warn(`[Tab ${this.id}] Unicode11 addon failed to load:`, e);
        }
        try {
            this.webglAddon = new WebglAddon.WebglAddon();
            this.term.loadAddon(this.webglAddon);
            this.webglAddon.onContextLoss(() => {
                console.warn(`[Tab ${this.id}] WebGL context lost. Falling back to native DOM renderer.`);
                this.webglAddon.dispose();
            });
            console.log(`[Tab ${this.id}] 🚀 WebGL Renderer Active`);
        } catch (e) {
            console.warn(`[Tab ${this.id}] ⚠️ WebGL failed on boot. Falling back to native DOM renderer.`, e);
            if (this.webglAddon) this.webglAddon.dispose();
        }

        this.term.open(this.element);
        if (this.term.textarea) {
            this.term.textarea.name = `xterm-input-${this.id}`;
            this.term.textarea.id = `xterm-input-${this.id}`;
            this.term.textarea.setAttribute('autocapitalize', 'off');
            this.term.textarea.setAttribute('autocorrect', 'off');
            this.term.textarea.setAttribute('spellcheck', 'false');
            this.term.textarea.setAttribute('autocomplete', 'new-password');
            this.term.textarea.setAttribute('inputmode', 'email');
        }
        this.element.addEventListener('mousedown', (e) => {
            if (e.button === 2) e.stopPropagation();
            if (this.term) this.term.focus();
        }, true);
        this.element.addEventListener('mouseup', (e) => { if (e.button === 2) e.stopPropagation(); }, true);
        this.element.addEventListener('click', (e) => {
            if (e.button === 2) e.stopPropagation();
            if (this.element.classList.contains('e2ee-shielded') && (!this.e2ee || !this.e2ee.isReady)) {
                this.initiateE2EE();
            } else if (this.term) {
                this.term.focus();
            }
        }, true);

        try {
            this.fitAddon.fit();
        } catch (e) {
            console.warn("Initial fit failed", e);
        }

        this.e2ee = new (window.ClientE2EESession || ClientE2EESession)();
        this._pendingPassphrase = null;
        this.isProcessExited = false;

        this.socket = io({
            forceNew: true,
            multiplex: false,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000,
            query: {
                cols: this.term.cols || 80,
                rows: this.term.rows || 30,
                tabId: this.id
            }
        });

        this.setupSocketEvents();
        if (this.wasEncrypted || serverE2EEStatus?.forceE2EE) {
            this.element.classList.add('e2ee-shielded');
            const container = document.getElementById('terminals-container');
            if (container) container.classList.add('e2ee-shielded');
        }

        if (this.term.textarea) {
            this.term.textarea.addEventListener('focus', () => {
                if (this.manager.activeTabId !== this.id) {
                    this.manager.setActiveTab(this.id);
                }
            });
        }

        this.term.onData((data) => {
            if (this.isProcessExited) {
                if (data.includes('\r') || data.includes('\n')) {
                    this.isProcessExited = false;
                    this.term.write('\r\n\x1b[36m⚡ Restarting session...\x1b[0m\r\n');
                    if (this.socket) {
                        this.socket.connect();
                    }
                }
                return;
            }
            if (this.wasEncrypted || serverE2EEStatus?.forceE2EE) {
                if (this.e2ee && this.e2ee.isReady) {
                    const dataBytes = new TextEncoder().encode(data);
                    const framed = new Uint8Array(1 + dataBytes.length);
                    framed[0] = 0x01; // OP_INPUT
                    framed.set(dataBytes, 1);
                    this.e2ee.enqueueEncryptInput(framed, (wireBuf) => {
                        this.socket.emit('terminal:input:enc', wireBuf);
                    });
                }
                // Never emit plaintext if this tab was encrypted!
                return;
            }
            this.socket.emit('terminal:input', data);
        });

        // Initial Resize Request
        setTimeout(() => this.resize(), 50);

        this.resizeObserver = new ResizeObserver(() => {
            const isGrid = document.getElementById('terminals-container').classList.contains('grid-mode');
            if (this.isActive() || isGrid) {
                this.resize();
            }
        });
        this.resizeObserver.observe(document.getElementById('terminals-container'));
    }

    handleOutputData(data) {
        if (typeof data !== 'string') return;
        if (data.includes('\x1b[?1049h')) {
            this.altBuffer = true;
        } else if (data.includes('\x1b[?1049l')) {
            this.altBuffer = false;
            setTimeout(() => this.manager.saveState(), 100);
        }

        if (!mouseReportingEnabled) {
            data = data.replace(/\x1b\[\?(1000|1002|1003|1006)h/g, '');
        }
        this.term.write(data);
    }

    async initiateE2EE(status = serverE2EEStatus) {
        if (this.e2ee && this.e2ee.isReady) return;
        try {
            const choice = await promptE2EE(status);
            if (choice.mode === 'passkey') {
                this.socket.emit('e2ee:init', { mode: 'passkey' });
            } else {
                this._pendingPassphrase = choice.passphrase;
                this.socket.emit('e2ee:init', { mode: 'passphrase' });
            }
        } catch (err) {
            console.warn("E2EE unlock cancelled:", err);
        }
    }

    setupSocketEvents() {
        this.socket.on('e2ee:status', (status) => {
            serverE2EEStatus = status;
            if (this.isActive()) {
                updateE2EEUI(this.e2ee && this.e2ee.isReady);
            }
            if ((status.forceE2EE || this.wasEncrypted) && (!this.e2ee || !this.e2ee.isReady)) {
                this.initiateE2EE(status);
            } else if (!status.forceE2EE && !this.wasEncrypted) {
                if (this.element) this.element.classList.remove('e2ee-shielded');
                const container = document.getElementById('terminals-container');
                if (container) container.classList.remove('e2ee-shielded');
                if (this.isActive()) this.term.focus();
            }
        });

        this.socket.on('terminal:output', (data) => {
            if (this.e2ee && this.e2ee.isReady) return;
            this.handleOutputData(data);
        });

        this.socket.on('terminal:output:enc', (wireBuffer) => {
            if (!this.e2ee) return;
            this.e2ee.enqueueDecryptOutput(wireBuffer, (decryptedText) => {
                this.handleOutputData(decryptedText);
            });
        });

        this.socket.on('e2ee:challenge', async (challengePayload) => {
            try {
                if (challengePayload.mode === 'passkey') {
                    if (!window.SimpleWebAuthnBrowser || !window.SimpleWebAuthnBrowser.startAuthentication) {
                        throw new Error("WebAuthn library not loaded. Try refreshing.");
                    }
                    const assertionResult = await this.e2ee.completePasskeyChallenge(
                        challengePayload,
                        window.SimpleWebAuthnBrowser.startAuthentication
                    );
                    this.socket.emit('e2ee:verify', assertionResult);
                } else {
                    const passphrase = this._pendingPassphrase || cachedSessionPassphrase;
                    const encryptedProof = await this.e2ee.completePassphraseChallenge(
                        passphrase,
                        challengePayload.salt,
                        challengePayload.serverNonce,
                        challengePayload.iterations
                    );
                    this.socket.emit('e2ee:verify', { mode: 'passphrase', encryptedProof });
                }
            } catch (err) {
                console.error("E2EE Challenge completion error:", err);
                if (e2eeFeedbackMsg) {
                    const msg = err.name === 'NotAllowedError'
                        ? 'Passkey was cancelled or timed out. Try again.'
                        : (err.message || 'Authentication error');
                    e2eeFeedbackMsg.textContent = msg;
                    if (e2eeModal && !e2eeModal.open && typeof e2eeModal.showModal === 'function') {
                        e2eeModal.showModal();
                    }
                }
            }
        });

        this.socket.on('e2ee:ready', (data) => {
            this.e2ee.markReady();
            this.wasEncrypted = true;
            if (this.tabElement) {
                this.tabElement.classList.add('tab-encrypted');
            }
            if (this.element) {
                this.element.classList.remove('e2ee-shielded');
            }
            const container = document.getElementById('terminals-container');
            if (container) {
                container.classList.remove('e2ee-shielded');
            }
            if (this.isActive()) {
                updateE2EEUI(true);
            }
            this._lastCols = null;
            this._lastRows = null;
            this.term.focus();
            this.resize();
        });

        this.socket.on('e2ee:error', (msg) => {
            console.error("E2EE Error from server:", msg);
            if (e2eeFeedbackMsg) {
                e2eeFeedbackMsg.textContent = msg;
                if (e2eeModal && !e2eeModal.open && typeof e2eeModal.showModal === 'function') {
                    e2eeModal.showModal();
                }
            }
        });

        this.socket.on('terminal:exit', ({ code }) => {
            this.isProcessExited = true;
            this.term.write(`\r\n\x1b[33m[Process exited (code ${code}). Press Enter to restart]\x1b[0m\r\n`);
        });

        this.socket.on('connect', () => {
            this.isProcessExited = false;
            // On fresh connection, re-instantiate client E2EE session for fresh keys
            this.e2ee = new (window.ClientE2EESession || ClientE2EESession)();
            this.syncStatus();
            if (this.isActive()) {
                this.term.focus();
                this.startLatencyCheck();
                setTimeout(() => {
                    this.resize();
                    this.term.focus();
                }, 100);
            }
        });

        this.socket.on('disconnect', (reason) => {
            if (this.isActive()) this.updateStatus('disconnected');
            clearInterval(this.pingInterval);

            // If disconnected by server, transport, or ping timeout, attempt reconnect
            if (reason === 'io server disconnect' || reason === 'transport close' || reason === 'ping timeout') {
                if (!this.isProcessExited) {
                    setTimeout(() => {
                        if (this.socket && !this.socket.connected) {
                            if (this.isActive()) this.updateStatus('connecting');
                            this.socket.connect();
                        }
                    }, 1000);
                }
            }
        });

        this.socket.on('connect_error', () => {
            if (this.isActive()) this.updateStatus('error');
        });

        this.socket.on('latency:pong', (timestamp) => {
            if (!this.isActive()) return;
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
            if (this.socket.connected) {
                this.socket.emit('latency:ping', Date.now());
            }
        }, 2000);
    }

    createElements() {
        this.element = document.createElement('div');
        this.element.className = 'terminal-instance';
        this.element.id = `term-${this.id}`;
        document.getElementById('terminals-container').appendChild(this.element);

        this.tabElement = document.createElement('div');
        this.tabElement.className = 'tab';
        const titleSpan = document.createElement('span');
        titleSpan.className = 'tab-title';
        titleSpan.textContent = this.name;

        const closeSpan = document.createElement('span');
        closeSpan.className = 'tab-close';
        closeSpan.textContent = '✕';

        this.tabElement.appendChild(titleSpan);
        this.tabElement.appendChild(closeSpan);

        this.tabElement.addEventListener('click', (e) => {
            if (!e.target.classList.contains('tab-close')) {
                this.manager.setActiveTab(this.id);
            }
        });

        this.tabElement.addEventListener('dblclick', () => {
            this.startRenaming();
        });

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
        input.name = `tab-rename-${this.id}`;
        input.id = `tab-rename-${this.id}`;
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
        return '';
    }

    isActive() {
        return this.manager.activeTabId === this.id;
    }

    activate() {
        this.element.classList.add('active');
        this.tabElement.classList.add('active');
        if (this.tabElement) {
            this.tabElement.classList.toggle('tab-encrypted', Boolean(this.e2ee && this.e2ee.isReady));
        }
        this.term.focus();
        this.resize();
        this.syncStatus();
        this.startLatencyCheck();
        updateE2EEUI(this.e2ee && this.e2ee.isReady);
        if (this.socket && !this.socket.connected && !this.isProcessExited) {
            this.socket.connect();
        }
        setTimeout(() => {
            if (this.isActive()) {
                this.term.focus();
                this.syncStatus();
            }
        }, 100);
        setTimeout(() => {
            if (this.isActive()) this.term.focus();
        }, 300);
    }

    syncStatus() {
        if (!this.isActive()) return;
        if (this.socket && this.socket.connected) {
            this.updateStatus('connected');
        } else if (this.socket && this.socket.io && this.socket.io.engine && this.socket.io.engine.readyState === 'opening') {
            this.updateStatus('connecting');
        } else {
            this.updateStatus('disconnected');
        }
    }

    deactivate() {
        this.element.classList.remove('active');
        this.tabElement.classList.remove('active');
        clearInterval(this.pingInterval);
    }

    resize() {
        try {
            this.fitAddon.fit();
            const cols = this.term.cols || 80;
            const rows = this.term.rows || 30;
            if (this._lastCols === cols && this._lastRows === rows) return;
            this._lastCols = cols;
            this._lastRows = rows;

            if (this.socket && this.socket.connected) {
                if (this.wasEncrypted || serverE2EEStatus?.forceE2EE) {
                    if (this.e2ee && this.e2ee.isReady) {
                        const jsonBytes = new TextEncoder().encode(JSON.stringify({ cols, rows }));
                        const framed = new Uint8Array(1 + jsonBytes.length);
                        framed[0] = 0x02; // OP_RESIZE
                        framed.set(jsonBytes, 1);
                        this.e2ee.enqueueEncryptInput(framed, (wireBuf) => {
                            this.socket.emit('terminal:input:enc', wireBuf);
                        });
                    }
                    return;
                }
                this.socket.emit('terminal:resize', { cols, rows });
            }
        } catch (e) { /* Ignore resize errors if hidden */ }
    }

    updateStatus(state) {
        if (!this.isActive()) return;
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

    // 3. CORRECTED DESTROY METHOD
    destroy() {
        try {
            if (this.element) this.element.remove();
            if (this.tabElement) this.tabElement.remove();
        } catch (e) {
            console.error("DOM Cleanup error", e);
        }
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.resizeObserver) { this.resizeObserver.disconnect(); }
        try {
            if (this.socket) {
                this.socket.emit('terminal:close');
                this.socket.disconnect();
            }
        } catch (e) {
            console.warn("Socket cleanup error", e);
        }
        try {
            if (this.webglAddon) this.webglAddon.dispose();
            if (this.term) this.term.dispose();
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

        if (window.Sortable) {
            new Sortable(document.getElementById('tabs-list'), {
                animation: 150,
                ghostClass: 'tab-ghost',
                onEnd: () => this.saveState()
            });
        }

        this.setupFileUploads();
        this.restoreState();
        setInterval(() => this.saveState(), 5000);
    }

    createTab(name = null, content = '', specificId = null, isEncrypted = false) {
        const id = (specificId !== null && specificId !== undefined) ? specificId : this.nextId++;
        if (id >= this.nextId) {
            this.nextId = id + 1;
        }
        const tab = new TerminalTab(id, this, name, content, isEncrypted);
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
                        isEncrypted: Boolean(t.wasEncrypted),
                        content: ''
                    });
                }
            });
        });

        try {
            localStorage.setItem('wiredterm-state', JSON.stringify(state));
        } catch (e) {
            console.warn("Failed to persist state:", e.message);
        }
    }

    restoreState() {
        try {
            const raw = localStorage.getItem('wiredterm-state');
            if (!raw) {
                this.createTab();
                return;
            }

            const state = JSON.parse(raw);

            if (state.isGridMode) {
                document.getElementById('terminals-container').classList.add('grid-mode');
                document.getElementById('grid-mode-btn').style.color = '#7ee787';
            }

            if (state.nextId && Number.isInteger(state.nextId)) {
                this.nextId = state.nextId;
            }

            if (state.tabs && state.tabs.length > 0) {
                state.tabs.forEach(t => {
                    this.createTab(t.name, t.content, t.id, Boolean(t.isEncrypted));
                });
                if (state.activeId && this.tabs.has(state.activeId)) {
                    this.setActiveTab(state.activeId);
                }
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
                const csrfRes = await fetch('/api/csrf-token');
                const { token } = await csrfRes.json();

                const res = await fetch('/upload', {
                    method: 'POST',
                    headers: { 'x-csrf-token': token },
                    body: formData
                });
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

    await waitForFonts();

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

    window.tabManager = new TabManager();

    if (termContainer) {
        termContainer.addEventListener('click', () => {
            const active = window.tabManager ? window.tabManager.getActiveTab() : null;
            if (active && active.term) active.term.focus();
        });
    }

    window.addEventListener('focus', () => {
        const active = window.tabManager ? window.tabManager.getActiveTab() : null;
        if (active && active.term) active.term.focus();
    });

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            logoutBtn.innerHTML = '<span class="btn-text">Bye!</span> ⏻';
            fetch('/logout', { method: 'POST' }).then(() => {
                window.location.href = '/login';
            });
        });
    }

    document.addEventListener('contextmenu', (event) => {
        if (!mouseReportingEnabled) return;
        if (event.shiftKey) return;
        event.preventDefault();
    });

    // --- TERMINAL SEARCH LOGIC ---
    const searchBar = document.getElementById('search-bar');
    const searchInput = document.getElementById('search-input');
    const searchPrev = document.getElementById('search-prev');
    const searchNext = document.getElementById('search-next');
    const searchClose = document.getElementById('search-close');
    const searchTriggerBtn = document.getElementById('search-trigger-btn');

    if (searchTriggerBtn) {
        searchTriggerBtn.addEventListener('click', () => {
            searchBar.classList.remove('hidden');
            searchInput.focus();
            searchInput.select();
        });
    }

    function executeSearch(next = true) {
        if (!window.tabManager) return;
        const activeTab = window.tabManager.getActiveTab();
        if (!activeTab || !activeTab.searchAddon) return;

        const term = searchInput.value;
        if (!term) return;

        const baseTheme = themes[currentTheme];
        activeTab.term.options.theme = {
            ...baseTheme,
            selectionBackground: baseTheme.searchHighlightBg,
            selectionForeground: baseTheme.searchHighlightFg
        };

        if (next) activeTab.searchAddon.findNext(term);
        else activeTab.searchAddon.findPrevious(term);
    }

    function closeSearch() {
        searchBar.classList.add('hidden');
        if (window.tabManager) {
            const activeTab = window.tabManager.getActiveTab();
            if (activeTab) {
                activeTab.term.options.theme = themes[currentTheme];
                activeTab.term.clearSelection();
                activeTab.term.focus();
            }
        }
    }

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            executeSearch(!e.shiftKey); // Shift+Enter searches backwards
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeSearch();
        }
    });

    searchNext.addEventListener('click', () => executeSearch(true));
    searchPrev.addEventListener('click', () => executeSearch(false));
    searchClose.addEventListener('click', closeSearch);

    // --- KEYBOARD SHORTCUTS ---
    window.addEventListener('keydown', (e) => {
        const isModifier = e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey;

        // New Tab: Ctrl + Alt (Control + Option) + T
        if (isModifier && e.code === 'KeyT') {
            e.preventDefault();
            e.stopPropagation();
            if (window.tabManager) window.tabManager.createTab();
            return;
        }

        // Close Active Tab: Ctrl + Alt (Control + Option) + X
        if (isModifier && e.code === 'KeyX') {
            e.preventDefault();
            e.stopPropagation();
            if (window.tabManager && window.tabManager.activeTabId) {
                window.tabManager.closeTab(window.tabManager.activeTabId);
            }
            return;
        }

        // Toggle Grid Mode: Ctrl + Alt (Control + Option) + G
        if (isModifier && e.code === 'KeyG') {
            e.preventDefault();
            e.stopPropagation();
            const gridBtn = document.getElementById('grid-mode-btn');
            if (gridBtn) gridBtn.click();
            return;
        }

        // Toggle Mouse Mode (Copy/Paste): Ctrl + Alt (Control + Option) + M
        if (isModifier && e.code === 'KeyM') {
            e.preventDefault();
            e.stopPropagation();
            const mouseModeBtn = document.getElementById('mouse-mode-btn');
            if (mouseModeBtn) mouseModeBtn.click();
            return;
        }

        // Toggle Theme (Light/Dark): Ctrl + Alt (Control + Option) + L
        if (isModifier && e.code === 'KeyL') {
            e.preventDefault();
            e.stopPropagation();
            const themeToggleBtn = document.getElementById('theme-btn');
            if (themeToggleBtn) themeToggleBtn.click();
            return;
        }

        // Open Search: Ctrl + Alt (Control + Option) + F
        if (isModifier && e.code === 'KeyF') {
            e.preventDefault();
            e.stopPropagation();
            searchBar.classList.remove('hidden');
            searchInput.focus();
            searchInput.select();
            return;
        }

        // Switch Tabs: Ctrl + Alt (Control + Option) + [ OR ]
        if (isModifier && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
            e.preventDefault();
            e.stopPropagation();
            const tabElements = Array.from(document.querySelectorAll('.tab'));
            const activeTabEl = document.querySelector('.tab.active');
            if (tabElements.length > 1 && activeTabEl) {
                const currentIndex = tabElements.indexOf(activeTabEl);
                let nextIndex;
                if (e.code === 'BracketLeft') {
                    nextIndex = (currentIndex - 1 + tabElements.length) % tabElements.length;
                }
                else {
                    nextIndex = (currentIndex + 1) % tabElements.length;
                }
                tabElements[nextIndex].click();
            }
        }
    }, true);

    // --- MOBILE VIEWPORT FIX ---
    if (window.visualViewport) {
        const resizeViewport = () => {
            document.body.style.height = window.visualViewport.height + 'px';
            window.scrollTo(0, 0);
            if (window.tabManager) {
                const activeTab = window.tabManager.getActiveTab();
                if (activeTab) activeTab.resize();
            }
        };
        window.visualViewport.addEventListener('resize', resizeViewport);
        window.visualViewport.addEventListener('scroll', resizeViewport);
        resizeViewport();
    }

    // --- VIRTUAL MOBILE KEYBOARD LOGIC ---
    let mobileCtrlActive = false;
    let mobileAltActive = false;
    const mCtrlBtn = document.getElementById('m-ctrl-btn');
    const mAltBtn = document.getElementById('m-alt-btn');

    // ANSI hex codes for special keys
    const mKeyMap = {
        'esc': '\x1b',
        'tab': '\x09',
        'up': '\x1b[A',
        'down': '\x1b[B',
        'right': '\x1b[C',
        'left': '\x1b[D'
    };

    // Handle clicking the virtual buttons
    document.querySelectorAll('.m-key').forEach(btn => {
        const triggerAction = (e) => {
            e.preventDefault();
            const keyType = btn.getAttribute('data-key');
            const activeTab = window.tabManager ? window.tabManager.getActiveTab() : null;
            if (keyType === 'ctrl') {
                mobileCtrlActive = !mobileCtrlActive;
                mCtrlBtn.classList.toggle('active-toggle', mobileCtrlActive);
                if (activeTab) activeTab.term.focus();
                return;
            }
            if (keyType === 'alt') {
                mobileAltActive = !mobileAltActive;
                mAltBtn.classList.toggle('active-toggle', mobileAltActive);
                if (activeTab) activeTab.term.focus();
                return;
            }
            if (mKeyMap[keyType] && activeTab && activeTab.socket) {
                activeTab.socket.emit('terminal:input', mKeyMap[keyType]);
                activeTab.term.focus();
            }
        };
        btn.addEventListener('touchend', triggerAction, { passive: false });
        btn.addEventListener('click', triggerAction);
    });

    // Intercept actual typing to apply the Ctrl/Alt modifiers
    if (window.tabManager) {
        const originalEmit = io.Socket.prototype.emit;
        io.Socket.prototype.emit = function (eventName, payload) {
            if (eventName === 'terminal:input' && (mobileCtrlActive || mobileAltActive) && payload.length === 1) {
                const charLower = payload.toLowerCase();

                // --- LOCAL APP SHORTCUTS (Ctrl + Alt) ---
                if (mobileCtrlActive && mobileAltActive) {
                    let shortcutTriggered = false;

                    if (charLower === 't') { if (window.tabManager) window.tabManager.createTab(); shortcutTriggered = true; }
                    else if (charLower === 'x') { if (window.tabManager && window.tabManager.activeTabId) window.tabManager.closeTab(window.tabManager.activeTabId); shortcutTriggered = true; }
                    else if (charLower === 'g') { const btn = document.getElementById('grid-mode-btn'); if (btn) btn.click(); shortcutTriggered = true; }
                    else if (charLower === 'm') { const btn = document.getElementById('mouse-mode-btn'); if (btn) btn.click(); shortcutTriggered = true; }
                    else if (charLower === 'l') { const btn = document.getElementById('theme-btn'); if (btn) btn.click(); shortcutTriggered = true; }
                    else if (charLower === 'f') {
                        const searchBar = document.getElementById('search-bar');
                        const searchInput = document.getElementById('search-input');
                        if (searchBar && searchInput) {
                            searchBar.classList.remove('hidden');
                            searchInput.focus();
                            searchInput.select();
                        }
                        shortcutTriggered = true;
                    }
                    else if (payload === '[' || payload === ']') {
                        const tabElements = Array.from(document.querySelectorAll('.tab'));
                        const activeTabEl = document.querySelector('.tab.active');
                        if (tabElements.length > 1 && activeTabEl) {
                            const currentIndex = tabElements.indexOf(activeTabEl);
                            const nextIndex = payload === '['
                                ? (currentIndex - 1 + tabElements.length) % tabElements.length
                                : (currentIndex + 1) % tabElements.length;
                            tabElements[nextIndex].click();
                        }
                        shortcutTriggered = true;
                    }
                    if (shortcutTriggered) {
                        mobileCtrlActive = false;
                        mobileAltActive = false;
                        mCtrlBtn.classList.remove('active-toggle');
                        mAltBtn.classList.remove('active-toggle');
                        return;
                    }
                }

                // --- STANDARD TERMINAL MODIFIERS ---
                let modifiedPayload = payload;
                const charCode = payload.charCodeAt(0);
                if (mobileCtrlActive) {
                    if (charCode >= 97 && charCode <= 122) {
                        modifiedPayload = String.fromCharCode(charCode - 96);
                    }
                    else if (charCode >= 65 && charCode <= 90) {
                        modifiedPayload = String.fromCharCode(charCode - 64);
                    }
                    else if (payload === ' ') {
                        modifiedPayload = '\x00';
                    }
                    mobileCtrlActive = false;
                    mCtrlBtn.classList.remove('active-toggle');
                }
                if (mobileAltActive) {
                    modifiedPayload = '\x1b' + modifiedPayload;
                    mobileAltActive = false;
                    mAltBtn.classList.remove('active-toggle');
                }
                return originalEmit.call(this, eventName, modifiedPayload);
            }
            return originalEmit.apply(this, arguments);
        };
    }
});

// --- Passkey, Download, and Telemetry Logic ---
document.addEventListener('DOMContentLoaded', () => {
    // Settings Dropdown Toggle
    const settingsBtn = document.getElementById('settings-menu-btn');
    const settingsDropdown = document.getElementById('settings-dropdown');
    if (settingsBtn && settingsDropdown) {
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            settingsDropdown.classList.toggle('show');
        });
        document.addEventListener('click', (e) => {
            if (!settingsBtn.contains(e.target) && !settingsDropdown.contains(e.target)) {
                settingsDropdown.classList.remove('show');
            }
        });
    }

    // Custom Dialog Helpers
    function showCustomAlert(message, title = "Message") {
        return new Promise(resolve => {
            const modal = document.getElementById('custom-modal');
            document.getElementById('custom-modal-title').textContent = title;
            document.getElementById('custom-modal-text').textContent = message;
            document.getElementById('custom-modal-input-container').style.display = 'none';
            document.getElementById('custom-modal-cancel').style.display = 'none';

            const okBtn = document.getElementById('custom-modal-ok');
            const cleanup = () => {
                okBtn.removeEventListener('click', onOk);
                modal.close();
                resolve();
            };
            const onOk = () => cleanup();
            okBtn.addEventListener('click', onOk);
            modal.showModal();
        });
    }
    window.showCustomAlert = showCustomAlert;

    function showCustomPrompt(message, title = "Input Required") {
        return new Promise(resolve => {
            const modal = document.getElementById('custom-modal');
            document.getElementById('custom-modal-title').textContent = title;
            document.getElementById('custom-modal-text').textContent = message;
            const inputContainer = document.getElementById('custom-modal-input-container');
            const inputField = document.getElementById('custom-modal-input');
            inputContainer.style.display = 'block';
            inputField.value = '';

            const cancelBtn = document.getElementById('custom-modal-cancel');
            cancelBtn.style.display = 'inline-flex';
            const okBtn = document.getElementById('custom-modal-ok');

            const cleanup = (val) => {
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                inputField.removeEventListener('keydown', onKey);
                modal.close();
                resolve(val);
            };
            const onOk = () => cleanup(inputField.value);
            const onCancel = () => cleanup(null);
            const onKey = (e) => {
                if (e.key === 'Enter') onOk();
                if (e.key === 'Escape') onCancel();
            };

            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            inputField.addEventListener('keydown', onKey);

            modal.showModal();
            inputField.focus();
        });
    }

    function showCustomConfirm(message, title = "Confirm") {
        return new Promise(resolve => {
            const modal = document.getElementById('custom-modal');
            document.getElementById('custom-modal-title').textContent = title;
            document.getElementById('custom-modal-text').textContent = message;
            document.getElementById('custom-modal-input-container').style.display = 'none';

            const cancelBtn = document.getElementById('custom-modal-cancel');
            cancelBtn.style.display = 'inline-flex';
            const okBtn = document.getElementById('custom-modal-ok');
            okBtn.textContent = 'Yes';
            cancelBtn.textContent = 'No';

            const cleanup = (val) => {
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                okBtn.textContent = 'OK';
                cancelBtn.textContent = 'Cancel';
                modal.close();
                resolve(val);
            };
            const onOk = () => cleanup(true);
            const onCancel = () => cleanup(false);

            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);

            modal.showModal();
        });
    }

    // 1. Download
    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', async () => {
            const fileName = await showCustomPrompt('Enter the name of the file to download from /data:', 'Download File');
            if (fileName) {
                try {
                    const res = await fetch(`/download?file=${encodeURIComponent(fileName)}`, { method: 'HEAD' });
                    if (res.ok) {
                        window.location.href = `/download?file=${encodeURIComponent(fileName)}`;
                    } else {
                        const statusMsg = res.status === 404 ? 'File not found' : (res.status === 403 ? 'Access forbidden' : 'Download failed');
                        await showCustomAlert(statusMsg, 'Download Error');
                    }
                } catch (e) {
                    await showCustomAlert('Network error checking file', 'Download Error');
                }
            }
        });
    }

    // 1.5 Upload
    const uploadMenuBtn = document.getElementById('upload-menu-btn');
    const hiddenFileInput = document.getElementById('hidden-file-input');

    if (uploadMenuBtn && hiddenFileInput) {
        uploadMenuBtn.addEventListener('click', () => {
            hiddenFileInput.click();
            const settingsDropdown = document.getElementById('settings-dropdown');
            if (settingsDropdown) settingsDropdown.classList.remove('show');
        });

        hiddenFileInput.addEventListener('change', async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;

            const activeTab = window.tabManager ? window.tabManager.getActiveTab() : null;
            if (!activeTab) return;

            const formData = new FormData();
            for (const file of files) formData.append('files', file);

            activeTab.term.write('\r\n\x1b[36m📤 Uploading ' + files.length + ' file(s)...\x1b[0m\r\n');

            try {
                const csrfRes = await fetch('/api/csrf-token');
                const { token } = await csrfRes.json();

                const res = await fetch('/upload', {
                    method: 'POST',
                    headers: { 'x-csrf-token': token },
                    body: formData
                });
                if (!res.ok) throw new Error('Upload failed');
                activeTab.socket.emit('terminal:input', '\r');
            } catch (err) {
                activeTab.term.write(`\r\n\x1b[31m❌ Upload Error: ${err.message}\x1b[0m\r\n`);
                activeTab.socket.emit('terminal:input', '\r');
            }

            // Clear the input so the same file can be uploaded again if needed
            hiddenFileInput.value = '';
        });
    }

    // 2. Passkey Registration
    const passkeyBtn = document.getElementById('passkey-register-btn');
    if (passkeyBtn) {
        passkeyBtn.addEventListener('click', async () => {
            try {
                if (!window.SimpleWebAuthnBrowser) {
                    await showCustomAlert('WebAuthn library not loaded.', 'Error');
                    return;
                }
                const { startRegistration } = window.SimpleWebAuthnBrowser;
                const resp = await fetch('/webauthn/register-options');
                if (!resp.ok) {
                    const errData = await resp.json();
                    throw new Error(errData.error || 'Failed to get registration options');
                }
                const options = await resp.json();
                const attResp = await startRegistration(options);
                const verificationResp = await fetch('/webauthn/register-verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(attResp)
                });
                const verification = await verificationResp.json();
                if (verification.success) {
                    const wantsToDisable = await showCustomConfirm('Passkey registered! Do you want to disable PIN login and use passkeys only?', 'Success');
                    if (wantsToDisable) {
                        const csrfRes = await fetch('/api/csrf-token');
                        const { token } = await csrfRes.json();
                        await fetch('/api/settings', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-csrf-token': token
                            },
                            body: JSON.stringify({ disablePin: true })
                        });
                        await showCustomAlert('PIN login is now disabled.', 'Settings Updated');
                    } else {
                        await showCustomAlert('Passkey registered successfully.', 'Success');
                    }
                } else {
                    await showCustomAlert('Passkey registration failed.', 'Error');
                }
            } catch (e) {
                await showCustomAlert(e.message, 'Error');
            }
        });
    }

    // 2b. Security Settings Modal
    const securityBtn = document.getElementById('security-settings-btn');
    const securityModal = document.getElementById('security-modal');
    const secCloseBtn = document.getElementById('security-modal-close');
    const secCloseX = document.getElementById('security-modal-close-x');
    const secFeedback = document.getElementById('security-feedback-msg');

    const secForceStatus = document.getElementById('sec-force-e2ee-status');
    const secForceToggle = document.getElementById('sec-force-e2ee-toggle');

    const secPassStatus = document.getElementById('sec-passphrase-status');
    const secPassToggle = document.getElementById('sec-passphrase-toggle');

    const secPinStatus = document.getElementById('sec-pin-status');
    const secPinToggle = document.getElementById('sec-pin-toggle');

    let currentSettings = null;

    async function refreshSecurityModal() {
        if (!securityModal) return;
        if (secFeedback) secFeedback.textContent = '';
        try {
            const resp = await fetch('/api/settings');
            if (!resp.ok) throw new Error('Failed to load settings');
            currentSettings = await resp.json();

            // 1. Strict E2EE
            if (secForceStatus && secForceToggle) {
                if (currentSettings.envForceE2EE) {
                    secForceStatus.textContent = 'LOCKED (ENV)';
                    secForceStatus.className = 'badge badge-locked';
                    secForceToggle.disabled = true;
                    secForceToggle.textContent = 'Locked';
                } else if (currentSettings.forceE2EE) {
                    secForceStatus.textContent = 'ENABLED';
                    secForceStatus.className = 'badge badge-enabled';
                    secForceToggle.disabled = false;
                    secForceToggle.textContent = 'Disable';
                } else {
                    secForceStatus.textContent = 'DISABLED';
                    secForceStatus.className = 'badge badge-disabled';
                    secForceToggle.disabled = false;
                    secForceToggle.textContent = 'Enable';
                }
            }

            // 2. Passphrase Fallback
            if (secPassStatus && secPassToggle) {
                if (!currentSettings.hasEnvPassphrase) {
                    secPassStatus.textContent = 'NOT CONFIGURED';
                    secPassStatus.className = 'badge badge-disabled';
                    secPassToggle.disabled = true;
                    secPassToggle.textContent = 'N/A';
                } else if (currentSettings.disablePassphrase) {
                    secPassStatus.textContent = 'DISABLED';
                    secPassStatus.className = 'badge badge-disabled';
                    secPassToggle.disabled = false;
                    secPassToggle.textContent = 'Enable';
                } else {
                    secPassStatus.textContent = 'ENABLED';
                    secPassStatus.className = 'badge badge-enabled';
                    secPassToggle.disabled = false;
                    secPassToggle.textContent = 'Disable';
                }
            }

            // 3. PIN Login
            if (secPinStatus && secPinToggle) {
                if (currentSettings.envDisablePin) {
                    secPinStatus.textContent = 'DISABLED (ENV)';
                    secPinStatus.className = 'badge badge-locked';
                    secPinToggle.disabled = true;
                    secPinToggle.textContent = 'Locked';
                } else if (currentSettings.disablePin) {
                    secPinStatus.textContent = 'DISABLED';
                    secPinStatus.className = 'badge badge-disabled';
                    secPinToggle.disabled = false;
                    secPinToggle.textContent = 'Enable';
                } else {
                    secPinStatus.textContent = 'ENABLED';
                    secPinStatus.className = 'badge badge-enabled';
                    secPinToggle.disabled = false;
                    secPinToggle.textContent = 'Disable';
                }
            }
        } catch (e) {
            if (secFeedback) secFeedback.textContent = e.message;
        }
    }

    async function updateSetting(payload) {
        if (secFeedback) secFeedback.textContent = '';
        try {
            const csrfRes = await fetch('/api/csrf-token');
            const { token } = await csrfRes.json();
            const resp = await fetch('/api/settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': token
                },
                body: JSON.stringify(payload)
            });
            const data = await resp.json();
            if (!resp.ok) {
                throw new Error(data.error || 'Failed to update setting');
            }
            await refreshSecurityModal();
        } catch (err) {
            if (secFeedback) secFeedback.textContent = err.message;
        }
    }

    if (secForceToggle) {
        secForceToggle.addEventListener('click', () => {
            if (!currentSettings || currentSettings.envForceE2EE) return;
            updateSetting({ forceE2EE: !currentSettings.forceE2EE });
        });
    }

    if (secPassToggle) {
        secPassToggle.addEventListener('click', () => {
            if (!currentSettings || !currentSettings.hasEnvPassphrase) return;
            updateSetting({ disablePassphrase: !currentSettings.disablePassphrase });
        });
    }

    if (secPinToggle) {
        secPinToggle.addEventListener('click', () => {
            if (!currentSettings || currentSettings.envDisablePin) return;
            updateSetting({ disablePin: !currentSettings.disablePin });
        });
    }

    const closeSecurityModal = () => {
        if (securityModal && typeof securityModal.close === 'function') {
            securityModal.close();
        }
    };
    if (secCloseBtn) secCloseBtn.addEventListener('click', closeSecurityModal);
    if (secCloseX) secCloseX.addEventListener('click', closeSecurityModal);

    if (securityBtn) {
        securityBtn.addEventListener('click', async () => {
            const settingsDropdown = document.getElementById('settings-dropdown');
            if (settingsDropdown) settingsDropdown.classList.remove('show');
            await refreshSecurityModal();
            if (securityModal && typeof securityModal.showModal === 'function') {
                securityModal.showModal();
            }
        });
    }

    // 3. Telemetry (isolated socket, does not spawn a PTY)
    const telemetrySocket = io({ query: { type: 'telemetry' } });
    setInterval(() => {
        if (telemetrySocket.connected) {
            telemetrySocket.emit('telemetry:request');
        }
    }, 3000);
    telemetrySocket.on('telemetry:update', (data) => {
        const display = document.getElementById('telemetry-display');
        if (display) {
            display.textContent = `~ CPU: ${data.cpu} | RAM: ${data.mem}% of ${data.totalMem}GB`;
        }
    });
    setTimeout(() => {
        if (telemetrySocket.connected) telemetrySocket.emit('telemetry:request');
    }, 1000);

    // 4. Window Visibility & Reconnection Handler
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && window.tabManager) {
            const activeTab = window.tabManager.getActiveTab();
            if (activeTab) {
                activeTab.syncStatus();
                if (activeTab.socket && !activeTab.socket.connected && !activeTab.isProcessExited) {
                    activeTab.socket.connect();
                }
                activeTab.resize();
            }
        }
    });
});
