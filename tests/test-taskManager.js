#!/usr/bin/env -S gjs -m
/**
 * tests/test-taskManager.js — Unit tests for src/taskManager.js
 *
 * Run: gjs -m tests/test-taskManager.js
 *   or: ./tests/test-taskManager.js
 *
 * Tests: computeTaskState, pctToLevel, getTodayTasks, toggleTask,
 *        addTask, deleteTask, updateTask, getHeatmapData, getTodaySummary,
 *        midnight rollover scheduling.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// ── Minimal test harness ──────────────────────────────────────────────────────
let _passed = 0;
let _failed = 0;
const _failures = [];

function assert(condition, name) {
    if (condition) {
        print(`  ✓ ${name}`);
        _passed++;
    } else {
        print(`  ✗ ${name}`);
        _failed++;
        _failures.push(name);
    }
}

function assertEqual(a, b, name) {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    if (!ok) print(`    expected: ${JSON.stringify(b)}\n    got:      ${JSON.stringify(a)}`);
    assert(ok, name);
}

function section(name) {
    print(`\n── ${name} ──`);
}

// ── Isolated temp storage dir ─────────────────────────────────────────────────
const BASE_TMP = GLib.build_filenamev([GLib.get_tmp_dir(), `habbitpop-tm-test-${Date.now()}`]);
let _currentTmpDir = BASE_TMP;

const _origGetUserDataDir = GLib.get_user_data_dir;
GLib.get_user_data_dir = () => _currentTmpDir;

const { Storage } = await import('../src/storage.js');
const { TaskManager, TaskState, computeTaskState, pctToLevel } = await import('../src/taskManager.js');

function cleanup() {
    GLib.get_user_data_dir = _origGetUserDataDir;
    _rmrf(Gio.File.new_for_path(BASE_TMP));
}

function _rmrf(dir) {
    try {
        const iter = dir.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = iter.next_file(null)) !== null) {
            const child = dir.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY) _rmrf(child);
            else child.delete(null);
        }
        iter.close(null);
        dir.delete(null);
    } catch (_) {}
}

/** Build a date for today at a given HH:MM. */
function todayAt(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
}

/** Build a fake "now" N minutes offset from a given HH:MM today. */
function nowAt(hhmm, offsetMin = 0) {
    const d = todayAt(hhmm);
    d.setMinutes(d.getMinutes() + offsetMin);
    return d;
}

function freshManager() {
    // Each call gets its own isolated subdirectory so tests don't share state
    _currentTmpDir = GLib.build_filenamev([BASE_TMP, `run-${_passed + _failed + 1}`]);
    const s = new Storage();
    s.load();
    const tm = new TaskManager(s);
    return { s, tm };
}

// ══════════════════════════════════════════════════════════════════════════════
section('computeTaskState — completed');
{
    const entry = { taskId: 'x', title: 'T', time: '08:00', completed: true, completedAt: new Date().toISOString() };
    assertEqual(computeTaskState(entry, new Date()), TaskState.COMPLETED, 'completed entry → COMPLETED');
}

section('computeTaskState — upcoming');
{
    // Task at 23:50, now is 08:00
    const entry = { taskId: 'x', title: 'T', time: '23:50', completed: false, completedAt: null };
    const now = nowAt('08:00');
    assertEqual(computeTaskState(entry, now), TaskState.UPCOMING, 'future task → UPCOMING');
}

section('computeTaskState — current (within window)');
{
    // Task at 10:00, now is 10:30 (inside 60-min window)
    const entry = { taskId: 'x', title: 'T', time: '10:00', completed: false, completedAt: null };
    const now = nowAt('10:00', 30); // 10:30
    assertEqual(computeTaskState(entry, now), TaskState.CURRENT, '30min in window → CURRENT');
}

section('computeTaskState — current (at window start)');
{
    const entry = { taskId: 'x', title: 'T', time: '10:00', completed: false, completedAt: null };
    const now = nowAt('10:00', 0); // exactly 10:00
    assertEqual(computeTaskState(entry, now), TaskState.CURRENT, 'exactly at time → CURRENT');
}

section('computeTaskState — current (at window end - 1min)');
{
    const entry = { taskId: 'x', title: 'T', time: '10:00', completed: false, completedAt: null };
    const now = nowAt('10:00', 59); // 10:59
    assertEqual(computeTaskState(entry, now), TaskState.CURRENT, '59min in window → CURRENT');
}

