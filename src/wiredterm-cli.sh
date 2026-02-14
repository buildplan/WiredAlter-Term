#!/bin/sh

WT_VERSION=${WIREDTERM_VERSION:-"unknown"}
REPO="buildplan/wiredalter-term"

C_RESET='\033[0m'
C_CYAN='\033[1;36m'
C_GREEN='\033[1;32m'
C_RED='\033[1;31m'
C_YELLOW='\033[1;33m'
C_BLUE='\033[1;34m'
C_GRAY='\033[1;30m'

check_update() {
    printf "\n%bChecking for updates...%b\n" "$C_CYAN" "$C_RESET"

    if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
        printf "%bCannot check updates: 'curl' or 'jq' missing.%b\n" "$C_RED" "$C_RESET"
        return
    fi

    API_RESPONSE=$(curl -m 5 -s "https://api.github.com/repos/$REPO/tags")

    LATEST_TAG=$(printf "%s" "$API_RESPONSE" | jq -r 'if type=="array" then .[0].name else empty end' 2>/dev/null)

    if [ -z "$LATEST_TAG" ]; then
        printf "%bUnable to check for updates (API limit or network issue).%b\n" "$C_RED" "$C_RESET"
        return
    fi

    if [ "$WT_VERSION" = "$LATEST_TAG" ]; then
        printf "✨ You are up to date! (%b%s%b)\n" "$C_GREEN" "$WT_VERSION" "$C_RESET"
    else
        is_dev=0
        case "$WT_VERSION" in
            dev*|main|unknown) is_dev=1 ;;
        esac

        if [ "$is_dev" -eq 1 ]; then
            printf "⚠️  Running development build (%b%s%b). Latest stable release is %b%s%b.\n" \
                "$C_YELLOW" "$WT_VERSION" "$C_RESET" \
                "$C_GREEN" "$LATEST_TAG" "$C_RESET"
        else
            printf "🔔 %bUpdate Available!%b\n" "$C_YELLOW" "$C_RESET"
            printf "You are running %b%s%b. The latest is %b%s%b.\n" \
                "$C_RED" "$WT_VERSION" "$C_RESET" \
                "$C_GREEN" "$LATEST_TAG" "$C_RESET"
            printf "Run: %bdocker compose pull && docker compose up -d%b\n" "$C_GRAY" "$C_RESET"
        fi
    fi
}

show_version() {
    printf "%b💻 WiredTerm%b version %b%s%b\n" "$C_CYAN" "$C_RESET" "$C_GREEN" "$WT_VERSION" "$C_RESET"
    check_update
}

check_tool() {
    tool="$1"
    if command -v "$tool" >/dev/null 2>&1; then
        VER=""
        case "$tool" in
            tmux) VER=$(tmux -V) ;;
            tailscale) VER=$(tailscale version 2>/dev/null | head -n 1) ;;
            node) VER=$(node -v) ;;
            starship) VER=$(starship --version | head -n 1 | awk '{print $2}') ;;
            bash) VER=$(bash --version | head -n 1) ;;
            docker) VER=$(docker --version | awk '{print $3}' | tr -d ',') ;;
            *) VER=$("$tool" --version 2>/dev/null | head -n 1) ;;
        esac
        if [ -z "$VER" ]; then VER="Detected"; fi
        printf "%b%-15s%b %s\n" "$C_GREEN" "$tool" "$C_RESET" "$VER"
    else
        printf "%b%-15s%b Not installed\n" "$C_RED" "$tool" "$C_RESET"
    fi
}

show_tools() {
    printf "%b🛠️  WiredTerm Installed Tools:%b\n" "$C_BLUE" "$C_RESET"
    printf '%s\n' "------------------------------------------------"
    check_tool "node"
    check_tool "tmux"
    check_tool "tailscale"
    check_tool "starship"
    check_tool "bash"
    check_tool "docker"
    check_tool "jq"
    check_tool "eza"
    check_tool "bat"
    printf '%s\n' "------------------------------------------------"
}

show_info() {
    printf "%bℹ️  WiredTerm System Info:%b\n" "$C_BLUE" "$C_RESET"
    printf '%s\n' "------------------------------------------------"

    if [ -f /etc/os-release ]; then
        OS_NAME=$(grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '"')
    else
        OS_NAME="Unknown Linux"
    fi

    printf "%b%-15s%b %s\n" "$C_GREEN" "OS" "$C_RESET" "$OS_NAME"
    printf "%b%-15s%b %s\n" "$C_GREEN" "Architecture" "$C_RESET" "$(uname -m)"
    printf "%b%-15s%b %s\n" "$C_GREEN" "Data Dir" "$C_RESET" "/data"

    UPTIME_VAL=$(uptime -p 2>/dev/null || uptime)
    printf "%b%-15s%b %s\n" "$C_GREEN" "Uptime" "$C_RESET" "$UPTIME_VAL"
    printf '%s\n' "------------------------------------------------"
}

case "$1" in
    -v|--version|version)
        show_version
        ;;
    --tools|tools)
        show_tools
        ;;
    --info|info)
        show_info
        ;;
    *)
        printf "%b💻 WiredTerm CLI%b\n\n" "$C_CYAN" "$C_RESET"
        printf "Usage: wiredterm [COMMAND]\n\n"
        printf "Commands:\n"
        printf "  version, -v     Show version and check for updates\n"
        printf "  tools, --tools  List installed backend tools & versions\n"
        printf "  info, --info    Display system & container information\n"
        ;;
esac
