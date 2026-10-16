/**
 * heatmap.js — HabbitPop GitHub-style activity heatmap
 *
 * Renders a 12-week × 7-day grid using St.Widget cells (not Cairo).
 * 5 discrete levels (0–4) mapped to CSS classes for color.
 * Today's cell gets a distinct outline/glow.
 * Hover shows a tooltip with date + completion info.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

// Cell size and gap (px)
const CELL_SIZE = 12;
const CELL_GAP  = 3;
const CELL_STEP = CELL_SIZE + CELL_GAP;

// Month abbreviations
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Day abbreviations, indexed by grid row (Mon=0 … Sun=6).
// Only Mon/Wed/Fri are shown, for compactness.
const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

/**
 * Format a "YYYY-MM-DD" string to "Month Day" e.g. "October 3"
 */
function _formatDateDisplay(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

export const Heatmap = GObject.registerClass(
class Heatmap extends St.Widget {
    /**
     * @param {object[]} data  Array from taskManager.getHeatmapData()
     */
    _init(data) {
        super._init({
            style_class: 'hp-heatmap',
        });

        this._data  = data;
        this._cells = [];

        // ONE persistent tooltip label — created once, repositioned on hover.
        // Never destroyed/recreated during hover — that was the flicker root cause.
        this._tooltip = new St.Label({ style_class: 'hp-tooltip' });
        this._tooltip.hide();
        // Will be added to parent after _build() so it renders on top.
        this._tooltipAdded = false;

        // Track whether a rebuild is in progress so stale hover signals are ignored.
        this._rebuilding = false;

        this._build();
    }

    /**
     * Replace data and re-render. Only called on data changes, never on hover.
     *
     * Bug fix: before destroying children we set _rebuilding = true so that any
     * notify::hover signal that fires on a cell that is mid-destroy (a real
     * occurrence when the user is hovering while tasks-changed fires) becomes a
     * no-op instead of calling get_position() on a destroyed St.Widget — which
     * was the root cause of the crash / session logout.
     *
     * @param {object[]} data
     */
    update(data) {
        this._data = data;

        // Disconnect all hover signal handlers before destroying cells.
        // This prevents stale notify::hover callbacks from firing on destroyed
        // actors, which crashed the GNOME Shell process and logged out the user.
        this._rebuilding = true;
        for (const { cell, handlerId } of this._cells) {
            try {
                if (handlerId && cell)
                    cell.disconnect(handlerId);
            } catch (_) {}
        }
        this._cells = [];

        this.destroy_all_children();
        this._tooltipAdded = false;
        this._tooltip.hide();

        this._rebuilding = false;
        this._build();
    }

    _build() {
        // data is sorted oldest→newest (84 items = 12 weeks)
        // We need to figure out how many columns (weeks) we have
        // and which day-of-week each entry falls on.

        // The heatmap grid: rows = day-of-week (Mon=0 top … Sun=6 bottom)
        // Wait — standard GitHub style: rows Mon–Sun, cols = weeks left→right.
        // day of week: JS: 0=Sun,1=Mon...6=Sat
        // We display: row 0=Mon(1)...row 5=Sat(6), row 6=Sun(0)
        // So rowForDOW: DOW → row index
        // Mon=1→0, Tue=2→1, Wed=3→2, Thu=4→3, Fri=5→4, Sat=6→5, Sun=0→6

        const numEntries = this._data.length;
        const weeks = Math.ceil(numEntries / 7);

        // Day-label column width
        const labelColW = 28;

        // Month labels row height
        const monthRowH = 16;

        // Total grid size
        const gridW = labelColW + weeks * CELL_STEP;
        const gridH = monthRowH + 7 * CELL_STEP;

        this.set_size(gridW, gridH);

        // Render month labels
        this._renderMonthLabels(labelColW, weeks);

        // Render day labels
        this._renderDayLabels(monthRowH);

        // Render cells
        this._renderCells(labelColW, monthRowH);
    }

    _renderMonthLabels(labelColW, weeks) {
        let lastMonth = -1;

        for (let col = 0; col < weeks; col++) {
            // Find the first entry in this column
            // columns are filled from left (oldest) to right (newest)
            // entry index for column col, first row
            const firstIdx = col * 7; // approx
            if (firstIdx >= this._data.length) break;

            const entry = this._data[firstIdx];
            const [, m] = entry.date.split('-').map(Number);
            const monthIdx = m - 1;

            if (monthIdx !== lastMonth) {
                lastMonth = monthIdx;
                const lbl = new St.Label({
                    text: MONTHS[monthIdx],
                    style_class: 'hp-month-label',
                });
                lbl.set_position(labelColW + col * CELL_STEP, 0);
                this.add_child(lbl);
            }
        }
    }

    _renderDayLabels(monthRowH) {
        for (let row = 0; row < 7; row++) {
            const text = DAY_LABELS[row];
            if (!text) continue;
            const lbl = new St.Label({
                text,
                style_class: 'hp-day-label',
            });
            lbl.set_position(0, monthRowH + row * CELL_STEP);
            this.add_child(lbl);
        }
    }

    _renderCells(labelColW, monthRowH) {
        const n = this._data.length;
        if (n === 0) return;

        const firstEntry = this._data[0];
        const [fy, fm, fd] = firstEntry.date.split('-').map(Number);
        const firstDOW = new Date(fy, fm - 1, fd).getDay();
        const dowToRow = (dow) => dow === 0 ? 6 : dow - 1;
        const startRow = dowToRow(firstDOW);

        for (let i = 0; i < n; i++) {
            const linearPos = startRow + i;
            const col = Math.floor(linearPos / 7);
            const row = linearPos % 7;

            const entry = this._data[i];
            const x = labelColW + col * CELL_STEP;
            const y = 16 + row * CELL_STEP;

            const cell = new St.Widget({
                style_class: `hp-cell hp-cell-l${entry.level}${entry.isToday ? ' hp-cell-today' : ''}`,
                reactive: true,
                track_hover: true,
                width: CELL_SIZE,
                height: CELL_SIZE,
            });
            cell.set_position(x, y);

            // Hover: update + reposition the ONE persistent tooltip.
            // Never create or destroy it here — that was the flicker root cause.
            //
            // Bug fix: store the signal handler ID so update() can disconnect it
            // before destroy_all_children().  The _rebuilding guard is a second
            // line of defence: if the OS delivers a queued notify::hover after
            // disconnect() but before destroy completes, we bail out immediately
            // instead of calling get_position() on a dead actor.
            const handlerId = cell.connect('notify::hover', () => {
                if (this._rebuilding) return;
                try {
                    if (cell.hover) {
                        this._showTooltip(cell, entry);
                    } else {
                        this._tooltip.hide();
                    }
                } catch (_) {
                    // Ignore hover errors — never crash the shell
                }
            });

            this.add_child(cell);
            this._cells.push({ cell, entry, handlerId });
        }

        // Add tooltip last so it renders above all cells.
        // Only add once per build.
        if (!this._tooltipAdded) {
            this.add_child(this._tooltip);
            this._tooltipAdded = true;
        }
    }

    _showTooltip(cell, entry) {
        // Guard: cell or entry could be stale if update() was called mid-hover.
        // is_finalized() returns true when the underlying GObject has been freed;
        // calling any method on it after that point crashes the GNOME Shell process.
        if (!cell || !entry) return;
        if (cell.is_finalized?.()) return;
        try {
            const completed = (entry.tasks || []).filter(t => t.completed).length;
            const total     = (entry.tasks || []).length;
            const pct       = entry.completionPct || 0;
            const dateStr   = _formatDateDisplay(entry.date);

            const text = total === 0
                ? `${dateStr} — No tasks`
                : `${dateStr} — ${completed} / ${total} completed · ${pct}%`;

            this._tooltip.set_text(text);
            const [cx, cy] = cell.get_position();
            // Position above the cell; if at top rows push below instead
            const tooltipY = cy < 28 ? cy + CELL_SIZE + 4 : cy - 24;
            this._tooltip.set_position(Math.max(0, cx), Math.max(0, tooltipY));
            this._tooltip.show();
        } catch (_) {
            // Never crash the shell over a tooltip
        }
    }
});
