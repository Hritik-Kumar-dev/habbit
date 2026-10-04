#!/usr/bin/env -S gjs -m
/**
 * tests/test-storage.js — Unit tests for src/storage.js
 *
 * Run: gjs -m tests/test-storage.js
 *   or: ./tests/test-storage.js
 *
 * Tests: load/save, corrupt-file recovery, addTask, deleteTask, updateTask,
 *        rolloverDay (daily / weekday / none repeat), setTaskCompleted,
 *        completionPct, seedFakeHistory.
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

// ── Test-specific temp directory (isolated from real data) ────────────────────
const BASE_TMP = GLib.build_filenamev([GLib.get_tmp_dir(), `habbitpop-test-${Date.now()}`]);
let _currentTmpDir = BASE_TMP;

const _origGetUserDataDir = GLib.get_user_data_dir;
GLib.get_user_data_dir = () => _currentTmpDir;

// Import storage AFTER patching
const { Storage } = await import('../src/storage.js');

function cleanup() {
    GLib.get_user_data_dir = _origGetUserDataDir;
    _rmdirRecursive(Gio.File.new_for_path(BASE_TMP));
}

function _rmdirRecursive(dir) {
    try {
        const iter = dir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = iter.next_file(null)) !== null) {
            const child = dir.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                _rmdirRecursive(child);
            else
                child.delete(null);
        }
        iter.close(null);
        dir.delete(null);
    } catch (_) {}
}

function freshStorage() {
    // Each call gets its own isolated subdirectory so tests don't share state
    _currentTmpDir = GLib.build_filenamev([BASE_TMP, `run-${_passed + _failed + 1}`]);
    const s = new Storage();
    s.load();
    return s;
}

// Helper: date string N days from today
function daysFromNow(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

const TODAY_KEY = daysFromNow(0);

// ══════════════════════════════════════════════════════════════════════════════
section('Storage — initial state');
{
    const s = freshStorage();
    assertEqual(s.getTasks(), [], 'fresh store has no tasks');
    assertEqual(s.getAllDays(), {}, 'fresh store has no days');
}

// ══════════════════════════════════════════════════════════════════════════════
section('Storage — addTask / getTasks');
{
    const s = freshStorage();
    const t = s.addTask({ title: 'Test', from: '08:00', to: '08:30', type: 'habit', repeat: 'daily' });
    assert(t.id.startsWith('t_'), 'id is prefixed t_');
    assert(typeof t.createdAt === 'string', 'createdAt is string');
    assertEqual(s.getTasks().length, 1, 'one task after add');
    assertEqual(s.getTasks()[0].title, 'Test', 'title matches');
}

// ══════════════════════════════════════════════════════════════════════════════
section('Storage — updateTask');
{
    const s = freshStorage();
    const t = s.addTask({ title: 'Old title', from: '09:00', to: '09:30', type: 'todo', repeat: 'none' });
    s.updateTask(t.id, { title: 'New title', from: '10:00', to: '10:30' });
    const updated = s.getTasks().find(x => x.id === t.id);
    assertEqual(updated.title, 'New title', 'title updated');
    assertEqual(updated.from, '10:00', 'time updated');
}

// ══════════════════════════════════════════════════════════════════════════════
section('Storage — deleteTask');
{
    const s = freshStorage();
    const t = s.addTask({ title: 'Delete me', from: '07:00', to: '07:30', type: 'habit', repeat: 'daily' });
    assertEqual(s.getTasks().length, 1, 'one task before delete');
    s.deleteTask(t.id);
    assertEqual(s.getTasks().length, 0, 'zero tasks after delete');
}

// ══════════════════════════════════════════════════════════════════════════════
section('Storage — rolloverDay (daily habit)');
{
    const s = freshStorage();
    s.addTask({ title: 'Daily', from: '07:00', to: '07:30', type: 'habit', repeat: 'daily' });
    s.rolloverDay(new Date());
    const day = s.getDay(new Date());
    assertEqual(day.tasks.length, 1, 'daily task appears today');
    assertEqual(day.tasks[0].title, 'Daily', 'correct title');
    assertEqual(day.tasks[0].completed, false, 'starts incomplete');
}

// ══════════════════════════════════════════════════════════════════════════════
section('Storage — rolloverDay (weekday repeat)');
{
    const s = freshStorage();
    // Create a task that only repeats on days 1–5 (Mon–Fri)
    s.addTask({ title: 'Weekday', from: '09:00', to: '09:30', type: 'habit', repeat: { weekdays: [1,2,3,4,5] } });
    s.addTask({ title: 'Weekend', from: '10:00', to: '10:30', type: 'habit', repeat: { weekdays: [0,6] } });

    // Build explicit Monday and Sunday dates (no dependency on "today")
    // Use a fixed reference: 2026-10-05 is a Monday, 2026-10-04 is a Sunday
    const monday = new Date(2026, 9, 5);  // Oct 5 2026 = Monday (DOW=1)
    const sunday = new Date(2026, 9, 4);  // Oct 4 2026 = Sunday (DOW=0)

    // Roll over for Monday (DOW=1)
    s.rolloverDay(monday);
    const monDay = s.getDay(monday);
    const monTitles = monDay.tasks.map(t => t.title);
    assert(monTitles.includes('Weekday'), 'Weekday task on Monday');
    assert(!monTitles.includes('Weekend'), 'Weekend task NOT on Monday');

    // Roll over for Sunday (DOW=0)
    s.rolloverDay(sunday);
    const sunDay = s.getDay(sunday);
    const sunTitles = sunDay.tasks.map(t => t.title);
    assert(!sunTitles.includes('Weekday'), 'Weekday task NOT on Sunday');
    assert(sunTitles.includes('Weekend'), 'Weekend task on Sunday');
}

// ══════════════════════════════════════════════════════════════════════════════
section('Storage — setTaskCompleted + completionPct');
{
    const s = freshStorage();
    const t1 = s.addTask({ title: 'A', from: '07:00', to: '07:30', type: 'habit', repeat: 'daily' });
    const t2 = s.addTask({ title: 'B', from: '08:00', to: '08:30', type: 'habit', repeat: 'daily' });
    const t3 = s.addTask({ title: 'C', from: '09:00', to: '09:30', type: 'habit', repeat: 'daily' });
    s.rolloverDay(new Date());

    s.setTaskCompleted(t1.id, true);
    s.setTaskCompleted(t2.id, true);

    const day = s.getDay(new Date());
    assertEqual(day.completionPct, 67, '2/3 tasks = 67%');

    const entry = day.tasks.find(e => e.taskId === t1.id);
    assert(entry.completed, 't1 marked completed');
    assert(typeof entry.completedAt === 'string', 'completedAt is string when completed');

    // Un-complete t1
    s.setTaskCompleted(t1.id, false);
    const day2 = s.getDay(new Date());
    const e1 = day2.tasks.find(e => e.taskId === t1.id);
    assert(!e1.completed, 't1 un-completed');
    assert(e1.completedAt === null, 'completedAt null when un-completed');
    assertEqual(day2.completionPct, 33, '1/3 tasks = 33%');
}

// ══════════════════════════════════════════════════════════════════════════════
section('Storage — rollover preserves existing completion state');
{
    const s = freshStorage();
    const t = s.addTask({ title: 'Keep', from: '07:00', to: '07:30', type: 'habit', repeat: 'daily' });
    s.rolloverDay(new Date());
    s.setTaskCompleted(t.id, true);

    // Roll over again (simulates calling rolloverDay twice in the same day)
    s.rolloverDay(new Date());
    const day = s.getDay(new Date());
    const entry = day.tasks.find(e => e.taskId === t.id);
    assert(entry.completed, 'completion preserved across re-rollover');
}

// ══════════════════════════════════════════════════════════════════════════════
section('Storage — corrupt file recovery');
{
    // Set up a fresh isolated dir, then overwrite the data file with garbage
    _currentTmpDir = GLib.build_filenamev([BASE_TMP, 'corrupt-test']);
    const dataDir = GLib.build_filenamev([_currentTmpDir, 'pulse@hritikdev']);
    const dataPath = GLib.build_filenamev([dataDir, 'data.json']);

    const corruptDir = Gio.File.new_for_path(dataDir);
    if (!corruptDir.query_exists(null))
        corruptDir.make_directory_with_parents(null);

    const f = Gio.File.new_for_path(dataPath);
    const out = f.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    const garbage = new TextEncoder().encode('{ this is not valid json !!!');
    out.write_all(garbage, null);
    out.close(null);

    // Load should not throw; should start fresh and create a .bak file
    let threw = false;
    let s;
    try {
        s = new Storage();
        s.load();
    } catch (e) {
        threw = true;
    }
    assert(!threw, 'corrupt file does not throw');
    assertEqual(s.getTasks(), [], 'fresh state after corrupt file');

    // Check that a .bak file was created
    const bakExists = Gio.File.new_for_path(dataDir)
        .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let foundBak = false;
    let info;
    while ((info = bakExists.next_file(null)) !== null) {
        if (info.get_name().includes('.bak.')) foundBak = true;
    }
    bakExists.close(null);
    assert(foundBak, '.bak file created for corrupt data');
}

// ══════════════════════════════════════════════════════════════════════════════
section('Storage — save + reload round-trip');
{
    // Both Storage instances must point to the same dir
    _currentTmpDir = GLib.build_filenamev([BASE_TMP, 'roundtrip-test']);
    const s = new Storage();
    s.load();
    const t = s.addTask({ title: 'Persist', from: '08:30', to: '09:00', type: 'todo', repeat: 'none' });
    s.rolloverDay(new Date());
    s.setTaskCompleted(t.id, true);

    // Load a second instance from the same file
    const s2 = new Storage();
    s2.load();
    const tasks = s2.getTasks();
    assertEqual(tasks.length, 1, 'task survives save+reload');
    assertEqual(tasks[0].title, 'Persist', 'title survives');
    const day = s2.getDay(new Date());
    const entry = day.tasks.find(e => e.taskId === t.id);
    assert(entry?.completed, 'completed state survives save+reload');
}

// ══════════════════════════════════════════════════════════════════════════════
section('Storage — seedFakeHistory');
{
    const s = freshStorage();    s.seedFakeHistory();
    const days = s.getAllDays();
    const keys = Object.keys(days);
    assert(keys.length >= 80, `at least 80 days seeded (got ${keys.length})`);

    // All pct values should be 0–100
    const validPcts = keys.every(k => {
        const p = days[k].completionPct;
        return typeof p === 'number' && p >= 0 && p <= 100;
    });
    assert(validPcts, 'all completionPct values in 0–100');

    // Should have all 5 heatmap levels represented, so the colour ramp is exercised
    const { pctToLevel } = await import('../src/taskManager.js');
    const levels = new Set(keys.map(k => pctToLevel(days[k].completionPct)));
    assert(levels.size === 5, `all 5 heatmap levels present (got ${levels.size}: ${[...levels].sort().join(',')})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Results
cleanup();
print('');
print(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
print(`test-storage.js: ${_passed} passed, ${_failed} failed`);
if (_failures.length) {
    print('FAILED:');
    _failures.forEach(f => print(`  ✗ ${f}`));
    print('');
    import('system').then(({exit}) => exit(1));
} else {
    print('All tests passed ✓');
    print('');
}
