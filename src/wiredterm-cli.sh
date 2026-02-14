#!/bin/bash

WT_VERSION=${WIREDTERM_VERSION:-"unknown"}
REPO="buildplan/WiredAlter-Term"

check_update() {
    echo -e "\n\033[36mChecking for updates...\033[0m"

    # Fetch the latest stable tag from GitHub API
    LATEST_TAG=$(curl -s "https://api.github.com/repos/$REPO/tags" | grep '"name":' | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')

    if [ -z "$LATEST_TAG" ]; then
        echo -e "\033[1;31mUnable to check for updates (API limit or network issue).\033[0m"
        return
    fi

    if [ "$WT_VERSION" == "$LATEST_TAG" ]; then
        echo -e "✨ You are up to date! (\033[1;32m$WT_VERSION\033[0m)"
    elif [ "$WT_VERSION" == "unknown" ] || [ "$WT_VERSION" == "main" ] || [[ "$WT_VERSION" == dev* ]]; then
        echo -e "⚠️  Running development build (\033[1;33m$WT_VERSION\033[0m). Latest stable release is \033[1;32m$LATEST_TAG\033[0m."
    else
        echo -e "🔔 \033[1;33mUpdate Available!\033[0m"
        echo -e "You are running \033[1;31m$WT_VERSION\033[0m. The latest is \033[1;32m$LATEST_TAG\033[0m."
        echo -e "Run: \033[1;30mdocker compose pull && docker compose up -d\033[0m"
    fi
}

show_version() {
    echo -e "\033[1;36m💻 WiredTerm\033[0m version \033[1;32m$WT_VERSION\033[0m"
    check_update
}

show_tools() {
    echo -e "\033[1;34m🛠️  WiredTerm Installed Tools:\033[0m"
    echo "------------------------------------------------"

    check_tool() {
        if command -v "$1" >/dev/null 2>&1; then
            if [ "$1" == "tmux" ]; then VER=$(tmux -V);
            elif [ "$1" == "tailscale" ]; then VER=$(tailscale version | head -n 1);
            elif [ "$1" == "node" ]; then VER=$(node -v);
            elif [ "$1" == "starship" ]; then VER=$(starship --version | head -n 1 | awk '{print $2}');
            else VER=$($1 --version 2>/dev/null | head -n 1); fi
            printf "\033[1;32m%-15s\033[0m %s\n" "$1" "$VER"
        else
            printf "\033[1;31m%-15s\033[0m Not installed\n" "$1"
        fi
    }

    check_tool "node"
    check_tool "tmux"
    check_tool "tailscale"
    check_tool "starship"
    check_tool "bash"
    check_tool "docker"

    echo "------------------------------------------------"
}

case "$1" in
    -v|--version|version)
        show_version
        ;;
    --tools|tools)
        show_tools
        ;;
    *)
        echo -e "\033[1;36m💻 WiredTerm CLI\033[0m"
        echo "Usage: wiredterm [COMMAND]"
        echo ""
        echo "Commands:"
        echo "  version, -v     Show version and check for updates"
        echo "  tools, --tools  List installed backend tools & versions"
        ;;
esac
