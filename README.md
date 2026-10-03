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
├── dev-launch.sh      # Dev helper: install + nested shell
├── seed.js            # Generate 12 weeks of fake history for testing
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

### Option 1: Symlink (recommended for development)

```bash
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/habbitpop@hritikdev"
mkdir -p "$EXT_DIR/src"
ln -sf "$(pwd)/metadata.json"  "$EXT_DIR/metadata.json"
ln -sf "$(pwd)/extension.js"   "$EXT_DIR/extension.js"
ln -sf "$(pwd)/stylesheet.css" "$EXT_DIR/stylesheet.css"
ln -sf "$(pwd)/src"            "$EXT_DIR/src"
```

### Option 2: Copy with dev script

```bash
./dev-launch.sh
```

This copies all files and launches a nested GNOME Shell for testing.

### Enable

```bash
gnome-extensions enable habbitpop@hritikdev
```

Then **log out and back in** (Wayland) or press **Alt+F2 → r** (X11).

---

## Testing

### Nested Wayland session (recommended)

```bash
./dev-launch.sh
```

Opens a new nested GNOME Shell window. Click the clock to test.

### With seed data (heatmap testing)

```bash
# Option A: run seed script directly
gjs seed.js

# Option B: via env flag (extension seeds on enable)
HABBITPOP_SEED=1 ./dev-launch.sh --seed
```

### View logs

```bash
# Follow GNOME Shell logs filtered to HabbitPop
journalctl -f -o cat _COMM=gnome-shell | grep HabbitPop

# Or all GNOME Shell JS errors
journalctl -f -o cat /usr/bin/gnome-shell
```

### Reload after code changes (Wayland)

Log out and log back in, or restart the nested session.

```bash
# Disable and re-enable (picks up stylesheet changes):
gnome-extensions disable habbitpop@hritikdev
gnome-extensions enable habbitpop@hritikdev
```

---

## Development notes

- **GNOME Shell 50.1** on Ubuntu 26.04 LTS
- ESM module format (`import`/`export`) — required for GNOME 45+
- `stylesheet.css` uses the GNOME CSS subset (no `grid`, no `fr` units, no `calc()` with complex expressions, no `var()`)
- All widgets are `St.*` / `Clutter.*` — no HTML/web technology
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
