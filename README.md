# HabbitPop

A GNOME Shell extension for Ubuntu 26.04 / GNOME Shell 50.

Replaces the default date/time calendar popover with a fast productivity dashboard:

- **Left (61.8%)**: Today's habits & todos — toggle completion, add/edit/delete tasks
- **Right (38.2%)**: GitHub-style heatmap of the last 12 weeks + daily summary

Click the clock in the top bar → instant "what do I do now, how consistent have I been" glance.

---

## Architecture

```
habbitpop@hritikdev/
├── extension.js       # Entry point — Extension class, popover injection
├── metadata.json      # Extension metadata (uuid, shell-version)
├── stylesheet.css     # All dark-theme styles (GNOME CSS subset)
├── src/
│   ├── storage.js     # Data layer: atomic JSON reads/writes, schema
│   ├── taskManager.js # Business logic: rollover, states, heatmap data
│   ├── leftPanel.js   # Today's habits/todos UI
│   ├── rightPanel.js  # Heatmap + summary UI
│   └── heatmap.js     # Heatmap grid widget
├── dev-launch.sh      # Dev helper: install + headless shell session
├── seed.js            # Generate 12 weeks of fake history for testing
├── tests/
│   ├── test-storage.js     # Unit tests for storage layer
│   └── test-taskManager.js # Unit tests for business logic
└── README.md
```

### Layer separation

```
extension.js (shell integration)
    └── HabbitPopLayout
            ├── LeftPanel  (src/leftPanel.js)
            └── RightPanel (src/rightPanel.js)
                    └── Heatmap (src/heatmap.js)

TaskManager (src/taskManager.js)
    └── Storage (src/storage.js)
              └── ~/.local/share/habbitpop@hritikdev/data.json
```

### Data format

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "t_1727982000000_123456",
      "title": "Morning exercise",
      "time": "07:00",
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
          "time": "07:00",
          "completed": true,
          "completedAt": "2026-10-03T07:23:00.000Z"
        }
      ],
      "completionPct": 78
    }
  }
}
```

**repeat** can be:
- `"none"` — single todo (shows every day until deleted)
- `"daily"` — appears every day
- `{ "weekdays": [1,2,3,4,5] }` — Mon–Fri (0=Sun, 1=Mon … 6=Sat)

**Task states** (computed at runtime, not stored):
| State | Condition |
|-------|-----------|
| `upcoming` | task time > now |
| `current` | task time ≤ now < time + 60 min |
| `missed` | task time + 60 min < now, not completed |
| `completed` | `completed === true` |

### Heatmap intensity levels

| Level | % completion |
|-------|-------------|
| 0 | 0% |
| 1 | 1–33% |
| 2 | 34–66% |
| 3 | 67–99% |
| 4 | 100% |

### Popover injection strategy

1. Locate `Main.panel.statusArea.dateMenu.menu.box`
2. Navigate to the `#calendarArea` hbox (bin → calendarArea)
3. **Hide** all existing children (calendar, message list)
4. **Inject** our `HabbitPopLayout` as a new child
5. On `disable()`: destroy our widget, **show** originals again

No method monkey-patching — only DOM manipulation. Fully reversible.

---

## Install

### Symlink into extensions dir (recommended for development)

```bash
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/habbitpop@hritikdev"
mkdir -p "$EXT_DIR"
ln -sf "$(pwd)/metadata.json"  "$EXT_DIR/metadata.json"
ln -sf "$(pwd)/extension.js"   "$EXT_DIR/extension.js"
ln -sf "$(pwd)/stylesheet.css" "$EXT_DIR/stylesheet.css"
ln -sf "$(pwd)/src"            "$EXT_DIR/src"
```

Or use the dev script (handles clean reinstall automatically):

```bash
./dev-launch.sh
```

### Enable in your live session

On Wayland, the running shell **only scans the extensions dir at startup** — `gnome-extensions enable` won't find a newly-installed extension in a running session. The options are:

1. **Log out and log back in** — GNOME Shell rescans on startup, then:
   ```bash
   gnome-extensions enable habbitpop@hritikdev
   ```
2. **Use the headless test session** (no logout needed, see Testing below).

---

## Testing

### Headless GNOME Shell session (no logout needed)

`gnome-shell --nested` was removed in GNOME 45. The correct dev workflow for GNOME 50 uses `--headless --virtual-monitor` on a private D-Bus session:

```bash
./dev-launch.sh
```

This script:
1. Installs extension symlinks (clean, idempotent)
2. Starts a `dbus-daemon --session` private bus
3. Launches `gnome-shell --headless --virtual-monitor 1920x1080`
4. Calls `gdbus EnableExtension habbitpop@hritikdev`
5. Reports extension state and any errors

To also seed 12 weeks of fake heatmap data first:

```bash
./dev-launch.sh --seed
```

### Seed data (heatmap testing)

```bash
# Run directly (always works):
gjs -m seed.js

# Or via shebang (after chmod +x seed.js):
./seed.js
```

> Note: bare `gjs seed.js` (without `-m`) does **not** work — ESM `import`
> requires module mode. Use `gjs -m` or the shebang invocation.

### Unit tests

```bash
gjs -m tests/test-storage.js
gjs -m tests/test-taskManager.js
```

Both run without a display, GNOME Shell, or any special setup. They use an
isolated temp directory and clean up after themselves.

```
test-storage.js:     33 passed, 0 failed
test-taskManager.js: 43 passed, 0 failed
```

### View logs

```bash
# In another terminal while dev-launch.sh is running:
./dev-launch.sh --logs

# Or directly:
journalctl -f -o cat _COMM=gnome-shell | grep HabbitPop
```

### After code changes

Since symlinks point directly at source files, just re-enable the extension in
the headless session — no copy step needed:

```bash
gdbus call --session \
  --dest org.gnome.Shell.Extensions \
  --object-path /org/gnome/Shell/Extensions \
  --method org.gnome.Shell.Extensions.ReloadExtension \
  "habbitpop@hritikdev"
```

Or stop and restart `dev-launch.sh`.

---

## Development notes

- **GNOME Shell 50.1** on Ubuntu 26.04 LTS
- ESM module format (`import`/`export`) — required for GNOME 45+
- `stylesheet.css` uses the GNOME CSS subset — no `grid`, no `fr` units,
  no `calc()` with complex expressions, no `var()`, no `border-radius: %`
- All widgets are `St.*` / `Clutter.*` — no HTML/web technology
- `St.ScrollView.child` requires an `StScrollable`; plain `St.Widget` is not
  scrollable — always wrap in `St.BoxLayout` first
- `Clutter.Actor.raise_top()` was removed in GNOME 45 — don't call it
- Storage: `~/.local/share/habbitpop@hritikdev/data.json`
- Atomic writes: write to `.tmp` then `GLib.rename()`

### Future scope (not in MVP)
- Streaks counter
- Weekly stats panel
- Task categories / tags
- Desktop notifications at task time
- Keyboard shortcuts (open popover, quick-add)
- GitHub contribution sync

---

## Uninstall

```bash
./dev-launch.sh --uninstall
# Then: log out / log in
```

Manual:
```bash
gnome-extensions disable habbitpop@hritikdev
rm -rf "$HOME/.local/share/gnome-shell/extensions/habbitpop@hritikdev"
# Data is kept at ~/.local/share/habbitpop@hritikdev/
# To also remove data:
rm -rf "$HOME/.local/share/habbitpop@hritikdev"
```
