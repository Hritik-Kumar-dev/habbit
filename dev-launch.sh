#!/usr/bin/env bash
# dev-launch.sh — Install + test HabbitPop in a headless GNOME Shell session
#
# GNOME 50 dropped --nested. Use --headless --virtual-monitor instead.
# A new dbus-daemon session is required so the headless shell doesn't collide
# with your running desktop session.
#
# Usage:
#   ./dev-launch.sh            # install symlinks + launch headless shell
#   ./dev-launch.sh --seed     # same but also seed 12 weeks of fake heatmap data
#   ./dev-launch.sh --logs     # tail live GNOME Shell logs (existing session)
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

# ── Install via symlinks ───────────────────────────────────────────────────────
install_extension() {
    info "Installing extension → $EXTENSION_DIR"
    # Always start clean so repeated runs never leave stale files or nested symlinks
    rm -rf "$EXTENSION_DIR"
    mkdir -p "$EXTENSION_DIR"

    ln -sf "$SCRIPT_DIR/metadata.json"  "$EXTENSION_DIR/metadata.json"
    ln -sf "$SCRIPT_DIR/extension.js"   "$EXTENSION_DIR/extension.js"
    ln -sf "$SCRIPT_DIR/stylesheet.css" "$EXTENSION_DIR/stylesheet.css"
    ln -sf "$SCRIPT_DIR/src"            "$EXTENSION_DIR/src"

    success "Symlinks ready."
}

# ── Uninstall ──────────────────────────────────────────────────────────────────
uninstall_extension() {
    info "Uninstalling $EXTENSION_UUID …"
    rm -rf "$EXTENSION_DIR"
    success "Removed $EXTENSION_DIR"
    info "Data preserved at ~/.local/share/$EXTENSION_UUID/"
    info "Log out and back in for your desktop session to forget the extension."
    exit 0
}

# ── Logs ──────────────────────────────────────────────────────────────────────
show_logs() {
    info "Tailing GNOME Shell logs (Ctrl+C to stop)…"
    journalctl -f -o cat _COMM=gnome-shell 2>/dev/null \
        | grep --line-buffered -E '\[HabbitPop\]|habbitpop|HabbitPop|JS ERROR|Gjs-CRITICAL|Extension error'
    exit 0
}

# ── Parse args ─────────────────────────────────────────────────────────────────
SEED=""
for arg in "$@"; do
    case "$arg" in
        --seed)      SEED="1" ;;
        --logs)      show_logs ;;
        --uninstall) uninstall_extension ;;
        *) warn "Unknown argument: $arg (ignored)" ;;
    esac
done

# ── Seed data if requested ─────────────────────────────────────────────────────
if [ -n "$SEED" ]; then
    info "Seeding 12 weeks of fake history…"
    gjs -m "$SCRIPT_DIR/seed.js"
fi

# ── Install ────────────────────────────────────────────────────────────────────
install_extension

# ── Print instructions ─────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW} HabbitPop — headless test session${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo " The script will:"
echo "   1. Spin up a private D-Bus session (dbus-daemon --session)"
echo "   2. Start gnome-shell --headless --virtual-monitor 1920x1080"
echo "      (no screen needed — renders to /dev/null)"
echo "   3. Enable habbitpop@hritikdev via gdbus call"
echo "   4. Print the extension state and any errors"
echo ""
echo " To interact / log in a second terminal while this runs:"
echo -e "   ${CYAN}./dev-launch.sh --logs${NC}"
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Launch headless shell on a private D-Bus session ──────────────────────────

# Step 1: start a session-scoped dbus-daemon and capture its address
info "Starting private D-Bus daemon…"
DBUS_ADDR=$(dbus-daemon --session --fork --print-address 2>/dev/null)
if [ -z "$DBUS_ADDR" ]; then
    error "dbus-daemon failed to start."
    exit 1
fi
export DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR"
success "D-Bus address: $DBUS_ADDR"

# Extract PID from the dbus address so we can clean it up on exit
DBUS_PID=$(dbus-daemon --session --print-pid 2>/dev/null || true)

cleanup() {
    info "Shutting down headless session…"
    kill "$GNOME_SHELL_PID" 2>/dev/null || true
    # Kill dbus-daemon that owns this address
    pkill -f "dbus-daemon.*$DBUS_ADDR" 2>/dev/null || true
    info "Done."
}
trap cleanup EXIT INT TERM

# Export seed flag so the extension reads it on enable()
[ -n "$SEED" ] && export HABBITPOP_SEED=1

# Step 2: launch headless gnome-shell in the background
info "Launching gnome-shell --headless --virtual-monitor 1920x1080 …"
gnome-shell --headless --virtual-monitor 1920x1080 &
GNOME_SHELL_PID=$!

# Give the shell time to start and register its D-Bus services
info "Waiting for shell to register on D-Bus (~5s)…"
for i in $(seq 1 20); do
    sleep 0.5
    if gdbus introspect --session --dest org.gnome.Shell.Extensions \
        --object-path /org/gnome/Shell/Extensions >/dev/null 2>&1; then
        success "Shell is ready."
        break
    fi
    if [ $i -eq 20 ]; then
        error "Timed out waiting for gnome-shell D-Bus service."
        error "Check: journalctl -xe | grep gnome-shell"
        exit 1
    fi
done

# Step 3: enable the extension
info "Enabling habbitpop@hritikdev…"
RESULT=$(gdbus call --session \
    --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.EnableExtension \
    "habbitpop@hritikdev" 2>&1)
echo "  EnableExtension → $RESULT"

# Step 4: query extension state
sleep 1
info "Extension state:"
gdbus call --session \
    --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionInfo \
    "habbitpop@hritikdev" 2>&1 | python3 -c "
import sys, re
raw = sys.stdin.read()
# Pull out the 'state' value: 1=ENABLED, 2=DISABLED, 3=ERROR, 6=INITIALIZED
m = re.search(r\"'state'[^<]*<uint32 (\\d+)>\", raw)
states = {1:'ENABLED', 2:'DISABLED', 3:'ERROR ❌', 4:'OUT_OF_DATE', 5:'DOWNLOADING', 6:'INITIALIZED'}
if m:
    code = int(m.group(1))
    print(f'  State: {states.get(code, code)}')
else:
    print('  (Could not parse state from:', raw[:200], ')')
" 2>/dev/null || echo "  (python3 not available for state parsing)"

# Step 5: show errors if any
ERRORS=$(gdbus call --session \
    --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionErrors \
    "habbitpop@hritikdev" 2>&1)
if echo "$ERRORS" | grep -q "'\\|\""; then
    warn "Extension reported errors:"
    echo "$ERRORS"
else
    success "No extension errors reported."
fi

echo ""
info "Headless shell is running (PID $GNOME_SHELL_PID). Press Ctrl+C to stop."
info "In another terminal: ./dev-launch.sh --logs"
echo ""

# Keep script alive until Ctrl+C
wait "$GNOME_SHELL_PID" 2>/dev/null || true
