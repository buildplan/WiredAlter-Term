#!/bin/sh

# Dynamic Docker Socket Permission
if [ -S /var/run/docker.sock ]; then
    SOCKET_GID=$(stat -c '%g' /var/run/docker.sock)
    echo "🔌 Detected Host Docker GID: $SOCKET_GID"

    if getent group $SOCKET_GID > /dev/null; then
        GROUP_NAME=$(getent group $SOCKET_GID | cut -d: -f1)
        echo "   Group '$GROUP_NAME' already exists with ID $SOCKET_GID"
    else
        GROUP_NAME=docker-host
        groupadd -g $SOCKET_GID $GROUP_NAME
        echo "   Created dynamic group '$GROUP_NAME' with GID $SOCKET_GID"
    fi

    usermod -aG $GROUP_NAME node
    echo "   Added 'node' user to group '$GROUP_NAME'"
else
    echo "⚠️  No Docker socket found. Running without Docker control."
fi

# Fix Data Permissions
chown -R node:node /data
echo "✅ Permissions fixed for /data"

# Generate Defaults
SEED_CONFIG_DIR="/usr/local/share/smart-term/config"
mkdir -p "$SEED_CONFIG_DIR"

echo "🌱 Generating default Starship config..."
cat <<EOF > "$SEED_CONFIG_DIR/starship.toml"
"\$schema" = 'https://starship.rs/config-schema.json'
add_newline = true

[character]
success_symbol = '[➜](bold green)'
error_symbol = '[✗](bold red)'

[os]
disabled = false
symbols.Debian = ' '

[docker_context]
symbol = ' '

[nodejs]
symbol = ' '
EOF

# Ensure 'node' user can read these files
chmod -R 755 /usr/local/share/smart-term

# Handover to application
echo "🚀 Starting application..."
exec dumb-init -- gosu node "$@"
