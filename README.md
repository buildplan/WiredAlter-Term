# WiredAlterTerm 💻

A containerized, persistent, web-based terminal built on Node.js 24 and Debian Trixie. Features a custom Nerd Font, Starship prompt, and full Docker control from the browser.

## 🚀 Features

* **Persistent Configuration:** SSH keys, Bash history, and Starship config survive restarts.
* **Customizable Aesthetics:** "Hack" Nerd Font and Debian-themed prompt included by default.
* **Docker-in-Docker:** Run `docker ps` and other commands directly from the web terminal.
* **Portable:** Automatically fixes permissions (GID mapping) to work on any host OS.
* **Self-Healing:** Automatically restores default configuration if files are deleted.

## 🛠️ Quick Start

1.  **Start the container:**

    ```bash
    docker compose up -d --build
    ```
2.  **Access the terminal:**
    Open `http://localhost:3939` (or your VPS IP).

## ⚙️ Customization Guide

All configuration lives in the local `data/` folder on your host machine.

### 1. Change the Font

To use a different font (e.g., FiraCode), simply replace the file in the data directory.

* **Location:** `./data/fonts/font.ttf`
* **Action:** Overwrite this file with your desired `.ttf` (rename it to `font.ttf`).
* **Apply:** Refresh your browser (Ctrl+F5).

### 2. Customize the Prompt

The prompt is powered by [Starship](https://starship.rs).

* **Location:** `./data/.config/starship.toml`
* **Action:** Edit this file to change colors, symbols, or modules.
* **Apply:** Run `docker compose restart` or reload the shell.

### 3. SSH Keys

Your keys are stored persistently.

* **Location:** `./data/.ssh/`
* **Usage:** Keys generated via `ssh-keygen` inside the web terminal are automatically saved here.

## 🆘 Troubleshooting

**"My prompt looks broken / I want to reset everything"**

If you mess up your configuration and want to go back to the factory defaults:
1.  Stop the container: `docker compose down`
2.  Delete the broken file from `./data` (e.g., `rm data/.config/starship.toml`).
3.  Start the container: `docker compose up -d`
4.  The system will detect the missing file and auto-generate the default one.

**"Docker permission denied"**

Ensure the container was started with access to the socket. The entrypoint script automatically detects the host's Docker Group ID and adds the `node` user to it. Check logs with:

```bash
docker compose logs -f
```

If you want to verify the "Reset" capability one last time:
1.  Run `rm data/.config/starship.toml` on your VPS.
2.  Restart the container.
3.  Watch the logs—you should see `🌱 Seeding default: .config/starship.toml` instead of `Found persistent file`.

