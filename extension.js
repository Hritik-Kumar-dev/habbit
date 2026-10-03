/**
 * extension.js — HabbitPop GNOME Shell Extension
 *
 * GNOME 50 / ESM format.
 *
 * Strategy:
 *   On enable():
 *     1. Access Main.panel.statusArea.dateMenu (DateMenuButton)
 *     2. Find the #calendarArea hbox (first child of the bin inside menu.box)
 *     3. Hide all existing children of calendarArea
 *     4. Inject our own St.BoxLayout with golden-ratio split (left 61.8% | right 38.2%)
 *
 *   On disable():
 *     1. Destroy our widget
 *     2. Show all original children again
 *     3. Disconnect all signals, clear timers
 *
 * No methods are monkey-patched. Only DOM manipulation → clean and review-compliant.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Storage } from './src/storage.js';
import { TaskManager } from './src/taskManager.js';
import { LeftPanel } from './src/leftPanel.js';
import { RightPanel } from './src/rightPanel.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// Reference popover dimensions (px) — clamped to screen later
const REF_WIDTH  = 1300;
const REF_HEIGHT = 700;

// Golden ratio: φ = 1.618; left = φ/(1+φ), right = 1/(1+φ)
const PHI = 1.618033988749895;
const LEFT_FRAC  = PHI / (1 + PHI);   // ≈ 0.618
const RIGHT_FRAC = 1 / (1 + PHI);      // ≈ 0.382
const PANEL_GAP  = 16; // px gap between left and right

// ── HabbitPopLayout ───────────────────────────────────────────────────────────

/**
 * Main container widget injected into the dateMenu popover.
 * Holds left panel + right panel side by side with golden-ratio widths.
 */
const HabbitPopLayout = GObject.registerClass(
class HabbitPopLayout extends St.BoxLayout {
    _init(taskManager, popoverWidth, popoverHeight) {
        super._init({
            style_class: 'hp-container',
            x_expand: true,
            y_expand: true,
        });

        // Compute panel widths from available space
        const availW = popoverWidth - PANEL_GAP;
        const leftW  = Math.floor(availW * LEFT_FRAC);
        const rightW = Math.floor(availW * RIGHT_FRAC);

        // Left panel
        const leftWrap = new St.Widget({
            style_class: 'hp-panel-wrap',
            width: leftW,
            height: popoverHeight,
            clip_to_allocation: true,
        });
        this._leftPanel = new LeftPanel(taskManager);
        this._leftPanel.set_size(leftW, popoverHeight);
        leftWrap.add_child(this._leftPanel);
        this.add_child(leftWrap);

        // Gap
        const gap = new St.Widget({ width: PANEL_GAP });
        this.add_child(gap);

        // Right panel
        const rightWrap = new St.Widget({
            style_class: 'hp-panel-wrap',
            width: rightW,
            height: popoverHeight,
            clip_to_allocation: true,
        });
        this._rightPanel = new RightPanel(taskManager);
        this._rightPanel.set_size(rightW, popoverHeight);
        rightWrap.add_child(this._rightPanel);
        this.add_child(rightWrap);
    }

    destroy() {
        if (this._leftPanel) {
            this._leftPanel.destroy();
            this._leftPanel = null;
        }
        if (this._rightPanel) {
            this._rightPanel.destroy();
            this._rightPanel = null;
        }
        super.destroy();
    }
});

// ── Extension ──────────────────────────────────────────────────────────────────

export default class HabbitPopExtension extends Extension {
    enable() {
        // ── 1. Init storage + task manager ──────────────────────────────────
        this._storage = new Storage();
        this._storage.load();

        // Seed fake data if HABBITPOP_SEED env var is set
        if (GLib.getenv('HABBITPOP_SEED') === '1') {
            this._storage.seedFakeHistory();
        }

        this._taskManager = new TaskManager(this._storage);
        this._taskManager.start();

        // ── 2. Locate the dateMenu popover internals ─────────────────────────
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu) {
            console.error('[HabbitPop] dateMenu not found — extension not loaded');
            return;
        }
        this._dateMenu = dateMenu;

