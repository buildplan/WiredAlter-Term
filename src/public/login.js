document.addEventListener('DOMContentLoaded', () => {
    const themeBtn = document.getElementById('theme-btn');
    const iconSun = document.getElementById('icon-sun');
    const iconMoon = document.getElementById('icon-moon');

    const isLightStart = document.documentElement.classList.contains('light');
    updateThemeIcons(isLightStart);

    function updateThemeIcons(isLight) {
        if (isLight) {
            iconSun.style.display = 'none';
            iconMoon.style.display = 'inline';
        } else {
            iconSun.style.display = 'inline';
            iconMoon.style.display = 'none';
        }
    }

    themeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const html = document.documentElement;
        const isLight = html.classList.toggle('light');
        localStorage.setItem('wired-term-theme', isLight ? 'light' : 'dark');
        updateThemeIcons(isLight);
    });


    // --- EXISTING LOGIN LOGIC ---
    const input = document.getElementById('realPinInput');
    const feedback = document.getElementById('feedbackMsg');
    const cursor = document.getElementById('fakeCursor');

    fetch('/auth-methods').then(r => r.json()).then(data => {
        if (data.disablePin) {
            const wrapper = document.querySelector('.input-wrapper');
            if (wrapper) wrapper.style.display = 'none';
            feedback.textContent = "PIN LOGIN DISABLED. USE PASSKEY.";
            feedback.style.color = "#58a6ff";
        }
    }).catch(err => console.error("Could not fetch auth methods", err));

    document.addEventListener('click', (e) => {
        if (e.target.closest('#theme-btn')) return;
        if (input && document.querySelector('.input-wrapper').style.display !== 'none') {
            input.focus();
        }
    });

    // Handle Enter Key
    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const pin = input.value;

            if (!pin) return;

            feedback.textContent = "VERIFYING...";
            feedback.style.color = "#e0af68"; // Yellow

            try {
                const res = await fetch('/verify-pin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin })
                });

                const data = await res.json();

                if (res.ok) {
                    feedback.textContent = "ACCESS GRANTED";
                    feedback.style.color = "#9ece6a"; // Green
                    setTimeout(() => window.location.href = '/', 500);
                } else {
                    feedback.textContent = data.error || "ACCESS DENIED";
                    feedback.style.color = "#ff5555"; // Red
                    input.value = ''; // Clear input
                }
            } catch (err) {
                feedback.textContent = "SYSTEM ERROR";
            }
        }
    });

    const passkeyBtn = document.getElementById('passkeyBtn');
    if (passkeyBtn) {
        passkeyBtn.addEventListener('click', async () => {
            const { startAuthentication } = window.SimpleWebAuthnBrowser;
            feedback.textContent = "WAITING FOR PASSKEY...";
            feedback.style.color = "#e0af68";
            try {
                const resp = await fetch('/webauthn/auth-options');
                if (!resp.ok) {
                    const data = await resp.json();
                    throw new Error(data.error || 'No passkeys found');
                }
                const options = await resp.json();
                const asseResp = await startAuthentication(options);
                const verificationResp = await fetch('/webauthn/auth-verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(asseResp)
                });
                const verification = await verificationResp.json();
                if (verification.success) {
                    feedback.textContent = "ACCESS GRANTED";
                    feedback.style.color = "#9ece6a";
                    setTimeout(() => window.location.href = '/', 500);
                } else {
                    feedback.textContent = "PASSKEY REJECTED";
                    feedback.style.color = "#ff5555";
                }
            } catch (e) {
                feedback.textContent = e.message || "SYSTEM ERROR";
                feedback.style.color = "#ff5555";
            }
        });
    }
});