section('computeTaskState — missed (just past window)');
{
    // Task at 10:00, now is 11:01 (60+ min ago)
    const entry = { taskId: 'x', title: 'T', time: '10:00', completed: false, completedAt: null };
    const now = nowAt('10:00', 61); // 11:01
    assertEqual(computeTaskState(entry, now), TaskState.MISSED, '61min past → MISSED');
}

section('computeTaskState — missed (well past)');
{
    const entry = { taskId: 'x', title: 'T', time: '07:00', completed: false, completedAt: null };
    const now = nowAt('22:00');
    assertEqual(computeTaskState(entry, now), TaskState.MISSED, 'hours past → MISSED');
}

// ══════════════════════════════════════════════════════════════════════════════
section('pctToLevel');
{
    assertEqual(pctToLevel(0),   0, '0%   → level 0');
    assertEqual(pctToLevel(1),   1, '1%   → level 1');
    assertEqual(pctToLevel(33),  1, '33%  → level 1');
    assertEqual(pctToLevel(34),  2, '34%  → level 2');
    assertEqual(pctToLevel(66),  2, '66%  → level 2');
    assertEqual(pctToLevel(67),  3, '67%  → level 3');
    assertEqual(pctToLevel(99),  3, '99%  → level 3');
    assertEqual(pctToLevel(100), 4, '100% → level 4');
}

// ══════════════════════════════════════════════════════════════════════════════
section('TaskManager — getTodayTasks (empty)');
{
    const { tm } = freshManager();
    tm.start();
    assertEqual(tm.getTodayTasks(), [], 'no tasks when none defined');
    tm.stop();
}

section('TaskManager — addTask appears in getTodayTasks');
{
    const { tm } = freshManager();
    tm.start();
    tm.addTask({ title: 'Morning run', time: '07:00', type: 'habit', repeat: 'daily' });
    const tasks = tm.getTodayTasks();
    assertEqual(tasks.length, 1, 'one task after add');
    assertEqual(tasks[0].title, 'Morning run', 'correct title');
    assert(Object.values(TaskState).includes(tasks[0].state), 'has a valid state');
    tm.stop();
}

section('TaskManager — toggleTask (false → true → false)');
{
    const { tm } = freshManager();
    tm.start();
    tm.addTask({ title: 'Toggle me', time: '09:00', type: 'habit', repeat: 'daily' });
    const [task] = tm.getTodayTasks();

    const newState = tm.toggleTask(task.taskId);
    assert(newState === true, 'toggleTask returns true on first toggle');
    assertEqual(tm.getTodayTasks()[0].state, TaskState.COMPLETED, 'state is COMPLETED after toggle');

    const back = tm.toggleTask(task.taskId);
    assert(back === false, 'toggleTask returns false on second toggle');
    assert(tm.getTodayTasks()[0].state !== TaskState.COMPLETED, 'state is not COMPLETED after un-toggle');
    tm.stop();
}

section('TaskManager — deleteTask removes from today');
{
    const { tm } = freshManager();
    tm.start();
    tm.addTask({ title: 'Delete me', time: '10:00', type: 'habit', repeat: 'daily' });
    tm.addTask({ title: 'Keep me',   time: '11:00', type: 'habit', repeat: 'daily' });
    assertEqual(tm.getTodayTasks().length, 2, '2 tasks before delete');

    const [first] = tm.getTodayTasks();
    tm.deleteTask(first.taskId);
    assertEqual(tm.getTodayTasks().length, 1, '1 task after delete');
    assertEqual(tm.getTodayTasks()[0].title, 'Keep me', 'correct task remains');
    tm.stop();
}

section('TaskManager — updateTask reflects in today');
{
    const { tm } = freshManager();
    tm.start();
    tm.addTask({ title: 'Old', time: '08:00', type: 'habit', repeat: 'daily' });
    const [t] = tm.getTodayTasks();
    tm.updateTask(t.taskId, { title: 'New', time: '09:00' });
    const updated = tm.getTodayTasks()[0];
    assertEqual(updated.title, 'New', 'title updated in today tasks');
    assertEqual(updated.time, '09:00', 'time updated in today tasks');
    tm.stop();
}

