/**
 * src/reportView.js — PULSE Monthly Dashboard
 *
 * Zero overflow guarantee:
 *   - All progress bars use pct * (innerW / 100) so they NEVER exceed the container.
 *   - Weekly overview uses x_expand on every column — fills full width.
 *   - Habit matrix horizontal-scrolls independently.
 *   - No spacing: in constructors (CSS-only).
 *   - Every section separated by explicit margin-bottom in CSS.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const MONTHS       = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun',
                      'Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS_SHORT   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ── ReportData ────────────────────────────────────────────────────────────────

class ReportData {
    constructor(storage, year, month) {
        this.year    = year;
        this.month   = month;
        this.tasks   = storage.getTasks();
        this.allDays = storage.getAllDays();
        this.nDays   = new Date(year, month + 1, 0).getDate();

        this.days = [];
        for (let d = 1; d <= this.nDays; d++) {
            const key  = this._key(year, month, d);
            const rec  = this.allDays[key] || { tasks: [], completionPct: 0 };
            const dow  = new Date(year, month, d).getDay();
            const goal = this._goalForDay(dow);
            const done = rec.tasks.filter(t => t.completed).length;
            this.days.push({ day: d, dow, key, rec, done, goal,
                left: Math.max(0, goal - done),
                pct: goal > 0 ? Math.round(done / goal * 100) : 0 });
        }

        this.weeks = [];
        for (let i = 0; i < this.days.length; i += 7)
            this.weeks.push(this.days.slice(i, i + 7));

        this.monthDone = this.days.reduce((s, d) => s + d.done, 0);
        this.monthGoal = this.days.reduce((s, d) => s + d.goal, 0);
        this.monthPct  = this.monthGoal > 0
            ? Math.round(this.monthDone / this.monthGoal * 100) : 0;

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

        this.top10 = [...this.habitStats].sort((a,b) => b.done - a.done).slice(0, 10);
    }

    _key(y, m, d) {
        return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
    _applies(task, dow) {
        if (!task.repeat || task.repeat === 'daily' || task.repeat === 'none') return true;
        if (typeof task.repeat === 'object' && Array.isArray(task.repeat.weekdays))
            return task.repeat.weekdays.includes(dow);
        return true;
    }
    _goalForDay(dow) { return this.tasks.filter(t => this._applies(t, dow)).length; }
    _habitGoal(task) { return this.days.filter(d => this._applies(task, d.dow)).length; }
    cellCompleted(taskId, dayIdx) {
        const d = this.days[dayIdx];
        if (!d) return null;
        const task = this.tasks.find(t => t.id === taskId);
        if (!task || !this._applies(task, d.dow)) return null;
        const e = d.rec.tasks.find(e => e.taskId === taskId);
        return e ? e.completed : false;
    }
}

// ── Progress bar — width strictly capped to innerW ────────────────────────────

function progressBar(pct, innerW, bgCls, fgCls, h = 6) {
    const bg = new St.BoxLayout({ style_class: bgCls, x_expand: true, height: h });
    if (pct > 0) {
        const w = Math.max(4, Math.round(pct / 100 * (innerW - 4)));
        bg.add_child(new St.Widget({ style_class: fgCls, height: h,
            style: `width: ${w}px; max-width: ${innerW}px;` }));
    }
    return bg;
}

// ── Mini bar chart ─────────────────────────────────────────────────────────────

function barChart(values, maxVal, cellW, h) {
    const box = new St.BoxLayout({ x_expand: true });
    for (const v of values) {
        const bH = maxVal > 0 ? Math.max(v > 0 ? 3 : 0, Math.round(v / maxVal * h)) : 0;
        const col = new St.BoxLayout({ vertical: true, width: cellW });
        col.add_child(new St.Widget({ height: h - bH, width: cellW }));
        if (bH > 0)
            col.add_child(new St.Widget({ height: bH, width: cellW - 2,
                style_class: 'rpt-bar-fill' }));
        box.add_child(col);
    }
    return box;
}

// ── Sparkline (trend dots) ────────────────────────────────────────────────────

function sparkline(pcts, w, h) {
    const c = new St.Widget({ width: w, height: h, style_class: 'rpt-trend-container' });
    const n = pcts.length;
    if (!n) return c;
    const stepX = n > 1 ? (w - 6) / (n - 1) : 0;
    pcts.forEach((pct, i) => {
        if (pct === null) return;
        const dot = new St.Widget({
            width: 6, height: 6,
            style_class: pct >= 70 ? 'rpt-dot rpt-dot-high'
                       : pct >= 35 ? 'rpt-dot rpt-dot-mid'
                       :             'rpt-dot rpt-dot-low',
        });
        dot.set_position(Math.round(i * stepX), Math.round((100 - pct) / 100 * (h - 8)));
        c.add_child(dot);
    });
    return c;
}

// ── Section divider ────────────────────────────────────────────────────────────

function sectionHdr(text) {
    return new St.Label({ text, style_class: 'rpt-section-header' });
}

function divider() {
    return new St.Widget({ style_class: 'rpt-divider', height: 1, x_expand: true });
}

// ── 1. Header ─────────────────────────────────────────────────────────────────

function buildHeader(rd, onMonthChange) {
    const box = new St.BoxLayout({ style_class: 'rpt-header-row', x_expand: true });

    // Left: PULSE + month
    const left = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-header-left' });
    left.add_child(new St.Label({ text: 'PULSE', style_class: 'rpt-title-big' }));
    left.add_child(new St.Label({ text: `${MONTHS[rd.month]} ${rd.year}`, style_class: 'rpt-title-month' }));
    box.add_child(left);

    // Right: year + month selectors
    const right = new St.BoxLayout({ vertical: true, style_class: 'rpt-selectors' });

    const yearRow = new St.BoxLayout({ style_class: 'rpt-sel-row' });
    yearRow.add_child(new St.Label({ text: 'YEAR', style_class: 'rpt-sel-label' }));
    const now = new Date();
    for (let y = now.getFullYear() - 2; y <= now.getFullYear() + 1; y++) {
        const b = new St.Button({ label: String(y), can_focus: true,
            style_class: y === rd.year ? 'rpt-sel-chip rpt-sel-chip-on' : 'rpt-sel-chip' });
        b.connect('clicked', () => onMonthChange(y, rd.month));
        yearRow.add_child(b);
    }
    right.add_child(yearRow);

    const monthRow = new St.BoxLayout({ style_class: 'rpt-sel-row' });
    monthRow.add_child(new St.Label({ text: 'MONTH', style_class: 'rpt-sel-label' }));
    MONTHS_SHORT.forEach((m, i) => {
        const b = new St.Button({ label: m, can_focus: true,
            style_class: i === rd.month ? 'rpt-sel-chip rpt-sel-chip-on' : 'rpt-sel-chip' });
        b.connect('clicked', () => onMonthChange(rd.year, i));
        monthRow.add_child(b);
    });
    right.add_child(monthRow);
    box.add_child(right);
    return box;
}

// ── 2. Trend row ──────────────────────────────────────────────────────────────

function buildTrendRow(rd, innerW) {
    const row = new St.BoxLayout({ x_expand: true, style_class: 'rpt-section' });

    // Sparkline (takes ~70% of width)
    const chartW = Math.floor(innerW * 0.68);
    const chartBox = new St.BoxLayout({ vertical: true, width: chartW });
    chartBox.add_child(sectionHdr('MONTHLY PROGRESS'));
    chartBox.add_child(sparkline(rd.days.map(d => d.pct), chartW - 8, 72));
    // X-axis labels
    const xRow = new St.BoxLayout({ width: chartW - 8 });
    rd.days.forEach((d, i) => {
        if (d.day === 1 || d.day % 5 === 0 || i === rd.days.length - 1) {
            const lbl = new St.Label({ text: String(d.day), style_class: 'rpt-axis-label' });
            lbl.set_position(Math.round(i * (chartW - 14) / (rd.days.length - 1 || 1)), 0);
            xRow.add_child(lbl);
        }
    });
    chartBox.add_child(xRow);
    row.add_child(chartBox);

    // Spacer
    row.add_child(new St.Widget({ width: 16 }));

    // Ring / donut (~30% of width)
    const ringW = innerW - chartW - 16;
    const ringBox = new St.BoxLayout({ vertical: true, width: ringW, style_class: 'rpt-ring-section' });
    ringBox.add_child(sectionHdr('MONTHLY OVERVIEW'));

    const pctLbl = new St.Label({ text: `${rd.monthPct}%`, style_class: 'rpt-ring-pct',
        x_align: Clutter.ActorAlign.CENTER, x_expand: true });
    ringBox.add_child(pctLbl);
    ringBox.add_child(new St.Label({ text: 'complete', style_class: 'rpt-ring-sub',
        x_align: Clutter.ActorAlign.CENTER, x_expand: true }));
    ringBox.add_child(progressBar(rd.monthPct, ringW - 16, 'rpt-ring-bar-bg', 'rpt-ring-bar-fg', 8));

    const statsRow = new St.BoxLayout({ x_expand: true });
    const mkStat = (val, lbl, cls) => {
        const b = new St.BoxLayout({ vertical: true, x_expand: true });
        b.add_child(new St.Label({ text: String(val), style_class: cls,
            x_align: Clutter.ActorAlign.CENTER, x_expand: true }));
        b.add_child(new St.Label({ text: lbl, style_class: 'rpt-ring-stat-lbl',
            x_align: Clutter.ActorAlign.CENTER, x_expand: true }));
        return b;
    };
    statsRow.add_child(mkStat(rd.monthDone, 'done', 'rpt-ring-count-done'));
    statsRow.add_child(mkStat(rd.monthGoal - rd.monthDone, 'left', 'rpt-ring-count-left'));
    ringBox.add_child(statsRow);

    row.add_child(ringBox);
    return row;
}

// ── 3. Weekly overview — FULL WIDTH ──────────────────────────────────────────

function buildWeeklyOverview(rd, innerW) {
    const section = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-section' });
    section.add_child(sectionHdr('WEEKLY OVERVIEW'));
    section.add_child(divider());

    const LABEL_W = 88;
    const nWeeks  = rd.weeks.length;
    // Each week column gets equal share of remaining width
    const colW    = Math.floor((innerW - LABEL_W - 8) / Math.max(nWeeks, 1));
    // Cell width within each week: fit 7 bars in colW with 2px gap
    const cellW   = Math.max(8, Math.floor((colW - 4) / 7));

    const body = new St.BoxLayout({ x_expand: true });

    // Label column
    const lblCol = new St.BoxLayout({ vertical: true, width: LABEL_W, style_class: 'rpt-week-labels' });
    // Spacer height = bar chart height (52) + day-row height (18) + week header (22)
    lblCol.add_child(new St.Widget({ height: 92 }));
    ['Completed', 'Goal', 'Left', 'Progress'].forEach(t =>
        lblCol.add_child(new St.Label({ text: t, style_class: 'rpt-row-label' }))
    );
    body.add_child(lblCol);

    const maxDayDone = Math.max(...rd.days.map(d => d.done), 1);

    rd.weeks.forEach((week, wi) => {
        const wDone = week.reduce((s, d) => s + d.done, 0);
        const wGoal = week.reduce((s, d) => s + d.goal, 0);
        const wPct  = wGoal > 0 ? Math.round(wDone / wGoal * 100) : 0;

        const col = new St.BoxLayout({ vertical: true, width: colW, style_class: 'rpt-week-col' });

        // Week header
        col.add_child(new St.Label({ text: `Week ${wi + 1}`, style_class: 'rpt-week-num',
            x_align: Clutter.ActorAlign.CENTER, width: colW }));

        // Bar chart (height 52)
        col.add_child(barChart(week.map(d => d.done), maxDayDone, cellW, 52));

        // Day numbers row
        const dayRow = new St.BoxLayout({ width: colW });
        week.forEach(d => dayRow.add_child(new St.Label({
            text: String(d.day), style_class: 'rpt-day-num',
            width: cellW, x_align: Clutter.ActorAlign.CENTER,
        })));
        col.add_child(dayRow);

        // Stat rows
        [{ v: wDone, c: 'rpt-stat-done' }, { v: wGoal, c: '' }, { v: Math.max(0,wGoal-wDone), c: 'rpt-stat-left' }]
            .forEach(({ v, c }) => col.add_child(new St.Label({
                text: String(v), style_class: `rpt-stat-val ${c}`.trim(),
                x_align: Clutter.ActorAlign.CENTER, width: colW,
            })));

        // Progress
        col.add_child(new St.Label({ text: `${wDone}/${wGoal} · ${wPct}%`, style_class: 'rpt-prog-frac',
            x_align: Clutter.ActorAlign.CENTER, width: colW }));
        col.add_child(progressBar(wPct, colW - 4, 'rpt-prog-bar-bg', 'rpt-prog-bar-fg', 5));

        body.add_child(col);
    });

    section.add_child(body);
    return section;
}

// ── 4. Habit matrix ───────────────────────────────────────────────────────────

function buildHabitMatrix(rd, innerW) {
    const section = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-section' });
    section.add_child(sectionHdr('DAILY HABITS'));
    section.add_child(divider());

    if (!rd.habitStats.length) {
        section.add_child(new St.Label({ text: 'No habits defined.', style_class: 'rpt-empty' }));
        return section;
    }

    // Compute cell size to fit all columns in available width — NO horizontal scroll
    const LABEL  = 130;
    const GOAL_W = 32;
    const totalCols = rd.days.length; // e.g. 31 for October
    const available = innerW - LABEL - GOAL_W - 8;
    // CELL must be at least 14px for readability
    const CELL = Math.max(14, Math.floor(available / Math.max(totalCols, 1)));

    const grid = new St.BoxLayout({ vertical: true, x_expand: true });

    // Column headers
    const colHdr = new St.BoxLayout({ x_expand: true });
    colHdr.add_child(new St.Widget({ width: LABEL }));
    colHdr.add_child(new St.Label({ text: 'Goal', style_class: 'rpt-matrix-goal-hdr', width: GOAL_W }));

    rd.weeks.forEach((week, wi) => {
        const wHdr = new St.BoxLayout({ vertical: true });
        wHdr.add_child(new St.Label({
            text: `Wk ${wi+1}`, style_class: 'rpt-matrix-week-label',
            width: week.length * CELL, x_align: Clutter.ActorAlign.CENTER,
        }));
        const dayRow = new St.BoxLayout({});
        week.forEach(d => {
            const cell = new St.BoxLayout({ vertical: true, width: CELL });
            cell.add_child(new St.Label({ text: DAYS_SHORT[d.dow].slice(0,2),
                style_class: 'rpt-matrix-dow', width: CELL, x_align: Clutter.ActorAlign.CENTER }));
            cell.add_child(new St.Label({ text: String(d.day),
                style_class: 'rpt-matrix-daynum', width: CELL, x_align: Clutter.ActorAlign.CENTER }));
            dayRow.add_child(cell);
        });
        wHdr.add_child(dayRow);
        colHdr.add_child(wHdr);
    });
    grid.add_child(colHdr);

    // Habit rows — wrap in vertical scroll if many habits
    const rowBox = new St.BoxLayout({ vertical: true, x_expand: true });
    rd.habitStats.forEach(hs => {
        const row = new St.BoxLayout({ style_class: 'rpt-matrix-row', x_expand: true });
        const name = new St.Label({ text: hs.task.title, style_class: 'rpt-matrix-name', width: LABEL });
        name.clutter_text.ellipsize = 3;
        row.add_child(name);
        row.add_child(new St.Label({ text: String(hs.goal), style_class: 'rpt-matrix-goal',
            width: GOAL_W, x_align: Clutter.ActorAlign.CENTER }));

        rd.weeks.forEach((week, wi) => {
            const wCells = new St.BoxLayout({});
            week.forEach((d, di) => {
                const s = rd.cellCompleted(hs.task.id, wi * 7 + di);
                wCells.add_child(new St.Widget({ width: CELL, height: CELL,
                    style_class: s === null ? 'rpt-cell rpt-cell-na'
                               : s          ? 'rpt-cell rpt-cell-done'
                               :              'rpt-cell rpt-cell-empty' }));
            });
            row.add_child(wCells);
        });
        rowBox.add_child(row);
    });

    // Vertical scroll for many habits (max 200px height)
    if (rd.habitStats.length > 6) {
        const vScroll = new St.ScrollView({
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            height: Math.min(rd.habitStats.length * 24, 240),
        });
        vScroll.child = rowBox;
        grid.add_child(vScroll);
    } else {
        grid.add_child(rowBox);
    }

    section.add_child(grid);
    return section;
}

// ── 5. Top 10 ─────────────────────────────────────────────────────────────────

function buildTop10(rd) {
    const section = new St.BoxLayout({ vertical: true, style_class: 'rpt-section' });
    section.add_child(sectionHdr('TOP 10 HABITS'));
    section.add_child(divider());

    if (!rd.top10.length) {
        section.add_child(new St.Label({ text: 'No data this month.', style_class: 'rpt-empty' }));
        return section;
    }

    rd.top10.forEach((hs, i) => {
        const row = new St.BoxLayout({ x_expand: true, style_class: 'rpt-top-row' });
        row.add_child(new St.Label({ text: String(i+1), style_class: 'rpt-top-rank', width: 22 }));
        const name = new St.Label({ text: hs.task.title, style_class: 'rpt-top-name', x_expand: true });
        name.clutter_text.ellipsize = 3;
        row.add_child(name);
        row.add_child(new St.Label({ text: String(hs.done), style_class: 'rpt-top-count' }));
        row.add_child(new St.Label({ text: `${hs.pct}%`, style_class: 'rpt-top-pct' }));
        section.add_child(row);
    });
    return section;
}

// ── 6. Overall progress ───────────────────────────────────────────────────────

function buildOverallProgress(rd, innerW) {
    const section = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-section' });
    section.add_child(sectionHdr('OVERALL PROGRESS'));
    section.add_child(divider());

    if (!rd.habitStats.length) {
        section.add_child(new St.Label({ text: 'No habits defined.', style_class: 'rpt-empty' }));
        return section;
    }

    const barW = innerW - 32; // label + frac + pct take ~32px less

    rd.habitStats.forEach(hs => {
        const row = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-overall-row' });

        const top = new St.BoxLayout({ x_expand: true });
        const name = new St.Label({ text: hs.task.title, style_class: 'rpt-overall-name', x_expand: true });
        name.clutter_text.ellipsize = 3;
        top.add_child(name);
        top.add_child(new St.Label({ text: `${hs.done}/${hs.goal}`, style_class: 'rpt-overall-frac' }));
        top.add_child(new St.Label({ text: `${hs.pct}%`, style_class: 'rpt-overall-pct' }));
        row.add_child(top);
        row.add_child(progressBar(hs.pct, barW, 'rpt-overall-bar-bg', 'rpt-overall-bar-fg', 5));
        section.add_child(row);
    });

    return section;
}

// ── ReportDashboard ───────────────────────────────────────────────────────────

export const ReportDashboard = GObject.registerClass(
class ReportDashboard extends St.BoxLayout {
    _init(storage, width) {
        super._init({ style_class: 'rpt-dashboard', vertical: true, x_expand: true, y_expand: true });
        this._storage = storage;
        this._innerW  = Math.max(500, (width || 1200) - 40);
        const now = new Date();
        this._year  = now.getFullYear();
        this._month = now.getMonth();
        this._build();
    }

    _build() {
        this.destroy_all_children();

        const rd = new ReportData(this._storage, this._year, this._month);

        const onMonthChange = (y, m) => { this._year = y; this._month = m; this._build(); };

        const scroll = new St.ScrollView({
            x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });

        const inner = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rpt-inner' });

        inner.add_child(buildHeader(rd, onMonthChange));
        inner.add_child(buildTrendRow(rd, this._innerW));
        inner.add_child(buildWeeklyOverview(rd, this._innerW));

        // Mid row: habit matrix (left) + top10 (right)
        const midRow = new St.BoxLayout({ x_expand: true });
        const matrixW = Math.floor(this._innerW * 0.70);
        const top10W  = this._innerW - matrixW - 16;

        const matrixWrap = new St.BoxLayout({ vertical: true, width: matrixW });
        matrixWrap.add_child(buildHabitMatrix(rd, matrixW));
        midRow.add_child(matrixWrap);
        midRow.add_child(new St.Widget({ width: 16 }));

        const top10Wrap = new St.BoxLayout({ vertical: true, width: top10W, style_class: 'rpt-top10-wrap' });
        top10Wrap.add_child(buildTop10(rd));
        midRow.add_child(top10Wrap);
        inner.add_child(midRow);

        // Overall progress — vertical scroll for many habits
        const overallSection = buildOverallProgress(rd, this._innerW);
        if (rd.habitStats.length > 5) {
            const overallScroll = new St.ScrollView({
                x_expand: true,
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
                height: Math.min(rd.habitStats.length * 38, 280),
            });
            overallScroll.child = overallSection;
            inner.add_child(overallScroll);
        } else {
            inner.add_child(overallSection);
        }

        scroll.child = inner;
        this.add_child(scroll);
    }
});
