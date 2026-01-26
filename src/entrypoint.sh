#!/bin/sh

# Dynamic Docker Socket Permission
if [ -S /var/run/docker.sock ]; then
    SOCKET_GID=$(stat -c '%g' /var/run/docker.sock)
    echo "🔌 Detected Host Docker GID: $SOCKET_GID"

    if getent group "$SOCKET_GID" > /dev/null; then
        GROUP_NAME=$(getent group "$SOCKET_GID" | cut -d: -f1)
        echo "   Group '$GROUP_NAME' already exists with ID $SOCKET_GID"
    else
        GROUP_NAME=docker-host
        groupadd -g "$SOCKET_GID" "$GROUP_NAME"
        echo "   Created dynamic group '$GROUP_NAME' with GID $SOCKET_GID"
    fi

    usermod -aG "$GROUP_NAME" node
    echo "   Added 'node' user to group '$GROUP_NAME'"
else
    echo "⚠️  No Docker socket found. Running without Docker control."
fi

# Fix Data Permissions
chown -R node:node /data
echo "✅ Permissions fixed for /data"

# --- Configuration Management ---
DEFAULTS_DIR="/usr/local/share/smart-term/defaults"
CONFIG_DIR="/usr/local/share/smart-term/config"
USER_BASHRC="/home/node/.bashrc"

mkdir -p "$CONFIG_DIR"

# Starship Config
echo "🌱 Seeding default Starship config..."
cp "$DEFAULTS_DIR/starship.default.toml" "$CONFIG_DIR/starship.toml"

# .bashrc Injection
if ! grep -q "Tools Init" "$USER_BASHRC"; then
    echo "⚙️  Injecting shell environment..."
    cat "$DEFAULTS_DIR/bashrc.default" >> "$USER_BASHRC"
    echo 'export TS_SOCKET=/var/run/tailscale/tailscaled.sock' >> "$USER_BASHRC"
else
    echo "⚙️  Shell environment already configured."
fi

# Ensure 'node' user can read these files
chmod -R 755 /usr/local/share/smart-term

# --- tailscale setup ---
if [ -n "$TAILSCALE_AUTH_KEY" ]; then
    echo "🔗 Starting Tailscale..."
    tailscaled --tun=userspace-networking --socket=/var/run/tailscale/tailscaled.sock &
    sleep 3
    TS_HOSTNAME="$(hostname)"
    tailscale up --authkey="${TAILSCALE_AUTH_KEY}" --hostname="${TS_HOSTNAME}" --ssh --operator=node
    echo "✅ Tailscale started. Hostname: $TS_HOSTNAME"
else
    echo "⚠️  TAILSCALE_AUTH_KEY not found. Skipping Tailscale start."
fi

# Handover to application
echo "🚀 Starting application..."
export TS_SOCKET=/var/run/tailscale/tailscaled.sock
exec dumb-init -- gosu node "$@"
