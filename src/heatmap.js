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

        this._build();
    }

    /**
     * Replace data and re-render. Only called on data changes, never on hover.
     * @param {object[]} data
     */
    update(data) {
        this._data = data;
        this.destroy_all_children();
        this._cells = [];
        this._tooltipAdded = false;
        this._tooltip.hide();
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
            cell.connect('notify::hover', () => {
                if (cell.hover) {
                    this._showTooltip(cell, entry);
                } else {
                    this._tooltip.hide();
                }
            });

            this.add_child(cell);
            this._cells.push({ cell, entry });
        }

        // Add tooltip last so it renders above all cells.
        // Only add once per build.
        if (!this._tooltipAdded) {
            this.add_child(this._tooltip);
            this._tooltipAdded = true;
        }
    }

    _showTooltip(cell, entry) {
        const completed = entry.tasks.filter(t => t.completed).length;
        const total     = entry.tasks.length;
        const pct       = entry.completionPct;
        const dateStr   = _formatDateDisplay(entry.date);

        const text = total === 0
            ? `${dateStr} — No tasks`
            : `${dateStr} — ${completed} / ${total} completed · ${pct}%`;

        // Update text and position in place — no destroy, no re-add.
        this._tooltip.set_text(text);
        const [cx, cy] = cell.get_position();
        this._tooltip.set_position(cx, Math.max(0, cy - 24));
        this._tooltip.show();
    }
});
