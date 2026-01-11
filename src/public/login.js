document.addEventListener('DOMContentLoaded', async () => {
    const pinForm = document.getElementById('pinForm');
    const ssoContainer = document.getElementById('ssoContainer');
    const input = document.getElementById('realPinInput');
    const feedback = document.getElementById('feedbackMsg');
    
    // 1. Fetch Auth Configuration from Backend
    try {
        const res = await fetch('/auth/config');
        const config = await res.json();
        
        // Show/Hide PIN Form
        if (config.hasPin) {
            pinForm.style.display = 'block';
            if (input) input.focus();
        }

        // Show/Hide SSO Button
        if (config.hasOidc) {
            ssoContainer.style.display = 'block';
            // If we have SSO but no PIN, hide the divider
            if (!config.hasPin) {
                document.querySelector('.divider').style.display = 'none';
            }
        }
        
    } catch (e) {
        console.error("Failed to load auth config", e);
        if (feedback) feedback.textContent = "SYSTEM ERROR: AUTH_CONFIG_FAIL";
    }

    // 2. PIN Input Logic (only if element exists)
    if (input) {
        document.addEventListener('click', () => {
            if (pinForm.style.display !== 'none') input.focus();
        });

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
                    feedback.style.color = "#ff5555";
                }
            }
        });
    }
});