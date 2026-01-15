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

    document.addEventListener('click', (e) => {
        if (e.target.closest('#theme-btn')) return;
        input.focus();
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
});