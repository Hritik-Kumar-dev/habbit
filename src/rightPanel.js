/**
 * rightPanel.js — HabbitPop right panel
 *
 * Contains:
 *   - GitHub-style heatmap (last 12 weeks)
 *   - "Less ░▒▓█ More" legend
 *   - Daily summary card: "7 / 9 tasks completed", "78% today"
 *   - Encouraging line
 *
 * Live updates: taskManager 'tasks-changed' signal triggers heatmap + summary refresh.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { Heatmap } from './heatmap.js';

// Encouraging messages keyed by completion level
const ENCOURAGEMENTS = [
    'Start small. Every check counts.',       // 0%
    "You're getting started. Keep it up!",    // 1–33%
    "Halfway there. You've got momentum!",    // 34–66%
    "Almost perfect. Finish strong!",         // 67–99%
    "Perfect day! 🎉 See you tomorrow.",      // 100%
];

function _encouragement(pct) {
    if (pct === 0)   return ENCOURAGEMENTS[0];
    if (pct <= 33)   return ENCOURAGEMENTS[1];
    if (pct <= 66)   return ENCOURAGEMENTS[2];
    if (pct <= 99)   return ENCOURAGEMENTS[3];
    return ENCOURAGEMENTS[4];
}

export const RightPanel = GObject.registerClass(
class RightPanel extends St.BoxLayout {
    _init(taskManager) {
        super._init({
            style_class: 'hp-right-panel',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        this._taskManager = taskManager;

        this._buildHeader();
        this._buildHeatmap();
        this._buildLegend();
        this._buildSummary();

        // Live update on task changes
        this._changedId = taskManager.connect('tasks-changed', () => this._refresh());
        this._rolledId = taskManager.connect('day-rolled-over', () => this._refresh());
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

    // ── Build ─────────────────────────────────────────────────────────────────

    _buildHeader() {
        const header = new St.Label({
            text: 'Activity',
            style_class: 'hp-panel-title hp-right-title',
        });
        this.add_child(header);
    }

    _buildHeatmap() {
        const data = this._taskManager.getHeatmapData(84);
        this._heatmap = new Heatmap(data);

        // Wrap in a scrollview in case the grid is wider than the panel.
        // The heatmap itself is a plain St.Widget (absolute positioning), but
        // St.ScrollView.child only accepts an StScrollable → needs a wrapper.
        const holder = new St.BoxLayout({
            style_class: 'hp-heatmap-holder',
        });
        holder.add_child(this._heatmap);

        const scroll = new St.ScrollView({
            style_class: 'hp-heatmap-scroll',
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
        });
        scroll.child = holder;
        this._heatmapScroll = scroll;
        this.add_child(scroll);
    }

    _buildLegend() {
        const legend = new St.BoxLayout({
            style_class: 'hp-legend',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });

        const lessLbl = new St.Label({ text: 'Less', style_class: 'hp-legend-label' });
        legend.add_child(lessLbl);

        for (let i = 0; i <= 4; i++) {
            const cell = new St.Widget({
                style_class: `hp-legend-cell hp-cell-l${i}`,
                width: 12,
                height: 12,
            });
            legend.add_child(cell);
        }

        const moreLbl = new St.Label({ text: 'More', style_class: 'hp-legend-label' });
        legend.add_child(moreLbl);

        this.add_child(legend);
    }

    _buildSummary() {
        this._summaryCard = new St.BoxLayout({
            style_class: 'hp-summary-card',
            vertical: true,
            x_expand: true,
        });

        this._completionLabel = new St.Label({
            style_class: 'hp-summary-completion',
        });
        this._pctLabel = new St.Label({
            style_class: 'hp-summary-pct',
        });
        this._encourageLabel = new St.Label({
            style_class: 'hp-summary-encourage',
        });
        this._encourageLabel.clutter_text.line_wrap = true;

        this._summaryCard.add_child(this._completionLabel);
        this._summaryCard.add_child(this._pctLabel);
        this._summaryCard.add_child(this._encourageLabel);

        this.add_child(this._summaryCard);

        this._updateSummary();
    }

    // ── Refresh ───────────────────────────────────────────────────────────────

    _refresh() {
        // Refresh heatmap data
        const data = this._taskManager.getHeatmapData(84);
        this._heatmap.update(data);

        // Refresh summary
        this._updateSummary();
    }

    _updateSummary() {
        const { total, completed, pct } = this._taskManager.getTodaySummary();

        if (total === 0) {
            this._completionLabel.set_text('No tasks today');
            this._pctLabel.set_text('');
            this._encourageLabel.set_text('Add your first task to get started.');
        } else {
            this._completionLabel.set_text(`${completed} / ${total} tasks completed`);
            this._pctLabel.set_text(`${pct}% today`);
            this._encourageLabel.set_text(_encouragement(pct));
        }
    }
});
