#!/usr/bin/env -S gjs -m
/**
 * apps/report.js — PULSE Monthly Report
 *
 * Full-screen GTK4/libadwaita window.
 * Reads ~/.local/share/pulse@hritikdev/data.json — offline, no network.
 *
 * Sections:
 *   1. Month/year selector
 *   2. Daily completion % area chart  (Cairo)
 *   3. Donut: completed vs remaining  (Cairo)
 *   4. Week-by-week table: per-day bars, Completed/Goal/Left rows
 *   5. Habit grid: rows = habits, cols = days, clickable cells
 *   6. Per-habit progress bars
 *
 * Run standalone: gjs -m apps/report.js
 */

import Adw from 'gi://Adw';
import Cairo from 'gi://cairo';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
    bg:       [0.067, 0.075, 0.094],   // #111318
    panel:    [0.106, 0.118, 0.141],   // #1B1E24
    border:   [0.165, 0.180, 0.220],   // #2A2E38
    blue:     [0.294, 0.620, 1.000],   // #4B9EFF
    blueA:    [0.118, 0.329, 0.549],   // #1E5497
    purple:   [0.486, 0.361, 0.749],   // #7C5CBF
    text:     [0.949, 0.949, 0.949],   // #F2F2F2
    muted:    [0.627, 0.643, 0.678],   // #A0A4AD
    dim:      [0.353, 0.369, 0.408],   // #5A5E68
};

function setColor(cr, [r,g,b], a=1) { cr.setSourceRGBA(r,g,b,a); }

// ── Data helpers ──────────────────────────────────────────────────────────────

const DATA_PATH = GLib.build_filenamev([GLib.get_user_data_dir(), 'pulse@hritikdev', 'data.json']);

function loadData() {
    try {
        const [, b] = Gio.File.new_for_path(DATA_PATH).load_contents(null);
        return JSON.parse(new TextDecoder().decode(b));
    } catch (_) {
        return { version: 2, tasks: [], days: {} };
    }
}

function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
}

