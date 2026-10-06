/**
 * storage.js — PULSE data persistence layer
 *
 * Schema (version 2)
 * ------------------
 * {
 *   version: 2,
 *   tasks: [
 *     {
 *       id: string,          // "t_<timestamp>_<random>"
 *       title: string,
 *       from: string,        // "HH:MM" 24h start time
 *       to: string,          // "HH:MM" 24h end time (must be > from)
 *       type: "habit",
 *       repeat: "none"|"daily"|{weekdays: number[]},
 *       createdAt: string    // ISO date string
 *     }
 *   ],
 *   days: {
 *     "YYYY-MM-DD": {
 *       date: string,
 *       tasks: [
 *         {
 *           taskId: string,
 *           title: string,
 *           from: string,
 *           to: string,
 *           completed: boolean,
 *           completedAt: string|null
 *         }
 *       ],
 *       completionPct: number
 *     }
 *   }
 * }
 *
 * Migration from v1 (habbitpop):
 *   • Copies ~/.local/share/habbitpop@hritikdev/data.json → pulse@hritikdev/
 *   • Sets time → from, derives to = from + 30 min
 *   • Bumps version to 2
 *   • Leaves old dir intact as a backup
 *
 * Atomic writes: write to .tmp then GLib.rename.
 * Corrupt file: back up as data.json.bak.<ts> and start fresh.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const DATA_VERSION = 2;
const DATA_DIR_NAME = 'pulse@hritikdev';
const OLD_DIR_NAME  = 'habbitpop@hritikdev';

function _genId() {
    return `t_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
}

function _dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** Add N minutes to "HH:MM", returns "HH:MM". */
function _addMinutes(hhmm, mins) {
    const [h, m] = hhmm.split(':').map(Number);
    const total = h * 60 + m + mins;
    const nh = Math.min(Math.floor(total / 60), 23);
    const nm = total % 60;
    return `${String(nh).padStart(2,'0')}:${String(nm).padStart(2,'0')}`;
}

export class Storage {
    constructor() {
        const base = GLib.get_user_data_dir();
        this._dir      = GLib.build_filenamev([base, DATA_DIR_NAME]);
        this.dataPath  = GLib.build_filenamev([this._dir, 'data.json']); // public for FileMonitor
        this._data     = null;
    }

    // ── Migration from old habbitpop dir ──────────────────────────────────────

