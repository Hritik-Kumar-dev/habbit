#!/usr/bin/env -S gjs -m
/**
 * apps/settings.js — PULSE Settings Window
 *
 * Standalone GTK4/libadwaita app launched by the extension via Gio.Subprocess.
 * Reads and writes ~/.local/share/pulse@hritikdev/data.json.
 * The extension watches the file with Gio.FileMonitor and reloads live.
 *
 * Run standalone: gjs -m apps/settings.js
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

// ── Data helpers ──────────────────────────────────────────────────────────────

const DATA_DIR  = GLib.build_filenamev([GLib.get_user_data_dir(), 'pulse@hritikdev']);
const DATA_PATH = GLib.build_filenamev([DATA_DIR, 'data.json']);

function ensureDir() {
    const d = Gio.File.new_for_path(DATA_DIR);
    if (!d.query_exists(null)) d.make_directory_with_parents(null);
}

function loadData() {
    ensureDir();
    const f = Gio.File.new_for_path(DATA_PATH);
    if (!f.query_exists(null)) return { version: 2, tasks: [], days: {} };
    try {
        const [, b] = f.load_contents(null);
        return JSON.parse(new TextDecoder().decode(b));
    } catch (_) {
        return { version: 2, tasks: [], days: {} };
    }
}

function saveData(data) {
    ensureDir();
    const tmp = `${DATA_PATH}.tmp`;
    const out = Gio.File.new_for_path(tmp).replace(
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    out.write_all(new TextEncoder().encode(JSON.stringify(data, null, 2)), null);
    out.close(null);
    GLib.rename(tmp, DATA_PATH);
}

function genId() {
    return `t_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function repeatLabel(repeat) {
    if (!repeat || repeat === 'daily') return 'Every day';
    if (repeat === 'none') return 'One-off';
    if (typeof repeat === 'object' && Array.isArray(repeat.weekdays)) {
        const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        return repeat.weekdays.map(d => DAYS[d]).join(', ');
    }
    return String(repeat);
}

function toMins(hhmm) {
    const [h, m] = (hhmm || '00:00').split(':').map(Number);
    return h * 60 + m;
}

// ── Add / Edit dialog ─────────────────────────────────────────────────────────

function showHabitDialog(parent, prefill, onSave) {
    const isEdit = !!prefill;
    const dialog = new Adw.Dialog({ title: isEdit ? 'Edit Habit' : 'Add Habit' });
    dialog.set_content_width(420);

    const toolbar = new Adw.ToolbarView();
    dialog.set_child(toolbar);
    toolbar.add_top_bar(new Adw.HeaderBar());

    const page = new Adw.PreferencesPage();
    toolbar.set_content(page);

    // ── Basic info ──
    const infoGroup = new Adw.PreferencesGroup({ title: 'Habit' });
    page.add(infoGroup);

    const nameRow = new Adw.EntryRow({ title: 'Name' });
    if (prefill?.title) nameRow.set_text(prefill.title);
    infoGroup.add(nameRow);

    // ── Time window ──
    const timeGroup = new Adw.PreferencesGroup({ title: 'Time window' });
    page.add(timeGroup);

    const fromRow = new Adw.EntryRow({ title: 'From (HH:MM)' });
    fromRow.set_text(prefill?.from || '09:00');
    timeGroup.add(fromRow);

    const toRow = new Adw.EntryRow({ title: 'To (HH:MM)' });
    toRow.set_text(prefill?.to || '09:30');
    timeGroup.add(toRow);

    const validationLbl = new Gtk.Label({
        label: '⚠ End time must be after start time',
        css_classes: ['error'],
        halign: Gtk.Align.START,
        margin_start: 12,
    });
    validationLbl.set_visible(false);

    const validRow = new Adw.ActionRow();
    validRow.set_child(validationLbl);
    timeGroup.add(validRow);

    // ── Repeat ──
    const repeatGroup = new Adw.PreferencesGroup({ title: 'Repeat' });
    page.add(repeatGroup);

    const everyDayRow = new Adw.SwitchRow({ title: 'Repeat every day' });
    const isDaily = !prefill || prefill.repeat === 'daily' || !prefill.repeat;
    everyDayRow.set_active(isDaily);
    repeatGroup.add(everyDayRow);

    // Day chips
    const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const chipBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        halign: Gtk.Align.CENTER,
        margin_top: 4,
        margin_bottom: 8,
    });
    const chipBtns = DAY_NAMES.map((label, i) => {
        const btn = new Gtk.ToggleButton({ label });
        btn.add_css_class('pill');
        // Pre-select
        const isActive = prefill?.repeat?.weekdays
            ? prefill.repeat.weekdays.includes(i)
            : true;
        btn.set_active(isActive);
        chipBox.append(btn);
        return btn;
    });

    const chipRow = new Adw.ActionRow();
    chipRow.set_child(chipBox);
    repeatGroup.add(chipRow);

    // Sync chip sensitivity with toggle
    const syncChips = () => {
        const daily = everyDayRow.get_active();
        chipBox.set_sensitive(!daily);
        if (daily) chipBtns.forEach(b => b.set_active(true));
    };
    everyDayRow.connect('notify::active', syncChips);
    syncChips();

    // ── Save button ──
    const actGroup = new Adw.PreferencesGroup();
    page.add(actGroup);

    const saveBtn = new Gtk.Button({
        label: isEdit ? 'Save Changes' : 'Add Habit',
        halign: Gtk.Align.END,
        margin_top: 8,
        margin_bottom: 8,
    });
    saveBtn.add_css_class('suggested-action');
    saveBtn.add_css_class('pill');
    const saveRow = new Adw.ActionRow();
    saveRow.set_child(saveBtn);
    actGroup.add(saveRow);

    saveBtn.connect('clicked', () => {
        const name = nameRow.get_text().trim();
        const from = fromRow.get_text().trim();
        const to   = toRow.get_text().trim();

        // Validate
        if (!name) { nameRow.add_css_class('error'); return; }
        nameRow.remove_css_class('error');

        if (toMins(to) <= toMins(from)) {
            validationLbl.set_visible(true);
            toRow.add_css_class('error');
            return;
        }
        validationLbl.set_visible(false);
        toRow.remove_css_class('error');

        let repeat;
        if (everyDayRow.get_active()) {
            repeat = 'daily';
        } else {
            const sel = chipBtns.map((b, i) => b.get_active() ? i : -1).filter(i => i >= 0);
            repeat = sel.length === 0 ? 'none'
                   : sel.length === 7 ? 'daily'
                   : { weekdays: sel };
        }

        onSave({ name, from, to, repeat });
        dialog.close();
    });

    dialog.present(parent);
}

// ── HabitRow ──────────────────────────────────────────────────────────────────

const HabitRow = GObject.registerClass(
class HabitRow extends Adw.ActionRow {
    _init(task, onEdit, onDelete) {
        super._init({
            title: GLib.markup_escape_text(task.title, -1),
            subtitle: `${task.from} – ${task.to}  ·  ${repeatLabel(task.repeat)}`,
        });

        const editBtn = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Edit',
        });
        editBtn.add_css_class('flat');
        editBtn.connect('clicked', () => onEdit(task));
        this.add_suffix(editBtn);

        const delBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Delete',
        });
        delBtn.add_css_class('flat');
        delBtn.connect('clicked', () => onDelete(task.id));
        this.add_suffix(delBtn);
    }
});

// ── SettingsWindow ────────────────────────────────────────────────────────────

const SettingsWindow = GObject.registerClass(
class SettingsWindow extends Adw.ApplicationWindow {
    _init(app) {
        super._init({
            application: app,
            title: 'PULSE — Settings',
            default_width: 480,
            default_height: 600,
        });

        const toolbar = new Adw.ToolbarView();
        this.set_content(toolbar);

        const header = new Adw.HeaderBar();
        toolbar.add_top_bar(header);

        // + Add button in header bar
        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add Habit',
        });
        addBtn.add_css_class('suggested-action');
        addBtn.connect('clicked', () => this._openAddDialog());
        header.pack_end(addBtn);

        const scroll = new Gtk.ScrolledWindow({ vexpand: true });
        toolbar.set_content(scroll);

        this._prefPage = new Adw.PreferencesPage();
        scroll.set_child(this._prefPage);

        this._data = loadData();
        this._buildList();
    }

    _buildList() {
        // Teardown old group if rebuilding
        if (this._habitsGroup) this._prefPage.remove(this._habitsGroup);

        this._habitsGroup = new Adw.PreferencesGroup({
            title: 'Habits',
            description: `${this._data.tasks.length} habit(s) defined`,
        });
        this._prefPage.add(this._habitsGroup);

        if (this._data.tasks.length === 0) {
            const placeholder = new Adw.ActionRow({
                title: 'No habits yet',
                subtitle: 'Tap + to add your first habit',
                icon_name: 'view-list-symbolic',
            });
            this._habitsGroup.add(placeholder);
            return;
        }

        for (const task of this._data.tasks) {
            this._habitsGroup.add(new HabitRow(
                task,
                t => this._openEditDialog(t),
                id => this._confirmDelete(id),
            ));
        }
    }

    _openAddDialog() {
        showHabitDialog(this, null, ({ name, from, to, repeat }) => {
            this._data.tasks.push({
                id: genId(),
                title: name,
                from, to,
                type: 'habit',
                repeat,
                createdAt: new Date().toISOString(),
            });
            saveData(this._data);
            this._data = loadData();
            this._buildList();
        });
    }

    _openEditDialog(task) {
        showHabitDialog(this, task, ({ name, from, to, repeat }) => {
            const idx = this._data.tasks.findIndex(t => t.id === task.id);
            if (idx === -1) return;
            Object.assign(this._data.tasks[idx], { title: name, from, to, repeat });
            saveData(this._data);
            this._data = loadData();
            this._buildList();
        });
    }

    _confirmDelete(id) {
        const task = this._data.tasks.find(t => t.id === id);
        const dlg = new Adw.AlertDialog({
            heading: 'Delete Habit?',
            body: `"${task?.title}" will be removed. Past history is kept for the heatmap.`,
        });
        dlg.add_response('cancel', 'Cancel');
        dlg.add_response('delete', 'Delete');
        dlg.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dlg.connect('response', (_d, id_) => {
            if (id_ !== 'delete') return;
            this._data.tasks = this._data.tasks.filter(t => t.id !== id);
            saveData(this._data);
            this._data = loadData();
            this._buildList();
        });
        dlg.present(this);
    }
});

// ── App bootstrap ─────────────────────────────────────────────────────────────

const app = new Adw.Application({
    application_id: 'dev.hritik.pulse.Settings',
    flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
});

app.connect('activate', () => {
    let win = app.get_active_window();
    if (!win) win = new SettingsWindow(app);
    win.present();
});

app.run([]);
