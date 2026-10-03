/**
 * seed.js — Generate ~12 weeks of fake history for heatmap testing
 *
 * This is a standalone GJS script. Run from terminal:
 *   gjs seed.js
 *
 * Or set HABBITPOP_SEED=1 env variable before enabling the extension.
 *
 * The seed injects into the same data.json that the extension uses.
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
    // Weekends slightly lower, some off days, general ~65% average
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;

    // Base completion probability
    const base = isWeekend ? 0.50 : 0.70;
    // Add some noise
    const dayRng = (Math.sin(i * 7.3 + 1.5) + 1) / 2; // deterministic pseudo-random
    const pFull  = base + (dayRng - 0.5) * 0.3;

    const dayTasks = sampleTasks
        .filter(t => {
            if (t.repeat === 'daily') return true;
            if (t.repeat === 'none') return true;
            if (t.repeat && typeof t.repeat === 'object') return t.repeat.weekdays.includes(dow);
            return false;
        })
        .map(t => {
            const taskRng = (Math.sin(i * 3.7 + t.id.charCodeAt(5)) + 1) / 2;
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
