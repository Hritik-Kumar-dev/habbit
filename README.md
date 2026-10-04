# PULSE

A GNOME Shell extension for Ubuntu 26.04 / GNOME Shell 50.

Adds its own top-bar indicator (heartbeat icon + "7/9" progress label). Clicking it opens a compact popover — daily habit checklist + 12-week heatmap. The native date/time calendar and notifications are completely untouched.

---

## Architecture

```
pulse@hritikdev/
├── extension.js          # Entry point — PanelMenu.Button indicator, FileMonitor
├── metadata.json         # uuid: pulse@hritikdev, shell-version: ["50"]
├── stylesheet.css        # Dark charcoal theme (GNOME CSS subset)
├── src/
│   ├── storage.js        # Data layer: atomic JSON, schema v2, migration
│   ├── taskManager.js    # Business logic: rollover, states, heatmap data
│   ├── pulsePopover.js   # Popover UI: header + task list + heatmap + bottom bar
│   └── heatmap.js        # Heatmap grid widget (St.Widget cells)
├── apps/
│   ├── settings.js       # GTK4/Adwaita settings window (add/edit/delete habits)
│   └── report.js         # GTK4 full-screen monthly report with Cairo charts
├── dev-launch.sh         # Headless shell for testing
├── seed.js               # Generate 12 weeks of fake history
├── tests/
│   ├── test-storage.js   # 33 unit tests for storage layer
│   └── test-taskManager.js # 43 unit tests for business logic
└── README.md
```

### How it hooks into the shell

**Does not touch the native DateMenu.** Adds its own `PanelMenu.Button` via `Main.panel.addToStatusArea('pulse', indicator)`. The indicator's `menu.box` hosts the `PulsePopover` widget directly. `disable()` calls `indicator.destroy()` — nothing else to clean up.

### Popover layout (single column, ~480px wide)

```
┌──────────────────────────────────┐
│  PULSE    Sun, Oct 5   7/9 · 78% │  header
├──────────────────────────────────┤
│  ● Morning exercise  07:00–07:30 │  task list
│  ○ Read 30 min       08:30–09:00 │  (scrollable, max 260px)
│  …                               │
├──────────────────────────────────┤
│  [12-week heatmap]               │  compact heatmap
│  Less ░▒▓█ More                  │  legend
├──────────────────────────────────┤
│  [ ⚙ Settings ]  [ 📊 Report ]   │  bottom bar
└──────────────────────────────────┘
```

### Data format (v2)

```json
{
  "version": 2,
  "tasks": [
    {
      "id": "t_1727982000000_123456",
      "title": "Morning exercise",
      "from": "07:00",
      "to":   "07:30",
      "type": "habit",
      "repeat": "daily",
      "createdAt": "2026-10-01T00:00:00.000Z"
    }
  ],
  "days": {
    "2026-10-03": {
      "date": "2026-10-03",
      "tasks": [
        {
          "taskId": "t_1727982000000_123456",
          "title": "Morning exercise",
          "from": "07:00",
          "to":   "07:30",
          "completed": true,
          "completedAt": "2026-10-03T07:23:00.000Z"
        }
      ],
      "completionPct": 78
    }
  }
}
```

### Migration from HabbitPop (v1 → v2)

On first enable, `storage.migrateFromHabbitpop()` runs:
- Copies `~/.local/share/habbitpop@hritikdev/data.json` → `pulse@hritikdev/`
- Maps `time` → `from`, sets `to = from + 30 min`
- Old dir is left intact as a backup

### Task states

| State | Condition |
|-------|-----------|
| `upcoming`  | now < from |
| `current`   | from ≤ now < to |
| `missed`    | now ≥ to, not completed |
| `completed` | `completed === true` |

### Heatmap levels

| Level | % |
|-------|---|
| 0 | 0% |
| 1 | 1–33% |
| 2 | 34–66% |
| 3 | 67–99% |
| 4 | 100% |

### Live refresh (FileMonitor)

`extension.js` watches `data.json` with `Gio.FileMonitor`. When `apps/settings.js` or `apps/report.js` write changes, the extension reloads storage and re-emits `tasks-changed` — the popover updates without reopening.

---

## Install

```bash
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/pulse@hritikdev"
rm -rf "$EXT_DIR" && mkdir -p "$EXT_DIR"
ln -sf "$(pwd)/metadata.json"  "$EXT_DIR/metadata.json"
ln -sf "$(pwd)/extension.js"   "$EXT_DIR/extension.js"
ln -sf "$(pwd)/stylesheet.css" "$EXT_DIR/stylesheet.css"
ln -sf "$(pwd)/src"            "$EXT_DIR/src"
ln -sf "$(pwd)/apps"           "$EXT_DIR/apps"
```

Or use `./dev-launch.sh` which does this automatically.

**Then log out and back in**, then:
```bash
gnome-extensions enable pulse@hritikdev
```

---

## Testing

### Headless session (no logout needed)

```bash
./dev-launch.sh          # installs + launches headless shell
./dev-launch.sh --seed   # also seeds 12 weeks of fake data
./dev-launch.sh --logs   # tail logs in another terminal
```

`gnome-shell --nested` was removed in GNOME 45. This script uses `--headless --virtual-monitor 1920x1080` on a private dbus-daemon session.

### Seed heatmap data

```bash
gjs -m seed.js    # always works
./seed.js         # via shebang (chmod +x already set)
```

### Unit tests (no display needed)

```bash
gjs -m tests/test-storage.js
gjs -m tests/test-taskManager.js
```

```
test-storage.js:     33 passed, 0 failed
test-taskManager.js: 43 passed, 0 failed
```

### Run apps standalone

```bash
gjs -m apps/settings.js   # Settings window
gjs -m apps/report.js     # Monthly report
```

### View logs

```bash
journalctl -f -o cat _COMM=gnome-shell | grep PULSE
```

---

## Development notes

- **GNOME Shell 50.1** on Ubuntu 26.04 LTS
- ESM format (`import`/`export`) — required for GNOME 45+
- GNOME CSS subset: no `grid`, no `fr`, no `var()`, no `border-radius: %`
- `St.ScrollView.child` requires `StScrollable` — wrap `St.Widget` in `St.BoxLayout`
- `Clutter.Actor.raise_top()` removed in GNOME 45 — don't use it
- Atomic writes: `.tmp` file then `GLib.rename()`
- Data dir: `~/.local/share/pulse@hritikdev/data.json`

### Future scope

- Streaks counter
- Notifications at habit start time
- Keyboard shortcut to open popover
- iCloud/Nextcloud sync
- Widget for lock screen

---

## Uninstall

```bash
./dev-launch.sh --uninstall
# log out / back in
```

Data is preserved at `~/.local/share/pulse@hritikdev/`. Remove manually if desired:
```bash
rm -rf ~/.local/share/pulse@hritikdev
```
