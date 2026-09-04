import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
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

function _notify(title, body) {
    try {
        Main.notify(title, body);
    } catch (e) {
        _warn('Main.notify failed', e);
    }
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

export const CastDisplayMenuToggle = GObject.registerClass(
class CastDisplayMenuToggle extends QuickSettings.QuickMenuToggle {
    _init(extension, displayConfig, presentationMode, castService) {
        super._init({
            title: _('Cast Display'),
            iconName: 'preferences-desktop-display-symbolic',
            toggleMode: false,
        });

        this._extension = extension;
        this._displayConfig = displayConfig;
        this._presentation = presentationMode;
        this._cast = castService;
        this._settings = extension.getSettings();
        this._groupMap = _loadGroupMap(this._settings);
        this._monitors = [];
        this._devices = [];
        this._castStatus = {state: 'idle', deviceId: '', deviceName: '', error: ''};
        this._presentationBeforeCast = null;
        this._castOwnedPresentation = false;
        this._syncingPresentation = false;
        this._destroyed = false;

        this._disconnectMonitors = null;
        this._disconnectPresentation = null;
        this._disconnectCastAvail = null;
        this._disconnectCastDevices = null;
        this._disconnectCastSession = null;

        this._actionBox = null;
        this._groupingBox = null;
        this._monitorGrid = null;
        this._presentationItem = null;
        this._castSectionBox = null;
        this._castListBox = null;
        this._castStatusLabel = null;

        this.menu.setHeader(
            'preferences-desktop-display-symbolic',
            _('Cast Display'),
            _('Layout, presentation, and cast')
        );

        this._buildActionGrid();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildGroupingSection();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildPresentationSwitch();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildCastSection();

        this.menu.addSettingsAction(
            _('Display settings'),
            'gnome-display-panel.desktop'
        );

        this._disconnectMonitors = this._displayConfig.connectMonitorsChanged(() => {
            this._refreshMonitors().catch(e =>
                _warn('Hotplug refresh failed', e));
        });

        this._disconnectPresentation = this._presentation.connectChanged(() => {
            this._syncPresentationSwitch();
            this._updateSubtitle();
        });

        this._disconnectCastAvail = this._cast.connectAvailability(() => {
            this._refreshCastUi().catch(e =>
                _warn('Cast availability refresh failed', e));
        });
        this._disconnectCastDevices = this._cast.connectDevicesChanged(() => {
            this._refreshDevices(false).catch(e =>
                _warn('Cast devices refresh failed', e));
        });
        this._disconnectCastSession = this._cast.connectSessionChanged(status => {
            this._onCastSession(status);
        });

        // Windows Cast–like: scan when the menu opens
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen || this._destroyed)
                return;
            this._onCastMenuOpened().catch(e =>
                _warn('Cast menu open scan failed', e));
        });

        this._refreshMonitors().catch(e =>
            _warn('Initial monitor refresh failed', e));
        this._syncPresentationSwitch();
        this._refreshCastUi().catch(e =>
            _warn('Initial cast refresh failed', e));
    }

    async _onCastMenuOpened() {
        this._updateCastStatusLabel(_('Searching for displays…'));
        await this._cast.ensureStarted();
        if (!this._cast.available) {
            this._updateCastStatusLabel(
                _('Cast helper not running. Run ./install.sh, then reopen.')
            );
            this._rebuildCastList();
            return;
        }
        await this._refreshDevices(true);
        this._applyCastStatusToUi();
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

        const heading = new St.Label({
            text: _('Layout'),
            style_class: 'dac-section-label',
        });
        this._actionBox.add_child(heading);

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

    _buildPresentationSwitch() {
        this._presentationItem = new PopupMenu.PopupSwitchMenuItem(
            _('Presentation mode'),
            this._presentation.enabled
        );
        this._presentationItem.connect('toggled', item => {
            if (this._syncingPresentation || !this._presentation)
                return;
            const state = item.state;
            // Manual toggle takes ownership away from cast auto-presentation.
            this._castOwnedPresentation = false;
            this._presentationBeforeCast = null;
            this._presentation.setEnabled(state).then(ok => {
                if (!ok) {
                    this._syncPresentationSwitch();
                    _notify(_('Cast Display'), _('Could not change presentation mode'));
                }
            }).catch(e => {
                _warn('Presentation switch failed', e);
                this._syncPresentationSwitch();
            });
        });
        this.menu.addMenuItem(this._presentationItem);
    }

    _syncPresentationSwitch() {
        if (!this._presentationItem || !this._presentation)
            return;
        this._syncingPresentation = true;
        this._presentationItem.setToggleState(this._presentation.enabled);
        this._syncingPresentation = false;
    }

    _buildCastSection() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        this._castSectionBox = new St.BoxLayout({
            vertical: true,
            style_class: 'dac-cast-section',
            x_expand: true,
        });

        const headerRow = new St.BoxLayout({
            style_class: 'dac-cast-header',
            x_expand: true,
        });
        const heading = new St.Label({
            text: _('Cast to…'),
            style_class: 'dac-section-label',
            x_expand: true,
        });
        headerRow.add_child(heading);

        const refreshBtn = new St.Button({
            style_class: 'button dac-cast-refresh',
            label: _('Refresh'),
            can_focus: true,
        });
        refreshBtn.connect('clicked', () => {
            this._refreshDevices(true).catch(e =>
                _warn('Cast refresh failed', e));
        });
        headerRow.add_child(refreshBtn);
        this._castSectionBox.add_child(headerRow);

        this._castStatusLabel = new St.Label({
            text: '',
            style_class: 'dim-label dac-cast-status',
        });
        this._castStatusLabel.clutter_text.line_wrap = true;
        this._castSectionBox.add_child(this._castStatusLabel);

        this._castListBox = new St.BoxLayout({
            vertical: true,
            style_class: 'dac-cast-list',
            x_expand: true,
        });
        this._castSectionBox.add_child(this._castListBox);

        item.add_child(this._castSectionBox);
        this.menu.addMenuItem(item);
    }

    async _refreshCastUi() {
        if (this._destroyed)
            return;

        if (!this._cast.available) {
            await this._cast.ensureStarted();
        }

        if (!this._cast.available) {
            this._devices = [];
            this._castStatus = {state: 'idle', deviceId: '', deviceName: '', error: ''};
            this._rebuildCastList();
            this._updateCastStatusLabel(
                _('Cast helper not running. Run ./install.sh, then reopen.')
            );
            this._updateSubtitle();
            this.checked = false;
            return;
        }

        try {
            this._castStatus = await this._cast.getStatus();
        } catch (e) {
            _warn('getStatus failed', e);
        }
        await this._refreshDevices(false);
        this._applyCastStatusToUi();
    }

    async _refreshDevices(forceRefresh = false) {
        if (this._destroyed || !this._cast.available)
            return;

        try {
            if (forceRefresh)
                await this._cast.refresh();
            this._devices = await this._cast.listDevices();
        } catch (e) {
            _warn('listDevices failed', e);
            this._devices = [];
            _notify(_('Cast Display'), _('Could not list cast devices'));
        }
        this._rebuildCastList();
        this._updateSubtitle();
    }

    _rebuildCastList() {
        if (!this._castListBox)
            return;

        this._castListBox.destroy_all_children();

        if (!this._cast.available)
            return;

        const casting = this._castStatus.state === 'casting' ||
            this._castStatus.state === 'connecting';
        const activeId = this._castStatus.deviceId;

        if (casting && activeId) {
            this._castListBox.add_child(this._createActiveCastRow());
            return;
        }

        let lastId = '';
        try {
            lastId = this._settings.get_string('last-cast-device') || '';
        } catch (_) { /* ignore */ }

        if (lastId) {
            const last = this._devices.find(d => d.id === lastId);
            if (last) {
                this._castListBox.add_child(
                    this._createDeviceRow(last, {reconnect: true})
                );
            }
        }

        if (!this._devices.length) {
            const empty = new St.Label({
                text: _('No displays found. Check Wi‑Fi / Cast / Miracast.'),
                style_class: 'dim-label',
            });
            this._castListBox.add_child(empty);
            return;
        }

        for (const device of this._devices) {
            if (lastId && device.id === lastId)
                continue;
            this._castListBox.add_child(this._createDeviceRow(device));
        }
    }

    _protocolLabel(protocol) {
        if (protocol === 'miracast')
            return _('Wireless display');
        return _('Cast');
    }

    _createDeviceRow(device, {reconnect = false} = {}) {
        const row = new St.BoxLayout({
            style_class: 'dac-cast-device-row',
            x_expand: true,
        });

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });
        const name = new St.Label({
            text: reconnect
                ? _('Reconnect · %s').format(device.name || device.id)
                : (device.name || device.id),
            style_class: 'dac-cast-device-name',
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(name);

        const metaParts = [];
        metaParts.push(this._protocolLabel(device.protocol));
        if (device.model)
            metaParts.push(device.model);
        const meta = new St.Label({
            text: metaParts.join(' · '),
            style_class: 'dim-label',
        });
        textBox.add_child(meta);
        row.add_child(textBox);

        const connectBtn = new St.Button({
            style_class: 'button dac-cast-action',
            label: reconnect ? _('Reconnect') : _('Connect'),
            can_focus: true,
        });
        connectBtn.connect('clicked', () => {
            this._startCast(device).catch(e =>
                _warn('startCast failed', e));
        });
        row.add_child(connectBtn);
        return row;
    }

    _createActiveCastRow() {
        const row = new St.BoxLayout({
            style_class: 'dac-cast-device-row',
            x_expand: true,
        });
        const label = new St.Label({
            text: _('Connected to %s').format(
                this._castStatus.deviceName || this._castStatus.deviceId
            ),
            style_class: 'dac-cast-device-name',
            x_expand: true,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(label);

        const stopBtn = new St.Button({
            style_class: 'button dac-cast-action',
            label: _('Disconnect'),
            can_focus: true,
        });
        stopBtn.connect('clicked', () => {
            this._stopCast().catch(e => _warn('stopCast failed', e));
        });
        row.add_child(stopBtn);
        return row;
    }

    _updateCastStatusLabel(text) {
        if (this._castStatusLabel)
            this._castStatusLabel.text = text || '';
    }

    _applyCastStatusToUi() {
        const s = this._castStatus;
        this.checked = s.state === 'casting' || s.state === 'connecting';

        if (s.state === 'error' && s.error) {
            this._updateCastStatusLabel(s.error);
        } else if (s.state === 'connecting') {
            this._updateCastStatusLabel(
                _('Connecting to %s…').format(s.deviceName || s.deviceId)
            );
        } else if (s.state === 'casting') {
            this._updateCastStatusLabel('');
        } else if (this._cast.available) {
            this._updateCastStatusLabel('');
        }

        this._rebuildCastList();
        this._updateSubtitle();
    }

    _onCastSession(status) {
        if (this._destroyed)
            return;
        const prev = this._castStatus.state;
        this._castStatus = status || this._castStatus;
        this._applyCastStatusToUi();

        if (status?.state === 'error' && status.error) {
            _notify(_('Cast Display'), status.error);
            this._restorePresentationAfterCast().catch(e =>
                _warn('restore presentation failed', e));
        } else if (status?.state === 'idle' &&
                   (prev === 'casting' || prev === 'connecting')) {
            this._restorePresentationAfterCast().catch(e =>
                _warn('restore presentation failed', e));
        }
    }

    async _startCast(device) {
        if (!this._cast.available) {
            _notify(_('Cast Display'), _('Cast helper is not running'));
            return;
        }

        const source = this._settings.get_string('cast-source') || 'primary';
        try {
            this._settings.set_string('last-cast-device', device.id);
        } catch (_) { /* ignore */ }

        await this._maybeEnablePresentationForCast();

        this._castStatus = {
            state: 'connecting',
            deviceId: device.id,
            deviceName: device.name,
            error: '',
        };
        this._applyCastStatusToUi();

        try {
            await this._cast.castDesktop(device.id, source);
            try {
                this._castStatus = await this._cast.getStatus();
            } catch (_) { /* SessionChanged will update */ }
            this._applyCastStatusToUi();
        } catch (e) {
            _warn('CastDesktop failed', e);
            const msg = e?.message || String(e);
            _notify(_('Cast Display'), msg);
            this._castStatus = {
                state: 'error',
                deviceId: device.id,
                deviceName: device.name,
                error: msg,
            };
            this._applyCastStatusToUi();
            await this._restorePresentationAfterCast();
        }
    }

    async _stopCast() {
        try {
            await this._cast.stop();
            this._castStatus = {state: 'idle', deviceId: '', deviceName: '', error: ''};
            this._applyCastStatusToUi();
            await this._restorePresentationAfterCast();
        } catch (e) {
            _warn('Stop cast failed', e);
            _notify(_('Cast Display'), _('Could not stop casting'));
        }
    }

    async _maybeEnablePresentationForCast() {
        let auto = true;
        try {
            auto = this._settings.get_boolean('cast-auto-presentation');
        } catch (_) { /* ignore */ }

        if (!auto || !this._presentation)
            return;

        this._presentationBeforeCast = this._presentation.enabled;
        if (!this._presentation.enabled) {
            const ok = await this._presentation.enable();
            this._castOwnedPresentation = !!ok;
            this._syncPresentationSwitch();
        } else {
            this._castOwnedPresentation = false;
        }
    }

    async _restorePresentationAfterCast() {
        if (!this._castOwnedPresentation || !this._presentation)
            return;

        this._castOwnedPresentation = false;
        const wasOff = this._presentationBeforeCast === false;
        this._presentationBeforeCast = null;
        if (wasOff && this._presentation.enabled) {
            await this._presentation.disable();
            this._syncPresentationSwitch();
        }
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
        const s = this._castStatus;
        if (s.state === 'casting') {
            this.subtitle = _('Connected to %s').format(s.deviceName || s.deviceId);
            return;
        }
        if (s.state === 'connecting') {
            this.subtitle = _('Connecting…');
            return;
        }
        if (s.state === 'error' && s.error) {
            this.subtitle = _('Cast error');
            return;
        }
        if (this._presentation?.enabled) {
            this.subtitle = _('Presentation');
            return;
        }

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
            if (!ok) {
                _warn(`Layout action ${kind} did not apply`);
                _notify(_('Cast Display'), _('Layout could not be applied'));
            }
            await this._refreshMonitors();
        } catch (e) {
            _warn(`Layout action ${kind} failed`, e);
            _notify(_('Cast Display'), _('Layout could not be applied'));
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
            if (!ok) {
                _warn('Custom grouping apply returned false');
                _notify(_('Cast Display'), _('Grouping could not be applied'));
            }
            await this._refreshMonitors();
        } catch (e) {
            _warn('Custom grouping apply failed', e);
            _notify(_('Cast Display'), _('Grouping could not be applied'));
        }
    }

    destroy() {
        this._destroyed = true;

        const disconnect = fn => {
            if (!fn)
                return;
            try {
                fn();
            } catch (_) { /* ignore */ }
        };

        disconnect(this._disconnectMonitors);
        disconnect(this._disconnectPresentation);
        disconnect(this._disconnectCastAvail);
        disconnect(this._disconnectCastDevices);
        disconnect(this._disconnectCastSession);

        this._disconnectMonitors = null;
        this._disconnectPresentation = null;
        this._disconnectCastAvail = null;
        this._disconnectCastDevices = null;
        this._disconnectCastSession = null;

        this._displayConfig = null;
        this._presentation = null;
        this._cast = null;
        this._settings = null;
        this._extension = null;
        super.destroy();
    }
});
