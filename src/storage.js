/**
 * storage.js — HabbitPop data persistence layer
 *
 * Schema
 * ------
 * data.json:
 * {
 *   version: 1,
 *   tasks: [
 *     {
 *       id: string,          // UUID-like "t_<timestamp>_<random>"
 *       title: string,
 *       time: string,        // "HH:MM" 24h
 *       type: "todo"|"habit",
 *       repeat: "none"|"daily"|{weekdays: number[]}, // weekdays: 0=Sun..6=Sat
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
 *           time: string,
 *           completed: boolean,
 *           completedAt: string|null
 *         }
 *       ],
 *       completionPct: number   // 0-100, cached
 *     }
 *   }
 * }
 *
 * Atomic writes: write to .tmp file then rename (GLib.rename).
 * Corrupt file: back up as data.json.bak.<timestamp> and start fresh.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const DATA_VERSION = 1;

/**
 * Generate a simple unique ID.
 * @returns {string}
 */
function _genId() {
    const ts = Date.now();
    const rand = Math.floor(Math.random() * 1000000);
    return `t_${ts}_${rand}`;
}

/**
 * Format a Date as "YYYY-MM-DD".
 * @param {Date} date
 * @returns {string}
 */
function _dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export class Storage {
    constructor() {
        // ~/.local/share/habbitpop@hritikdev/
        const dataDir = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'habbitpop@hritikdev',
        ]);
        this._dir = dataDir;
        this._dataPath = GLib.build_filenamev([dataDir, 'data.json']);
        this._data = null;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    /**
     * Load data from disk. Creates fresh data if file missing or corrupt.
     * Must be called once before using any other method.
     */
    load() {
        // Ensure directory exists
        const dir = Gio.File.new_for_path(this._dir);
        if (!dir.query_exists(null)) {
            dir.make_directory_with_parents(null);
        }

        const file = Gio.File.new_for_path(this._dataPath);
        if (!file.query_exists(null)) {
            this._data = this._emptyData();
            return;
        }

        try {
            const [, contents] = file.load_contents(null);
            const text = new TextDecoder().decode(contents);
            const parsed = JSON.parse(text);

            // Basic schema validation
            if (
                typeof parsed !== 'object' ||
                !Array.isArray(parsed.tasks) ||
                typeof parsed.days !== 'object'
            ) {
                throw new Error('Invalid schema');
            }

            this._data = parsed;
        } catch (e) {
            // Corrupt or invalid — back up and start fresh
            this._backupCorrupt();
            this._data = this._emptyData();
        }
    }

    /**
     * Persist data to disk atomically.
     */
    save() {
        if (!this._data) return;

        const tmpPath = `${this._dataPath}.tmp`;
        const text = JSON.stringify(this._data, null, 2);
        const bytes = new TextEncoder().encode(text);

        const tmpFile = Gio.File.new_for_path(tmpPath);
        const outStream = tmpFile.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        outStream.write_all(bytes, null);
        outStream.close(null);

        // Atomic rename
        GLib.rename(tmpPath, this._dataPath);
    }

    // ── Task definitions (the "template" tasks) ────────────────────────────────

    /**
     * Return all task definitions.
     * @returns {object[]}
     */
    getTasks() {
        return this._data.tasks;
    }

    /**
     * Add a new task definition.
     * @param {object} taskDef  { title, time, type, repeat }
     * @returns {object} the created task with id
     */
    addTask(taskDef) {
        const task = {
            id: _genId(),
            title: taskDef.title,
            time: taskDef.time || '09:00',
            type: taskDef.type || 'todo',
            repeat: taskDef.repeat || 'none',
            createdAt: new Date().toISOString(),
        };
        this._data.tasks.push(task);
        this.save();
        return task;
    }

    /**
     * Update a task definition in-place.
     * @param {string} id
     * @param {object} updates
     * @returns {object|null}
     */
    updateTask(id, updates) {
        const idx = this._data.tasks.findIndex(t => t.id === id);
        if (idx === -1) return null;
        Object.assign(this._data.tasks[idx], updates);
        this.save();
        return this._data.tasks[idx];
    }

    /**
     * Delete a task definition. Does NOT remove from historical day records
     * (they are kept for heatmap accuracy).
     * @param {string} id
     */
    deleteTask(id) {
        this._data.tasks = this._data.tasks.filter(t => t.id !== id);
        this.save();
    }

    // ── Day records ───────────────────────────────────────────────────────────

    /**
     * Get the day record for a given date. Creates it fresh if missing.
     * @param {Date|string} date  Date object or "YYYY-MM-DD"
     * @returns {object}
     */
    getDay(date) {
        const key = typeof date === 'string' ? date : _dateKey(date);
        if (!this._data.days[key]) {
            this._data.days[key] = this._freshDayRecord(key);
        }
        return this._data.days[key];
    }

    /**
     * Mark a task entry in today's record as completed or not.
     * @param {string} taskId
     * @param {boolean} completed
     * @param {Date} [forDate=new Date()]
     */
    setTaskCompleted(taskId, completed, forDate = new Date()) {
        const day = this.getDay(forDate);
        const entry = day.tasks.find(t => t.taskId === taskId);
        if (!entry) return;

        entry.completed = completed;
        entry.completedAt = completed ? new Date().toISOString() : null;
        day.completionPct = this._calcCompletionPct(day);
        this.save();
    }

    /**
     * Return all day records (for heatmap).
     * @returns {object} { "YYYY-MM-DD": dayRecord }
     */
    getAllDays() {
        return this._data.days;
    }

    /**
     * Regenerate today's task list from current task definitions.
     * Called on date rollover or first open of the day.
     * Preserves existing completion state if tasks were already started.
     * @param {Date} [forDate=new Date()]
     */
    rolloverDay(forDate = new Date()) {
        const key = _dateKey(forDate);
        const existing = this._data.days[key];

        // Build a map of existing completion states
        const existingState = {};
        if (existing) {
            for (const entry of existing.tasks) {
                existingState[entry.taskId] = {
                    completed: entry.completed,
                    completedAt: entry.completedAt,
                };
            }
        }

        const dayOfWeek = forDate.getDay(); // 0=Sun..6=Sat

        // Build fresh task list from definitions that apply today
        const todayTasks = [];
        for (const task of this._data.tasks) {
            const applies = this._taskAppliesToDay(task, forDate, dayOfWeek);
            if (!applies) continue;

            const prev = existingState[task.id] || {};
            todayTasks.push({
                taskId: task.id,
                title: task.title,
                time: task.time,
                completed: prev.completed || false,
                completedAt: prev.completedAt || null,
            });
        }

        // Sort by time
        todayTasks.sort((a, b) => a.time.localeCompare(b.time));

        this._data.days[key] = {
            date: key,
            tasks: todayTasks,
            completionPct: this._calcCompletionPct({ tasks: todayTasks }),
        };
        this.save();
    }

    // ── Seed / debug ──────────────────────────────────────────────────────────

    /**
     * Generate ~12 weeks of fake history for heatmap testing.
     * Called via HABBITPOP_SEED=1 env flag.
     */
    seedFakeHistory() {
        const today = new Date();
        for (let i = 83; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const key = _dateKey(d);

            // Skip if already has real data
            if (this._data.days[key]?.tasks?.length > 0) continue;

            const total = 5 + Math.floor(Math.random() * 5);
            const done = Math.floor(Math.random() * (total + 1));
            const tasks = [];
            for (let j = 0; j < total; j++) {
                tasks.push({
                    taskId: `seed_${j}`,
                    title: `Task ${j + 1}`,
                    time: `${String(8 + j).padStart(2, '0')}:00`,
                    completed: j < done,
                    completedAt: j < done ? d.toISOString() : null,
                });
            }
            this._data.days[key] = {
                date: key,
                tasks,
                completionPct: Math.round((done / total) * 100),
            };
        }
        this.save();
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _emptyData() {
        return { version: DATA_VERSION, tasks: [], days: {} };
    }

    _freshDayRecord(key) {
        return { date: key, tasks: [], completionPct: 0 };
    }

    _calcCompletionPct(day) {
        if (!day.tasks.length) return 0;
        const done = day.tasks.filter(t => t.completed).length;
        return Math.round((done / day.tasks.length) * 100);
    }

    _taskAppliesToDay(task, date, dayOfWeek) {
        if (task.repeat === 'daily') return true;
        if (task.repeat === 'none') {
            // Show todos only on their creation day or if created before today
            // and not yet completed — show them every day until completed.
            // For simplicity: todos without repeat appear every day.
            return true;
        }
        if (task.repeat && typeof task.repeat === 'object' && Array.isArray(task.repeat.weekdays)) {
            return task.repeat.weekdays.includes(dayOfWeek);
        }
        return true;
    }

    _backupCorrupt() {
        try {
            const src = Gio.File.new_for_path(this._dataPath);
            const ts = Date.now();
            const bakPath = `${this._dataPath}.bak.${ts}`;
            const dst = Gio.File.new_for_path(bakPath);
            src.copy(dst, Gio.FileCopyFlags.NONE, null, null);
        } catch (_) {
            // Best-effort backup
        }
    }
}
