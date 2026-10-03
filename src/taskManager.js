/**
 * taskManager.js — HabbitPop business logic layer
 *
 * Sits between storage.js (raw data) and the UI panels.
 * Handles:
 *   - Date rollover (midnight + resume-from-suspend)
 *   - Task state computation (upcoming / current / completed / missed)
 *   - Recurring habit generation
 *   - Signals to notify UI of changes
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

// ── Task states ────────────────────────────────────────────────────────────────
export const TaskState = Object.freeze({
    UPCOMING:  'upcoming',
    CURRENT:   'current',
    COMPLETED: 'completed',
    MISSED:    'missed',
});

/**
 * Parse "HH:MM" into minutes since midnight.
 * @param {string} time
 * @returns {number}
 */
function _timeToMinutes(time) {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
}

/**
 * Compute what state a task entry is in right now.
 *
 * Rules:
 *   - completed: entry.completed === true
 *   - current: task time window is active (time ≤ now < time + 60 min)
 *   - missed: task time has passed more than 60 min ago and not completed
 *   - upcoming: task time is in the future (or within 60 min window)
 *
 * @param {object} entry  { taskId, title, time, completed, completedAt }
 * @param {Date}   now
 * @returns {string}  one of TaskState.*
 */
export function computeTaskState(entry, now) {
    if (entry.completed) return TaskState.COMPLETED;

    const taskMins = _timeToMinutes(entry.time);
    const nowMins = now.getHours() * 60 + now.getMinutes();

    if (nowMins >= taskMins && nowMins < taskMins + 60)
        return TaskState.CURRENT;

    if (nowMins >= taskMins + 60)
        return TaskState.MISSED;

    return TaskState.UPCOMING;
}

/**
 * Compute the completion intensity level for the heatmap.
 * 0% → 0, 1-33% → 1, 34-66% → 2, 67-99% → 3, 100% → 4
 * @param {number} pct  0-100
 * @returns {number} 0-4
 */
export function pctToLevel(pct) {
    if (pct === 0)  return 0;
    if (pct <= 33)  return 1;
    if (pct <= 66)  return 2;
    if (pct <= 99)  return 3;
    return 4;
}

// ── TaskManager class ──────────────────────────────────────────────────────────

export class TaskManager extends GObject.Object {
    static {
        GObject.registerClass({
            Signals: {
                // Emitted when today's task list changes (add/delete/complete)
                'tasks-changed': {},
                // Emitted on date rollover
                'day-rolled-over': {},
            },
        }, this);
    }

    constructor(storage) {
        super();
        this._storage = storage;
        this._midnightTimer = null;
        this._today = this._todayKey();
    }

    /**
     * Start the manager: rollover today, schedule midnight timer.
     */
    start() {
        this._ensureToday();
        this._scheduleMidnight();
    }

    /**
     * Stop the manager: clear timers.
     */
    stop() {
        if (this._midnightTimer) {
            GLib.source_remove(this._midnightTimer);
            this._midnightTimer = null;
        }
    }

    // ── Today's tasks ─────────────────────────────────────────────────────────

    /**
     * Return today's task entries with computed state.
     * @returns {object[]}  [...entry, state: TaskState.*]
     */
    getTodayTasks() {
        const day = this._storage.getDay(new Date());
        const now = new Date();
        return day.tasks.map(entry => ({
            ...entry,
            state: computeTaskState(entry, now),
        }));
    }

    /**
     * Toggle a task's completed state.
     * @param {string} taskId
     * @returns {boolean} new completed state
     */
    toggleTask(taskId) {
        const day = this._storage.getDay(new Date());
        const entry = day.tasks.find(t => t.taskId === taskId);
        if (!entry) return false;

        const newState = !entry.completed;
        this._storage.setTaskCompleted(taskId, newState);
        this.emit('tasks-changed');
        return newState;
    }

    /**
     * Add a new task definition and immediately generate today's entry.
     * @param {object} taskDef  { title, time, type, repeat }
     * @returns {object} created task
     */
    addTask(taskDef) {
        const task = this._storage.addTask(taskDef);
        // Re-rollover today to include the new task
        this._storage.rolloverDay(new Date());
        this.emit('tasks-changed');
        return task;
    }

    /**
     * Update a task definition and re-rollover today.
     * @param {string} id
     * @param {object} updates
     */
    updateTask(id, updates) {
        this._storage.updateTask(id, updates);
        this._storage.rolloverDay(new Date());
        this.emit('tasks-changed');
    }

    /**
     * Delete a task definition.
     * @param {string} id
     */
    deleteTask(id) {
        this._storage.deleteTask(id);
        this._storage.rolloverDay(new Date());
        this.emit('tasks-changed');
    }

    // ── Heatmap data ──────────────────────────────────────────────────────────

    /**
     * Return the last N days of completion data for the heatmap.
     * @param {number} [days=84]  12 weeks
     * @returns {object[]} [{date, completionPct, level, tasks}, ...]
     */
    getHeatmapData(days = 84) {
        const allDays = this._storage.getAllDays();
        const result = [];
        const today = new Date();

        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const key = this._keyFromDate(d);
            const dayRecord = allDays[key];
            const pct = dayRecord ? dayRecord.completionPct : 0;

            result.push({
                date: key,
                dateObj: new Date(d),
                completionPct: pct,
                level: pctToLevel(pct),
                tasks: dayRecord ? dayRecord.tasks : [],
                isToday: i === 0,
            });
        }
        return result;
    }

    /**
     * Today's summary stats.
     * @returns {{ total: number, completed: number, pct: number }}
     */
    getTodaySummary() {
        const day = this._storage.getDay(new Date());
        const total = day.tasks.length;
        const completed = day.tasks.filter(t => t.completed).length;
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
        return { total, completed, pct };
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _ensureToday() {
        const key = this._todayKey();
        // If the stored day record is missing or empty, do a rollover
        const day = this._storage.getDay(new Date());
        if (!day.tasks.length) {
            this._storage.rolloverDay(new Date());
        }
    }

    _scheduleMidnight() {
        const now = new Date();
        const msToMidnight =
            new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
            - now;

        // GLib.timeout_add only accepts seconds or milliseconds
        // Use a one-shot timer, then reschedule
        this._midnightTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, msToMidnight, () => {
            this._midnightTimer = null;
            this._handleMidnight();
            return GLib.SOURCE_REMOVE;
        });
    }

    _handleMidnight() {
        this._storage.rolloverDay(new Date());
        this.emit('day-rolled-over');
        this.emit('tasks-changed');
        this._scheduleMidnight();
    }

    _todayKey() {
        return this._keyFromDate(new Date());
    }

    _keyFromDate(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
}
