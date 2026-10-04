/**
 * src/reportView.js — PULSE Monthly Dashboard
 *
 * Built entirely with St widgets — no Cairo, no Clutter.Canvas.
 * (Clutter.Canvas was removed in GNOME 45; St.DrawingArea doesn't exist
 *  in GNOME 50's St-18 typelib either.)
 *
 * Charts are rendered as grids of St.Widget rectangles (same approach
 * as the heatmap). All data derives from a single ReportData instance.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

// ── Constants ─────────────────────────────────────────────────────────────────

const MONTHS      = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun',
                      'Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS_SHORT  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ── ReportData — single source of truth ──────────────────────────────────────

class ReportData {
    constructor(storage, year, month) {
        this.year    = year;
        this.month   = month;
        this.tasks   = storage.getTasks();
        this.allDays = storage.getAllDays();
        this.nDays   = new Date(year, month + 1, 0).getDate();

        // Per-day array
        this.days = [];
        for (let d = 1; d <= this.nDays; d++) {
            const key = this._key(year, month, d);
            const rec = this.allDays[key] || { tasks: [], completionPct: 0 };
            const dow  = new Date(year, month, d).getDay();
            const goal = this._goalForDay(dow);
            const done = rec.tasks.filter(t => t.completed).length;
            this.days.push({
                day: d, dow, key, rec,
                completed: done,
                goal,
                left: Math.max(0, goal - done),
                pct:  goal > 0 ? Math.round(done / goal * 100) : 0,
            });
        }

        // Calendar weeks (groups of 7 starting from day 1)
        this.weeks = [];
        for (let i = 0; i < this.days.length; i += 7)
            this.weeks.push(this.days.slice(i, i + 7));

        // Monthly totals
        this.monthDone = this.days.reduce((s, d) => s + d.completed, 0);
        this.monthGoal = this.days.reduce((s, d) => s + d.goal, 0);
        this.monthPct  = this.monthGoal > 0
            ? Math.round(this.monthDone / this.monthGoal * 100) : 0;

        // Per-habit stats
        this.habitStats = this.tasks.map(task => {
            const goal = this._habitGoal(task);
            let done = 0;
            for (const d of this.days) {
                const e = d.rec.tasks.find(e => e.taskId === task.id);
                if (e?.completed) done++;
            }
            return { task, done, goal, left: Math.max(0, goal - done),
                     pct: goal > 0 ? Math.round(done / goal * 100) : 0 };
        });

        this.top10 = [...this.habitStats]
            .sort((a, b) => b.done - a.done)
            .slice(0, 10);
    }

    _key(y, m, d) {
        return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }

    _taskApplies(task, dow) {
        if (!task.repeat || task.repeat === 'daily') return true;
        if (task.repeat === 'none') return true;
        if (typeof task.repeat === 'object' && Array.isArray(task.repeat.weekdays))
            return task.repeat.weekdays.includes(dow);
        return true;
    }

    _goalForDay(dow) {
        return this.tasks.filter(t => this._taskApplies(t, dow)).length;
    }

    _habitGoal(task) {
        return this.days.filter(d => this._taskApplies(task, d.dow)).length;
    }

    cellCompleted(taskId, dayIdx) {
        const d = this.days[dayIdx];
        if (!d) return null;
        const task = this.tasks.find(t => t.id === taskId);
        if (!task || !this._taskApplies(task, d.dow)) return null;
        const entry = d.rec.tasks.find(e => e.taskId === taskId);
        return entry ? entry.completed : false;
    }
}

// ── St-widget chart helpers ───────────────────────────────────────────────────

/**
 * Mini bar chart using St.Widget columns.
 * values[]: numbers, maxVal: scale top, w: total width, h: total height.
 * Returns St.BoxLayout.
 */
function makeBarChart(values, maxVal, w, h, barStyleFn) {
    const box = new St.BoxLayout({ x_expand: true });
    const n   = values.length;
    const bW  = Math.max(2, Math.floor(w / n) - 1);

    for (let i = 0; i < n; i++) {
        const v   = values[i] ?? 0;
        const bH  = maxVal > 0 ? Math.max(v > 0 ? 2 : 0, Math.round(v / maxVal * h)) : 0;

        // Column: spacer on top + bar on bottom
        const col = new St.BoxLayout({ vertical: true, width: bW });

        // top spacer
        const spacer = new St.Widget({ height: h - bH, width: bW });
        col.add_child(spacer);

        // bar fill
        if (bH > 0) {
            const bar = new St.Widget({
                height: bH,
                width: bW,
                style_class: barStyleFn ? barStyleFn(i, v) : 'rpt-bar-fill',
            });
            col.add_child(bar);
        }
        box.add_child(col);
    }
    return box;
}

