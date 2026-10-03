#!/usr/bin/env bash
# dev-launch.sh — Launch HabbitPop in a nested GNOME Shell session for testing
#
# Usage:
#   ./dev-launch.sh            # install + launch nested session
#   ./dev-launch.sh --seed     # install + seed fake data + launch
#   ./dev-launch.sh --logs     # just tail GNOME Shell logs (existing session)
#   ./dev-launch.sh --uninstall

set -euo pipefail

EXTENSION_UUID="habbitpop@hritikdev"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Colour helpers ──────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${CYAN}[habbitpop]${NC} $*"; }
success() { echo -e "${GREEN}[habbitpop]${NC} $*"; }
warn()    { echo -e "${YELLOW}[habbitpop]${NC} $*"; }
error()   { echo -e "${RED}[habbitpop]${NC} $*" >&2; }

# ── Install ─────────────────────────────────────────────────────────────────
install_extension() {
    info "Installing extension to $EXTENSION_DIR"
    mkdir -p "$EXTENSION_DIR/src"

    # Copy files
    cp "$SCRIPT_DIR/metadata.json"   "$EXTENSION_DIR/"
    cp "$SCRIPT_DIR/extension.js"    "$EXTENSION_DIR/"
    cp "$SCRIPT_DIR/stylesheet.css"  "$EXTENSION_DIR/"
    cp "$SCRIPT_DIR/src/"*.js        "$EXTENSION_DIR/src/"

    success "Extension files copied."
}

# ── Uninstall ────────────────────────────────────────────────────────────────
uninstall_extension() {
    info "Uninstalling $EXTENSION_UUID"
    gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null || true
    rm -rf "$EXTENSION_DIR"
    success "Uninstalled."
    exit 0
}

# ── Logs ─────────────────────────────────────────────────────────────────────
show_logs() {
    info "Tailing GNOME Shell logs (Ctrl+C to stop)..."
    journalctl -f -o cat /usr/bin/gnome-shell 2>/dev/null \
        | grep --line-buffered -E '\[HabbitPop\]|habbitpop|HabbitPop' \
        || journalctl -f -o cat _COMM=gnome-shell \
        | grep --line-buffered -E '\[HabbitPop\]|habbitpop|HabbitPop'
}

# ── Parse args ───────────────────────────────────────────────────────────────
SEED=""
for arg in "$@"; do
    case "$arg" in
        --seed)      SEED="1" ;;
        --logs)      show_logs; exit 0 ;;
        --uninstall) uninstall_extension ;;
        *)           warn "Unknown arg: $arg" ;;
    esac
done

# ── Main ─────────────────────────────────────────────────────────────────────
install_extension

# Check if inside Wayland or X11
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
    info "Wayland session detected."
    info "Launching nested GNOME Shell on Wayland (dbus-run-session)..."
    echo ""
    echo -e "${YELLOW}IMPORTANT${NC}: The nested shell opens in a new window."
    echo "  1. Click the clock in the top bar of the nested shell."
    echo "  2. You should see HabbitPop instead of the calendar."
    echo "  3. To view logs, run in another terminal:"
    echo "     journalctl -f -o cat _COMM=gnome-shell | grep HabbitPop"
    echo ""

    # Enable the extension inside the nested session via env
    export GNOME_SHELL_SLOWDOWN_FACTOR=2
    [ -n "$SEED" ] && export HABBITPOP_SEED=1

    dbus-run-session -- gnome-shell --nested --wayland 2>&1 | \
        grep -E 'HabbitPop|habbitpop|JS ERROR|Extension error' || true

elif [ -n "${DISPLAY:-}" ]; then
    info "X11 session detected."
    info "Reloading GNOME Shell on X11 (Alt+F2 → r is the interactive way)."
    info "Enabling extension and restarting shell process..."

    gnome-extensions enable "$EXTENSION_UUID" 2>/dev/null || true

    warn "On X11 you need to log out/in or press Alt+F2 and type 'r' to reload."
    warn "Or run: busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'global.reexec_self()'"
else
    error "No display found (WAYLAND_DISPLAY or DISPLAY not set)."
    error "Run this script from a desktop session."
    exit 1
fi
