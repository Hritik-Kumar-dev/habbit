/**
 * extension.js — PULSE GNOME Shell Extension
 *
 * GNOME 50 / ESM format.
 *
 * Architecture
 * ────────────
 * • Adds its own PanelMenu.Button to the top bar via
 *   Main.panel.addToStatusArea('pulse', this._indicator).
 * • The native DateMenu (calendar, notifications, clocks, weather) is
 *   completely untouched — it works exactly as stock GNOME.
 * • Clicking the PULSE indicator opens the PULSE popover (habit list +
 *   heatmap) as a standard dropdown attached to the indicator itself.
 * • disable() destroys the indicator (and thus its popover) and
 *   disconnects all signals. Nothing is left behind.
 *
 * File monitor
 * ────────────
 * A Gio.FileMonitor watches the data file. When apps/settings.js or
 * apps/report.js write changes, the extension reloads storage and
 * re-emits tasks-changed so the popover refreshes live.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { Storage } from './src/storage.js';
import { TaskManager } from './src/taskManager.js';
import { PulsePopover } from './src/pulsePopover.js';

// Popover widths
const POPOVER_WIDTH_MAIN   = 680;    // main + settings views
const POPOVER_WIDTH_REPORT = 1200;   // report view

// ── PulseIndicator ─────────────────────────────────────────────────────────────

const PulseIndicator = GObject.registerClass(
class PulseIndicator extends PanelMenu.Button {
    _init(taskManager, extensionPath) {
        // 0.5 = center-aligned popup (horizontally centered under the button)
        super._init(0.5, 'PULSE');

        this._taskManager = taskManager;
        this._extensionPath = extensionPath;

        this._buildTopBarWidget();
        this._buildPopover();

        // Keep the label in sync whenever tasks change
        this._changedId = taskManager.connect('tasks-changed', () => this._updateLabel());
        this._rolledId  = taskManager.connect('day-rolled-over', () => this._updateLabel());
        this._updateLabel();
    }

    _buildTopBarWidget() {
        // Horizontal box: heartbeat icon + "7/9" progress label
        const box = new St.BoxLayout({
            style_class: 'pulse-indicator-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Icon — use a symbolic that exists in GNOME: activity-symbolic or
        // view-grid-symbolic; fall back to "heart" if available.
        this._icon = new St.Icon({
            icon_name: 'pulse-symbolic',
            fallback_icon_name: 'view-grid-symbolic',
            style_class: 'pulse-indicator-icon system-status-icon',
        });
        box.add_child(this._icon);

        this._label = new St.Label({
            style_class: 'pulse-indicator-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._label);

        this.add_child(box);
    }

    _buildPopover() {
        const monitor = Main.layoutManager.primaryMonitor;
        const screenW = monitor ? monitor.width : 1920;
        const maxMain   = Math.floor(screenW * 0.92);
        const maxReport = Math.floor(screenW * 0.95);

        this._mainW   = Math.min(POPOVER_WIDTH_MAIN,   maxMain);
        this._reportW = Math.min(POPOVER_WIDTH_REPORT, maxReport);

        this._popover = new PulsePopover(
            this._taskManager,
            this._extensionPath,
            this._mainW,
            this._reportW,
        );
        this.menu.box.add_child(this._popover);
        this.menu.box.set_style(`padding: 0; margin: 0; min-width: ${this._mainW}px;`);
    }

    _updateLabel() {
        const { completed, total } = this._taskManager.getTodaySummary();
        if (total === 0) {
            this._label.set_text('');
            this._label.hide();
        } else {
            this._label.set_text(`${completed}/${total}`);
            this._label.show();
        }
    }

    destroy() {
        if (this._changedId) {
            this._taskManager.disconnect(this._changedId);
            this._changedId = null;
        }
        if (this._rolledId) {
            this._taskManager.disconnect(this._rolledId);
            this._rolledId = null;
        }
        super.destroy();
    }
});

// ── Extension ──────────────────────────────────────────────────────────────────

export default class PulseExtension extends Extension {
    enable() {
        // ── Storage + TaskManager ────────────────────────────────────────────
        this._storage = new Storage();

        // Migrate old habbitpop data dir if it exists and new one doesn't yet
        this._storage.migrateFromHabbitpop();

        this._storage.load();

        if (GLib.getenv('PULSE_SEED') === '1')
            this._storage.seedFakeHistory();

        this._taskManager = new TaskManager(this._storage);
        this._taskManager.start();

        // ── Indicator ────────────────────────────────────────────────────────
        this._indicator = new PulseIndicator(
            this._taskManager,
            this.path,
        );

        // Place in the CENTER box, immediately after the native date/time button.
        // dateMenu sits at index 0 of _centerBox children; we insert at index 1
        // so PULSE appears directly to its right.
        // Using addToStatusArea with 'center' puts it in the correct box and
        // registers it so it is properly destroyed on removal.
        Main.panel.addToStatusArea('pulse', this._indicator, 1, 'center');

        // ── File monitor — live reload when settings/report apps write ────────
        this._setupFileMonitor();

        console.log('[PULSE] Enabled.');
    }

    disable() {
        // ── File monitor ─────────────────────────────────────────────────────
        this._teardownFileMonitor();

        // ── Indicator (owns the popover) ──────────────────────────────────────
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        // ── TaskManager ───────────────────────────────────────────────────────
        if (this._taskManager) {
            this._taskManager.stop();
            this._taskManager = null;
        }

        this._storage = null;

        console.log('[PULSE] Disabled.');
    }

    // ── File monitor ──────────────────────────────────────────────────────────

    _setupFileMonitor() {
        const dataPath = this._storage.dataPath;
        const file = Gio.File.new_for_path(dataPath);

        this._fileMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._reloadTimer = null;
        this._ownWrite = false;   // guard: true while WE are writing, ignore our own events

        this._fileMonitorId = this._fileMonitor.connect('changed',
            (_monitor, _file, _otherFile, eventType) => {
                if (eventType !== Gio.FileMonitorEvent.CHANGES_DONE_HINT &&
                    eventType !== Gio.FileMonitorEvent.CREATED) return;

                // Ignore events caused by our own saves (prevents reload loop)
                if (this._ownWrite) return;

                if (this._reloadTimer) {
                    GLib.source_remove(this._reloadTimer);
                    this._reloadTimer = null;
                }
                this._reloadTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    this._reloadTimer = null;
                    this._onDataFileChanged();
                    return GLib.SOURCE_REMOVE;
                });
            }
        );
    }

    _teardownFileMonitor() {
        if (this._reloadTimer) {
            GLib.source_remove(this._reloadTimer);
            this._reloadTimer = null;
        }
        if (this._fileMonitor) {
            if (this._fileMonitorId) {
                this._fileMonitor.disconnect(this._fileMonitorId);
                this._fileMonitorId = null;
            }
            this._fileMonitor.cancel();
            this._fileMonitor = null;
        }
    }

    _onDataFileChanged() {
        if (!this._storage || !this._taskManager) return;
        console.log('[PULSE] Data file changed \u2014 reloading.');
        // Only reload data + notify UI.
        // Do NOT call rolloverDay: it calls save() which re-triggers the monitor.
        this._storage.load();
        this._taskManager.emit('tasks-changed');
    }
}
