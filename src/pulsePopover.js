/**
 * src/pulsePopover.js — PULSE main popover widget
 *
 * Layout
 * ──────
 * ┌────────────────────────────────────────────────────┐
 * │  PULSE        Sun, Oct 5            7/9 · 78%  ⚙ 📊│  header (full width)
 * ├───────────────────────────┬────────────────────────┤
 * │  Task name   07:00–07:30  │  [12-week heatmap]     │
 * │  Task name   08:00–08:30  │  Less ░▒▓█ More        │
 * │  …           (scrollable) │  ──────────────────    │
 * │                           │  7 / 9 completed       │
 * │  + Add habit              │  78% today             │
 * └───────────────────────────┴────────────────────────┘
 *
 * Golden ratio: left = 61.8%, right = 38.2%, 12px gap, 16px outer padding.
 *
 * View switching (no new window, no subprocess):
 *   main     → the two-column layout above
 *   settings → St-widget settings form (add / edit / delete habits)
 *   report   → placeholder (spec supplied separately)
 *
 * Hover flicker fixes applied:
 *   - Tooltip is ONE persistent St.Label; repositioned/updated in place.
 *   - Task rows are NOT recreated on hover; only rebuilt when data changes.
 *   - CSS hover states change only color/opacity, never geometry.
 *   - No enter/leave signal handlers on rows; :hover pseudo-class in CSS.
 *   - reactive:true only on cells/buttons that need it.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { TaskState } from './taskManager.js';
import { Heatmap } from './heatmap.js';
import { ReportDashboard } from './reportView.js';

// ── Theme helpers ──────────────────────────────────────────────────────────────

const THEMES = [
    { id: 'dark-blue',     label: 'Dark Blue',     desc: 'Default dark + blue accent' },
    { id: 'dark-purple',   label: 'Dark Purple',   desc: 'Dark + purple accent' },
    { id: 'dark-gray',     label: 'Dark Gray',     desc: 'Neutral dark gray' },
    { id: 'dark-original', label: 'Dark Original', desc: 'Pure dark, minimal color' },
    { id: 'light',         label: 'Light',         desc: 'Light mode' },
];

const PREFS_PATH = GLib.build_filenamev([GLib.get_user_data_dir(), 'pulse@hritikdev', 'prefs.json']);

function _loadPrefs() {
    try {
        const [, b] = Gio.File.new_for_path(PREFS_PATH).load_contents(null);
        return JSON.parse(new TextDecoder().decode(b));
    } catch (_) { return { theme: 'dark-blue' }; }
}

function _savePrefs(prefs) {
    try {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'pulse@hritikdev']);
        Gio.File.new_for_path(dir).make_directory_with_parents(null);
    } catch (_) {}
    try {
        const tmp = `${PREFS_PATH}.tmp`;
        const out = Gio.File.new_for_path(tmp).replace(null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        out.write_all(new TextEncoder().encode(JSON.stringify(prefs, null, 2)), null);
        out.close(null);
        GLib.rename(tmp, PREFS_PATH);
    } catch (e) { console.error('[PULSE] prefs save failed:', e.message); }
}

// ── Layout constants ──────────────────────────────────────────────────────────

const PHI          = 1.618033988749895;
const LEFT_FRAC    = PHI / (1 + PHI);   // ≈ 0.618
const OUTER_PAD    = 16;                 // px, matches CSS padding
const COL_GAP      = 12;                 // px gap between columns

// ── Helpers ───────────────────────────────────────────────────────────────────

function _fmt(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function _todayLabel() {
    return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function _toMins(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
}

// ── TaskRow ────────────────────────────────────────────────────────────────────
//
// Layout: [task name x_expand] [from–to time] [action control]
//
// Action control:
//   unchecked → "Mark as done" pill button (muted, blue on hover)
//   checked   → green check icon (no label, no circle)
//
// Hover flicker fix:
//   - No enter/leave handlers. :hover in CSS only.
//   - No geometry changes on hover (border always present, just color changes).
//   - Context menu inserted as sibling, not recreated on hover.

const TaskRow = GObject.registerClass(
class TaskRow extends St.BoxLayout {
    _init(entry, onToggle, onEdit, onDelete) {
        super._init({
            style_class: `pulse-task-row pulse-task-${entry.state}`,
            // reactive needed for right-click context menu
            reactive: true,
            x_expand: true,
        });
        this._entry   = entry;
        this._ctxMenu = null;

        // ── Name ──
        const name = new St.Label({
            text: entry.title,
            style_class: entry.completed ? 'pulse-task-name pulse-task-done-text' : 'pulse-task-name',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        name.clutter_text.ellipsize = 3; // END
        this.add_child(name);

        // ── NOW badge (current window) ──
        if (entry.state === TaskState.CURRENT) {
            this.add_child(new St.Label({
                text: 'NOW',
                style_class: 'hp-badge hp-badge-now',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // ── Time range ──
        const timeStr = (entry.from && entry.to)
            ? `${_fmt(entry.from)} – ${_fmt(entry.to)}`
            : _fmt(entry.time || entry.from || '');
        if (timeStr) {
            this.add_child(new St.Label({
                text: timeStr,
                style_class: 'pulse-task-time',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // ── Action: "Mark as done" pill OR green check ──
        if (entry.completed) {
            // Green check icon — no button frame
            const check = new St.Icon({
                icon_name: 'object-select-symbolic',
                icon_size: 14,
                style_class: 'pulse-done-icon',
                reactive: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            // Clicking the check also un-toggles
            check.connect('button-press-event', () => { onToggle(entry.taskId); return Clutter.EVENT_STOP; });
            this.add_child(check);
        } else {
            // "Mark as done" pill
            const pill = new St.Button({
                label: 'Mark as done',
                style_class: 'pulse-mark-btn',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            pill.connect('clicked', () => onToggle(entry.taskId));
            this.add_child(pill);
        }

        // ── Right-click → edit / delete ──
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
        this._ctxMenu = new St.BoxLayout({
            style_class: 'hp-context-menu',
            vertical: true,
            reactive: true,
        });
        const mk = (label, cls, cb) => {
            const b = new St.Button({ label, style_class: cls, x_expand: true });
            b.connect('clicked', () => {
                this._ctxMenu?.destroy();
                this._ctxMenu = null;
                cb();
            });
            return b;
        };
        this._ctxMenu.add_child(mk('Edit',   'hp-ctx-btn',                    () => onEdit(this._entry.taskId)));
        this._ctxMenu.add_child(mk('Delete', 'hp-ctx-btn hp-ctx-btn-delete',  () => onDelete(this._entry.taskId)));
        const parent = this.get_parent();
        if (parent)
            parent.insert_child_at_index(this._ctxMenu, parent.get_children().indexOf(this) + 1);
    }
});

// ── AddHabitForm (St widgets, used in settings view) ─────────────────────────

const AddHabitForm = GObject.registerClass(
class AddHabitForm extends St.BoxLayout {
    _init(prefill, onSubmit, onCancel) {
        super._init({ style_class: 'hp-add-form', vertical: true, x_expand: true });

        // Name
        const nameRow = new St.BoxLayout({ style_class: 'hp-form-row', x_expand: true });
        this._nameEntry = new St.Entry({
            hint_text: 'Habit name…',
            style_class: 'hp-form-input',
            x_expand: true,
            can_focus: true,
        });
        if (prefill?.title) this._nameEntry.set_text(prefill.title);
        nameRow.add_child(this._nameEntry);
        this.add_child(nameRow);

        // From – To row
        const timeRow = new St.BoxLayout({ style_class: 'hp-form-row', x_expand: true });
        this._fromEntry = new St.Entry({
            hint_text: 'From',
            text: prefill?.from || '09:00',
            style_class: 'hp-form-input hp-form-time',
            can_focus: true,
        });
        const dash = new St.Label({
            text: '–',
            style_class: 'hp-form-dash',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._toEntry = new St.Entry({
            hint_text: 'To',
            text: prefill?.to || '09:30',
            style_class: 'hp-form-input hp-form-time',
            can_focus: true,
        });
        timeRow.add_child(this._fromEntry);
        timeRow.add_child(dash);
        timeRow.add_child(this._toEntry);
        this.add_child(timeRow);

        // Repeat every day toggle row
        const repeatRow = new St.BoxLayout({ style_class: 'hp-form-row', x_expand: true });
        const repeatLbl = new St.Label({
            text: 'Repeat every day',
            style_class: 'hp-form-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dailyToggle = new St.Button({
            style_class: 'pulse-toggle',
            can_focus: true,
            toggle_mode: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const isDaily = !prefill || prefill.repeat === 'daily' || !prefill.repeat;
        this._dailyToggle.checked = isDaily;
        this._dailyToggle.label = isDaily ? 'ON' : 'OFF';
        this._dailyToggle.style_class = isDaily ? 'pulse-toggle pulse-toggle-on' : 'pulse-toggle';
        this._dailyToggle.connect('clicked', () => {
            const on = this._dailyToggle.checked;
            this._dailyToggle.label = on ? 'ON' : 'OFF';
            this._dailyToggle.style_class = on
                ? 'pulse-toggle pulse-toggle-on'
                : 'pulse-toggle';
            this._updateWeekdayChips();
        });
        repeatRow.add_child(repeatLbl);
        repeatRow.add_child(this._dailyToggle);
        this.add_child(repeatRow);

        // Weekday chips row (visible when daily is off)
        const DAYS = ['Su','Mo','Tu','We','Th','Fr','Sa'];
        const prefillDays = prefill?.repeat?.weekdays;
        this._chipRow = new St.BoxLayout({ style_class: 'pulse-chip-row', x_expand: true });
        this._chips = DAYS.map((d, i) => {
            const chip = new St.Button({
                label: d,
                style_class: 'pulse-day-chip',
                toggle_mode: true,
                can_focus: true,
            });
            chip.checked = prefillDays ? prefillDays.includes(i) : true;
            chip.style_class = chip.checked ? 'pulse-day-chip pulse-day-chip-on' : 'pulse-day-chip';
            chip.connect('clicked', () => {
                chip.style_class = chip.checked ? 'pulse-day-chip pulse-day-chip-on' : 'pulse-day-chip';
            });
            this._chipRow.add_child(chip);
            return chip;
        });
        this.add_child(this._chipRow);
        this._updateWeekdayChips();

        // Validation message
        this._validationLbl = new St.Label({
            text: '⚠ End time must be after start time',
            style_class: 'pulse-form-error',
        });
        this._validationLbl.hide();
        this.add_child(this._validationLbl);

        // Actions
        const actionRow = new St.BoxLayout({ style_class: 'hp-form-row hp-form-actions', x_expand: true });
        const submitBtn = new St.Button({
            label: prefill ? 'Save' : 'Add',
            style_class: 'hp-form-submit',
            can_focus: true,
        });
        submitBtn.connect('clicked', () => this._submit(onSubmit));
        const cancelBtn = new St.Button({
            label: 'Cancel',
            style_class: 'hp-form-cancel',
            can_focus: true,
        });
        cancelBtn.connect('clicked', onCancel);
        actionRow.add_child(submitBtn);
        actionRow.add_child(cancelBtn);
        this.add_child(actionRow);

        // Keyboard shortcuts
        this._nameEntry.clutter_text.connect('key-press-event', (_a, ev) => {
            const s = ev.get_key_symbol();
            if (s === Clutter.KEY_Return || s === Clutter.KEY_KP_Enter) {
                this._submit(onSubmit);
                return Clutter.EVENT_STOP;
            }
            if (s === Clutter.KEY_Escape) {
                onCancel();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._nameEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateWeekdayChips() {
        this._chipRow.visible = !this._dailyToggle.checked;
    }

    _repeatValue() {
        if (this._dailyToggle.checked) return 'daily';
        const sel = this._chips.map((c, i) => c.checked ? i : -1).filter(i => i >= 0);
        if (sel.length === 0) return 'none';
        if (sel.length === 7) return 'daily';
        return { weekdays: sel };
    }

    _submit(onSubmit) {
        const title = this._nameEntry.get_text().trim();
        if (!title) return;
        const from = this._fromEntry.get_text().trim() || '09:00';
        const to   = this._toEntry.get_text().trim()   || '09:30';
        if (_toMins(to) <= _toMins(from)) {
            this._validationLbl.show();
            return;
        }
        this._validationLbl.hide();
        onSubmit({ title, from, to, type: 'habit', repeat: this._repeatValue() });
    }
});

// ── SettingsView ──────────────────────────────────────────────────────────────

const SettingsView = GObject.registerClass(
class SettingsView extends St.BoxLayout {
    _init(taskManager, onBack) {
        super._init({ style_class: 'pulse-view', vertical: true, x_expand: true, y_expand: true });

        this._taskManager = taskManager;
        this._activeForm  = null;

        // ── Top bar ───────────────────────────────────────────────────────────
        const topBar = new St.BoxLayout({ style_class: 'pulse-view-topbar', x_expand: true });
        const backBtn = new St.Button({ label: '← Back', style_class: 'pulse-back-btn', can_focus: true });
        backBtn.connect('clicked', () => { this._closeForm(); onBack(); });
        topBar.add_child(backBtn);
        topBar.add_child(new St.Label({
            text: 'Settings', style_class: 'pulse-view-title',
            x_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        }));
        const addBtn = new St.Button({ label: '+', style_class: 'pulse-view-add-btn', can_focus: true });
        addBtn.connect('clicked', () => this._openAddForm());
        topBar.add_child(addBtn);
        this.add_child(topBar);

        // ── Two-column body ───────────────────────────────────────────────────
        // LEFT: habit list + add form
        // RIGHT: appearance settings (themes, future options)
        const body = new St.BoxLayout({ x_expand: true, y_expand: true });

        // Left column — scrollable habit list
        const leftCol = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });

        leftCol.add_child(new St.Label({ text: 'HABITS', style_class: 'pulse-settings-section-hdr' }));

        this._scroll = new St.ScrollView({
            style_class: 'pulse-settings-scroll',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._listBox = new St.BoxLayout({ style_class: 'pulse-settings-list', vertical: true, x_expand: true });
        this._scroll.child = this._listBox;
        leftCol.add_child(this._scroll);

        // Form mount below list (inside left col)
        this._formMount = new St.BoxLayout({ vertical: true, x_expand: true });
        leftCol.add_child(this._formMount);

        body.add_child(leftCol);

        // Divider
        body.add_child(new St.Widget({ style_class: 'pulse-settings-divider', width: 1 }));

        // Right column — appearance + future settings, scrollable
        const rightScroll = new St.ScrollView({
            style_class: 'pulse-settings-right-scroll',
            x_expand: false,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            width: 220,
        });
        this._rightCol = new St.BoxLayout({ vertical: true, width: 220, style_class: 'pulse-settings-right' });
        rightScroll.child = this._rightCol;
        body.add_child(rightScroll);

        this.add_child(body);

        this._buildAppearance();
        this._buildList();
        this._changedId = taskManager.connect('tasks-changed', () => this._buildList());
    }

    destroy() {
        if (this._changedId) {
            this._taskManager.disconnect(this._changedId);
            this._changedId = null;
        }
        super.destroy();
    }

    _buildAppearance() {
        const prefs = _loadPrefs();

        // ── Theme section ─────────────────────────────────────────────────────
        const themeSection = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'pulse-settings-section' });
        themeSection.add_child(new St.Label({ text: 'THEME', style_class: 'pulse-settings-section-hdr' }));

        const themeList = new St.BoxLayout({ vertical: true, x_expand: true });
        THEMES.forEach(theme => {
            const btn = new St.Button({
                style_class: theme.id === prefs.theme
                    ? 'pulse-theme-chip pulse-theme-chip-on'
                    : 'pulse-theme-chip',
                can_focus: true,
                x_expand: true,
            });
            const inner = new St.BoxLayout({ vertical: true });
            inner.add_child(new St.Label({ text: theme.label, style_class: 'pulse-theme-name' }));
            inner.add_child(new St.Label({ text: theme.desc,  style_class: 'pulse-theme-desc' }));
            btn.child = inner;

            btn.connect('clicked', () => {
                const p = _loadPrefs();
                p.theme = theme.id;
                _savePrefs(p);
                this._applyTheme(theme.id);
                themeList.get_children().forEach((c, i) => {
                    c.style_class = THEMES[i].id === theme.id
                        ? 'pulse-theme-chip pulse-theme-chip-on'
                        : 'pulse-theme-chip';
                });
            });
            themeList.add_child(btn);
        });

        themeSection.add_child(themeList);

        // ── About section ─────────────────────────────────────────────────────
        const aboutSection = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'pulse-settings-section' });
        aboutSection.add_child(new St.Label({ text: 'ABOUT', style_class: 'pulse-settings-section-hdr' }));
        aboutSection.add_child(new St.Label({ text: 'PULSE v1', style_class: 'pulse-settings-name' }));
        aboutSection.add_child(new St.Label({ text: 'Habit tracker for GNOME 50', style_class: 'pulse-settings-sub' }));
        aboutSection.add_child(new St.Label({ text: 'ubuntu 26.04 LTS', style_class: 'pulse-settings-sub' }));

        this._rightCol.add_child(themeSection);
        this._rightCol.add_child(aboutSection);
    }

    _applyTheme(themeId) {
        // Walk up to find the PulsePopover (the root of our widget tree)
        let node = this;
        while (node) {
            if (node.style_class && node.style_class.includes('pulse-popover')) {
                // Remove all theme classes, add the new one
                const base = node.style_class
                    .split(' ')
                    .filter(c => !c.startsWith('theme-'))
                    .join(' ');
                node.style_class = `${base} theme-${themeId}`;
                return;
            }
            node = node.get_parent?.() ?? null;
        }
    }

    _buildList() {
        this._listBox.destroy_all_children();
        const tasks = this._taskManager._storage.getTasks();

        if (tasks.length === 0) {
            const empty = new St.Label({
                text: 'No habits yet. Tap + to add one.',
                style_class: 'hp-empty-msg',
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            this._listBox.add_child(empty);
            return;
        }

        for (const task of tasks) {
            const row = new St.BoxLayout({
                style_class: 'pulse-settings-row',
                x_expand: true,
                reactive: true,
            });

            const info = new St.BoxLayout({ vertical: true, x_expand: true });
            info.add_child(new St.Label({
                text: task.title,
                style_class: 'pulse-settings-name',
            }));
            info.add_child(new St.Label({
                text: `${_fmt(task.from)} – ${_fmt(task.to)}  ·  ${this._repeatStr(task.repeat)}`,
                style_class: 'pulse-settings-sub',
            }));
            row.add_child(info);

            const editBtn = new St.Button({ label: '✎', style_class: 'pulse-settings-icon-btn', can_focus: true });
            editBtn.connect('clicked', () => this._openEditForm(task));
            row.add_child(editBtn);

            const delBtn = new St.Button({ label: '✕', style_class: 'pulse-settings-icon-btn pulse-settings-del-btn', can_focus: true });
            delBtn.connect('clicked', () => {
                this._taskManager.deleteTask(task.id);
            });
            row.add_child(delBtn);

            this._listBox.add_child(row);
        }
    }

    _repeatStr(repeat) {
        if (!repeat || repeat === 'daily') return 'Every day';
        if (repeat === 'none') return 'No repeat';
        if (typeof repeat === 'object' && repeat.weekdays) {
            const D = ['Su','Mo','Tu','We','Th','Fr','Sa'];
            return repeat.weekdays.map(i => D[i]).join(' ');
        }
        return String(repeat);
    }

    _openAddForm() {
        this._closeForm();
        this._activeForm = new AddHabitForm(
            null,
            def => { this._taskManager.addTask(def); this._closeForm(); },
            () => this._closeForm(),
        );
        this._formMount.add_child(this._activeForm);
    }

    _openEditForm(task) {
        this._closeForm();
        this._activeForm = new AddHabitForm(
            task,
            updates => { this._taskManager.updateTask(task.id, updates); this._closeForm(); },
            () => this._closeForm(),
        );
        this._formMount.add_child(this._activeForm);
    }

    _closeForm() {
        if (this._activeForm) {
            this._activeForm.destroy();
            this._activeForm = null;
        }
    }
});

// ── ReportView ────────────────────────────────────────────────────────────────

const ReportView = GObject.registerClass(
class ReportView extends St.BoxLayout {
    _init(taskManager, width, onBack) {
        super._init({ style_class: 'pulse-view', vertical: true, x_expand: true, y_expand: true });

        this._taskManager = taskManager;
        this._width = width;

        // Back button row
        const topBar = new St.BoxLayout({ style_class: 'pulse-view-topbar', x_expand: true });
        const backBtn = new St.Button({
            label: '← Back',
            style_class: 'pulse-back-btn',
            can_focus: true,
        });
        backBtn.connect('clicked', onBack);
        topBar.add_child(backBtn);

        const title = new St.Label({
            text: 'Report',
            style_class: 'pulse-view-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        topBar.add_child(title);

        // Spacer to balance back button
        topBar.add_child(new St.Widget({ width: 60 }));

        this.add_child(topBar);

        // Dashboard fills the rest
        this.add_child(new ReportDashboard(this._taskManager._storage, this._width));
    }
});

// ── MainView (two-column: tasks left, heatmap+summary right) ──────────────────
//
// Hover flicker fix for heatmap:
//   - this._tooltip is ONE persistent St.Label created once in _build().
//   - On cell hover: set text + position + show. On leave: hide (not destroy).
//   - Cells never cause list rebuild or heatmap rebuild.

const MainView = GObject.registerClass(
class MainView extends St.BoxLayout {
    _init(taskManager, popoverWidth) {
        super._init({ style_class: 'pulse-main-view', x_expand: true, y_expand: true });

        this._taskManager = taskManager;
        this._showingForm = false;
        this._editingTaskId = null;
        this._activeForm = null;

        // Compute column widths
        const inner  = popoverWidth - 2 * OUTER_PAD;
        const leftW  = Math.floor(inner * LEFT_FRAC) - Math.floor(COL_GAP / 2);
        const rightW = inner - leftW - COL_GAP;

        this._leftW  = leftW;
        this._rightW = rightW;

        this._buildLeft(leftW);
        this.add_child(new St.Widget({ width: COL_GAP }));
        this._buildRight(rightW);
    }

    // ── Left column: task list + add button ───────────────────────────────────

    _buildLeft(w) {
        this._leftCol = new St.BoxLayout({
            style_class: 'pulse-left-col',
            vertical: true,
            width: w,
        });

        this._taskScroll = new St.ScrollView({
            style_class: 'pulse-task-scroll',
            x_expand: true,
            y_expand: true,
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
        this._leftCol.add_child(this._taskScroll);

        this._addBtn = new St.Button({
            label: '+ Add habit',
            style_class: 'hp-add-btn',
            x_expand: true,
            can_focus: true,
        });
        this._addBtn.connect('clicked', () => this._openAddForm());
        this._leftCol.add_child(this._addBtn);

        this.add_child(this._leftCol);
        this._renderTasks();
    }

    // ── Right column: heatmap + legend + summary ──────────────────────────────

    _buildRight(w) {
        this._rightCol = new St.BoxLayout({
            style_class: 'pulse-right-col',
            vertical: true,
            width: w,
        });

        this._buildHeatmap(w);
        this._buildSummary();

        this.add_child(this._rightCol);
    }

    _buildHeatmap(w) {
        const data = this._taskManager.getHeatmapData(84);
        this._heatmap = new Heatmap(data, /* stableTooltip= */ true);

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
        this._rightCol.add_child(scroll);

        // Legend
        const legend = new St.BoxLayout({
            style_class: 'hp-legend',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        legend.add_child(new St.Label({ text: 'Less', style_class: 'hp-legend-label' }));
        for (let i = 0; i <= 4; i++)
            legend.add_child(new St.Widget({ style_class: `hp-legend-cell hp-cell-l${i}`, width: 11, height: 11 }));
        legend.add_child(new St.Label({ text: 'More', style_class: 'hp-legend-label' }));
        this._rightCol.add_child(legend);
    }

    _buildSummary() {
        this._summaryCard = new St.BoxLayout({
            style_class: 'pulse-summary-card',
            vertical: true,
            x_expand: true,
        });
        this._completionLbl = new St.Label({ style_class: 'pulse-summary-completion' });
        this._pctLbl        = new St.Label({ style_class: 'pulse-summary-pct' });
        this._encourageLbl  = new St.Label({ style_class: 'pulse-summary-encourage' });
        this._encourageLbl.clutter_text.line_wrap = true;
        this._summaryCard.add_child(this._completionLbl);
        this._summaryCard.add_child(this._pctLbl);
        this._summaryCard.add_child(this._encourageLbl);
        this._rightCol.add_child(this._summaryCard);
        this._updateSummary();
    }

    _updateSummary() {
        const { completed, total, pct } = this._taskManager.getTodaySummary();
        if (total === 0) {
            this._completionLbl.set_text('No habits today');
            this._pctLbl.set_text('');
            this._encourageLbl.set_text('Add a habit to get started.');
        } else {
            this._completionLbl.set_text(`${completed} / ${total} completed`);
            this._pctLbl.set_text(`${pct}%`);
            const msg = pct === 0   ? 'Start small. Every check counts.'
                      : pct <= 33  ? "Getting started. Keep going!"
                      : pct <= 66  ? "Halfway there. Great momentum!"
                      : pct <= 99  ? "Almost done. Finish strong!"
                      : "Perfect day! 🎉";
            this._encourageLbl.set_text(msg);
        }
    }

    // ── Task rendering (data-driven, never on hover) ──────────────────────────

    _renderTasks() {
        this._taskListBox.destroy_all_children();
        const tasks = this._taskManager.getTodayTasks();

        if (tasks.length === 0) {
            const empty = new St.Label({
                text: 'Nothing planned.\nAdd a habit to get started.',
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

    // ── Refresh (called only when data changes, not on hover) ─────────────────

    refresh() {
        this._updateSummary();
        this._renderTasks();
        this._heatmap.update(this._taskManager.getHeatmapData(84));
    }

    // ── Add / Edit forms ──────────────────────────────────────────────────────

    _openAddForm() {
        if (this._showingForm) return;
        this._showingForm = true;
        this._editingTaskId = null;
        this._activeForm = new AddHabitForm(
            null,
            def => { this._taskManager.addTask(def); this._closeForm(); },
            () => this._closeForm(),
        );
        const idx = this._leftCol.get_children().indexOf(this._addBtn);
        this._leftCol.insert_child_at_index(this._activeForm, idx);
        this._addBtn.hide();
    }

    _openEditForm(taskId) {
        if (this._activeForm) { this._activeForm.destroy(); this._activeForm = null; }
        this._showingForm = true;
        this._editingTaskId = taskId;
        const def = this._taskManager._storage.getTasks().find(t => t.id === taskId);
        if (!def) return;
        this._activeForm = new AddHabitForm(
            def,
            updates => { this._taskManager.updateTask(taskId, updates); this._closeForm(); },
            () => this._closeForm(),
        );
        const idx = this._leftCol.get_children().indexOf(this._addBtn);
        this._leftCol.insert_child_at_index(this._activeForm, idx);
        this._addBtn.hide();
    }

    _closeForm() {
        this._showingForm    = false;
        this._editingTaskId  = null;
        if (this._activeForm) { this._activeForm.destroy(); this._activeForm = null; }
        this._addBtn.show();
    }
});

// ── PulsePopover ──────────────────────────────────────────────────────────────

export const PulsePopover = GObject.registerClass(
class PulsePopover extends St.BoxLayout {
    _init(taskManager, _extensionPath, mainWidth, reportWidth) {
        super._init({
            style_class: 'pulse-popover',
            vertical: true,
            width: mainWidth,
        });

        this._taskManager = taskManager;
        this._mainWidth   = mainWidth;
        this._reportWidth = reportWidth || mainWidth;
        this._width       = mainWidth;
        this._currentView = 'main';

        // Apply saved theme on creation
        const savedTheme = _loadPrefs().theme || 'dark-blue';
        this.style_class = `pulse-popover theme-${savedTheme}`;

        this._buildHeader();
        this._buildBody();

        // Data change → refresh only the main view (not on hover)
        this._changedId = taskManager.connect('tasks-changed', () => {
            this._updateHeader();
            if (this._currentView === 'main') this._mainView.refresh();
        });
        this._rolledId = taskManager.connect('day-rolled-over', () => {
            this._updateHeader();
            if (this._currentView === 'main') this._mainView.refresh();
        });
    }

    destroy() {
        if (this._changedId) { this._taskManager.disconnect(this._changedId); this._changedId = null; }
        if (this._rolledId)  { this._taskManager.disconnect(this._rolledId);  this._rolledId  = null; }
        super.destroy();
    }

    // ── Header: PULSE | date | summary | icon buttons ─────────────────────────

    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: 'pulse-header',
            x_expand: true,
        });

        header.add_child(new St.Label({ text: 'PULSE', style_class: 'pulse-wordmark' }));

        this._dateLabel = new St.Label({
            text: _todayLabel(),
            style_class: 'pulse-header-date',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._dateLabel);

        this._summaryLabel = new St.Label({
            style_class: 'pulse-header-summary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._summaryLabel);

        // Icon-only footer buttons in the header's right corner
        const btnBox = new St.BoxLayout({ style_class: 'pulse-icon-btn-box', y_align: Clutter.ActorAlign.CENTER });

        const settingsBtn = new St.Button({
            style_class: 'pulse-icon-btn',
            can_focus: true,
        });
        settingsBtn.child = new St.Icon({
            icon_name: 'preferences-system-symbolic',
            icon_size: 14,
            style_class: 'pulse-icon-btn-icon',
        });
        settingsBtn.connect('clicked', () => this._switchView('settings'));
        btnBox.add_child(settingsBtn);

        const reportBtn = new St.Button({
            style_class: 'pulse-icon-btn',
            can_focus: true,
        });
        reportBtn.child = new St.Icon({
            icon_name: 'x-office-spreadsheet-symbolic',
            fallback_icon_name: 'office-chart-bar-symbolic',
            icon_size: 14,
            style_class: 'pulse-icon-btn-icon',
        });
        reportBtn.connect('clicked', () => this._switchView('report'));
        btnBox.add_child(reportBtn);

        header.add_child(btnBox);
        this.add_child(header);
        this._updateHeader();
    }

    _updateHeader() {
        const { completed, total, pct } = this._taskManager.getTodaySummary();
        this._dateLabel.set_text(_todayLabel());
        this._summaryLabel.set_text(
            total === 0 ? '' : `${completed} / ${total} · ${pct}%`
        );
    }

    // ── Body: view container ──────────────────────────────────────────────────

    _buildBody() {
        this._body = new St.Widget({
            x_expand: true,
            y_expand: true,
            style_class: 'pulse-body',
        });
        this.add_child(this._body);
        this._showMainView();
    }

    // ── View switching ────────────────────────────────────────────────────────

    _switchView(view) {
        if (view === this._currentView) return;
        this._currentView = view;

        // Expand width for report, shrink back for main/settings
        const newWidth = (view === 'report') ? this._reportWidth : this._mainWidth;
        if (newWidth !== this._width) {
            this._width = newWidth;
            this.set_width(newWidth);
            const menuBox = this.get_parent();
            if (menuBox)
                menuBox.set_style(`padding: 0; margin: 0; min-width: ${newWidth}px;`);
        }

        this._body.destroy_all_children();
        if (view === 'main')     this._showMainView();
        if (view === 'settings') this._showSettingsView();
        if (view === 'report')   this._showReportView();
    }

    _showMainView() {
        this._currentView = 'main';
        this._mainView = new MainView(this._taskManager, this._mainWidth);
        this._mainView.x_expand = true;
        this._mainView.y_expand = true;
        this._body.add_child(this._mainView);
    }

    _showSettingsView() {
        const view = new SettingsView(this._taskManager, () => this._switchView('main'));
        view.x_expand = true;
        view.y_expand = true;
        this._body.add_child(view);
    }

    _showReportView() {
        const view = new ReportView(this._taskManager, this._width, () => this._switchView('main'));
        view.x_expand = true;
        view.y_expand = true;
        this._body.add_child(view);
    }
});
