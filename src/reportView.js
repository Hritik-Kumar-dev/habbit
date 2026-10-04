/**
 * src/reportView.js — PULSE Monthly Dashboard
 *
 * Full report built with St widgets + Cairo (Clutter.Canvas).
 * Single source of truth: ReportData computes everything from storage.
 *
 * Sections (top → bottom):
 *   1. Header row: PULSE title | year/month selectors
 *   2. Trend row:  area/line chart (daily %)  |  donut (monthly %)
 *   3. Weekly overview: per-week bar chart + Completed/Goal/Left + progress bar
 *   4. Daily habit matrix: habit rows × day columns with ✓/□ cells
 *   5. Overall progress: per-habit bar rows
 *
 * All content scrolls vertically inside a single St.ScrollView.
 * Width is constrained to the popover width supplied from PulsePopover.
 */

import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

// ── Palette (matches stylesheet.css) ─────────────────────────────────────────
const P = {
    bg:     [0.067, 0.075, 0.094],
    panel:  [0.106, 0.118, 0.141],
    panel2: [0.125, 0.137, 0.165],
    border: [0.165, 0.180, 0.220],
    blue:   [0.294, 0.620, 1.000],
    blueD:  [0.118, 0.329, 0.549],
    purple: [0.486, 0.361, 0.749],
    text:   [0.949, 0.949, 0.949],
    muted:  [0.627, 0.643, 0.678],
    dim:    [0.353, 0.369, 0.408],
    green:  [0.204, 0.780, 0.349],
};

function rgb(cr, [r,g,b], a = 1) { cr.setSourceRGBA(r, g, b, a); }

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ── ReportData — single source of truth ──────────────────────────────────────

