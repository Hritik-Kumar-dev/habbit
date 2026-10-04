/**
 * src/pulsePopover.js — PULSE main popover widget
 *
 * Single-column, top-to-bottom:
 *   ┌─────────────────────────────────┐
 *   │  PULSE   Sun, Oct 5   7/9 · 78% │  ← header
 *   ├─────────────────────────────────┤
 *   │  ○ Morning exercise  07:00–08:00 │  ← task list (scrollable)
 *   │  ● Read 30 min       08:30–09:00 │
 *   │  …                              │
 *   ├─────────────────────────────────┤
 *   │  [heatmap grid]  Less ░▒▓█ More │  ← compact heatmap
 *   ├─────────────────────────────────┤
 *   │  [⚙ Settings]      [📊 Report]  │  ← bottom bar
 *   └─────────────────────────────────┘
 *
 * Width: passed in from extension.js (default 480px).
 * All panels reuse the existing task list, heatmap, and styling.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { TaskState } from './taskManager.js';
import { Heatmap } from './heatmap.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function _dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _fmt(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const ap = h < 12 ? 'AM' : 'PM';
    return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ap}`;
}

function _todayLabel() {
    return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── TaskRow ────────────────────────────────────────────────────────────────────

const TaskRow = GObject.registerClass(
class TaskRow extends St.BoxLayout {
    _init(entry, onToggle, onEdit, onDelete) {
        super._init({
            style_class: `hp-task-row hp-task-${entry.state}`,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        this._entry = entry;
        this._ctxMenu = null;

        // Toggle button
        const btn = new St.Button({
            style_class: `hp-check-btn ${entry.completed ? 'hp-check-done' : ''}`,
            can_focus: true,
        });
        btn.child = new St.Icon({
            icon_name: entry.completed ? 'object-select-symbolic' : 'checkbox-symbolic',
            icon_size: 14,
            style_class: 'hp-check-icon',
        });
        btn.connect('clicked', () => onToggle(entry.taskId));
        this.add_child(btn);

        // Name
        const name = new St.Label({
            text: entry.title,
            style_class: `hp-task-name ${entry.completed ? 'hp-task-done-text' : ''}`,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        name.clutter_text.ellipsize = 3;
        this.add_child(name);

        // NOW badge
        if (entry.state === TaskState.CURRENT) {
            this.add_child(new St.Label({
                text: 'NOW',
                style_class: 'hp-badge hp-badge-now',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // from – to time (new schema) or legacy time
        const timeStr = (entry.from && entry.to)
            ? `${_fmt(entry.from)} – ${_fmt(entry.to)}`
            : _fmt(entry.time || entry.from || '');

        if (timeStr) {
            this.add_child(new St.Label({
                text: timeStr,
                style_class: 'hp-task-time',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // Right-click → edit/delete
        this.connect('button-press-event', (_a, event) => {
            if (event.get_button() === 3) {
                this._showCtxMenu(onEdit, onDelete);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _showCtxMenu(onEdit, onDelete) {
        if (this._ctxMenu) { this._ctxMenu.destroy(); this._ctxMenu = null; }
        this._ctxMenu = new St.BoxLayout({ style_class: 'hp-context-menu', vertical: true, reactive: true });
        const mk = (label, cls, cb) => {
            const b = new St.Button({ label, style_class: cls, x_expand: true });
            b.connect('clicked', () => { this._ctxMenu?.destroy(); this._ctxMenu = null; cb(); });
            return b;
        };
        this._ctxMenu.add_child(mk('Edit',   'hp-ctx-btn', () => onEdit(this._entry.taskId)));
        this._ctxMenu.add_child(mk('Delete', 'hp-ctx-btn hp-ctx-btn-delete', () => onDelete(this._entry.taskId)));
        const parent = this.get_parent();
        if (parent) parent.insert_child_at_index(this._ctxMenu, parent.get_children().indexOf(this) + 1);
    }
});

// ── AddHabitForm ───────────────────────────────────────────────────────────────

const AddHabitForm = GObject.registerClass(
class AddHabitForm extends St.BoxLayout {
    _init(prefill, onSubmit, onCancel) {
        super._init({ style_class: 'hp-add-form', vertical: true, x_expand: true });

        // Name
        this._nameEntry = new St.Entry({
            hint_text: 'Habit name…',
            style_class: 'hp-form-input',
            x_expand: true, can_focus: true,
        });
        if (prefill?.title) this._nameEntry.set_text(prefill.title);

        // From / To time row
        const timeRow = new St.BoxLayout({ style_class: 'hp-form-row', x_expand: true });
        this._fromEntry = new St.Entry({
            hint_text: 'From HH:MM', text: prefill?.from || '09:00',
            style_class: 'hp-form-input hp-form-time', can_focus: true,
        });
        const dash = new St.Label({ text: '–', style_class: 'hp-form-dash', y_align: Clutter.ActorAlign.CENTER });
        this._toEntry = new St.Entry({
            hint_text: 'To HH:MM', text: prefill?.to || '09:30',
            style_class: 'hp-form-input hp-form-time', can_focus: true,
        });
        timeRow.add_child(this._fromEntry);
        timeRow.add_child(dash);
        timeRow.add_child(this._toEntry);

        // Repeat cycle button
        this._repeatOptions = ['daily', 'Mon-Fri', 'Weekends', 'none'];
        const prefillRepeat = prefill?.repeat;
        this._repeatIdx = prefillRepeat === 'none' ? 3
            : (prefillRepeat && typeof prefillRepeat === 'object') ? (
                JSON.stringify(prefillRepeat.weekdays) === '[1,2,3,4,5]' ? 1 : 2
            ) : 0;
        this._repeatBtn = new St.Button({
            label: this._repeatLabel(),
            style_class: 'hp-repeat-btn', can_focus: true,
        });
        this._repeatBtn.connect('clicked', () => {
            this._repeatIdx = (this._repeatIdx + 1) % this._repeatOptions.length;
            this._repeatBtn.label = this._repeatLabel();
        });

        // Actions
        const actionRow = new St.BoxLayout({ style_class: 'hp-form-row hp-form-actions', x_expand: true });
        const submitBtn = new St.Button({ label: prefill ? 'Save' : 'Add', style_class: 'hp-form-submit', can_focus: true });
        submitBtn.connect('clicked', () => this._submit(onSubmit));
        const cancelBtn = new St.Button({ label: 'Cancel', style_class: 'hp-form-cancel', can_focus: true });
        cancelBtn.connect('clicked', onCancel);
        actionRow.add_child(submitBtn);
        actionRow.add_child(cancelBtn);

        const nameRow = new St.BoxLayout({ style_class: 'hp-form-row', x_expand: true });
        nameRow.add_child(this._nameEntry);

        this.add_child(nameRow);
        this.add_child(timeRow);
        this.add_child(this._repeatBtn);
        this.add_child(actionRow);

        // Enter submits, Escape cancels
        this._nameEntry.clutter_text.connect('key-press-event', (_a, ev) => {
            const s = ev.get_key_symbol();
            if (s === Clutter.KEY_Return || s === Clutter.KEY_KP_Enter) { this._submit(onSubmit); return Clutter.EVENT_STOP; }
            if (s === Clutter.KEY_Escape) { onCancel(); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this._nameEntry.grab_key_focus(); return GLib.SOURCE_REMOVE; });
    }

    _repeatLabel() {
        const r = this._repeatOptions[this._repeatIdx];
        return r === 'daily' ? 'Every day' : r === 'Mon-Fri' ? 'Mon – Fri' : r === 'Weekends' ? 'Weekends' : 'No repeat';
    }

    _repeatValue() {
        const r = this._repeatOptions[this._repeatIdx];
        if (r === 'daily') return 'daily';
        if (r === 'Mon-Fri') return { weekdays: [1,2,3,4,5] };
        if (r === 'Weekends') return { weekdays: [0,6] };
        return 'none';
    }

    _submit(onSubmit) {
        const title = this._nameEntry.get_text().trim();
        if (!title) return;
        onSubmit({
            title,
            from: this._fromEntry.get_text().trim() || '09:00',
            to:   this._toEntry.get_text().trim()   || '09:30',
            type: 'habit',
            repeat: this._repeatValue(),
        });
    }
});

// ── PulsePopover ──────────────────────────────────────────────────────────────

export const PulsePopover = GObject.registerClass(
class PulsePopover extends St.BoxLayout {
    _init(taskManager, extensionPath, width) {
        super._init({
            style_class: 'pulse-popover',
            vertical: true,
            width,
        });

        this._taskManager = taskManager;
        this._extensionPath = extensionPath;
        this._width = width;
        this._showingForm = false;
        this._editingTaskId = null;
        this._activeForm = null;

        this._buildHeader();
        this._buildTaskList();
        this._buildHeatmap();
        this._buildBottomBar();

        this._changedId = taskManager.connect('tasks-changed', () => this._refresh());
        this._rolledId  = taskManager.connect('day-rolled-over', () => {
            this._updateHeader();
            this._refresh();
        });
    }

    destroy() {
        if (this._changedId) { this._taskManager.disconnect(this._changedId); this._changedId = null; }
        if (this._rolledId)  { this._taskManager.disconnect(this._rolledId);  this._rolledId  = null; }
        super.destroy();
    }

    // ── Header ────────────────────────────────────────────────────────────────

    _buildHeader() {
        this._headerBox = new St.BoxLayout({
            style_class: 'pulse-header',
            x_expand: true,
        });

        // Left: PULSE wordmark
        const wordmark = new St.Label({ text: 'PULSE', style_class: 'pulse-wordmark' });
        this._headerBox.add_child(wordmark);

        // Middle: today's date
        this._dateLabel = new St.Label({
            text: _todayLabel(),
            style_class: 'pulse-header-date',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._headerBox.add_child(this._dateLabel);

        // Right: "7 / 9 · 78%"
        this._summaryLabel = new St.Label({
            style_class: 'pulse-header-summary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._headerBox.add_child(this._summaryLabel);

        this.add_child(this._headerBox);
        this._updateHeader();
    }

    _updateHeader() {
        const { completed, total, pct } = this._taskManager.getTodaySummary();
        this._dateLabel.set_text(_todayLabel());
        if (total === 0) {
            this._summaryLabel.set_text('No tasks');
        } else {
            this._summaryLabel.set_text(`${completed} / ${total} · ${pct}%`);
        }
    }

    // ── Task list ─────────────────────────────────────────────────────────────

    _buildTaskList() {
        this._taskScroll = new St.ScrollView({
            style_class: 'pulse-task-scroll',
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });

        this._taskListBox = new St.BoxLayout({
            style_class: 'hp-task-list',
            vertical: true,
            x_expand: true,
        });
        this._taskScroll.child = this._taskListBox;
        this.add_child(this._taskScroll);

        // "+ Add habit" button sits below scroll but above heatmap
        this._addBtn = new St.Button({
            label: '+ Add habit',
            style_class: 'hp-add-btn',
            x_expand: true,
            can_focus: true,
        });
        this._addBtn.connect('clicked', () => this._openAddForm());
        this.add_child(this._addBtn);

        this._renderTasks();
    }

    _renderTasks() {
        this._taskListBox.destroy_all_children();
        const tasks = this._taskManager.getTodayTasks();

        if (tasks.length === 0) {
            const empty = new St.Label({
                text: 'Nothing planned. Add a habit to get started.',
                style_class: 'hp-empty-msg',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            empty.clutter_text.line_wrap = true;
            this._taskListBox.add_child(empty);
            return;
        }

        for (const entry of tasks) {
            this._taskListBox.add_child(new TaskRow(
                entry,
                id => this._taskManager.toggleTask(id),
                id => this._openEditForm(id),
                id => this._taskManager.deleteTask(id),
            ));
        }
    }

    // ── Heatmap ───────────────────────────────────────────────────────────────

    _buildHeatmap() {
        const data = this._taskManager.getHeatmapData(84);
        this._heatmap = new Heatmap(data);

        const holder = new St.BoxLayout({ style_class: 'hp-heatmap-holder' });
        holder.add_child(this._heatmap);

        const scroll = new St.ScrollView({
            style_class: 'pulse-heatmap-scroll',
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
        });
        scroll.child = holder;
        this.add_child(scroll);

        // Legend row
        const legend = new St.BoxLayout({
            style_class: 'hp-legend',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        legend.add_child(new St.Label({ text: 'Less', style_class: 'hp-legend-label' }));
        for (let i = 0; i <= 4; i++) {
            legend.add_child(new St.Widget({ style_class: `hp-legend-cell hp-cell-l${i}`, width: 11, height: 11 }));
        }
        legend.add_child(new St.Label({ text: 'More', style_class: 'hp-legend-label' }));
        this.add_child(legend);
    }

    // ── Bottom bar ────────────────────────────────────────────────────────────

    _buildBottomBar() {
        const bar = new St.BoxLayout({
            style_class: 'pulse-bottom-bar',
            x_expand: true,
        });

        const settingsBtn = new St.Button({
            label: '⚙  Settings',
            style_class: 'pulse-bar-btn',
            x_expand: true,
            can_focus: true,
        });
        settingsBtn.connect('clicked', () => this._launchApp('settings'));

        const reportBtn = new St.Button({
            label: '📊  Report',
            style_class: 'pulse-bar-btn pulse-bar-btn-accent',
            x_expand: true,
            can_focus: true,
        });
        reportBtn.connect('clicked', () => this._launchApp('report'));

        bar.add_child(settingsBtn);
        bar.add_child(reportBtn);
        this.add_child(bar);
    }

    // ── Launch external apps ──────────────────────────────────────────────────

    _launchApp(appName) {
        const appPath = GLib.build_filenamev([this._extensionPath, 'apps', `${appName}.js`]);
        try {
            const proc = Gio.Subprocess.new(
                ['gjs', '-m', appPath],
                Gio.SubprocessFlags.NONE,
            );
            proc.wait_async(null, null);
        } catch (e) {
            console.error(`[PULSE] Failed to launch ${appName}:`, e.message);
        }
    }

    // ── Forms ─────────────────────────────────────────────────────────────────

    _openAddForm() {
        if (this._showingForm) return;
        this._showingForm = true;
        this._editingTaskId = null;
        this._activeForm = new AddHabitForm(
            null,
            def => { this._taskManager.addTask(def); this._closeForm(); },
            () => this._closeForm(),
        );
        // Insert above add button
        const addBtnIdx = this.get_children().indexOf(this._addBtn);
        this.insert_child_at_index(this._activeForm, addBtnIdx);
        this._addBtn.hide();
    }

    _openEditForm(taskId) {
        if (this._activeForm) { this._activeForm.destroy(); this._activeForm = null; }
        this._showingForm = true;
        this._editingTaskId = taskId;

        const tasks = this._taskManager._storage.getTasks();
        const def = tasks.find(t => t.id === taskId);
        if (!def) return;

        this._activeForm = new AddHabitForm(
            def,
            updates => { this._taskManager.updateTask(taskId, updates); this._closeForm(); },
            () => this._closeForm(),
        );
        const addBtnIdx = this.get_children().indexOf(this._addBtn);
        this.insert_child_at_index(this._activeForm, addBtnIdx);
        this._addBtn.hide();
    }

    _closeForm() {
        this._showingForm = false;
        this._editingTaskId = null;
        if (this._activeForm) { this._activeForm.destroy(); this._activeForm = null; }
        this._addBtn.show();
    }

    // ── Refresh ───────────────────────────────────────────────────────────────

    _refresh() {
        this._updateHeader();
        this._renderTasks();
        const data = this._taskManager.getHeatmapData(84);
        this._heatmap.update(data);
    }
});