function dateKey(year, month, day) {
    return `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

/** Get all day records for a given month. Returns array[1..daysInMonth]. */
function monthData(data, year, month) {
    const n = daysInMonth(year, month);
    const result = [];
    for (let d = 1; d <= n; d++) {
        const key = dateKey(year, month, d);
        const rec = data.days[key];
        result.push({
            day: d,
            key,
            pct: rec ? rec.completionPct : null,   // null = no data
            tasks: rec ? rec.tasks : [],
            dow: new Date(year, month, d).getDay(),
        });
    }
    return result;
}

/** Split days array into ISO weeks (Mon-start). */
function splitIntoWeeks(days) {
    const weeks = [];
    let week = [];
    for (const d of days) {
        const row = d.dow === 0 ? 6 : d.dow - 1; // Mon=0
        if (row === 0 && week.length > 0) { weeks.push(week); week = []; }
        week.push(d);
    }
    if (week.length) weeks.push(week);
    return weeks;
}

// ── Cairo drawing helpers ─────────────────────────────────────────────────────

function roundedRect(cr, x, y, w, h, r) {
    cr.newPath();
    cr.arc(x + r,     y + r,     r, Math.PI,       1.5*Math.PI);
    cr.arc(x + w - r, y + r,     r, 1.5*Math.PI,   2*Math.PI);
    cr.arc(x + w - r, y + h - r, r, 0,              0.5*Math.PI);
    cr.arc(x + r,     y + h - r, r, 0.5*Math.PI,   Math.PI);
    cr.closePath();
}

function drawText(cr, text, x, y, size, color, bold=false) {
    const layout = PangoCairo.createLayout(cr);
    const desc = Pango.FontDescription.from_string(`${bold ? 'Bold ' : ''}${size}`);
    layout.set_font_description(desc);
    layout.set_text(text, -1);
    setColor(cr, color);
    cr.moveTo(x, y);
    PangoCairo.showLayout(cr, layout);
}

function textSize(cr, text, size, bold=false) {
    const layout = PangoCairo.createLayout(cr);
    const desc = Pango.FontDescription.from_string(`${bold ? 'Bold ' : ''}${size}`);
    layout.set_font_description(desc);
    layout.set_text(text, -1);
    const [w, h] = layout.get_pixel_size();
    return [w, h];
}

// ── Area chart (daily completion %) ──────────────────────────────────────────

const AreaChart = GObject.registerClass(
class AreaChart extends Gtk.DrawingArea {
    _init(days) {
        super._init({ height_request: 120, hexpand: true });
        this._days = days;
        this.set_draw_func((_area, cr, w, h) => this._draw(cr, w, h));
    }

    update(days) { this._days = days; this.queue_draw(); }

    _draw(cr, w, h) {
        const pad = { l: 32, r: 12, t: 12, b: 24 };
        const gw = w - pad.l - pad.r;
        const gh = h - pad.t - pad.b;

        // Background
        setColor(cr, C.panel);
        roundedRect(cr, 0, 0, w, h, 8);
        cr.fill();

        const days = this._days.filter(d => d.pct !== null);
        if (days.length === 0) return;

        const n = this._days.length;
        const xStep = gw / Math.max(n - 1, 1);

        const pts = this._days.map((d, i) => ({
            x: pad.l + i * xStep,
            y: pad.t + (d.pct !== null ? (100 - d.pct) / 100 * gh : gh),
            hasData: d.pct !== null,
        }));

        // Area fill
        cr.newPath();
        cr.moveTo(pts[0].x, pad.t + gh);
        for (const p of pts) cr.lineTo(p.x, p.y);
        cr.lineTo(pts[pts.length-1].x, pad.t + gh);
        cr.closePath();
        setColor(cr, C.blue, 0.15);
        cr.fill();

        // Line
        cr.newPath();
        let started = false;
        for (const p of pts) {
            if (!p.hasData) { started = false; continue; }
            if (!started) { cr.moveTo(p.x, p.y); started = true; }
            else cr.lineTo(p.x, p.y);
        }
        setColor(cr, C.blue);
        cr.setLineWidth(2);
        cr.stroke();

        // Axes
        setColor(cr, C.dim);
        cr.setLineWidth(1);
        cr.moveTo(pad.l, pad.t);
        cr.lineTo(pad.l, pad.t + gh);
        cr.lineTo(pad.l + gw, pad.t + gh);
        cr.stroke();

        // Y labels: 0%, 50%, 100%
        for (const pct of [0, 50, 100]) {
            const y = pad.t + (100 - pct) / 100 * gh;
            drawText(cr, `${pct}%`, 0, y - 6, '9', C.dim);
        }

        // X: show day numbers for first day of each week
        for (let i = 0; i < this._days.length; i++) {
            if (this._days[i].dow === 1 || i === 0) {
                const x = pad.l + i * xStep;
                drawText(cr, String(this._days[i].day), x - 4, pad.t + gh + 4, '9', C.dim);
            }
        }
    }
});

// ── Donut chart ───────────────────────────────────────────────────────────────

const DonutChart = GObject.registerClass(
class DonutChart extends Gtk.DrawingArea {
    _init(completed, total) {
        super._init({ width_request: 180, height_request: 180 });
        this._completed = completed;
        this._total = total;
        this.set_draw_func((_a, cr, w, h) => this._draw(cr, w, h));
    }

    update(completed, total) { this._completed = completed; this._total = total; this.queue_draw(); }

    _draw(cr, w, h) {
        const cx = w / 2, cy = h / 2;
        const R = Math.min(w, h) * 0.42;
        const r = R * 0.58;

        setColor(cr, C.panel);
        roundedRect(cr, 0, 0, w, h, 8);
        cr.fill();

        const total = this._total || 1;
        const done  = Math.min(this._completed, total);
        const frac  = done / total;

        // Background arc (remaining)
        cr.setLineWidth(R - r);
        setColor(cr, C.border);
        cr.arc(cx, cy, (R+r)/2, 0, 2*Math.PI);
        cr.stroke();

        // Completed arc
        if (frac > 0) {
            setColor(cr, C.blue);
            cr.arc(cx, cy, (R+r)/2, -Math.PI/2, -Math.PI/2 + 2*Math.PI*frac);
            cr.stroke();
        }

        // Centre text
        const pct = total > 0 ? Math.round(frac * 100) : 0;
        const pctStr = `${pct}%`;
        const [pw] = textSize(cr, pctStr, '20', true);
        drawText(cr, pctStr, cx - pw/2, cy - 14, '20', C.text, true);

        const subStr = `${done}/${total}`;
        const [sw] = textSize(cr, subStr, '10', false);
        drawText(cr, subStr, cx - sw/2, cy + 4, '10', C.muted);

        const label = 'Monthly';
        const [lw] = textSize(cr, label, '9', false);
        drawText(cr, label, cx - lw/2, cy + 18, '9', C.dim);
    }
});

// ── Week bars ─────────────────────────────────────────────────────────────────

const WeekBars = GObject.registerClass(
class WeekBars extends Gtk.DrawingArea {
    _init(weeks, data) {
        super._init({ height_request: 160, hexpand: true });
        this._weeks = weeks;
        this._data  = data;
        this.set_draw_func((_a, cr, w, h) => this._draw(cr, w, h));
    }

    update(weeks, data) { this._weeks = weeks; this._data = data; this.queue_draw(); }

    _draw(cr, w, h) {
        setColor(cr, C.panel);
        roundedRect(cr, 0, 0, w, h, 8);
        cr.fill();

        const nWeeks = this._weeks.length;
        if (nWeeks === 0) return;

        const pad = { l: 8, r: 8, t: 20, b: 8 };
        const secW = (w - pad.l - pad.r) / nWeeks;

        this._weeks.forEach((week, wi) => {
            const sx = pad.l + wi * secW;
            const nDays = week.length;
            const barW  = Math.floor((secW - 16) / nDays);
            const maxH  = h - pad.t - pad.b - 20;

            // Week label
            const weekNum = wi + 1;
            const [lw] = textSize(cr, `W${weekNum}`, '9', false);
            drawText(cr, `W${weekNum}`, sx + secW/2 - lw/2, pad.t - 14, '9', C.muted);

            week.forEach((day, di) => {
                const bx = sx + 8 + di * barW;
                const pct = day.pct ?? 0;
                const bh  = Math.max(2, Math.round(pct / 100 * maxH));
                const by  = pad.t + maxH - bh;

                // Bar
                const alpha = day.pct !== null ? 1 : 0.25;
                setColor(cr, C.blue, alpha);
                roundedRect(cr, bx, by, barW - 2, bh, 2);
                cr.fill();

                // Day number below
                const dayStr = String(day.day);
                const [dw] = textSize(cr, dayStr, '8', false);
                drawText(cr, dayStr, bx + (barW-2)/2 - dw/2, pad.t + maxH + 2, '8', C.dim);
            });
        });
    }
});

// ── Habit grid ────────────────────────────────────────────────────────────────

function buildHabitGrid(data, days, tasks) {
    const CELL = 28;
    const COL_W = CELL;
    const LABEL_W = 160;

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });

    // Header row: day numbers
    const headerBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
    const spacer = new Gtk.Label({ label: '', width_request: LABEL_W });
    headerBox.append(spacer);
    for (const d of days) {
        const lbl = new Gtk.Label({
            label: String(d.day),
            width_request: COL_W,
            css_classes: ['caption', 'dim-label'],
            halign: Gtk.Align.CENTER,
        });
        headerBox.append(lbl);
    }
    box.append(headerBox);

    // Build task completion map: taskId → { dayKey: completed }
    const completionMap = {};
    for (const d of days) {
        for (const entry of d.tasks) {
            if (!completionMap[entry.taskId]) completionMap[entry.taskId] = {};
            completionMap[entry.taskId][d.key] = entry.completed;
        }
    }

    // One row per defined task
    for (const task of tasks) {
        const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });

        const label = new Gtk.Label({
            label: task.title,
            width_request: LABEL_W,
            halign: Gtk.Align.START,
            ellipsize: Pango.EllipsizeMode.END,
            css_classes: ['caption'],
            tooltip_text: task.title,
            margin_end: 4,
        });
        row.append(label);

        for (const d of days) {
            const completed = completionMap[task.id]?.[d.key];
            const hasData   = d.tasks.some(e => e.taskId === task.id);

            // Small colored square
            const cell = new Gtk.DrawingArea({
                width_request: COL_W,
                height_request: COL_W,
            });
            cell.set_draw_func((_a, cr, _w, _h) => {
                if (!hasData) {
                    setColor(cr, C.dim, 0.2);
                } else if (completed) {
                    setColor(cr, C.blue, 0.9);
                } else {
                    setColor(cr, C.dim, 0.5);
                }
                roundedRect(cr, 3, 3, COL_W - 6, COL_W - 6, 3);
                cr.fill();
            });
            row.append(cell);
        }

        box.append(row);
    }

    return box;
}

// ── Per-habit progress bars ───────────────────────────────────────────────────

function buildHabitProgress(days, tasks) {
    const group = new Adw.PreferencesGroup({ title: 'Habit Progress' });

    for (const task of tasks) {
        let total = 0, done = 0;
        for (const d of days) {
            const entry = d.tasks.find(e => e.taskId === task.id);
            if (entry) { total++; if (entry.completed) done++; }
        }
        const pct = total > 0 ? Math.round(done / total * 100) : 0;

        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(task.title, -1),
            subtitle: `${done} / ${total} · ${pct}%`,
        });

        const bar = new Gtk.ProgressBar({
            fraction: total > 0 ? done / total : 0,
            width_request: 120,
            valign: Gtk.Align.CENTER,
        });
        bar.add_css_class('accent');
        row.add_suffix(bar);
        group.add(row);
    }

    return group;
}

// ── Top 10 habits ─────────────────────────────────────────────────────────────

function buildTop10(days, tasks) {
    const stats = tasks.map(task => {
        let total = 0, done = 0;
        for (const d of days) {
            const e = d.tasks.find(e => e.taskId === task.id);
            if (e) { total++; if (e.completed) done++; }
        }
        return { task, done, total, pct: total > 0 ? done/total : 0 };
    });
    stats.sort((a, b) => b.pct - a.pct);
    const top = stats.slice(0, 10);

    const group = new Adw.PreferencesGroup({ title: 'Top 10 Habits this Month' });
    top.forEach(({ task, done, total, pct }, rank) => {
        const row = new Adw.ActionRow({
            title: `${rank + 1}. ${GLib.markup_escape_text(task.title, -1)}`,
            subtitle: `${done} / ${total} · ${Math.round(pct * 100)}%`,
        });
        group.add(row);
    });
    if (top.length === 0) {
        group.add(new Adw.ActionRow({ title: 'No data this month' }));
    }
    return group;
}

// ── ReportWindow ──────────────────────────────────────────────────────────────

const ReportWindow = GObject.registerClass(
class ReportWindow extends Adw.ApplicationWindow {
    _init(app) {
        super._init({
            application: app,
            title: 'PULSE — Monthly Report',
            default_width: 900,
            default_height: 720,
            fullscreened: false,
        });

        const now = new Date();
        this._year  = now.getFullYear();
        this._month = now.getMonth();
        this._data  = loadData();

        const toolbar = new Adw.ToolbarView();
        this.set_content(toolbar);

        const header = new Adw.HeaderBar();
        toolbar.add_top_bar(header);

        // Month navigation
        const prevBtn = new Gtk.Button({ icon_name: 'go-previous-symbolic' });
        prevBtn.connect('clicked', () => this._changeMonth(-1));
        header.pack_start(prevBtn);

        this._monthLabel = new Gtk.Label({ css_classes: ['heading'] });
        header.set_title_widget(this._monthLabel);

        const nextBtn = new Gtk.Button({ icon_name: 'go-next-symbolic' });
        nextBtn.connect('clicked', () => this._changeMonth(1));
        header.pack_end(nextBtn);

        // Main scroll
        const scroll = new Gtk.ScrolledWindow({ vexpand: true });
        toolbar.set_content(scroll);

        this._mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 16,
            margin_top: 16,
            margin_bottom: 16,
            margin_start: 16,
            margin_end: 16,
        });
        scroll.set_child(this._mainBox);

        this._buildReport();
    }

    _changeMonth(delta) {
        this._month += delta;
        if (this._month < 0)  { this._month = 11; this._year--; }
        if (this._month > 11) { this._month = 0;  this._year++; }
        this._buildReport();
    }

    _buildReport() {
        // Clear
        let child = this._mainBox.get_first_child();
        while (child) { const n = child.get_next_sibling(); this._mainBox.remove(child); child = n; }

        const MONTH_NAMES = ['January','February','March','April','May','June',
                             'July','August','September','October','November','December'];
        this._monthLabel.set_label(`${MONTH_NAMES[this._month]} ${this._year}`);

        const days  = monthData(this._data, this._year, this._month);
        const weeks = splitIntoWeeks(days);
        const tasks = this._data.tasks;

        // ── Row 1: area chart + donut side-by-side ──
        const row1 = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });

        this._areaChart = new AreaChart(days);
        row1.append(this._areaChart);

        // Compute monthly totals for donut
        let monthTotal = 0, monthDone = 0;
        for (const d of days) {
            monthTotal += d.tasks.length;
            monthDone  += d.tasks.filter(t => t.completed).length;
        }
        this._donut = new DonutChart(monthDone, monthTotal);
        row1.append(this._donut);

        this._mainBox.append(row1);

        // ── Row 2: weekly summary title ──
        const weekTitle = new Gtk.Label({
            label: 'Week by Week',
            css_classes: ['heading'],
            halign: Gtk.Align.START,
        });
        this._mainBox.append(weekTitle);

        // ── Row 3: week bar chart ──
        this._weekBars = new WeekBars(weeks, this._data);
        this._mainBox.append(this._weekBars);

        // Per-week stat rows
        for (const week of weeks) {
            const wBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
            let wTotal = 0, wDone = 0;
            for (const d of week) {
                wTotal += d.tasks.length;
                wDone  += d.tasks.filter(t => t.completed).length;
            }
            const wPct = wTotal > 0 ? Math.round(wDone/wTotal*100) : 0;
            const wLbl = new Gtk.Label({
                label: `${wDone}/${wTotal}  ·  ${wPct}%`,
                css_classes: ['caption', 'dim-label'],
            });
            const wBar = new Gtk.ProgressBar({ fraction: wTotal > 0 ? wDone/wTotal : 0, hexpand: true, valign: Gtk.Align.CENTER });
            wBar.add_css_class('accent');
            wBox.append(wLbl);
            wBox.append(wBar);
            this._mainBox.append(wBox);
        }

        // ── Row 4: habit grid ──
        if (tasks.length > 0) {
            const gridTitle = new Gtk.Label({
                label: 'Habit Grid',
                css_classes: ['heading'],
                halign: Gtk.Align.START,
            });
            this._mainBox.append(gridTitle);

            const gridScroll = new Gtk.ScrolledWindow({
                hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
                vscrollbar_policy: Gtk.PolicyType.NEVER,
                height_request: Math.min(tasks.length * 32 + 40, 280),
            });
            gridScroll.set_child(buildHabitGrid(this._data, days, tasks));
            this._mainBox.append(gridScroll);

            // ── Row 5: per-habit progress ──
            this._mainBox.append(buildHabitProgress(days, tasks));

            // ── Row 6: top 10 ──
            this._mainBox.append(buildTop10(days, tasks));
        } else {
            this._mainBox.append(new Gtk.Label({
                label: 'No habits defined yet. Open Settings to add some.',
                css_classes: ['dim-label'],
                halign: Gtk.Align.CENTER,
                margin_top: 40,
            }));
        }
    }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const app = new Adw.Application({
    application_id: 'dev.hritik.pulse.Report',
    flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
});

app.connect('activate', () => {
    let win = app.get_active_window();
    if (!win) win = new ReportWindow(app);
    win.present();
});

app.run([]);