        // The menu box has one child: a Bin widget
        // The bin has one child: hbox#calendarArea
        // We find calendarArea by name or fallback to index
        this._calendarArea = this._findCalendarArea(dateMenu);
        if (!this._calendarArea) {
            console.error('[HabbitPop] calendarArea not found — extension not loaded');
            return;
        }

        // ── 3. Hide original children ────────────────────────────────────────
        this._hiddenChildren = [];
        const children = this._calendarArea.get_children();
        for (const child of children) {
            child.hide();
            this._hiddenChildren.push(child);
        }

        // ── 4. Compute popover size ──────────────────────────────────────────
        const [screenW, screenH] = this._getScreenSize();
        const maxW = Math.floor(screenW * 0.92);
        const maxH = Math.floor(screenH * 0.85);
        const popoverW = Math.min(REF_WIDTH, maxW);
        const popoverH = Math.min(REF_HEIGHT, maxH);

        // ── 5. Inject our layout ─────────────────────────────────────────────
        this._habbitLayout = new HabbitPopLayout(this._taskManager, popoverW, popoverH);
        this._calendarArea.add_child(this._habbitLayout);

        // Force the popover to our desired size
        this._calendarArea.set_size(popoverW, popoverH);

        // Also apply to the menu box so it doesn't shrink
        const menuBox = dateMenu.menu.box;
        menuBox.set_style(`min-width: ${popoverW}px; min-height: ${popoverH}px;`);
        this._prevMenuStyle = null; // we'll restore by clearing

        console.log('[HabbitPop] Enabled. Popover size:', popoverW, 'x', popoverH);
    }

    disable() {
        // ── 1. Destroy our widget ─────────────────────────────────────────────
        if (this._habbitLayout) {
            this._habbitLayout.destroy();
            this._habbitLayout = null;
        }

        // ── 2. Restore original children ─────────────────────────────────────
        if (this._hiddenChildren) {
            for (const child of this._hiddenChildren) {
                child.show();
            }
            this._hiddenChildren = null;
        }

        // ── 3. Restore calendar area size ─────────────────────────────────────
        if (this._calendarArea) {
            this._calendarArea.set_size(-1, -1); // natural size
            this._calendarArea = null;
        }

        // ── 4. Restore menu box style ─────────────────────────────────────────
        if (this._dateMenu) {
            this._dateMenu.menu.box.set_style('');
            this._dateMenu = null;
        }

        // ── 5. Stop task manager ──────────────────────────────────────────────
        if (this._taskManager) {
            this._taskManager.stop();
            this._taskManager = null;
        }

        this._storage = null;

        console.log('[HabbitPop] Disabled and cleaned up.');
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Locate the #calendarArea hbox inside the dateMenu popover.
     * The structure is: menu.box → bin → hbox[name="calendarArea"]
     *
     * We look for a child named "calendarArea" anywhere in the first two levels.
     */
    _findCalendarArea(dateMenu) {
        const menuBox = dateMenu.menu.box;
        // Level 1: direct children of menu.box
        for (const child of menuBox.get_children()) {
            if (child.name === 'calendarArea') return child;
            // Level 2: children of the bin
            for (const grandchild of child.get_children()) {
                if (grandchild.name === 'calendarArea') return grandchild;
                // Level 3: just in case
                for (const ggc of grandchild.get_children()) {
                    if (ggc.name === 'calendarArea') return ggc;
                }
            }
        }
        return null;
    }

    /**
     * Get the primary monitor's work area dimensions.
     * @returns {[number, number]} [width, height]
     */
    _getScreenSize() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) return [monitor.width, monitor.height];
        // Fallback
        return [1920, 1080];
    }
}
