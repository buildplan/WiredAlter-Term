# WiredAlterTerm

A robust, containerized, web-based terminal built on **Node.js 24** and **Debian 13 (Trixie)**.

It provides a full-featured terminal environment in your browser with persistent configuration, a custom Nerd Font, Starship prompt, and secure Docker-in-Docker control. Designed to be portable across any Linux host without permission issues.

## Key Features

* **Persistent Identity:** SSH keys (`~/.ssh`), Bash history, and shell configuration (`~/.bashrc`) persist across container restarts.
* **General Storage:** A dedicated `~/storage` directory for saving downloads, scripts, or project files persistently.
* **Customizable Aesthetics:** Ships with "Hack" Nerd Font and a Debian-themed Starship prompt. Both are fully customizable via the host filesystem.
* **Docker Control:** Run `docker ps`, `docker build`, and other commands directly from the browser (maps the host's Docker socket securely).
* **Portable & Self-Healing:**
    * **Auto-Permissions:** Automatically detects the host's Docker GID and maps it, preventing "Permission Denied" errors on any OS.
    * **Factory Reset:** Automatically detects missing config files and restores defaults if they are deleted.

---

## Quick Start

### 1. Installation
Clone the repository and start the container:

```bash
git clone https://github.com/buildplan/WiredAlter-Term.git
cd WiredAlter-Term
docker compose up -d --build
```

### 2. Access

Open your browser and navigate to:

* **Local:** `http://localhost:3939`
* **Remote:** `http://YOUR_VPS_IP:3939`

---

## Persistence & Storage Guide

All persistent data lives in the local `./data/` folder on your host machine. The container symlinks internal paths to this folder.

| Feature | Container Path | Host Path | Usage |
| --- | --- | --- | --- |
| **Storage** | `~/storage` | `./data/storage` | Save downloads/files here to keep them safe. |
| **SSH Keys** | `~/.ssh/` | `./data/.ssh/` | Keys generated here persist forever. |
| **Config** | `~/.config/` | `./data/.config/` | Starship configuration. |
| **Shell** | `~/.bashrc` | `./data/.bashrc` | Custom aliases and environment vars. |
| **Fonts** | *(Internal)* | `./data/fonts/` | The font file served to the browser. |

### Using General Storage

To save files (like source code, backups, or downloads) that survive container destruction, simply use the `storage` folder:

```bash
# Inside the web terminal
cd ~/storage
wget [https://example.com/project.zip](https://example.com/project.zip)
```

These files will instantly appear in `./data/storage` on your host.

---

## Customization

### 1. Change the Font

The terminal uses a single `.ttf` file. To switch to FiraCode or JetBrains Mono:

1. Download your desired Nerd Font `.ttf`.
2. Rename it to `font.ttf`.
3. Overwrite the existing file at `./data/fonts/font.ttf`.
4. **Apply:** Hard refresh your browser (`Ctrl+F5` or `Cmd+Shift+R`).

### 2. Customize the Prompt

The prompt is powered by [Starship](https://starship.rs).

1. Edit `./data/.config/starship.toml` on your host.
2. **Apply:** Run `docker compose restart` or reload the shell.

### 3. Add Custom Aliases

1. Edit `./data/.bashrc` on your host (or `nano ~/.bashrc` inside the terminal).
2. Add your alias: `alias ll='ls -la'`.
3. **Apply:** Run `source ~/.bashrc`.

---

## How It Works (Architecture)

This project uses a **"Seed and Link"** strategy for robustness:

1. **Entrypoint:** On startup, `src/entrypoint.sh` detects the host's Docker Group ID and dynamically adds the `node` user to that group.
2. **Seeding:** `src/index.js` checks if `./data` contains your config files.
   * If **No**: It copies the "Factory Defaults" (baked into the Docker image) to `./data`.
   * If **Yes**: It respects your existing files.
3. **Linking:** It forcefully removes the container's ephemeral config directories and creates symbolic links to `./data`.

---

## Troubleshooting

### "My prompt looks broken / I want to reset everything"

If you break your configuration and want to return to the fresh install state:

1. Stop the container: `docker compose down`
2. Delete the problematic file from `./data` (e.g., `rm data/.config/starship.toml`).
3. Start the container: `docker compose up -d`
4. **Result:** The system detects the missing file and auto-generates the default one.

### "Docker permission denied"

Ensure the container has access to the socket. The system logs will tell you if the permission fix worked:

```bash
docker compose logs -f
```

You should see: `🔌 Detected Host Docker GID: 989` (or similar).

### "Changes disappear after restart"

This should not happen. Ensure you are saving files into `~/storage` or one of the linked configuration files (`.bashrc`, `.ssh`). Files created in `~/` (root home) that are **not** symlinked will be lost on container recreation.