    /**
     * If the old habbitpop data dir exists and the new pulse dir doesn't,
     * copy and migrate the data file. Leaves old dir intact as backup.
     */
    migrateFromHabbitpop() {
        const base = GLib.get_user_data_dir();
        const oldDir  = GLib.build_filenamev([base, OLD_DIR_NAME]);
        const oldFile = GLib.build_filenamev([oldDir, 'data.json']);
        const newDir  = this._dir;
        const newFile = this.dataPath;

        const oldExists = Gio.File.new_for_path(oldFile).query_exists(null);
        const newExists = Gio.File.new_for_path(newFile).query_exists(null);

        if (!oldExists || newExists) return; // nothing to do

        console.log('[PULSE] Migrating data from habbitpop@hritikdev → pulse@hritikdev');

        try {
            // Ensure new dir exists
            const newDirFile = Gio.File.new_for_path(newDir);
            if (!newDirFile.query_exists(null))
                newDirFile.make_directory_with_parents(null);

            // Load old data
            const [, bytes] = Gio.File.new_for_path(oldFile).load_contents(null);
            const old = JSON.parse(new TextDecoder().decode(bytes));

            // Migrate
            const migrated = this._migrateV1toV2(old);

            // Write to new location atomically
            const tmp = `${newFile}.tmp`;
            const text = JSON.stringify(migrated, null, 2);
            const out = Gio.File.new_for_path(tmp).replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            out.write_all(new TextEncoder().encode(text), null);
            out.close(null);
            GLib.rename(tmp, newFile);

            console.log('[PULSE] Migration complete. Old data preserved at', oldDir);
        } catch (e) {
            console.error('[PULSE] Migration failed:', e.message);
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    load() {
        const dir = Gio.File.new_for_path(this._dir);
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);

        const file = Gio.File.new_for_path(this.dataPath);
        if (!file.query_exists(null)) {
            this._data = this._emptyData();
            return;
        }

        try {
            const [, contents] = file.load_contents(null);
            const text = new TextDecoder().decode(contents);
            const parsed = JSON.parse(text);

            if (typeof parsed !== 'object' || !Array.isArray(parsed.tasks) || typeof parsed.days !== 'object')
                throw new Error('Invalid schema');

            // Auto-migrate v1 on load (covers edge cases where migration ran but version wasn't bumped)
            this._data = parsed.version < 2 ? this._migrateV1toV2(parsed) : parsed;
        } catch (e) {
            this._backupCorrupt();
            this._data = this._emptyData();
        }
    }

    save() {
        if (!this._data) return;
        const tmp = `${this.dataPath}.tmp`;
        const bytes = new TextEncoder().encode(JSON.stringify(this._data, null, 2));
        const out = Gio.File.new_for_path(tmp).replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        out.write_all(bytes, null);
        out.close(null);
        GLib.rename(tmp, this.dataPath);
    }

    // ── Task definitions ──────────────────────────────────────────────────────

    getTasks() { return this._data.tasks; }

    addTask(def) {
        const fromTime = def.from || def.time || '09:00';
        const task = {
            id: _genId(),
            title: def.title,
            from: fromTime,
            to:   def.to || _addMinutes(fromTime, 30),
            type: def.type || 'habit',
            repeat: def.repeat || 'daily',
            createdAt: new Date().toISOString(),
        };
        this._data.tasks.push(task);
        this.save();
        return task;
    }

    updateTask(id, updates) {
        const idx = this._data.tasks.findIndex(t => t.id === id);
        if (idx === -1) return null;
        // Map legacy 'time' field if callers still send it
        if (updates.time && !updates.from) updates.from = updates.time;
        delete updates.time;
        Object.assign(this._data.tasks[idx], updates);
        this.save();
        return this._data.tasks[idx];
    }

    deleteTask(id) {
        this._data.tasks = this._data.tasks.filter(t => t.id !== id);
        this.save();
    }

    // ── Day records ───────────────────────────────────────────────────────────

    getDay(date) {
        const key = typeof date === 'string' ? date : _dateKey(date);
        if (!this._data.days[key])
            this._data.days[key] = { date: key, tasks: [], completionPct: 0 };
        return this._data.days[key];
    }

    setTaskCompleted(taskId, completed, forDate = new Date()) {
        const day = this.getDay(forDate);
        const entry = day.tasks.find(t => t.taskId === taskId);
        if (!entry) return;
        entry.completed = completed;
        entry.completedAt = completed ? new Date().toISOString() : null;
        day.completionPct = this._calcPct(day);
        this.save();
    }

    getAllDays() { return this._data.days; }

    rolloverDay(forDate = new Date()) {
        const key = _dateKey(forDate);
        const existing = this._data.days[key];
        const existingState = {};
        if (existing) {
            for (const e of existing.tasks)
                existingState[e.taskId] = { completed: e.completed, completedAt: e.completedAt };
        }

        const dow = forDate.getDay();
        const todayTasks = [];
        for (const task of this._data.tasks) {
            if (!this._taskAppliesToDay(task, forDate, dow)) continue;
            const prev = existingState[task.id] || {};
            todayTasks.push({
                taskId: task.id,
                title: task.title,
                from: task.from || task.time || '00:00',
                to:   task.to   || _addMinutes(task.from || task.time || '00:00', 30),
                completed: prev.completed || false,
                completedAt: prev.completedAt || null,
            });
        }

        todayTasks.sort((a, b) => (a.from || a.time || "00:00").localeCompare(b.from || b.time || "00:00"));
        this._data.days[key] = {
            date: key,
            tasks: todayTasks,
            completionPct: this._calcPct({ tasks: todayTasks }),
        };
        this.save();
    }

    // ── Seed / debug ──────────────────────────────────────────────────────────

    seedFakeHistory() {
        const today = new Date();
        for (let i = 83; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const key = _dateKey(d);
            if (this._data.days[key]?.tasks?.length > 0) continue;

            const total = 5 + Math.floor(Math.random() * 5);
            const done  = Math.floor(Math.random() * (total + 1));
            const tasks = [];
            for (let j = 0; j < total; j++) {
                const fromH = String(8 + j).padStart(2, '0');
                tasks.push({
                    taskId: `seed_${j}`,
                    title: `Habit ${j + 1}`,
                    from: `${fromH}:00`,
                    to:   `${fromH}:30`,
                    completed: j < done,
                    completedAt: j < done ? d.toISOString() : null,
                });
            }
            this._data.days[key] = { date: key, tasks, completionPct: Math.round((done/total)*100) };
        }
        this.save();
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _emptyData() {
        return { version: DATA_VERSION, tasks: [], days: {} };
    }

    _calcPct(day) {
        if (!day.tasks.length) return 0;
        return Math.round(day.tasks.filter(t => t.completed).length / day.tasks.length * 100);
    }

    _taskAppliesToDay(task, _date, dayOfWeek) {
        if (task.repeat === 'daily' || task.repeat === 'none' || !task.repeat) return true;
        if (typeof task.repeat === 'object' && Array.isArray(task.repeat.weekdays))
            return task.repeat.weekdays.includes(dayOfWeek);
        return true;
    }

    _backupCorrupt() {
        try {
            const src = Gio.File.new_for_path(this.dataPath);
            const dst = Gio.File.new_for_path(`${this.dataPath}.bak.${Date.now()}`);
            src.copy(dst, Gio.FileCopyFlags.NONE, null, null);
        } catch (_) {}
    }

    /** Migrate v1 schema (single `time` field) to v2 (`from`/`to`). */
    _migrateV1toV2(old) {
        console.log('[PULSE] Migrating schema v1 → v2 (time → from/to)');
        const tasks = (old.tasks || []).map(t => ({
            ...t,
            from: t.from || t.time || '09:00',
            to:   t.to   || _addMinutes(t.from || t.time || '09:00', 30),
        }));
        // Remove legacy `time` field
        tasks.forEach(t => delete t.time);

        const days = {};
        for (const [key, day] of Object.entries(old.days || {})) {
            days[key] = {
                ...day,
                tasks: (day.tasks || []).map(e => ({
                    ...e,
                    from: e.from || e.time || '00:00',
                    to:   e.to   || _addMinutes(e.from || e.time || '00:00', 30),
                })),
            };
            days[key].tasks.forEach(e => delete e.time);
        }
        return { version: DATA_VERSION, tasks, days };
    }
}
