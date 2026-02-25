# WiredAlterTerm

A containerised, web-based terminal built on **Node.js 25** and **Debian 13 (Trixie)**.

It provides a terminal environment in your browser with persistent configuration, a custom Nerd Font, Starship prompt, and secure Docker-in-Docker control. Designed to be portable across Linux hosts.

## Key Features

* **Grid View & Tabs:** Manage multiple terminal instances simultaneously with an auto-resizing CSS grid and a tabbed interface.
* **Persistent Sessions (tmux):** Terminal sessions automatically run inside `tmux`. If your browser disconnects, your background processes keep running.
* **Secure Docker Control:** Maps the host's Docker socket through an isolated `socket-proxy` container. Read-only access is enforced by default, preventing unauthorised container creation or deletion while allowing `docker ps` and `docker exec`.
* **Tailscale Integration:** Built-in Tailscale/Headscale support to expose the terminal exclusively to your private VPN network without opening public ports.
* **Persistent Identity:** SSH keys (`~/.ssh`), Bash history, and shell configuration (`~/.bashrc`) persist across container restarts.
* **General Storage:** A dedicated `~/storage` directory for saving downloads, scripts, or project files.
* **Drag & Drop Uploads:** Drop files directly into the terminal window to upload them to the `/data/` directory.

---

## Quick Start

### 1. Installation

Clone the repository and start the container using the included proxy configuration:

```bash
git clone https://github.com/buildplan/WiredAlter-Term.git
cd WiredAlter-Term
docker compose up -d --build
```

### 2. Access

Open your browser and navigate to:

* **Local:** `http://localhost:3939`
* **Remote:** `http://YOUR_VPS_IP:3939`
* **Tailscale:** `http://wiredterm:3939` (If configured)

---

## Keyboard Shortcuts

The web interface supports native keyboard shortcuts. On macOS, use `Control + Option` instead of `Ctrl + Alt`.

| Shortcut | Action |
| --- | --- |
| `Ctrl + Alt + T` | Open new terminal tab |
| `Ctrl + Alt + X` | Close active terminal tab |
| `Ctrl + Alt + [ / ]` | Switch between open tabs |
| `Ctrl + Alt + G` | Toggle Grid View |
| `Ctrl + Alt + M` | Toggle Mouse Reporting (allows native browser text selection) |
| `Ctrl + Alt + L` | Toggle Light/Dark theme |

---

## tmux & Raw Shell Usage

By default, the terminal auto-attaches to a background `tmux` session named `main`.

If you need a raw bash shell (e.g., to troubleshoot tmux configuration or run conflicting commands), you can use the built-in escape hatch aliases:

* `tmux-off`: Instantly disables tmux auto-start and provides instructions to drop into a raw shell.
* `tmux-on`: Re-enables tmux and instantly attaches the current window back to your session.

---

## Persistence & Storage Guide

All persistent data lives in the local `./data/` folder on your host machine. The container symlinks internal paths to this folder.

| Feature | Container Path | Host Path | Usage |
| --- | --- | --- | --- |
| **Storage** | `~/storage` | `./data/storage` | Save downloads/files here to keep them safe. |
| **SSH Keys** | `~/.ssh/` | `./data/.ssh/` | Keys generated here persist forever. |
| **Config** | `~/.config/` | `./data/.config/` | Starship configuration. |
| **tmux** | `~/.tmux.conf` | `./data/.tmux.conf` | Custom tmux key-binds and settings. |
| **Shell** | `~/.bashrc` | `./data/.bashrc` | Custom aliases and environment vars. |
| **Fonts** | *(Internal)* | `./data/fonts/` | The font file served to the browser. |
| **Uploads** | `/data/` | `./data/` | Files dragged into the browser UI land here. |

---

## Tailscale VPN Setup

To expose the terminal over Tailscale instead of the public internet:

1. Generate an auth key from your Tailscale admin panel.
2. Edit `docker-compose.yml` and uncomment/configure the Tailscale environment variables:

    ```yaml
    environment:
      - TAILSCALE_AUTH_KEY=tskey-auth-xxxxxx
      # - TAILSCALE_LOGIN_SERVER=https://headscale.your-domain.com # Optional
    ```

3. Restart the container. The terminal will join your Tailnet as `wiredterm`.

---

## System CLI

The container includes a custom CLI utility. Type `wiredterm` in the console to use it:

* `wiredterm version`: Checks your current build against the latest GitHub release.
* `wiredterm tools`: Lists the installed versions of underlying tools (Node, tmux, Docker, Starship).
* `wiredterm info`: Displays system architecture and uptime.

---

## Customisation

### 1. Change the Font

The terminal uses a single `.ttf` file. To switch to FiraCode or JetBrains Mono:

1. Download your desired Nerd Font `.ttf`.
2. Rename it to `font.ttf`.
3. Overwrite the existing file at `./data/fonts/font.ttf`.
4. **Apply:** Hard refresh your browser (`Ctrl+F5` or `Cmd+Shift+R`).

### 2. Customise the Prompt

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

1. **Proxy Network:** The terminal talks to the host Docker daemon via a locked-down, internal `socket-proxy`. The terminal container does not require root privileges or a raw socket mount.
2. **Seeding:** On boot, `src/index.js` checks if `./data` contains your config files.
   * If **No**: It copies the "Factory Defaults" (baked into the Docker image) to `./data`.
   * If **Yes**: It respects your existing files.
3. **Linking:** It forcefully removes the container's ephemeral config directories and creates symbolic links to `./data`.

---

## Screenshots

![Screenshot showing the main dashboard interface](https://github.com/user-attachments/assets/fb113347-80b6-44b7-a853-e78cd1ed42a2)

![Screenshot showing the settings configuration page](https://github.com/user-attachments/assets/d970f269-e5ff-4a9c-a343-a3844cbe2bb9)

---

## Troubleshooting

### "My prompt looks broken / I want to reset everything"

If you break your configuration and want to return to the fresh install state:

1. Stop the container: `docker compose down`
2. Delete the problematic file from `./data` (e.g., `rm data/.config/starship.toml`).
3. Start the container: `docker compose up -d`
4. **Result:** The system detects the missing file and auto-generates the default one.

### "Docker commands aren't working"

Ensure the `docker-proxy` container is running and healthy. The terminal relies on `DOCKER_HOST=tcp://docker-proxy:2375`. If you modify the proxy environment variables (e.g., `EXEC=0`), commands like `docker exec` will be rejected by the proxy firewall.

### "Changes disappear after restart"

Ensure you are saving files into `~/storage` or one of the linked configuration files (`.bashrc`, `.ssh`, `.tmux.conf`). Files created directly in `~/` (root home) that are **not** symlinked will be lost when the container is recreated.
