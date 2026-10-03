/**
 * leftPanel.js — HabbitPop left panel
 *
 * Today's habits/todos list with:
 *   - Header + subtitle
 *   - Scrollable task list with toggle, name, time, state label
 *   - Right-click context menu for edit/delete
 *   - "+ Add Todo" inline form
 *   - Empty state
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { TaskState } from './taskManager.js';

// ── Helper: format 24h "HH:MM" to "hh:mm AM/PM" ─────────────────────────────
function _fmt24to12(time) {
    const [h, m] = time.split(':').map(Number);
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
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
        this._onToggle = onToggle;
        this._onEdit = onEdit;
        this._onDelete = onDelete;

        this._buildUI();
        this._setupContextMenu();
    }

    _buildUI() {
        // Checkmark circle button
        this._checkBtn = new St.Button({
            style_class: `hp-check-btn ${this._entry.completed ? 'hp-check-done' : ''}`,
            can_focus: true,
        });
        const checkIcon = new St.Icon({
            icon_name: this._entry.completed ? 'object-select-symbolic' : 'checkbox-symbolic',
            icon_size: 16,
            style_class: 'hp-check-icon',
        });
        this._checkBtn.child = checkIcon;
        this._checkBtn.connect('clicked', () => this._onToggle(this._entry.taskId));
        this.add_child(this._checkBtn);

        // Task name
        this._nameLabel = new St.Label({
            text: this._entry.title,
            style_class: `hp-task-name ${this._entry.completed ? 'hp-task-done-text' : ''}`,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._nameLabel.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        this.add_child(this._nameLabel);

        // State badge (NOW / MISSED)
        if (this._entry.state === TaskState.CURRENT) {
            const nowBadge = new St.Label({
                text: 'NOW',
                style_class: 'hp-badge hp-badge-now',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(nowBadge);
        } else if (this._entry.state === TaskState.MISSED) {
            const missedBadge = new St.Label({
                text: 'MISSED',
                style_class: 'hp-badge hp-badge-missed',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(missedBadge);
        }

        // Time label
        this._timeLabel = new St.Label({
            text: _fmt24to12(this._entry.time),
            style_class: 'hp-task-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._timeLabel);
    }

    _setupContextMenu() {
        // Right-click → show edit/delete menu
        this.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 3) {
                this._showContextMenu();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _showContextMenu() {
        // Destroy any existing context menu
        if (this._ctxMenu) {
            this._ctxMenu.destroy();
            this._ctxMenu = null;
        }

        this._ctxMenu = new St.BoxLayout({
            style_class: 'hp-context-menu',
            vertical: true,
            reactive: true,
        });

        const editBtn = new St.Button({
            label: 'Edit',
            style_class: 'hp-ctx-btn',
            x_expand: true,
        });
        editBtn.connect('clicked', () => {
            if (this._ctxMenu) {
                this._ctxMenu.destroy();
                this._ctxMenu = null;
            }
            this._onEdit(this._entry.taskId);
        });

        const delBtn = new St.Button({
            label: 'Delete',
            style_class: 'hp-ctx-btn hp-ctx-btn-delete',
            x_expand: true,
        });
        delBtn.connect('clicked', () => {
            if (this._ctxMenu) {
                this._ctxMenu.destroy();
                this._ctxMenu = null;
            }
            this._onDelete(this._entry.taskId);
        });

        this._ctxMenu.add_child(editBtn);
        this._ctxMenu.add_child(delBtn);

        // Add context menu after the row in the parent
        const parent = this.get_parent();
        if (parent) {
            const idx = parent.get_children().indexOf(this);
            parent.insert_child_at_index(this._ctxMenu, idx + 1);
        }
    }
});

// ── AddTodoForm ────────────────────────────────────────────────────────────────

const AddTodoForm = GObject.registerClass(
class AddTodoForm extends St.BoxLayout {
    _init(onSubmit, onCancel) {
        super._init({
            style_class: 'hp-add-form',
            vertical: true,
            x_expand: true,
        });

        this._onSubmit = onSubmit;
        this._onCancel = onCancel;

        this._buildUI();
    }

    _buildUI() {
        // Row 1: task name input
        const nameRow = new St.BoxLayout({ style_class: 'hp-form-row', x_expand: true });

        this._nameEntry = new St.Entry({
            hint_text: 'Task name…',
            style_class: 'hp-form-input',
            x_expand: true,
            can_focus: true,
        });
        nameRow.add_child(this._nameEntry);
        this.add_child(nameRow);

        // Row 2: time + type + repeat
        const optRow = new St.BoxLayout({ style_class: 'hp-form-row hp-form-opts', x_expand: true });

        this._timeEntry = new St.Entry({
            hint_text: 'HH:MM',
            text: '09:00',
            style_class: 'hp-form-input hp-form-time',
            width: 70,
            can_focus: true,
        });
        optRow.add_child(this._timeEntry);

        // Type toggle: Habit / Todo
        this._typeHabit = new St.Button({
            label: 'Habit',
            style_class: 'hp-type-btn hp-type-active',
            toggle_mode: false,
        });
        this._typeTodo = new St.Button({
            label: 'Todo',
            style_class: 'hp-type-btn',
            toggle_mode: false,
        });
        this._selectedType = 'habit';
        this._typeHabit.connect('clicked', () => this._setType('habit'));
        this._typeTodo.connect('clicked', () => this._setType('todo'));
        optRow.add_child(this._typeHabit);
        optRow.add_child(this._typeTodo);

        // Repeat dropdown (simple cycle button)
        this._repeatOptions = ['none', 'daily', 'Mon-Fri', 'Weekends'];
        this._repeatIdx = 0;
        this._repeatBtn = new St.Button({
            label: 'No repeat',
            style_class: 'hp-repeat-btn',
            can_focus: true,
        });
        this._repeatBtn.connect('clicked', () => {
            this._repeatIdx = (this._repeatIdx + 1) % this._repeatOptions.length;
            this._repeatBtn.label = this._repeatLabel();
        });
        optRow.add_child(this._repeatBtn);
        this.add_child(optRow);

        // Row 3: submit / cancel
        const actionRow = new St.BoxLayout({ style_class: 'hp-form-row hp-form-actions', x_expand: true });

        const submitBtn = new St.Button({
            label: 'Add',
            style_class: 'hp-form-submit',
            can_focus: true,
        });
        submitBtn.connect('clicked', () => this._submit());

        const cancelBtn = new St.Button({
            label: 'Cancel',
            style_class: 'hp-form-cancel',
            can_focus: true,
        });
        cancelBtn.connect('clicked', () => this._onCancel());

        actionRow.add_child(submitBtn);
        actionRow.add_child(cancelBtn);
        this.add_child(actionRow);

        // Keyboard: Enter submits, Escape cancels
        this._nameEntry.clutter_text.connect('key-press-event', (_actor, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                this._submit();
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Escape) {
                this._onCancel();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Focus name entry on show
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._nameEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _setType(type) {
        this._selectedType = type;
        this._typeHabit.style_class = `hp-type-btn${type === 'habit' ? ' hp-type-active' : ''}`;
        this._typeTodo.style_class = `hp-type-btn${type === 'todo' ? ' hp-type-active' : ''}`;
    }

    _repeatLabel() {
        const r = this._repeatOptions[this._repeatIdx];
        if (r === 'none') return 'No repeat';
        if (r === 'daily') return 'Every day';
        if (r === 'Mon-Fri') return 'Mon – Fri';
        return 'Weekends';
    }

    _repeatValue() {
        const r = this._repeatOptions[this._repeatIdx];
        if (r === 'none') return 'none';
        if (r === 'daily') return 'daily';
        if (r === 'Mon-Fri') return { weekdays: [1, 2, 3, 4, 5] };
        return { weekdays: [0, 6] };
    }

    _submit() {
        const title = this._nameEntry.get_text().trim();
        if (!title) return;

        const time = this._timeEntry.get_text().trim() || '09:00';
        this._onSubmit({
            title,
            time,
            type: this._selectedType,
            repeat: this._repeatValue(),
        });
    }
});

// ── LeftPanel ─────────────────────────────────────────────────────────────────

export const LeftPanel = GObject.registerClass(
class LeftPanel extends St.BoxLayout {
    _init(taskManager) {
        super._init({
            style_class: 'hp-left-panel',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        this._taskManager = taskManager;
        this._showingForm = false;
        this._editingTaskId = null;

        this._buildHeader();
        this._buildTaskList();
        this._buildAddButton();

        // Listen for external task changes
        this._changedId = taskManager.connect('tasks-changed', () => this._refresh());
    }

    destroy() {
        if (this._changedId) {
            this._taskManager.disconnect(this._changedId);
            this._changedId = null;
        }
        super.destroy();
    }

    // ── Build ─────────────────────────────────────────────────────────────────

    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: 'hp-panel-header',
            x_expand: true,
        });

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });

        const title = new St.Label({
            text: "Today's Habits / Todos",
            style_class: 'hp-panel-title',
        });
        const subtitle = new St.Label({
            text: 'Small steps. Big progress.',
            style_class: 'hp-panel-subtitle',
        });
        textBox.add_child(title);
        textBox.add_child(subtitle);
        header.add_child(textBox);

        // Small check circle icon on the right
        const icon = new St.Icon({
            icon_name: 'checkbox-checked-symbolic',
            icon_size: 20,
            style_class: 'hp-header-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(icon);

        this.add_child(header);
    }

    _buildTaskList() {
        // Scrollable container
        this._scrollView = new St.ScrollView({
            style_class: 'hp-task-scroll',
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

        this._scrollView.child = this._taskListBox;
        this.add_child(this._scrollView);

        this._renderTasks();
    }

    _buildAddButton() {
        this._addBtn = new St.Button({
            label: '+ Add Todo',
            style_class: 'hp-add-btn',
            x_expand: true,
            can_focus: true,
        });
        this._addBtn.connect('clicked', () => this._openAddForm());
        this.add_child(this._addBtn);
    }

    // ── Render ────────────────────────────────────────────────────────────────

    _renderTasks() {
        // Clear existing
        this._taskListBox.destroy_all_children();

        const tasks = this._taskManager.getTodayTasks();

        if (tasks.length === 0) {
            this._renderEmptyState();
            return;
        }

        for (const entry of tasks) {
            const row = new TaskRow(
                entry,
                (id) => this._handleToggle(id),
                (id) => this._handleEdit(id),
                (id) => this._handleDelete(id),
            );
            this._taskListBox.add_child(row);
        }

        // If add form is showing in edit mode, re-open it
        if (this._showingForm && this._editingTaskId) {
            this._openEditForm(this._editingTaskId);
        }
    }

    _renderEmptyState() {
        const empty = new St.BoxLayout({
            style_class: 'hp-empty-state',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        const icon = new St.Icon({
            icon_name: 'view-list-symbolic',
            icon_size: 32,
            style_class: 'hp-empty-icon',
            x_align: Clutter.ActorAlign.CENTER,
        });

        const msg = new St.Label({
            text: 'Nothing planned yet.\nAdd something small to get started.',
            style_class: 'hp-empty-msg',
            x_align: Clutter.ActorAlign.CENTER,
        });
        msg.clutter_text.line_wrap = true;
        msg.clutter_text.justify = true;

        empty.add_child(icon);
        empty.add_child(msg);
        this._taskListBox.add_child(empty);
    }

    _refresh() {
        this._renderTasks();
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    _handleToggle(taskId) {
        this._taskManager.toggleTask(taskId);
        // tasks-changed signal will trigger _refresh()
    }

    _handleEdit(taskId) {
        this._editingTaskId = taskId;
        this._openEditForm(taskId);
    }

    _handleDelete(taskId) {
        this._taskManager.deleteTask(taskId);
    }

    _openAddForm() {
        if (this._showingForm) return;
        this._showingForm = true;
        this._editingTaskId = null;

        this._activeForm = new AddTodoForm(
            (def) => {
                this._taskManager.addTask(def);
                this._closeForm();
            },
            () => this._closeForm(),
        );
        // Insert above the add button (last child)
        this.insert_child_at_index(this._activeForm, this.get_children().length - 1);
        this._addBtn.hide();
    }

    _openEditForm(taskId) {
        if (this._showingForm && !this._editingTaskId) return;
        if (this._activeForm) {
            this._activeForm.destroy();
            this._activeForm = null;
        }
        this._showingForm = true;

        // Find original task def to pre-fill
        const tasks = this._taskManager._storage.getTasks();
        const taskDef = tasks.find(t => t.id === taskId);
        if (!taskDef) return;

        this._activeForm = new AddTodoForm(
            (def) => {
                this._taskManager.updateTask(taskId, def);
                this._closeForm();
            },
            () => this._closeForm(),
        );
        // Pre-fill
        this._activeForm._nameEntry.set_text(taskDef.title);
        this._activeForm._timeEntry.set_text(taskDef.time);

        this.insert_child_at_index(this._activeForm, this.get_children().length - 1);
        this._addBtn.hide();
    }

    _closeForm() {
        this._showingForm = false;
        this._editingTaskId = null;
        if (this._activeForm) {
            this._activeForm.destroy();
            this._activeForm = null;
        }
        this._addBtn.show();
    }
});