/**
 * Horizontal progress bar as two St.Widget divs.
 */
function makeProgressBar(pct, bgClass, fgClass) {
    const bg = new St.BoxLayout({ style_class: bgClass, x_expand: true });
    if (pct > 0) {
        const fg = new St.Widget({
            style_class: fgClass,
            // Use inline style for proportional width since St doesn't support %
            style: `width: ${Math.max(4, Math.round(pct))}px;`,
        });
        bg.add_child(fg);
    }
    return bg;
}

/**
 * Mini trend sparkline: row of dots (St.Widget) at varying heights.
 */
function makeTrendLine(pcts, w, h) {
    // Use a relative container with absolute-positioned dots
    const container = new St.Widget({ width: w, height: h, style_class: 'rpt-trend-container' });
    const n = pcts.length;
    if (n === 0) return container;

    const stepX = n > 1 ? w / (n - 1) : w / 2;

    pcts.forEach((pct, i) => {
        if (pct === null) return;
        const x = Math.round(i * stepX);
        const y = Math.round((100 - pct) / 100 * (h - 6));

        const dot = new St.Widget({
            style_class: pct >= 80 ? 'rpt-dot rpt-dot-high'
                        : pct >= 40 ? 'rpt-dot rpt-dot-mid'
                        : 'rpt-dot rpt-dot-low',
            width: 5,
            height: 5,
        });
        dot.set_position(x, y);
        container.add_child(dot);
    });
    return container;
}

/**
 * Donut-like ring represented as a sequence of colored squares.
 * Quick visual approximation without Cairo.
 */