section('TaskManager — tasks-changed signal fires on toggle');
{
    const { tm } = freshManager();
    tm.start();
    tm.addTask({ title: 'Signal test', time: '08:00', type: 'habit', repeat: 'daily' });
    const [t] = tm.getTodayTasks();

    let signalFired = 0;
    const id = tm.connect('tasks-changed', () => signalFired++);
    tm.toggleTask(t.taskId);
    tm.disconnect(id);

    assertEqual(signalFired, 1, 'tasks-changed fired once on toggle');
    tm.stop();
}

section('TaskManager — tasks-changed signal fires on add/delete/update');
{
    const { tm } = freshManager();
    tm.start();

    let count = 0;
    const id = tm.connect('tasks-changed', () => count++);

    tm.addTask({ title: 'A', time: '07:00', type: 'habit', repeat: 'daily' });
    tm.addTask({ title: 'B', time: '08:00', type: 'habit', repeat: 'daily' });
    const [a] = tm.getTodayTasks();
    tm.updateTask(a.taskId, { title: 'A updated' });
    tm.deleteTask(a.taskId);

    tm.disconnect(id);
    assertEqual(count, 4, 'tasks-changed fired 4 times (2 add + 1 update + 1 delete)');
    tm.stop();
}

section('TaskManager — getTodaySummary');
{
    const { tm } = freshManager();
    tm.start();

    const zero = tm.getTodaySummary();
    assertEqual(zero, { total: 0, completed: 0, pct: 0 }, 'zero summary when no tasks');

    tm.addTask({ title: 'A', time: '07:00', type: 'habit', repeat: 'daily' });
    tm.addTask({ title: 'B', time: '08:00', type: 'habit', repeat: 'daily' });
    tm.addTask({ title: 'C', time: '09:00', type: 'habit', repeat: 'daily' });

    const [a, b] = tm.getTodayTasks();
    tm.toggleTask(a.taskId);
    tm.toggleTask(b.taskId);

    const summary = tm.getTodaySummary();
    assertEqual(summary.total, 3, 'total = 3');
    assertEqual(summary.completed, 2, 'completed = 2');
    assertEqual(summary.pct, 67, 'pct = 67');
    tm.stop();
}

section('TaskManager — getHeatmapData structure');
{
    const { s, tm } = freshManager();
    s.seedFakeHistory();
    tm.start();
    const data = tm.getHeatmapData(84);
    assertEqual(data.length, 84, 'exactly 84 entries');

    const last = data[data.length - 1];
    assert(last.isToday, 'last entry is today');

    const first = data[0];
    assert(!first.isToday, 'first entry is not today');

    // All entries have required fields
    const valid = data.every(d =>
        typeof d.date === 'string' &&
        typeof d.completionPct === 'number' &&
        typeof d.level === 'number' &&
        d.level >= 0 && d.level <= 4 &&
        Array.isArray(d.tasks)
    );
    assert(valid, 'all entries have correct shape');

    // With seeded data, every heatmap level should appear (all 5 colours)
    const levels = new Set(data.map(d => d.level));
    assert(levels.size === 5, `all 5 heatmap levels present (got ${levels.size}: ${[...levels].sort().join(',')})`);

    // Dates should be ascending
    let ascending = true;
    for (let i = 1; i < data.length; i++) {
        if (data[i].date <= data[i-1].date) { ascending = false; break; }
    }
    assert(ascending, 'dates are in ascending order');

    tm.stop();
}

section('TaskManager — midnight timer scheduled');
{
    // We can't actually wait for midnight, but we can verify the timer is set
    const { tm } = freshManager();
    tm.start();
    assert(tm._midnightTimer !== null, 'midnight timer is set after start()');
    tm.stop();
    assert(tm._midnightTimer === null, 'midnight timer cleared after stop()');
}

section('TaskManager — stop() is idempotent');
{
    const { tm } = freshManager();
    tm.start();
    tm.stop();
    let threw = false;
    try { tm.stop(); } catch (_) { threw = true; }
    assert(!threw, 'calling stop() twice does not throw');
}

// ══════════════════════════════════════════════════════════════════════════════
// Results
cleanup();
print('');
print(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
print(`test-taskManager.js: ${_passed} passed, ${_failed} failed`);
if (_failures.length) {
    print('FAILED:');
    _failures.forEach(f => print(`  ✗ ${f}`));
    print('');
    const { exit } = await import('system');
    exit(1);
} else {
    print('All tests passed ✓');
    print('');
}
