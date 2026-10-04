/**
 * taskManager.js — PULSE business logic layer
 *
 * Task state uses from/to window:
 *   upcoming:  now < from
 *   current:   from ≤ now < to
 *   missed:    now ≥ to, not completed
 *   completed: entry.completed === true
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

export const TaskState = Object.freeze({
    UPCOMING:  'upcoming',
    CURRENT:   'current',
    COMPLETED: 'completed',
    MISSED:    'missed',
});

function _toMins(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
}

/**
 * Compute task state from from/to window.
 * Falls back to legacy `time` field (+ 60-min window) if no `to`.
 */
export function computeTaskState(entry, now) {
    if (entry.completed) return TaskState.COMPLETED;

    const nowMins = now.getHours() * 60 + now.getMinutes();
    const fromMins = _toMins(entry.from || entry.time);
    const toMins   = entry.to ? _toMins(entry.to) : fromMins + 60;

    if (nowMins >= fromMins && nowMins < toMins) return TaskState.CURRENT;
    if (nowMins >= toMins)                       return TaskState.MISSED;
    return TaskState.UPCOMING;
}

/**
 * 0% → 0, 1-33% → 1, 34-66% → 2, 67-99% → 3, 100% → 4
 */
export function pctToLevel(pct) {
    if (pct === 0)  return 0;
    if (pct <= 33)  return 1;
    if (pct <= 66)  return 2;
    if (pct <= 99)  return 3;
    return 4;
}

export class TaskManager extends GObject.Object {
    static {
        GObject.registerClass({
            Signals: {
                'tasks-changed':  {},
                'day-rolled-over': {},
            },
        }, this);
    }

    constructor(storage) {
        super();
        this._storage = storage;
        this._midnightTimer = null;
    }

    start() {
        this._ensureToday();
        this._scheduleMidnight();
    }

    stop() {
        if (this._midnightTimer) {
            GLib.source_remove(this._midnightTimer);
            this._midnightTimer = null;
        }
    }

    // ── Today ─────────────────────────────────────────────────────────────────

    getTodayTasks() {
        const day = this._storage.getDay(new Date());
        const now = new Date();
        return day.tasks.map(e => ({ ...e, state: computeTaskState(e, now) }));
    }

    toggleTask(taskId) {
        const day = this._storage.getDay(new Date());
        const entry = day.tasks.find(t => t.taskId === taskId);
        if (!entry) return false;
        const next = !entry.completed;
        this._storage.setTaskCompleted(taskId, next);
        this.emit('tasks-changed');
        return next;
    }

    addTask(def) {
        const task = this._storage.addTask(def);
        this._storage.rolloverDay(new Date());
        this.emit('tasks-changed');
        return task;
    }

    updateTask(id, updates) {
        this._storage.updateTask(id, updates);
        this._storage.rolloverDay(new Date());
        this.emit('tasks-changed');
    }

    deleteTask(id) {
        this._storage.deleteTask(id);
        this._storage.rolloverDay(new Date());
        this.emit('tasks-changed');
    }

    // ── Heatmap ───────────────────────────────────────────────────────────────

    getHeatmapData(days = 84) {
        const allDays = this._storage.getAllDays();
        const result = [];
        const today = new Date();
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const key = this._key(d);
            const rec = allDays[key];
            const pct = rec ? rec.completionPct : 0;
            result.push({
                date: key,
                dateObj: new Date(d),
                completionPct: pct,
                level: pctToLevel(pct),
                tasks: rec ? rec.tasks : [],
                isToday: i === 0,
            });
        }
        return result;
    }

    getTodaySummary() {
        const day = this._storage.getDay(new Date());
        const total = day.tasks.length;
        const completed = day.tasks.filter(t => t.completed).length;
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
        return { total, completed, pct };
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _ensureToday() {
        const day = this._storage.getDay(new Date());
        if (!day.tasks.length)
            this._storage.rolloverDay(new Date());
    }

    _scheduleMidnight() {
        const now = new Date();
        const ms = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5) - now;
        this._midnightTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._midnightTimer = null;
            this._storage.rolloverDay(new Date());
            this.emit('day-rolled-over');
            this.emit('tasks-changed');
            this._scheduleMidnight();
            return GLib.SOURCE_REMOVE;
        });
    }

    _key(d) {
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
}
