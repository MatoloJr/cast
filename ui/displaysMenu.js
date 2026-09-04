import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {DisplayConfig} from '../lib/displayConfig.js';

const GROUP_STYLE_CLASSES = [
    'dac-group-a',
    'dac-group-b',
    'dac-group-c',
    'dac-group-d',
    'dac-group-e',
    'dac-group-f',
];

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

function _loadGroupMap(settings) {
    try {
        const raw = settings.get_string('monitor-groups');
        const parsed = JSON.parse(raw || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        _warn('Failed to parse monitor-groups', e);
        return {};
    }
}

function _saveGroupMap(settings, map) {
    try {
        settings.set_string('monitor-groups', JSON.stringify(map));
    } catch (e) {
        _warn('Failed to save monitor-groups', e);
    }
}

function _letterIndex(letter) {
    if (!letter || typeof letter !== 'string')
        return 0;
    const code = letter.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
    return Math.max(0, code);
}

export const DisplaysMenuToggle = GObject.registerClass(
class DisplaysMenuToggle extends QuickSettings.QuickMenuToggle {
    _init(extension, displayConfig) {
        super._init({
            title: _('Displays'),
            iconName: 'preferences-desktop-display-symbolic',
            toggleMode: false,
        });

        this._extension = extension;
        this._displayConfig = displayConfig;
        this._settings = extension.getSettings();
        this._groupMap = _loadGroupMap(this._settings);
        this._monitors = [];
        this._disconnectMonitors = null;
        this._actionBox = null;
        this._groupingBox = null;
        this._monitorGrid = null;
        this._destroyed = false;

        this.menu.setHeader(
            'preferences-desktop-display-symbolic',
            _('Displays'),
            _('Layout and grouping')
        );

        this._buildActionGrid();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildGroupingSection();

        this.menu.addSettingsAction(
            _('Display settings'),
            'gnome-display-panel.desktop'
        );

        this._disconnectMonitors = this._displayConfig.connectMonitorsChanged(() => {
            this._refreshMonitors().catch(e =>
                _warn('Hotplug refresh failed', e));
        });

        this._refreshMonitors().catch(e =>
            _warn('Initial monitor refresh failed', e));
    }

    _buildActionGrid() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        this._actionBox = new St.BoxLayout({
            vertical: true,
            style_class: 'dac-action-grid',
            x_expand: true,
        });

        const actions = [
            [
                {label: _('Extend'), action: () => this._runLayout('extend')},
                {label: _('Mirror all'), action: () => this._runLayout('mirror')},
            ],
            [
                {label: _('Main only'), action: () => this._runLayout('main')},
                {label: _('Secondary only'), action: () => this._runLayout('secondary')},
            ],
        ];

        for (const row of actions) {
            const rowBox = new St.BoxLayout({
                style_class: 'dac-action-row',
                x_expand: true,
            });
            for (const {label, action} of row) {
                const button = new St.Button({
                    style_class: 'button dac-action-button',
                    label,
                    x_expand: true,
                    can_focus: true,
                });
                button.connect('clicked', () => {
                    action().catch(e => _warn(`Action ${label} failed`, e));
                });
                rowBox.add_child(button);
            }
            this._actionBox.add_child(rowBox);
        }

        item.add_child(this._actionBox);
        this.menu.addMenuItem(item);
    }

    _buildGroupingSection() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        this._groupingBox = new St.BoxLayout({
            vertical: true,
            style_class: 'dac-grouping-section',
            x_expand: true,
            visible: false,
        });

        const heading = new St.Label({
            text: _('Custom grouping'),
            style_class: 'dac-grouping-label',
        });
        this._groupingBox.add_child(heading);

        const hint = new St.Label({
            text: _('Tap a display to change its group'),
            style_class: 'dim-label',
        });
        this._groupingBox.add_child(hint);

        this._monitorGrid = new St.BoxLayout({
            style_class: 'dac-monitor-grid',
            x_expand: true,
        });
        this._groupingBox.add_child(this._monitorGrid);

        const applyButton = new St.Button({
            style_class: 'button dac-apply-button',
            label: _('Apply'),
            x_expand: true,
            can_focus: true,
        });
        applyButton.connect('clicked', () => {
            this._applyGroups().catch(e => _warn('Apply groups failed', e));
        });
        this._groupingBox.add_child(applyButton);

        item.add_child(this._groupingBox);
        this.menu.addMenuItem(item);
    }

    async _refreshMonitors() {
        if (this._destroyed)
            return;

        try {
            const state = await this._displayConfig.getCurrentState();
            if (this._destroyed)
                return;

            this._monitors = state.monitors || [];
            this._reconcileGroupMap();
            this._rebuildMonitorTiles();
            this._updateSubtitle();
        } catch (e) {
            _warn('getCurrentState in refresh failed', e);
        }
    }

    _reconcileGroupMap() {
        const saved = _loadGroupMap(this._settings);
        const next = {};
        const monitors = this._monitors;

        monitors.forEach((monitor, index) => {
            if (saved[monitor.connector])
                next[monitor.connector] = saved[monitor.connector];
            else if (this._groupMap[monitor.connector])
                next[monitor.connector] = this._groupMap[monitor.connector];
            else
                next[monitor.connector] = DisplayConfig.groupLetter(index);
        });

        this._groupMap = {...saved, ...next};
        for (const monitor of monitors)
            this._groupMap[monitor.connector] = next[monitor.connector];
    }

    _rebuildMonitorTiles() {
        if (!this._monitorGrid || !this._groupingBox)
            return;

        this._monitorGrid.destroy_all_children();

        const showGrouping = this._monitors.length >= 3;
        this._groupingBox.visible = showGrouping;

        if (!showGrouping)
            return;

        const maxGroups = this._monitors.length;

        for (const monitor of this._monitors) {
            const letter = this._groupMap[monitor.connector] || 'A';
            const tile = this._createMonitorTile(monitor, letter, maxGroups);
            this._monitorGrid.add_child(tile);
        }
    }

    _createMonitorTile(monitor, letter, maxGroups) {
        const box = new St.BoxLayout({
            vertical: true,
            style_class: `dac-monitor-tile ${this._groupStyleClass(letter)}`,
            x_expand: true,
        });

        const name = new St.Label({
            text: monitor.displayName || monitor.connector,
            style_class: 'dac-monitor-name',
            x_align: Clutter.ActorAlign.CENTER,
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(name);

        const connector = new St.Label({
            text: monitor.connector,
            style_class: 'dim-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(connector);

        const badge = new St.Label({
            text: _('Group %s').format(letter),
            style_class: 'dac-group-badge',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(badge);

        const button = new St.Button({
            child: box,
            x_expand: true,
            can_focus: true,
            track_hover: true,
        });

        button.connect('clicked', () => {
            this._cycleGroup(monitor.connector, maxGroups);
            this._rebuildMonitorTiles();
        });

        return button;
    }

    _groupStyleClass(letter) {
        const index = _letterIndex(letter) % GROUP_STYLE_CLASSES.length;
        return GROUP_STYLE_CLASSES[index];
    }

    _cycleGroup(connector, maxGroups) {
        const current = this._groupMap[connector] || 'A';
        const nextIndex = (_letterIndex(current) + 1) % maxGroups;
        this._groupMap[connector] = DisplayConfig.groupLetter(nextIndex);
    }

    _updateSubtitle() {
        const count = this._monitors.length;
        if (count === 0)
            this.subtitle = _('No displays');
        else if (count === 1)
            this.subtitle = _('1 display');
        else
            this.subtitle = _('%d displays').format(count);
    }

    async _runLayout(kind) {
        try {
            let ok = false;
            switch (kind) {
            case 'extend':
                ok = await this._displayConfig.applyExtend();
                break;
            case 'mirror':
                ok = await this._displayConfig.applyMirrorAll();
                break;
            case 'main':
                ok = await this._displayConfig.applyMainOnly();
                break;
            case 'secondary':
                ok = await this._displayConfig.applySecondaryOnly();
                break;
            }
            if (!ok)
                _warn(`Layout action ${kind} did not apply`);
            await this._refreshMonitors();
        } catch (e) {
            _warn(`Layout action ${kind} failed`, e);
        }
    }

    async _applyGroups() {
        try {
            const connected = {};
            for (const monitor of this._monitors)
                connected[monitor.connector] = this._groupMap[monitor.connector] || 'A';

            const toSave = {..._loadGroupMap(this._settings), ...connected};
            _saveGroupMap(this._settings, toSave);
            this._groupMap = toSave;

            const ok = await this._displayConfig.applyCustomGroups(connected);
            if (!ok)
                _warn('Custom grouping apply returned false');
            await this._refreshMonitors();
        } catch (e) {
            _warn('Custom grouping apply failed', e);
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._disconnectMonitors) {
            try {
                this._disconnectMonitors();
            } catch (_) { /* ignore */ }
            this._disconnectMonitors = null;
        }
        this._displayConfig = null;
        this._settings = null;
        this._extension = null;
        super.destroy();
    }
});
