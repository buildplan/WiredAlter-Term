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
"$schema" = 'https://starship.rs/config-schema.json'

add_newline = true
scan_timeout = 30
command_timeout = 500

format = """
[░▒▓](#7aa2f7)\
[  ](bg:#7aa2f7 fg:#15161e)\
[](fg:#7aa2f7 bg:#3b4261)\
$hostname\
$directory\
[](fg:#3b4261 bg:#292e42)\
$git_branch\
$git_status\
[](fg:#292e42 bg:#1f2335)\
$cmd_duration\
$nodejs\
$rust\
$golang\
$php\
$python\
$docker_context\
[](fg:#1f2335)\
\n$character"""

[hostname]
ssh_only = true
ssh_symbol = "🌐 "
style = "fg:#c0caf5 bg:#3b4261"
format = "[ $ssh_symbol$hostname ]($style)"

[directory]
style = "fg:#c0caf5 bg:#3b4261"
format = "[ $path$read_only ]($style)"
truncation_length = 3
truncation_symbol = "…/"
read_only = " "

[directory.substitutions]
"Documents" = "󰈙 "
"Downloads" = " "
"Music" = " "
"Pictures" = " "

[git_branch]
symbol = ""
style = "fg:#7aa2f7 bg:#292e42"
format = "[ $symbol $branch ]($style)"

[git_status]
style = "fg:#bb9af7 bg:#292e42"
format = "[ $all_status$ahead_behind ]($style)"

[cmd_duration]
min_time = 2000
style = "fg:#bb9af7 bg:#1f2335"
format = "[ ⏱ $duration ]($style)"

[nodejs]
symbol = ""
style = "fg:#7aa2f7 bg:#1f2335"
format = "[ $symbol ($version) ]($style)"

[rust]
symbol = ""
style = "fg:#7aa2f7 bg:#1f2335"
format = "[ $symbol ($version) ]($style)"

[golang]
symbol = ""
style = "fg:#7aa2f7 bg:#1f2335"
format = "[ $symbol ($version) ]($style)"

[php]
symbol = ""
style = "fg:#7aa2f7 bg:#1f2335"
format = "[ $symbol ($version) ]($style)"

[python]
symbol = "🐍"
style = "fg:#7aa2f7 bg:#1f2335"
format = "[ $symbol ($version) ]($style)"

[docker_context]
symbol = " "
style = "fg:#7aa2f7 bg:#1f2335"
format = "[ $symbol $context ]($style)"

[character]
success_symbol = "[➜](bold #7aa2f7)"
error_symbol = "[✗](bold #f7768e)"
EOF

# Ensure 'node' user can read these files
chmod -R 755 /usr/local/share/smart-term

# Handover to application
echo "🚀 Starting application..."
exec dumb-init -- gosu node "$@"
