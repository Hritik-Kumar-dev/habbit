#!/usr/bin/env -S gjs -m
/**
 * seed.js — Generate ~12 weeks of fake history for heatmap testing
 *
 * This is a standalone GJS ESM module. Run from terminal:
 *   gjs -m seed.js        ← always works
 *   ./seed.js             ← works after: chmod +x seed.js
 *
 * Or set HABBITPOP_SEED=1 before enabling the extension
 * (extension calls storage.seedFakeHistory() on load when set).
 *
 * Writes to the same data.json the extension uses.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'habbitpop@hritikdev']);
const DATA_PATH = GLib.build_filenamev([DATA_DIR, 'data.json']);

function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// Ensure directory exists
const dir = Gio.File.new_for_path(DATA_DIR);
if (!dir.query_exists(null)) {
    dir.make_directory_with_parents(null);
}

// Load existing data or create fresh
let data;
const file = Gio.File.new_for_path(DATA_PATH);
if (file.query_exists(null)) {
    try {
        const [, contents] = file.load_contents(null);
        data = JSON.parse(new TextDecoder().decode(contents));
    } catch (_) {
        data = { version: 1, tasks: [], days: {} };
    }
} else {
    data = { version: 1, tasks: [], days: {} };
}

// Sample tasks for realistic seed data
const sampleTasks = [
    { id: 'seed_t1', title: 'Morning exercise', time: '07:00', type: 'habit', repeat: 'daily' },
    { id: 'seed_t2', title: 'Read for 30 minutes', time: '08:30', type: 'habit', repeat: 'daily' },
    { id: 'seed_t3', title: 'Review emails', time: '09:00', type: 'todo', repeat: 'none' },
    { id: 'seed_t4', title: 'Deep work block', time: '10:00', type: 'habit', repeat: 'daily' },
    { id: 'seed_t5', title: 'Lunch break walk', time: '13:00', type: 'habit', repeat: { weekdays: [1,2,3,4,5] } },
    { id: 'seed_t6', title: 'Journal entry', time: '21:00', type: 'habit', repeat: 'daily' },
    { id: 'seed_t7', title: 'Weekly review', time: '18:00', type: 'habit', repeat: { weekdays: [5] } },
    { id: 'seed_t8', title: 'Meditate 10 min', time: '07:30', type: 'habit', repeat: 'daily' },
];

// Merge sample tasks (don't duplicate)
for (const t of sampleTasks) {
    if (!data.tasks.find(x => x.id === t.id)) {
        data.tasks.push({ ...t, createdAt: new Date().toISOString() });
    }
}

const today = new Date();

// Deterministic pseudo-random in [0,1) from an arbitrary key — Math.sin(i * k)
// alone gives the same value for every task of a day, which flattens the
// heatmap to 0%/100% days only.
function rng(...parts) {
    const key = parts.join('|');
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    // xorshift finaliser so nearby keys decorrelate
    h ^= h >>> 15;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909) >>> 0;
    h ^= h >>> 16;
    return h / 4294967296;
}

// Generate 84 days (12 weeks) of history
for (let i = 83; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = dateKey(d);

    // Skip today (let the extension handle that fresh)
    if (i === 0) continue;

    // Skip if real data exists already
    if (data.days[key]?.tasks?.some(t => !t.taskId.startsWith('seed_'))) continue;

    // Simulate a realistic completion curve:
    // weekends slightly lower, the odd completely-off day, ~60% average.
    // The spread matters — it has to exercise all five heatmap levels.
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;

    // ~8% of days are complete rest days (0%)
    const isRestDay = rng('rest', key) < 0.08;

    // Base completion probability + noise
    const base = isWeekend ? 0.45 : 0.68;
    const dayRng = rng('day', key); // deterministic pseudo-random
    const pFull = isRestDay ? 0 : Math.max(0.1, Math.min(1, base + (dayRng - 0.5) * 0.5));

    const dayTasks = sampleTasks
        .filter(t => {
            if (t.repeat === 'daily') return true;
            if (t.repeat === 'none') return true;
            if (t.repeat && typeof t.repeat === 'object') return t.repeat.weekdays.includes(dow);
            return false;
        })
        .map(t => {
            // Per-task jitter: different task, different outcome
            const taskRng = rng('task', key, t.id);
            const completed = taskRng < pFull;
            return {
                taskId: t.id,
                title: t.title,
                time: t.time,
                completed,
                completedAt: completed ? new Date(d.getTime() + 3600000).toISOString() : null,
            };
        });

    const done = dayTasks.filter(t => t.completed).length;
    const pct = dayTasks.length > 0 ? Math.round((done / dayTasks.length) * 100) : 0;

    data.days[key] = {
        date: key,
        tasks: dayTasks,
        completionPct: pct,
    };
}

// Write atomically
const tmpPath = `${DATA_PATH}.tmp`;
const text = JSON.stringify(data, null, 2);
const bytes = new TextEncoder().encode(text);
const tmpFile = Gio.File.new_for_path(tmpPath);
const outStream = tmpFile.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
outStream.write_all(bytes, null);
outStream.close(null);
GLib.rename(tmpPath, DATA_PATH);

print(`[seed.js] Done! Seeded ${Object.keys(data.days).length} days of history.`);
print(`[seed.js] Data written to: ${DATA_PATH}`);
print('[seed.js] Restart the extension to pick up the new data.');
