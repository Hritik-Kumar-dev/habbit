#!/usr/bin/env bash
# dev-launch.sh — Install + test HabbitPop in a nested GNOME Shell session
#
# Usage:
#   ./dev-launch.sh            # install (symlinks) + launch nested Wayland session
#   ./dev-launch.sh --seed     # same but also seed 12 weeks of fake heatmap data
#   ./dev-launch.sh --logs     # tail GNOME Shell logs (HabbitPop lines only)
#   ./dev-launch.sh --uninstall

set -euo pipefail

EXTENSION_UUID="habbitpop@hritikdev"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Colour helpers ──────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${CYAN}[habbitpop]${NC} $*"; }
success() { echo -e "${GREEN}[habbitpop]${NC} $*"; }
warn()    { echo -e "${YELLOW}[habbitpop]${NC} $*"; }
error()   { echo -e "${RED}[habbitpop]${NC} $*" >&2; }

# ── Install via symlinks ──────────────────────────────────────────────────────
install_extension() {
    info "Installing extension → $EXTENSION_DIR"

    # Always start fresh — remove whatever is there (symlinks or real files)
    rm -rf "$EXTENSION_DIR"
    mkdir -p "$EXTENSION_DIR"

    # Symlink individual top-level files
    ln -sf "$SCRIPT_DIR/metadata.json"  "$EXTENSION_DIR/metadata.json"
    ln -sf "$SCRIPT_DIR/extension.js"   "$EXTENSION_DIR/extension.js"
    ln -sf "$SCRIPT_DIR/stylesheet.css" "$EXTENSION_DIR/stylesheet.css"

    # Symlink the src directory itself (not inside a pre-created src/)
    ln -sf "$SCRIPT_DIR/src" "$EXTENSION_DIR/src"

    success "Symlinks created:"
    ls -la "$EXTENSION_DIR/"
}

# ── Uninstall ─────────────────────────────────────────────────────────────────
uninstall_extension() {
    info "Uninstalling $EXTENSION_UUID …"
    rm -rf "$EXTENSION_DIR"
    success "Extension directory removed."
    info "Data kept at: ~/.local/share/$EXTENSION_UUID/"
    info "Log out and back in to fully reload GNOME Shell."
    exit 0
}

# ── Logs ──────────────────────────────────────────────────────────────────────
show_logs() {
    info "Tailing GNOME Shell logs filtered to HabbitPop (Ctrl+C to stop)…"
    journalctl -f -o cat _COMM=gnome-shell 2>/dev/null \
        | grep --line-buffered -E '\[HabbitPop\]|habbitpop|HabbitPop|JS ERROR|Extension error' \
        || journalctl -f -o cat /usr/bin/gnome-shell \
        | grep --line-buffered -E '\[HabbitPop\]|habbitpop|HabbitPop|JS ERROR'
    exit 0
}

# ── Parse args ────────────────────────────────────────────────────────────────
SEED=""
for arg in "$@"; do
    case "$arg" in
        --seed)      SEED="1" ;;
        --logs)      show_logs ;;
        --uninstall) uninstall_extension ;;
        *) warn "Unknown arg: $arg" ;;
    esac
done

# ── Seed data if requested ────────────────────────────────────────────────────
if [ -n "$SEED" ]; then
    info "Seeding 12 weeks of fake history…"
    gjs -m "$SCRIPT_DIR/seed.js"
fi

# ── Install ───────────────────────────────────────────────────────────────────
install_extension

# ── Launch nested shell ───────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW} How to test HabbitPop${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  A nested GNOME Shell window is about to open."
echo ""
echo "  1. Wait for it to fully load (~5 seconds)"
echo "  2. Enable the extension in the nested shell:"
echo ""
echo -e "     ${GREEN}gnome-extensions enable habbitpop@hritikdev${NC}"
echo ""
echo "     (Run this from another terminal, NOT this one)"
echo ""
echo "  3. Click the clock in the nested shell's top bar"
echo "  4. HabbitPop should replace the calendar popover"
echo ""
echo "  To view logs while testing (another terminal):"
echo -e "     ${CYAN}./dev-launch.sh --logs${NC}"
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
info "Launching nested GNOME Shell on Wayland…"

# Export seed flag for the extension to pick up if needed
[ -n "$SEED" ] && export HABBITPOP_SEED=1

# Launch nested session — the new process will see the extension dir we just set up
dbus-run-session -- gnome-shell --nested --wayland 2>&1 \
    | grep -E --line-buffered 'HabbitPop|habbitpop|JS ERROR|Extension error|Gjs-CRITICAL' \
    || true

info "Nested shell exited."