function makeRingIndicator(pct) {
    const box = new St.BoxLayout({ vertical: true, style_class: 'rpt-ring-box' });

    // Percentage text
    const pctLbl = new St.Label({
        text: `${pct}%`,
        style_class: 'rpt-ring-pct',
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });
    box.add_child(pctLbl);

    const subLbl = new St.Label({
        text: 'complete',
        style_class: 'rpt-ring-sub',
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });
    box.add_child(subLbl);

    // Progress bar
    const barBg = new St.BoxLayout({ style_class: 'rpt-ring-bar-bg', x_expand: true, height: 8 });
    const barFg = new St.Widget({ style_class: 'rpt-ring-bar-fg', height: 8 });
    barFg.set_style(`width: ${Math.round(pct)}px;`);
    barBg.add_child(barFg);
    box.add_child(barBg);

    return box;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sectionHeader(text) {
    return new St.Label({ text, style_class: 'rpt-section-header' });
}

function statLabel(text, cls) {
    return new St.Label({ text, style_class: cls || 'rpt-stat-val' });
}

// ── 1. Header ─────────────────────────────────────────────────────────────────

function buildHeader(rd, onMonthChange) {
    const box = new St.BoxLayout({ style_class: 'rpt-header-row', x_expand: true });

    // Left: title + current month name
    const left = new St.BoxLayout({ vertical: true, x_expand: true });
    left.add_child(new St.Label({ text: 'PULSE', style_class: 'rpt-title-big' }));
    left.add_child(new St.Label({
        text: `${MONTHS[rd.month]} ${rd.year}`,
        style_class: 'rpt-title-month',
    }));
    box.add_child(left);

    // Right: year + month chip selectors
    const right = new St.BoxLayout({ vertical: true });

    // Year row
    const yearRow = new St.BoxLayout({ style_class: 'rpt-sel-row' });
    yearRow.add_child(new St.Label({ text: 'YEAR', style_class: 'rpt-sel-label' }));
    const now = new Date();
    for (let y = now.getFullYear() - 2; y <= now.getFullYear() + 1; y++) {
        const b = new St.Button({
            label: String(y),
            style_class: y === rd.year ? 'rpt-sel-chip rpt-sel-chip-on' : 'rpt-sel-chip',
            can_focus: true,
        });
        b.connect('clicked', () => onMonthChange(y, rd.month));
        yearRow.add_child(b);
    }
    right.add_child(yearRow);

    // Month row
    const monthRow = new St.BoxLayout({ style_class: 'rpt-sel-row' });
    monthRow.add_child(new St.Label({ text: 'MONTH', style_class: 'rpt-sel-label' }));
    MONTHS_SHORT.forEach((m, i) => {
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

// ── 2. Trend + ring ───────────────────────────────────────────────────────────

function buildTrendRow(rd) {
    const row = new St.BoxLayout({ x_expand: true, style_class: 'rpt-trend-row' });

    // Left: sparkline + axis labels
    const chartBox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-chart-box' });
    chartBox.add_child(new St.Label({ text: 'MONTHLY PROGRESS', style_class: 'rpt-section-header' }));

    const pcts = rd.days.map(d => d.pct);
    const sparkline = makeTrendLine(pcts, 280, 60);
    chartBox.add_child(sparkline);

    // X-axis day labels (every 5th)
    const xAxis = new St.BoxLayout({ x_expand: true });
    const n = pcts.length;
    const stepX = n > 1 ? 280 / (n - 1) : 0;
    rd.days.forEach((d, i) => {
        if (d.day === 1 || d.day % 5 === 0 || i === n - 1) {
            const lbl = new St.Label({ text: String(d.day), style_class: 'rpt-axis-label' });
            lbl.set_position(Math.round(i * stepX), 0);
            xAxis.add_child(lbl);
        }
    });
    chartBox.add_child(xAxis);
    row.add_child(chartBox);

    // Right: ring/donut indicator
    const ringBox = new St.BoxLayout({ vertical: true, style_class: 'rpt-ring-section' });
    ringBox.add_child(new St.Label({ text: 'MONTHLY OVERVIEW', style_class: 'rpt-section-header' }));
    ringBox.add_child(makeRingIndicator(rd.monthPct));

    // Completed / Left labels
    const statsRow = new St.BoxLayout({ style_class: 'rpt-ring-stats' });
    const doneBox = new St.BoxLayout({ vertical: true });
    doneBox.add_child(new St.Label({ text: `${rd.monthDone}`, style_class: 'rpt-ring-count-done' }));
    doneBox.add_child(new St.Label({ text: 'completed', style_class: 'rpt-ring-stat-lbl' }));
    statsRow.add_child(doneBox);
    const leftBox = new St.BoxLayout({ vertical: true });
    leftBox.add_child(new St.Label({ text: `${rd.monthGoal - rd.monthDone}`, style_class: 'rpt-ring-count-left' }));
    leftBox.add_child(new St.Label({ text: 'left', style_class: 'rpt-ring-stat-lbl' }));
    statsRow.add_child(leftBox);
    ringBox.add_child(statsRow);

    row.add_child(ringBox);
    return row;
}

// ── 3. Weekly overview ────────────────────────────────────────────────────────

function buildWeeklyOverview(rd) {
    const container = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-section' });
    container.add_child(sectionHeader('WEEKLY OVERVIEW'));

    const weeksRow = new St.BoxLayout({ x_expand: true });

    // Label column
    const lblCol = new St.BoxLayout({ vertical: true, style_class: 'rpt-week-labels' });
    lblCol.add_child(new St.Label({ text: ' ', style_class: 'rpt-week-spacer' })); // bar spacer
    lblCol.add_child(new St.Label({ text: ' ', style_class: 'rpt-week-spacer' })); // day nums spacer
    ['Completed','Goal','Left','Progress'].forEach(t =>
        lblCol.add_child(new St.Label({ text: t, style_class: 'rpt-row-label' }))
    );
    weeksRow.add_child(lblCol);

    const maxDayDone = Math.max(...rd.days.map(d => d.completed), 1);

    rd.weeks.forEach((week, wi) => {
        const wDone = week.reduce((s, d) => s + d.completed, 0);
        const wGoal = week.reduce((s, d) => s + d.goal, 0);
        const wPct  = wGoal > 0 ? Math.round(wDone / wGoal * 100) : 0;

        const col = new St.BoxLayout({ vertical: true, style_class: 'rpt-week-col' });

        // Week label
        col.add_child(new St.Label({ text: `Week ${wi + 1}`, style_class: 'rpt-week-num' }));

        // Mini bar chart
        const vals = week.map(d => d.completed);
        const barsW = week.length * 12;
        col.add_child(makeBarChart(vals, maxDayDone, barsW, 40,
            (_i, v) => v > 0 ? 'rpt-bar-fill' : 'rpt-bar-empty'));

        // Day numbers
        const dayNumRow = new St.BoxLayout({});
        week.forEach(d => {
            dayNumRow.add_child(new St.Label({
                text: String(d.day),
                style_class: 'rpt-day-num',
                width: 12,
                x_align: Clutter.ActorAlign.CENTER,
            }));
        });
        col.add_child(dayNumRow);

        // Stat rows
        [
            { val: wDone, cls: 'rpt-stat-val rpt-stat-done' },
            { val: wGoal, cls: 'rpt-stat-val' },
            { val: Math.max(0, wGoal - wDone), cls: 'rpt-stat-val rpt-stat-left' },
        ].forEach(({ val, cls }) =>
            col.add_child(new St.Label({ text: String(val), style_class: cls }))
        );

        // Progress fraction + bar
        const prog = new St.BoxLayout({ vertical: true });
        prog.add_child(new St.Label({
            text: `${wDone}/${wGoal}  ${wPct}%`,
            style_class: 'rpt-prog-frac',
        }));
        const barBg = new St.BoxLayout({ style_class: 'rpt-prog-bar-bg', height: 5 });
        if (wPct > 0) {
            const barFg = new St.Widget({
                style_class: 'rpt-prog-bar-fg',
                height: 5,
                style: `width: ${Math.max(4, Math.round(wPct / 100 * week.length * 12))}px;`,
            });
            barBg.add_child(barFg);
        }
        prog.add_child(barBg);
        col.add_child(prog);

        weeksRow.add_child(col);
    });

    container.add_child(weeksRow);
    return container;
}

// ── 4. Daily habit matrix ─────────────────────────────────────────────────────

function buildHabitMatrix(rd) {
    const container = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-section' });
    container.add_child(sectionHeader('DAILY HABITS'));

    const CELL   = 18;
    const LABEL  = 130;
    const GOAL_W = 32;

    const scroll = new St.ScrollView({
        x_expand: true,
        hscrollbar_policy: St.PolicyType.AUTOMATIC,
        vscrollbar_policy: St.PolicyType.NEVER,
        overlay_scrollbars: true,
    });

    const grid = new St.BoxLayout({ vertical: true });

    // ── Column headers ──
    const colHdr = new St.BoxLayout({});
    colHdr.add_child(new St.Widget({ width: LABEL }));
    colHdr.add_child(new St.Label({ text: 'Goal', style_class: 'rpt-matrix-goal-hdr', width: GOAL_W }));

    rd.weeks.forEach((week, wi) => {
        const wHdr = new St.BoxLayout({ vertical: true });
        wHdr.add_child(new St.Label({
            text: `Wk ${wi + 1}`,
            style_class: 'rpt-matrix-week-label',
            width: week.length * CELL,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const dayRow = new St.BoxLayout({});
        week.forEach(d => {
            const cell = new St.BoxLayout({ vertical: true, width: CELL });
            cell.add_child(new St.Label({
                text: DAYS_SHORT[d.dow].slice(0,2),
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
        colHdr.add_child(wHdr);
    });
    grid.add_child(colHdr);

    // ── Habit rows ──
    rd.habitStats.forEach(hs => {
        const row = new St.BoxLayout({ style_class: 'rpt-matrix-row' });

        const name = new St.Label({
            text: hs.task.title,
            style_class: 'rpt-matrix-name',
            width: LABEL,
        });
        name.clutter_text.ellipsize = 3;
        row.add_child(name);

        row.add_child(new St.Label({
            text: String(hs.goal),
            style_class: 'rpt-matrix-goal',
            width: GOAL_W,
            x_align: Clutter.ActorAlign.CENTER,
        }));

        rd.weeks.forEach((week, wi) => {
            const wCells = new St.BoxLayout({});
            week.forEach((d, di) => {
                const dayIdx = wi * 7 + di;
                const status = rd.cellCompleted(hs.task.id, dayIdx);
                const cls = status === null ? 'rpt-cell rpt-cell-na'
                          : status          ? 'rpt-cell rpt-cell-done'
                          :                   'rpt-cell rpt-cell-empty';
                wCells.add_child(new St.Widget({ width: CELL, height: CELL, style_class: cls }));
            });
            row.add_child(wCells);
        });

        grid.add_child(row);
    });

    const holder = new St.BoxLayout({ x_expand: true });
    holder.add_child(grid);
    scroll.child = holder;
    container.add_child(scroll);
    return container;
}

// ── 5. Top 10 ─────────────────────────────────────────────────────────────────

function buildTop10(rd) {
    const container = new St.BoxLayout({ vertical: true, style_class: 'rpt-section' });
    container.add_child(sectionHeader('TOP 10 HABITS'));

    if (rd.top10.length === 0) {
        container.add_child(new St.Label({ text: 'No data this month.', style_class: 'rpt-empty' }));
        return container;
    }

    rd.top10.forEach((hs, i) => {
        const row = new St.BoxLayout({ x_expand: true, style_class: 'rpt-top-row' });
        row.add_child(new St.Label({ text: `${i+1}`, style_class: 'rpt-top-rank', width: 18 }));
        const name = new St.Label({ text: hs.task.title, style_class: 'rpt-top-name', x_expand: true });
        name.clutter_text.ellipsize = 3;
        row.add_child(name);
        row.add_child(new St.Label({ text: String(hs.done), style_class: 'rpt-top-count' }));
        row.add_child(new St.Label({ text: `${hs.pct}%`, style_class: 'rpt-top-pct' }));
        container.add_child(row);
    });
    return container;
}

// ── 6. Overall progress ───────────────────────────────────────────────────────

function buildOverallProgress(rd) {
    const container = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-section' });
    container.add_child(sectionHeader('OVERALL PROGRESS'));

    if (rd.habitStats.length === 0) {
        container.add_child(new St.Label({ text: 'No habits defined.', style_class: 'rpt-empty' }));
        return container;
    }

    rd.habitStats.forEach(hs => {
        const row = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-overall-row' });

        const top = new St.BoxLayout({ x_expand: true });
        const name = new St.Label({ text: hs.task.title, style_class: 'rpt-overall-name', x_expand: true });
        name.clutter_text.ellipsize = 3;
        top.add_child(name);
        top.add_child(new St.Label({ text: `${hs.done}/${hs.goal}`, style_class: 'rpt-overall-frac' }));
        top.add_child(new St.Label({ text: `${hs.pct}%`, style_class: 'rpt-overall-pct' }));
        row.add_child(top);

        const barBg = new St.BoxLayout({ style_class: 'rpt-overall-bar-bg', x_expand: true, height: 4 });
        if (hs.pct > 0) {
            const barFg = new St.Widget({
                style_class: 'rpt-overall-bar-fg',
                height: 4,
                style: `width: ${Math.max(4, Math.round(hs.pct * 2))}px;`,
            });
            barBg.add_child(barFg);
        }
        row.add_child(barBg);
        container.add_child(row);
    });

    return container;
}

// ── ReportDashboard ───────────────────────────────────────────────────────────

export const ReportDashboard = GObject.registerClass(
class ReportDashboard extends St.BoxLayout {
    _init(storage, _width) {
        super._init({ style_class: 'rpt-dashboard', vertical: true, x_expand: true, y_expand: true });

        this._storage = storage;
        const now = new Date();
        this._year  = now.getFullYear();
        this._month = now.getMonth();

        this._build();
    }

    _build() {
        this.destroy_all_children();

        const rd = new ReportData(this._storage, this._year, this._month);

        const scroll = new St.ScrollView({
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });

        const inner = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-inner' });

        const onMonthChange = (y, m) => {
            this._year  = y;
            this._month = m;
            this._build();
        };

        inner.add_child(buildHeader(rd, onMonthChange));
        inner.add_child(buildTrendRow(rd));
        inner.add_child(buildWeeklyOverview(rd));

        // Mid row: matrix + top10 side by side
        const midRow = new St.BoxLayout({ x_expand: true, style_class: 'rpt-mid-row' });
        const matrixWrap = new St.BoxLayout({ vertical: true, x_expand: true });
        matrixWrap.add_child(buildHabitMatrix(rd));
        midRow.add_child(matrixWrap);

        const top10Wrap = new St.BoxLayout({ vertical: true, style_class: 'rpt-top10-wrap' });
        top10Wrap.add_child(buildTop10(rd));
        midRow.add_child(top10Wrap);
        inner.add_child(midRow);

        inner.add_child(buildOverallProgress(rd));

        scroll.child = inner;
        this.add_child(scroll);
    }
});
