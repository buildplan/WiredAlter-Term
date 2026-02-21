#!/bin/sh

# --- Docker Connection Logic ---
if [ -n "$DOCKER_HOST" ]; then
    # MODE 1: Socket Proxy
    echo "🛡️  Using Secure Docker Socket Proxy at $DOCKER_HOST"
elif [ -S /var/run/docker.sock ]; then
    # MODE 2: Raw Socket (Legacy/High Risk)
    SOCKET_GID=$(stat -c '%g' /var/run/docker.sock)
    echo "🔌 Detected Raw Host Docker GID: $SOCKET_GID"

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
    echo "⚠️  WARNING: Running with raw socket access. This container has root access to the host."
else
    # MODE 3: No Docker
    echo "⚠️  No Docker connection configured (No DOCKER_HOST or docker.sock found)."
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

# tmux Config
echo "🌱 Seeding default Tmux config..."
cp "$DEFAULTS_DIR/tmux.conf" "$CONFIG_DIR/tmux.conf"

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
    LOGIN_SERVER_ARG=""
    if [ -n "$TAILSCALE_LOGIN_SERVER" ]; then
        echo "   🎯 Custom Control Plane: $TAILSCALE_LOGIN_SERVER"
        LOGIN_SERVER_ARG="--login-server=${TAILSCALE_LOGIN_SERVER}"
    fi
    TS_EXTRA_FLAGS=${TAILSCALE_FLAGS:-"--ssh"}
    echo "   Using Flags: $TS_EXTRA_FLAGS"
    tailscale up --authkey="${TAILSCALE_AUTH_KEY}" \
                 --hostname="${TS_HOSTNAME}" \
                 --operator=node \
                 $LOGIN_SERVER_ARG \
                 $TS_EXTRA_FLAGS

    echo "✅ Tailscale started. Hostname: $TS_HOSTNAME"
else
    echo "⚠️  TAILSCALE_AUTH_KEY not found. Skipping Tailscale start."
fi

# Handover to application
echo "🚀 Starting application..."
export TS_SOCKET=/var/run/tailscale/tailscaled.sock
exec dumb-init -- gosu node "$@"