class ReportData {
    /**
     * @param {object} storage  Storage instance
     * @param {number} year
     * @param {number} month  0-based
     */
    constructor(storage, year, month) {
        this.year     = year;
        this.month    = month;
        this.tasks    = storage.getTasks();
        this.allDays  = storage.getAllDays();

        const nDays = new Date(year, month + 1, 0).getDate();
        this.nDays  = nDays;

        // Build array of day-objects for every day in the month
        this.days = [];
        for (let d = 1; d <= nDays; d++) {
            const key = this._key(year, month, d);
            const rec = this.allDays[key] || { tasks: [], completionPct: 0 };
            const completed = rec.tasks.filter(t => t.completed).length;
            const goal      = this._goalForDay(year, month, d);
            this.days.push({
                day:   d,
                dow:   new Date(year, month, d).getDay(), // 0=Sun
                key,
                rec,
                completed,
                goal,
                left: Math.max(0, goal - completed),
                pct:  goal > 0 ? Math.round(completed / goal * 100) : 0,
            });
        }

        // Split days into "calendar weeks" where each week starts where the
        // month's first week started (NOT Monday-aligned ISO weeks).
        // Week 1 = days 1..7 (or fewer if month starts mid-week from the
        // first day's DOW boundary), then groups of 7.
        this.weeks = this._buildWeeks();

        // Monthly totals
        this.monthCompleted = this.days.reduce((s, d) => s + d.completed, 0);
        this.monthGoal      = this.days.reduce((s, d) => s + d.goal, 0);
        this.monthPct       = this.monthGoal > 0
            ? Math.round(this.monthCompleted / this.monthGoal * 100) : 0;

        // Per-habit monthly stats
        this.habitStats = this._buildHabitStats();

        // Top 10 by completed count
        this.top10 = [...this.habitStats]
            .sort((a, b) => b.completed - a.completed)
            .slice(0, 10);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _key(y, m, d) {
        return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }

    /** Count how many times a habit applies during a given month. */
    _goalForDay(year, month, day) {
        const dow = new Date(year, month, day).getDay();
        return this.tasks.filter(t => this._taskApplies(t, dow)).length;
    }

    _taskApplies(task, dow) {
        if (!task.repeat || task.repeat === 'daily') return true;
        if (task.repeat === 'none') return true;
        if (typeof task.repeat === 'object' && Array.isArray(task.repeat.weekdays))
            return task.repeat.weekdays.includes(dow);
        return true;
    }

    /** Number of times a habit is expected in the selected month. */
    goalForHabit(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return 0;
        return this.days.filter(d => this._taskApplies(task, d.dow)).length;
    }

    /** Build calendar-week groups. Week = 7 contiguous days starting from day 1. */
    _buildWeeks() {
        const weeks = [];
        let i = 0;
        while (i < this.days.length) {
            weeks.push(this.days.slice(i, i + 7));
            i += 7;
        }
        return weeks;
    }

    /** Per-habit stats for the month. */
    _buildHabitStats() {
        return this.tasks.map(task => {
            let completed = 0;
            const goal = this.goalForHabit(task.id);
            for (const d of this.days) {
                const entry = d.rec.tasks.find(e => e.taskId === task.id);
                if (entry?.completed) completed++;
            }
            return {
                task,
                completed,
                goal,
                left: Math.max(0, goal - completed),
                pct:  goal > 0 ? Math.round(completed / goal * 100) : 0,
            };
        });
    }

    /** For a specific task on a specific day (1-based). */
    cellCompleted(taskId, day) {
        const d = this.days[day - 1];
        if (!d) return null;
        const entry = d.rec.tasks.find(e => e.taskId === taskId);
        if (!entry) {
            // Check if task applies that day at all
            const task = this.tasks.find(t => t.id === taskId);
            if (!task || !this._taskApplies(task, d.dow)) return null; // n/a
            return false; // applies but no record = not done
        }
        return entry.completed;
    }
}

// ── Cairo drawing area helper ─────────────────────────────────────────────────

function makeCanvas(w, h, drawFn) {
    const canvas = new Clutter.Canvas({ width: w, height: h });
    canvas.connect('draw', (_c, cr, _w, _h) => { drawFn(cr, w, h); return true; });

    const actor = new Clutter.Actor({ width: w, height: h });
    actor.content = canvas;
    canvas.invalidate();

    // Wrap in St.Widget so it integrates with St layout
    const wrapper = new St.Widget({ width: w, height: h });
    wrapper.add_child(actor);
    return { wrapper, canvas };
}

// ── Section header helper ─────────────────────────────────────────────────────

function sectionHeader(text) {
    const lbl = new St.Label({ text, style_class: 'rpt-section-header' });
    return lbl;
}

// ── 1. Header row ─────────────────────────────────────────────────────────────

function buildHeader(rd, onMonthChange) {
    const box = new St.BoxLayout({ style_class: 'rpt-header-row', x_expand: true });

    // Left: PULSE + subtitle
    const left = new St.BoxLayout({ vertical: true, style_class: 'rpt-header-left', x_expand: true });
    left.add_child(new St.Label({ text: 'PULSE', style_class: 'rpt-title-big' }));
    left.add_child(new St.Label({
        text: `${MONTHS[rd.month]} ${rd.year}`,
        style_class: 'rpt-title-month',
    }));
    box.add_child(left);

    // Right: year/month selectors
    const right = new St.BoxLayout({ style_class: 'rpt-selectors', vertical: true });

    // Year row
    const yearRow = new St.BoxLayout({ style_class: 'rpt-sel-row', spacing: 6 });
    yearRow.add_child(new St.Label({ text: 'YEAR', style_class: 'rpt-sel-label' }));

    const now = new Date();
    const years = [];
    // Show 3 years back, current, 1 ahead (or earliest year with data)
    const minYear = Math.min(rd.year - 2, now.getFullYear() - 2);
    for (let y = minYear; y <= now.getFullYear() + 1; y++) years.push(y);

    const yearBtns = years.map(y => {
        const b = new St.Button({
            label: String(y),
            style_class: y === rd.year ? 'rpt-sel-chip rpt-sel-chip-on' : 'rpt-sel-chip',
            can_focus: true,
        });
        b.connect('clicked', () => onMonthChange(y, rd.month));
        return b;
    });
    yearBtns.forEach(b => yearRow.add_child(b));
    right.add_child(yearRow);

    // Month row
    const monthRow = new St.BoxLayout({ style_class: 'rpt-sel-row', spacing: 4 });
    monthRow.add_child(new St.Label({ text: 'MONTH', style_class: 'rpt-sel-label' }));

    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    monthNames.forEach((m, i) => {
        const b = new St.Button({
            label: m,
            style_class: i === rd.month ? 'rpt-sel-chip rpt-sel-chip-on' : 'rpt-sel-chip',
            can_focus: true,
        });
        b.connect('clicked', () => onMonthChange(rd.year, i));
        monthRow.add_child(b);
    });
    right.add_child(monthRow);

    box.add_child(right);
    return box;
}

// ── 2a. Area/line chart (daily % trend) ──────────────────────────────────────

function buildTrendChart(rd, W) {
    const H = 120;
    const pad = { l: 36, r: 10, t: 10, b: 22 };
    const gw = W - pad.l - pad.r;
    const gh = H - pad.t - pad.b;

    const { wrapper, canvas } = makeCanvas(W, H, (cr) => {
        // Background
        rgb(cr, P.panel);
        _roundRect(cr, 0, 0, W, H, 8);
        cr.fill();

        const n = rd.days.length;
        if (n === 0) return;

        const xStep = n > 1 ? gw / (n - 1) : gw;

        const pts = rd.days.map((d, i) => ({
            x: pad.l + i * xStep,
            y: pad.t + (100 - d.pct) / 100 * gh,
            pct: d.pct,
            day: d.day,
        }));

        // Horizontal grid lines at 0%, 25%, 50%, 75%, 100%
        cr.setLineWidth(0.5);
        [0, 25, 50, 75, 100].forEach(p => {
            const y = pad.t + (100 - p) / 100 * gh;
            rgb(cr, P.border, 0.6);
            cr.moveTo(pad.l, y);
            cr.lineTo(pad.l + gw, y);
            cr.stroke();
            // Y label
            _text(cr, `${p}%`, 0, y - 5, 8, P.dim);
        });

        // Filled area
        cr.newPath();
        cr.moveTo(pts[0].x, pad.t + gh);
        pts.forEach(p => cr.lineTo(p.x, p.y));
        cr.lineTo(pts[pts.length - 1].x, pad.t + gh);
        cr.closePath();
        rgb(cr, P.blue, 0.12);
        cr.fill();

        // Line
        cr.newPath();
        cr.moveTo(pts[0].x, pts[0].y);
        pts.forEach(p => cr.lineTo(p.x, p.y));
        rgb(cr, P.blue, 0.9);
        cr.setLineWidth(1.5);
        cr.stroke();

        // Data points + x labels
        pts.forEach((p, i) => {
            // Circle
            cr.arc(p.x, p.y, 3, 0, 2 * Math.PI);
            rgb(cr, P.blue);
            cr.fill();

            // X label: show every 5th day + first + last
            if (i === 0 || i === n - 1 || (p.day % 5 === 0)) {
                _text(cr, String(p.day), p.x - 4, pad.t + gh + 4, 8, P.dim);
            }
        });

        // Axis
        rgb(cr, P.border);
        cr.setLineWidth(1);
        cr.moveTo(pad.l, pad.t);
        cr.lineTo(pad.l, pad.t + gh);
        cr.lineTo(pad.l + gw, pad.t + gh);
        cr.stroke();
    });

    return wrapper;
}

// ── 2b. Donut chart ────────────────────────────────────────────────────────────

function buildDonut(rd, size) {
    const W = size, H = size;
    const { wrapper, canvas } = makeCanvas(W, H, (cr) => {
        rgb(cr, P.panel);
        _roundRect(cr, 0, 0, W, H, 8);
        cr.fill();

        const cx = W / 2, cy = H / 2;
        const R = Math.min(W, H) * 0.40;
        const r = R * 0.60;
        const mid = (R + r) / 2;
        const lw = R - r;

        // Background ring
        cr.setLineWidth(lw);
        rgb(cr, P.panel2);
        cr.arc(cx, cy, mid, 0, 2 * Math.PI);
        cr.stroke();

        // Completed arc
        const frac = rd.monthGoal > 0 ? rd.monthCompleted / rd.monthGoal : 0;
        if (frac > 0) {
            cr.setLineWidth(lw);
            rgb(cr, P.blue);
            cr.arc(cx, cy, mid, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * frac);
            cr.stroke();
        }

        // Centre text
        const pctStr = `${rd.monthPct}%`;
        const tw = _textWidth(pctStr, 16);
        _text(cr, pctStr, cx - tw / 2, cy - 10, 16, P.text, true);
        const sub = 'complete';
        const sw = _textWidth(sub, 9);
        _text(cr, sub, cx - sw / 2, cy + 5, 9, P.muted);

        // Labels
        _text(cr, `✓ ${rd.monthCompleted}`, 4, H - 28, 9, P.blue);
        _text(cr, `○ ${rd.monthGoal - rd.monthCompleted}`, 4, H - 16, 9, P.dim);
    });
    return wrapper;
}

// ── 3. Weekly overview ────────────────────────────────────────────────────────

function buildWeeklyOverview(rd, W) {
    const container = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-section' });
    container.add_child(sectionHeader('WEEKLY OVERVIEW'));

    const weeksBox = new St.BoxLayout({ x_expand: true, spacing: 8 });

    // Left label column
    const labelCol = new St.BoxLayout({ vertical: true, style_class: 'rpt-week-labels' });
    labelCol.add_child(new St.Label({ text: '', style_class: 'rpt-week-label-title' })); // spacer for bar
    labelCol.add_child(new St.Label({ text: 'Completed', style_class: 'rpt-row-label' }));
    labelCol.add_child(new St.Label({ text: 'Goal',      style_class: 'rpt-row-label' }));
    labelCol.add_child(new St.Label({ text: 'Left',      style_class: 'rpt-row-label' }));
    labelCol.add_child(new St.Label({ text: 'Progress',  style_class: 'rpt-row-label rpt-row-label-prog' }));
    weeksBox.add_child(labelCol);

    const nWeeks = rd.weeks.length;
    const colW = Math.floor((W - 80 - (nWeeks - 1) * 8) / Math.max(nWeeks, 1));

    rd.weeks.forEach((week, wi) => {
        const wCompleted = week.reduce((s, d) => s + d.completed, 0);
        const wGoal      = week.reduce((s, d) => s + d.goal, 0);
        const wLeft      = Math.max(0, wGoal - wCompleted);
        const wPct       = wGoal > 0 ? Math.round(wCompleted / wGoal * 100) : 0;

        const col = new St.BoxLayout({ vertical: true, width: colW, style_class: 'rpt-week-col' });

        // Week label
        col.add_child(new St.Label({
            text: `Week ${wi + 1}`,
            style_class: 'rpt-week-num',
        }));

        // Mini bar chart
        const BAR_H = 48;
        const maxCompleted = Math.max(...rd.weeks.map(w2 => Math.max(...w2.map(d => d.completed), 0)), 1);
        const { wrapper: barWrapper } = makeCanvas(colW, BAR_H, (cr) => {
            rgb(cr, P.panel2);
            _roundRect(cr, 0, 0, colW, BAR_H, 4);
            cr.fill();

            const n   = week.length;
            const bW  = Math.max(4, Math.floor((colW - 8) / n) - 2);
            const pad = Math.floor((colW - n * (bW + 2)) / 2);

            week.forEach((d, di) => {
                const bH = d.completed > 0 ? Math.max(3, Math.round(d.completed / maxCompleted * (BAR_H - 8))) : 2;
                const bx = pad + di * (bW + 2);
                const by = BAR_H - 4 - bH;
                rgb(cr, P.blue, d.completed > 0 ? 0.85 : 0.2);
                _roundRect(cr, bx, by, bW, bH, 2);
                cr.fill();
            });
        });
        col.add_child(barWrapper);

        // Day numbers header
        const dayHeader = new St.BoxLayout({ spacing: 1 });
        week.forEach(d => {
            dayHeader.add_child(new St.Label({
                text: String(d.day),
                style_class: 'rpt-day-num',
                width: Math.floor(colW / week.length),
                x_align: Clutter.ActorAlign.CENTER,
            }));
        });
        col.add_child(dayHeader);

        // Stat rows
        [
            { val: wCompleted, cls: 'rpt-stat-val rpt-stat-done' },
            { val: wGoal,      cls: 'rpt-stat-val' },
            { val: wLeft,      cls: 'rpt-stat-val rpt-stat-left' },
        ].forEach(({ val, cls }) => {
            col.add_child(new St.Label({ text: String(val), style_class: cls }));
        });

        // Progress fraction + bar
        const progBox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-prog-box' });
        progBox.add_child(new St.Label({
            text: `${wCompleted}/${wGoal}  ${wPct}%`,
            style_class: 'rpt-prog-frac',
        }));

        // Progress bar (St.Widget, no Cairo — no relayout on hover)
        const barBg = new St.Widget({ style_class: 'rpt-prog-bar-bg', x_expand: true, height: 5 });
        const barFg = new St.Widget({
            style_class: 'rpt-prog-bar-fg',
            height: 5,
            width: Math.round(wPct / 100 * colW),
        });
        barBg.add_child(barFg);
        progBox.add_child(barBg);
        col.add_child(progBox);

        weeksBox.add_child(col);
    });

    container.add_child(weeksBox);
    return container;
}

// ── 4. Daily habit matrix ─────────────────────────────────────────────────────

function buildHabitMatrix(rd) {
    const container = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-section' });
    container.add_child(sectionHeader('DAILY HABITS'));

    const CELL  = 20;
    const LABEL = 140;
    const GOAL_W = 36;

    // Scroll horizontally if the matrix is wider than the popover
    const scrollH = new St.ScrollView({
        x_expand: true,
        hscrollbar_policy: St.PolicyType.AUTOMATIC,
        vscrollbar_policy: St.PolicyType.NEVER,
        overlay_scrollbars: true,
    });

    const grid = new St.BoxLayout({ vertical: true, x_expand: true });

    // ── Column header row ──────────────────────────────────────────────────
    const colHeader = new St.BoxLayout({ spacing: 0 });
    colHeader.add_child(new St.Widget({ width: LABEL }));          // habit name col
    colHeader.add_child(new St.Label({ text: 'Goal', style_class: 'rpt-matrix-goal-hdr', width: GOAL_W }));

    // Week group headers
    rd.weeks.forEach((week, wi) => {
        const wHdr = new St.BoxLayout({ vertical: true, style_class: 'rpt-matrix-week-hdr' });
        const wLbl = new St.Label({
            text: `Wk ${wi + 1}`,
            style_class: 'rpt-matrix-week-label',
            width: week.length * CELL,
        });
        wHdr.add_child(wLbl);

        // DOW + day number for each day in week
        const dayRow = new St.BoxLayout({ spacing: 0 });
        week.forEach(d => {
            const cell = new St.BoxLayout({ vertical: true, width: CELL, style_class: 'rpt-matrix-day-col' });
            cell.add_child(new St.Label({
                text: DAYS_SHORT[d.dow].slice(0, 2),
                style_class: 'rpt-matrix-dow',
                width: CELL,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            cell.add_child(new St.Label({
                text: String(d.day),
                style_class: 'rpt-matrix-daynum',
                width: CELL,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            dayRow.add_child(cell);
        });
        wHdr.add_child(dayRow);
        colHeader.add_child(wHdr);
    });
    grid.add_child(colHeader);

    // ── One row per habit ──────────────────────────────────────────────────
    for (const hs of rd.habitStats) {
        const row = new St.BoxLayout({ spacing: 0, style_class: 'rpt-matrix-row' });

        // Habit name
        const nameLbl = new St.Label({
            text: hs.task.title,
            style_class: 'rpt-matrix-name',
            width: LABEL,
        });
        nameLbl.clutter_text.ellipsize = 3;
        row.add_child(nameLbl);

        // Goal
        row.add_child(new St.Label({
            text: String(hs.goal),
            style_class: 'rpt-matrix-goal',
            width: GOAL_W,
            x_align: Clutter.ActorAlign.CENTER,
        }));

        // Cells grouped by week
        rd.weeks.forEach(week => {
            const weekCells = new St.BoxLayout({ spacing: 0 });
            week.forEach(d => {
                const status = rd.cellCompleted(hs.task.id, d.day);
                let cls;
                if (status === null)  cls = 'rpt-cell-na';
                else if (status)      cls = 'rpt-cell-done';
                else                  cls = 'rpt-cell-empty';

                const cell = new St.Widget({
                    width: CELL,
                    height: CELL,
                    style_class: `rpt-cell ${cls}`,
                });
                weekCells.add_child(cell);
            });
            row.add_child(weekCells);
        });

        grid.add_child(row);
    }

    const holder = new St.BoxLayout({ x_expand: true });
    holder.add_child(grid);
    scrollH.child = holder;
    container.add_child(scrollH);
    return container;
}

// ── 5. Top 10 habits ─────────────────────────────────────────────────────────

function buildTop10(rd) {
    const container = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-section' });
    container.add_child(sectionHeader('TOP 10 HABITS'));

    if (rd.top10.length === 0) {
        container.add_child(new St.Label({ text: 'No data this month.', style_class: 'rpt-empty' }));
        return container;
    }

    rd.top10.forEach((hs, i) => {
        const row = new St.BoxLayout({ x_expand: true, style_class: 'rpt-top-row', spacing: 8 });
        row.add_child(new St.Label({
            text: `${i + 1}`,
            style_class: 'rpt-top-rank',
            width: 20,
            x_align: Clutter.ActorAlign.END,
        }));
        const name = new St.Label({
            text: hs.task.title,
            style_class: 'rpt-top-name',
            x_expand: true,
        });
        name.clutter_text.ellipsize = 3;
        row.add_child(name);
        row.add_child(new St.Label({
            text: `${hs.completed}`,
            style_class: 'rpt-top-count',
        }));
        row.add_child(new St.Label({
            text: `${hs.pct}%`,
            style_class: 'rpt-top-pct',
        }));
        container.add_child(row);
    });
    return container;
}

// ── 6. Overall progress ───────────────────────────────────────────────────────

function buildOverallProgress(rd, W) {
    const container = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-section' });
    container.add_child(sectionHeader('OVERALL PROGRESS'));

    for (const hs of rd.habitStats) {
        const row = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'rpt-overall-row',
        });

        const top = new St.BoxLayout({ x_expand: true, spacing: 8 });
        const name = new St.Label({ text: hs.task.title, style_class: 'rpt-overall-name', x_expand: true });
        name.clutter_text.ellipsize = 3;
        top.add_child(name);
        top.add_child(new St.Label({ text: `${hs.completed}/${hs.goal}`, style_class: 'rpt-overall-frac' }));
        top.add_child(new St.Label({ text: `${hs.pct}%`, style_class: 'rpt-overall-pct' }));
        row.add_child(top);

        // Progress bar
        const barBg = new St.Widget({ style_class: 'rpt-overall-bar-bg', x_expand: true, height: 4 });
        const barW  = hs.pct > 0 ? Math.max(4, Math.round(hs.pct / 100 * (W - 32))) : 0;
        const barFg = new St.Widget({
            style_class: 'rpt-overall-bar-fg',
            height: 4,
            width: barW,
        });
        barBg.add_child(barFg);
        row.add_child(barBg);
        container.add_child(row);
    }

    if (rd.habitStats.length === 0)
        container.add_child(new St.Label({ text: 'No habits defined.', style_class: 'rpt-empty' }));

    return container;
}

// ── Cairo helpers ─────────────────────────────────────────────────────────────

function _roundRect(cr, x, y, w, h, r) {
    cr.newPath();
    cr.arc(x + r,     y + r,     r, Math.PI,       1.5 * Math.PI);
    cr.arc(x + w - r, y + r,     r, 1.5 * Math.PI, 2 * Math.PI);
    cr.arc(x + w - r, y + h - r, r, 0,              0.5 * Math.PI);
    cr.arc(x + r,     y + h - r, r, 0.5 * Math.PI,  Math.PI);
    cr.closePath();
}

function _text(cr, text, x, y, size, color, bold = false) {
    rgb(cr, color);
    cr.moveTo(x, y);
    cr.setFontSize(size);
    if (bold) cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
    else      cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
    cr.showText(text);
}

function _textWidth(text, size) {
    // Rough estimate: 0.6 × size per character
    return text.length * size * 0.6;
}

// ── ReportDashboard — the exported view class ─────────────────────────────────

export const ReportDashboard = GObject.registerClass(
class ReportDashboard extends St.BoxLayout {
    /**
     * @param {object} storage  Storage instance (reads getAllDays, getTasks)
     * @param {number} width    Available width in pixels
     */
    _init(storage, width) {
        super._init({
            style_class: 'rpt-dashboard',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        this._storage = storage;
        this._width   = width;

        const now = new Date();
        this._year  = now.getFullYear();
        this._month = now.getMonth();

        this._build();
    }

    _build() {
        // Destroy previous content
        this.destroy_all_children();

        const rd = new ReportData(this._storage, this._year, this._month);

        // ── Outer scroll ─────────────────────────────────────────────────────
        const scroll = new St.ScrollView({
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });

        const inner = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'rpt-inner',
        });

        const onMonthChange = (y, m) => {
            this._year  = y;
            this._month = m;
            this._build();
        };

        // ── 1. Header ────────────────────────────────────────────────────────
        inner.add_child(buildHeader(rd, onMonthChange));

        // ── 2. Trend + Donut ─────────────────────────────────────────────────
        const trendRow = new St.BoxLayout({ x_expand: true, spacing: 12, style_class: 'rpt-trend-row' });
        const donutSz  = 130;
        const chartW   = this._width - donutSz - 12 - 32; // 32 = inner padding
        trendRow.add_child(buildTrendChart(rd, Math.max(chartW, 160)));
        trendRow.add_child(buildDonut(rd, donutSz));
        inner.add_child(trendRow);

        // ── 3. Weekly overview ───────────────────────────────────────────────
        inner.add_child(buildWeeklyOverview(rd, this._width - 32));

        // ── 4 + 5. Two-column: habit matrix (left) + top 10 (right) ─────────
        const midRow = new St.BoxLayout({ x_expand: true, spacing: 12, style_class: 'rpt-mid-row' });
        const matrixW = Math.floor((this._width - 32 - 12) * 0.68);
        const top10W  = this._width - 32 - 12 - matrixW;

        const matrixBox = new St.BoxLayout({ vertical: true, width: matrixW });
        matrixBox.add_child(buildHabitMatrix(rd));

        const top10Box = new St.BoxLayout({ vertical: true, width: top10W });
        top10Box.add_child(buildTop10(rd));

        midRow.add_child(matrixBox);
        midRow.add_child(top10Box);
        inner.add_child(midRow);

        // ── 6. Overall progress ──────────────────────────────────────────────
        inner.add_child(buildOverallProgress(rd, this._width - 32));

        scroll.child = inner;
        this.add_child(scroll);
    }
});
