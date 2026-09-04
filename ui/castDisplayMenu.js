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

function _layoutActions() {
    return [
        [
            {label: _('Mirror'), kind: 'mirror'},
            {label: _('Extend'), kind: 'extend'},
        ],
        [
            {label: _('Main only'), kind: 'main'},
            {label: _('Secondary only'), kind: 'secondary'},
        ],
    ];
}

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

function _loadJsonMap(settings, key) {
    try {
        const raw = settings.get_string(key);
        const parsed = JSON.parse(raw || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        _warn(`Failed to parse ${key}`, e);
        return {};
    }
}

function _saveJsonMap(settings, key, map) {
    try {
        settings.set_string(key, JSON.stringify(map));
    } catch (e) {
        _warn(`Failed to save ${key}`, e);
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
            toggleMode: true,
        });

        this._extension = extension;
        this._displayConfig = displayConfig;
        this._presentation = presentationMode;
        this._cast = castService;
        this._settings = extension.getSettings();
        this._groupMap = _loadJsonMap(this._settings, 'monitor-groups');
        this._deviceGroupMap = _loadJsonMap(this._settings, 'cast-device-groups');
        this._monitors = [];
        this._devices = [];
        this._sessions = [];
        this._selectedIds = new Set();
        this._castStatus = {state: 'idle', deviceId: '', deviceName: '', error: ''};
        this._presentationBeforeCast = null;
        this._castOwnedPresentation = false;
        this._destroyed = false;
        this._syncingChecked = false;
        this._manageExpanded = false;

        this._disconnectMonitors = null;
        this._disconnectPresentation = null;
        this._disconnectCastAvail = null;
        this._disconnectCastDevices = null;
        this._disconnectCastSession = null;
        this._disconnectSettings = null;

        this._rootBox = null;
        this._statusLabel = null;
        this._bodyBox = null;

        this.menu.setHeader(
            'preferences-desktop-display-symbolic',
            _('Cast Display'),
            _('Find and connect displays')
        );

        this._buildRoot();
        this.menu.addSettingsAction(
            _('Display settings'),
            'gnome-display-panel.desktop'
        );

        let enabled = false;
        try {
            enabled = this._settings.get_boolean('cast-display-enabled');
        } catch (_) { /* ignore */ }
        this._syncingChecked = true;
        this.checked = enabled;
        this._syncingChecked = false;

        this.connect('notify::checked', () => {
            if (this._syncingChecked || this._destroyed)
                return;
            this._onActivationToggled(this.checked).catch(e =>
                _warn('Activation toggle failed', e));
        });

        this._disconnectMonitors = this._displayConfig.connectMonitorsChanged(() => {
            this._refreshMonitors().catch(e =>
                _warn('Hotplug refresh failed', e));
        });

        this._disconnectPresentation = this._presentation.connectChanged(() => {
            this._updateSubtitle();
        });

        this._disconnectCastAvail = this._cast.connectAvailability(() => {
            if (!this._isActivated())
                return;
            this._refreshCastUi().catch(e =>
                _warn('Cast availability refresh failed', e));
        });
        this._disconnectCastDevices = this._cast.connectDevicesChanged(() => {
            if (!this._isActivated())
                return;
            this._refreshDevices(false).catch(e =>
                _warn('Cast devices refresh failed', e));
        });
        this._disconnectCastSession = this._cast.connectSessionChanged(status => {
            this._onCastSession(status);
        });

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen || this._destroyed || !this._isActivated())
                return;
            this._onCastMenuOpened().catch(e =>
                _warn('Cast menu open scan failed', e));
        });

        this._refreshMonitors().catch(e =>
            _warn('Initial monitor refresh failed', e));
        this._rebuildBody();
        this._updateSubtitle();

        if (enabled) {
            this._refreshCastUi().catch(e =>
                _warn('Initial cast refresh failed', e));
        }
    }

    _isActivated() {
        try {
            return this._settings.get_boolean('cast-display-enabled');
        } catch (_) {
            return this.checked;
        }
    }

    async _onActivationToggled(enabled) {
        try {
            this._settings.set_boolean('cast-display-enabled', enabled);
        } catch (e) {
            _warn('Failed to persist cast-display-enabled', e);
        }

        if (!enabled) {
            this._selectedIds.clear();
            this._manageExpanded = false;
            if (this._sessions.length ||
                this._castStatus.state === 'casting' ||
                this._castStatus.state === 'connecting') {
                try {
                    await this._cast.stop();
                } catch (e) {
                    _warn('Stop on deactivate failed', e);
                }
                this._sessions = [];
                this._castStatus = {state: 'idle', deviceId: '', deviceName: '', error: ''};
                await this._restorePresentationAfterCast();
            }
            this._rebuildBody();
            this._updateCheckedFromState();
            this._updateSubtitle();
            return;
        }

        await this._cast.ensureStarted();
        this._rebuildBody();
        await this._refreshCastUi();
        this._updateCheckedFromState();
        this._updateSubtitle();
    }

    _updateCheckedFromState() {
        const casting = this._castStatus.state === 'casting' ||
            this._castStatus.state === 'connecting';
        const on = this._isActivated() || casting;
        this._syncingChecked = true;
        this.checked = on;
        this._syncingChecked = false;
    }

    _buildRoot() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        this._rootBox = new St.BoxLayout({
            vertical: true,
            style_class: 'dac-root',
            x_expand: true,
        });

        this._statusLabel = new St.Label({
            text: '',
            style_class: 'dim-label dac-cast-status',
        });
        this._statusLabel.clutter_text.line_wrap = true;
        this._rootBox.add_child(this._statusLabel);

        this._bodyBox = new St.BoxLayout({
            vertical: true,
            style_class: 'dac-body',
            x_expand: true,
        });
        this._rootBox.add_child(this._bodyBox);

        item.add_child(this._rootBox);
        this.menu.addMenuItem(item);
    }

    _setStatusText(text) {
        if (this._statusLabel)
            this._statusLabel.text = text || '';
    }

    async _onCastMenuOpened() {
        this._setStatusText(_('Searching for displays…'));
        await this._cast.ensureStarted();
        if (!this._cast.available) {
            this._setStatusText(
                _('Cast helper not running. Run ./install.sh, then reopen.')
            );
            this._rebuildBody();
            return;
        }
        await this._refreshDevices(true);
        await this._refreshSessions();
        this._applyCastStatusToUi();
    }

    async _refreshCastUi() {
        if (this._destroyed || !this._isActivated())
            return;

        if (!this._cast.available)
            await this._cast.ensureStarted();

        if (!this._cast.available) {
            this._devices = [];
            this._sessions = [];
            this._castStatus = {state: 'idle', deviceId: '', deviceName: '', error: ''};
            this._setStatusText(
                _('Cast helper not running. Run ./install.sh, then reopen.')
            );
            this._rebuildBody();
            this._updateCheckedFromState();
            this._updateSubtitle();
            return;
        }

        try {
            this._castStatus = await this._cast.getStatus();
        } catch (e) {
            _warn('getStatus failed', e);
        }
        await this._refreshSessions();
        await this._refreshDevices(false);
        this._applyCastStatusToUi();
    }

    async _refreshSessions() {
        if (!this._cast.available) {
            this._sessions = [];
            return;
        }
        try {
            this._sessions = await this._cast.listSessions();
        } catch (e) {
            _warn('listSessions failed', e);
            // Fall back to status-derived session for older helpers.
            if (this._castStatus.state === 'casting' ||
                this._castStatus.state === 'connecting') {
                const ids = (this._castStatus.deviceId || '')
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean);
                if (ids.length) {
                    this._sessions = ids.map((id, i) => ({
                        id,
                        name: i === 0
                            ? (this._castStatus.deviceName || id)
                            : id,
                        state: this._castStatus.state,
                    }));
                } else {
                    this._sessions = [];
                }
            } else {
                this._sessions = [];
            }
        }
    }

    async _refreshDevices(forceRefresh = false) {
        if (this._destroyed || !this._cast.available || !this._isActivated())
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
        this._pruneSelection();
        this._rebuildBody();
        this._updateSubtitle();
    }

    _pruneSelection() {
        const known = new Set(this._devices.map(d => d.id));
        for (const id of [...this._selectedIds]) {
            if (!known.has(id))
                this._selectedIds.delete(id);
        }
    }

    _rebuildBody() {
        if (!this._bodyBox)
            return;

        this._bodyBox.destroy_all_children();

        if (!this._isActivated()) {
            const empty = new St.Label({
                text: _('Cast Display is off. Turn it on to find wireless displays.'),
                style_class: 'dim-label dac-empty-hint',
            });
            empty.clutter_text.line_wrap = true;
            this._bodyBox.add_child(empty);
            return;
        }

        const sessionCount = this._sessions.length;
        const casting = this._castStatus.state === 'casting' ||
            this._castStatus.state === 'connecting';

        if (casting && sessionCount > 0) {
            if (sessionCount === 1)
                this._buildNormalConnectedUi();
            else
                this._buildAdvancedConnectedUi();
            this._buildAddDevicesSection();
            return;
        }

        this._buildIdleDevicePicker();
    }

    _buildIdleDevicePicker() {
        const header = new St.BoxLayout({
            style_class: 'dac-cast-header',
            x_expand: true,
        });
        const heading = new St.Label({
            text: _('Devices'),
            style_class: 'dac-section-label',
            x_expand: true,
        });
        header.add_child(heading);

        const refreshBtn = new St.Button({
            style_class: 'button dac-cast-refresh',
            label: _('Refresh'),
            can_focus: true,
        });
        refreshBtn.connect('clicked', () => {
            this._refreshDevices(true).catch(e =>
                _warn('Cast refresh failed', e));
        });
        header.add_child(refreshBtn);
        this._bodyBox.add_child(header);

        if (!this._cast.available) {
            const missing = new St.Label({
                text: _('Cast helper not running. Run ./install.sh, then reopen.'),
                style_class: 'dim-label',
            });
            missing.clutter_text.line_wrap = true;
            this._bodyBox.add_child(missing);
            return;
        }

        if (!this._devices.length) {
            const empty = new St.Label({
                text: _('No displays found. Check Wi‑Fi / Cast / Miracast.'),
                style_class: 'dim-label',
            });
            empty.clutter_text.line_wrap = true;
            this._bodyBox.add_child(empty);
        } else {
            const list = new St.BoxLayout({
                vertical: true,
                style_class: 'dac-cast-list',
                x_expand: true,
            });
            for (const device of this._devices)
                list.add_child(this._createSelectableDeviceRow(device));
            this._bodyBox.add_child(list);
        }

        const count = this._selectedIds.size;
        const hint = new St.Label({
            text: count > 1
                ? _('Multiple devices selected — advanced features after connect')
                : _('Select one or more devices, then Connect'),
            style_class: 'dim-label dac-select-hint',
        });
        hint.clutter_text.line_wrap = true;
        this._bodyBox.add_child(hint);

        const connectLabel = count > 1
            ? _('Connect (%d)').format(count)
            : _('Connect');
        const connectBtn = new St.Button({
            style_class: 'button dac-connect-button',
            label: connectLabel,
            x_expand: true,
            can_focus: true,
            reactive: count > 0,
        });
        if (count === 0)
            connectBtn.add_style_class_name('dac-connect-disabled');
        connectBtn.connect('clicked', () => {
            this._connectSelected().catch(e =>
                _warn('connectSelected failed', e));
        });
        this._bodyBox.add_child(connectBtn);
    }

    _createSelectableDeviceRow(device) {
        const selected = this._selectedIds.has(device.id);
        const row = new St.Button({
            style_class: selected
                ? 'dac-cast-device-row dac-cast-device-selected'
                : 'dac-cast-device-row',
            x_expand: true,
            can_focus: true,
            track_hover: true,
        });

        const inner = new St.BoxLayout({
            style_class: 'dac-cast-device-inner',
            x_expand: true,
        });

        const mark = new St.Label({
            text: selected ? '✓' : '○',
            style_class: 'dac-select-mark',
        });
        inner.add_child(mark);

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });
        const name = new St.Label({
            text: device.name || device.id,
            style_class: 'dac-cast-device-name',
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(name);

        const metaParts = [this._protocolLabel(device.protocol)];
        if (device.model)
            metaParts.push(device.model);
        const meta = new St.Label({
            text: metaParts.join(' · '),
            style_class: 'dim-label',
        });
        textBox.add_child(meta);
        inner.add_child(textBox);
        row.set_child(inner);

        row.connect('clicked', () => {
            this._toggleDeviceSelection(device);
        });
        return row;
    }

    _toggleDeviceSelection(device) {
        const id = device.id;
        if (this._selectedIds.has(id)) {
            this._selectedIds.delete(id);
            this._rebuildBody();
            return;
        }

        const isMiracast = device.protocol === 'miracast' ||
            id.startsWith('miracast:');
        if (isMiracast) {
            this._selectedIds.clear();
            this._selectedIds.add(id);
            this._rebuildBody();
            return;
        }

        // Drop miracast if selecting chromecast.
        for (const selectedId of [...this._selectedIds]) {
            const d = this._devices.find(x => x.id === selectedId);
            if (d?.protocol === 'miracast' || selectedId.startsWith('miracast:'))
                this._selectedIds.delete(selectedId);
        }
        this._selectedIds.add(id);
        this._rebuildBody();
    }

    _protocolLabel(protocol) {
        if (protocol === 'miracast')
            return _('Wireless display');
        return _('Cast');
    }

    _buildModeChipGrid(onKind) {
        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'dac-mode-grid',
            x_expand: true,
        });

        for (const row of LAYOUT_ACTIONS) {
            const rowBox = new St.BoxLayout({
                style_class: 'dac-action-row',
                x_expand: true,
            });
            for (const {label, kind} of row) {
                const button = new St.Button({
                    style_class: 'button dac-mode-chip',
                    label,
                    x_expand: true,
                    can_focus: true,
                });
                button.connect('clicked', () => {
                    onKind(kind).catch(e =>
                        _warn(`Layout ${kind} failed`, e));
                });
                rowBox.add_child(button);
            }
            box.add_child(rowBox);
        }
        return box;
    }

    _buildNormalConnectedUi() {
        const session = this._sessions[0];
        const heading = new St.Label({
            text: _('Connected'),
            style_class: 'dac-section-label',
        });
        this._bodyBox.add_child(heading);

        this._bodyBox.add_child(this._createSessionRow(session, {showModes: false}));

        const features = new St.Label({
            text: _('Features'),
            style_class: 'dac-section-label',
        });
        this._bodyBox.add_child(features);
        this._bodyBox.add_child(this._buildModeChipGrid(kind => this._runLayout(kind)));
    }

    _buildAdvancedConnectedUi() {
        const heading = new St.Label({
            text: _('Connected (%d)').format(this._sessions.length),
            style_class: 'dac-section-label',
        });
        this._bodyBox.add_child(heading);

        for (const session of this._sessions)
            this._bodyBox.add_child(this._createSessionRow(session, {showModes: true}));

        const manageToggle = new St.Button({
            style_class: 'button dac-manage-toggle',
            label: this._manageExpanded ? _('Hide manage') : _('Manage'),
            x_expand: true,
            can_focus: true,
        });
        manageToggle.connect('clicked', () => {
            this._manageExpanded = !this._manageExpanded;
            this._rebuildBody();
        });
        this._bodyBox.add_child(manageToggle);

        if (this._manageExpanded)
            this._buildManageSection();
    }

    _createSessionRow(session, {showModes = false} = {}) {
        const wrap = new St.BoxLayout({
            vertical: true,
            style_class: 'dac-session-block',
            x_expand: true,
        });

        const row = new St.BoxLayout({
            style_class: 'dac-cast-device-row',
            x_expand: true,
        });

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });
        const name = new St.Label({
            text: session.name || session.id,
            style_class: 'dac-cast-device-name',
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(name);

        const stateLabel = new St.Label({
            text: session.state === 'connecting'
                ? _('Connecting…')
                : _('Casting'),
            style_class: 'dim-label',
        });
        textBox.add_child(stateLabel);
        row.add_child(textBox);

        const stopBtn = new St.Button({
            style_class: 'button dac-cast-action',
            label: _('Disconnect'),
            can_focus: true,
        });
        stopBtn.connect('clicked', () => {
            this._disconnectSession(session.id).catch(e =>
                _warn('disconnectSession failed', e));
        });
        row.add_child(stopBtn);
        wrap.add_child(row);

        if (showModes) {
            const letter = this._deviceGroupMap[session.id] || 'A';
            const groupHint = new St.Label({
                text: _('Group %s').format(letter),
                style_class: `dim-label dac-group-badge ${this._groupStyleClass(letter)}`,
            });
            wrap.add_child(groupHint);
            wrap.add_child(this._buildModeChipGrid(kind => this._runLayout(kind)));
        }

        return wrap;
    }

    _buildManageSection() {
        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'dac-manage-section',
            x_expand: true,
        });

        const heading = new St.Label({
            text: _('Manage'),
            style_class: 'dac-section-label',
        });
        box.add_child(heading);

        const mirrorAll = new St.Button({
            style_class: 'button dac-connect-button',
            label: _('Mirror all'),
            x_expand: true,
            can_focus: true,
        });
        mirrorAll.connect('clicked', () => {
            this._mirrorAllConnected().catch(e =>
                _warn('mirrorAll failed', e));
        });
        box.add_child(mirrorAll);

        const groupHint = new St.Label({
            text: _('Tap a device to change its group'),
            style_class: 'dim-label',
        });
        box.add_child(groupHint);

        const grid = new St.BoxLayout({
            style_class: 'dac-monitor-grid',
            x_expand: true,
        });
        const maxGroups = Math.max(2, this._sessions.length);
        for (const session of this._sessions) {
            const letter = this._deviceGroupMap[session.id] || 'A';
            grid.add_child(this._createDeviceGroupTile(session, letter, maxGroups));
        }
        box.add_child(grid);

        if (this._monitors.length >= 3) {
            const localHeading = new St.Label({
                text: _('Local displays'),
                style_class: 'dac-section-label',
            });
            box.add_child(localHeading);
            const localGrid = new St.BoxLayout({
                style_class: 'dac-monitor-grid',
                x_expand: true,
            });
            const localMax = this._monitors.length;
            for (const monitor of this._monitors) {
                const letter = this._groupMap[monitor.connector] || 'A';
                localGrid.add_child(
                    this._createMonitorTile(monitor, letter, localMax)
                );
            }
            box.add_child(localGrid);

            const applyLocal = new St.Button({
                style_class: 'button dac-apply-button',
                label: _('Apply local groups'),
                x_expand: true,
                can_focus: true,
            });
            applyLocal.connect('clicked', () => {
                this._applyGroups().catch(e =>
                    _warn('Apply groups failed', e));
            });
            box.add_child(applyLocal);
        }

        this._bodyBox.add_child(box);
    }

    _createDeviceGroupTile(session, letter, maxGroups) {
        const box = new St.BoxLayout({
            vertical: true,
            style_class: `dac-monitor-tile ${this._groupStyleClass(letter)}`,
            x_expand: true,
        });

        const name = new St.Label({
            text: session.name || session.id,
            style_class: 'dac-monitor-name',
            x_align: Clutter.ActorAlign.CENTER,
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(name);

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
            const current = this._deviceGroupMap[session.id] || 'A';
            const nextIndex = (_letterIndex(current) + 1) % maxGroups;
            this._deviceGroupMap[session.id] = DisplayConfig.groupLetter(nextIndex);
            _saveJsonMap(this._settings, 'cast-device-groups', this._deviceGroupMap);
            this._rebuildBody();
        });
        return button;
    }

    _buildAddDevicesSection() {
        const connectedIds = new Set(this._sessions.map(s => s.id));
        const available = this._devices.filter(d => !connectedIds.has(d.id));
        if (!available.length)
            return;

        const heading = new St.Label({
            text: _('Add device'),
            style_class: 'dac-section-label',
        });
        this._bodyBox.add_child(heading);

        const list = new St.BoxLayout({
            vertical: true,
            style_class: 'dac-cast-list',
            x_expand: true,
        });
        for (const device of available) {
            if (device.protocol === 'miracast')
                continue;
            const row = new St.BoxLayout({
                style_class: 'dac-cast-device-row',
                x_expand: true,
            });
            const name = new St.Label({
                text: device.name || device.id,
                style_class: 'dac-cast-device-name',
                x_expand: true,
            });
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(name);

            const addBtn = new St.Button({
                style_class: 'button dac-cast-action',
                label: _('Add'),
                can_focus: true,
            });
            addBtn.connect('clicked', () => {
                this._addDeviceToSession(device).catch(e =>
                    _warn('addDevice failed', e));
            });
            row.add_child(addBtn);
            list.add_child(row);
        }
        this._bodyBox.add_child(list);
    }

    async _connectSelected() {
        const selected = this._devices.filter(d => this._selectedIds.has(d.id));
        if (!selected.length) {
            _notify(_('Cast Display'), _('Select a device first'));
            return;
        }
        await this._startCastSelected(selected);
    }

    async _startCastSelected(devices) {
        if (!this._cast.available) {
            _notify(_('Cast Display'), _('Cast helper is not running'));
            return;
        }

        const source = this._settings.get_string('cast-source') || 'primary';
        try {
            this._settings.set_string('last-cast-device', devices[0].id);
        } catch (_) { /* ignore */ }

        await this._maybeEnablePresentationForCast();

        const names = devices.map(d => d.name || d.id);
        this._castStatus = {
            state: 'connecting',
            deviceId: devices.map(d => d.id).join(','),
            deviceName: names.length === 1
                ? names[0]
                : _('%s + %d').format(names[0], names.length - 1),
            error: '',
        };
        this._sessions = devices.map(d => ({
            id: d.id,
            name: d.name || d.id,
            state: 'connecting',
        }));
        this._applyCastStatusToUi();

        try {
            if (typeof this._cast.castDevices === 'function')
                await this._cast.castDevices(devices.map(d => d.id), source);
            else if (devices.length === 1)
                await this._cast.castDesktop(devices[0].id, source);
            else
                throw new Error('Multi-device cast requires an updated cast helper');

            try {
                this._castStatus = await this._cast.getStatus();
            } catch (_) { /* SessionChanged will update */ }
            await this._refreshSessions();
            this._selectedIds.clear();
            this._applyCastStatusToUi();
        } catch (e) {
            _warn('CastDevices failed', e);
            const msg = e?.message || String(e);
            _notify(_('Cast Display'), msg);
            this._castStatus = {
                state: 'error',
                deviceId: devices[0]?.id || '',
                deviceName: devices[0]?.name || '',
                error: msg,
            };
            this._sessions = [];
            this._applyCastStatusToUi();
            await this._restorePresentationAfterCast();
        }
    }

    async _addDeviceToSession(device) {
        const ids = [...this._sessions.map(s => s.id), device.id];
        const known = ids.map(id => {
            const existing = this._sessions.find(s => s.id === id);
            if (existing)
                return {id, name: existing.name};
            return device;
        });
        await this._startCastSelected(known);
    }

    async _disconnectSession(deviceId) {
        try {
            if (this._sessions.length <= 1) {
                await this._stopCast();
                return;
            }
            if (typeof this._cast.disconnectDevice === 'function')
                await this._cast.disconnectDevice(deviceId);
            else
                await this._stopCast();

            await this._refreshSessions();
            try {
                this._castStatus = await this._cast.getStatus();
            } catch (_) { /* ignore */ }

            if (!this._sessions.length)
                await this._restorePresentationAfterCast();

            this._applyCastStatusToUi();
        } catch (e) {
            _warn('DisconnectDevice failed', e);
            _notify(_('Cast Display'), _('Could not disconnect device'));
        }
    }

    async _stopCast() {
        try {
            await this._cast.stop();
            this._castStatus = {state: 'idle', deviceId: '', deviceName: '', error: ''};
            this._sessions = [];
            this._manageExpanded = false;
            this._applyCastStatusToUi();
            await this._restorePresentationAfterCast();
        } catch (e) {
            _warn('Stop cast failed', e);
            _notify(_('Cast Display'), _('Could not stop casting'));
        }
    }

    async _mirrorAllConnected() {
        await this._runLayout('mirror');
        if (this._sessions.length < 2)
            return;
        const source = 'all';
        try {
            this._settings.set_string('cast-source', source);
        } catch (_) { /* ignore */ }
        const devices = this._sessions.map(s => ({id: s.id, name: s.name}));
        await this._startCastSelected(devices);
    }

    _applyCastStatusToUi() {
        const s = this._castStatus;

        if (s.state === 'error' && s.error) {
            this._setStatusText(s.error);
        } else if (s.state === 'connecting') {
            this._setStatusText(
                _('Connecting to %s…').format(s.deviceName || s.deviceId)
            );
        } else if (s.state === 'casting') {
            this._setStatusText('');
        } else if (this._isActivated() && this._cast.available) {
            this._setStatusText('');
        }

        this._updateCheckedFromState();
        this._rebuildBody();
        this._updateSubtitle();
    }

    _onCastSession(status) {
        if (this._destroyed)
            return;
        const prev = this._castStatus.state;
        this._castStatus = status || this._castStatus;

        this._refreshSessions().then(() => {
            this._applyCastStatusToUi();
        }).catch(e => {
            _warn('session refresh failed', e);
            this._applyCastStatusToUi();
        });

        if (status?.state === 'error' && status.error) {
            _notify(_('Cast Display'), status.error);
            this._restorePresentationAfterCast().catch(e =>
                _warn('restore presentation failed', e));
        } else if (status?.state === 'idle' &&
                   (prev === 'casting' || prev === 'connecting')) {
            this._sessions = [];
            this._restorePresentationAfterCast().catch(e =>
                _warn('restore presentation failed', e));
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
        if (wasOff && this._presentation.enabled)
            await this._presentation.disable();
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
            if (this._isActivated() && this._sessions.length >= 2 && this._manageExpanded)
                this._rebuildBody();
            this._updateSubtitle();
        } catch (e) {
            _warn('getCurrentState in refresh failed', e);
        }
    }

    _reconcileGroupMap() {
        const saved = _loadJsonMap(this._settings, 'monitor-groups');
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
            this._rebuildBody();
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
        if (!this._isActivated() && s.state !== 'casting' && s.state !== 'connecting') {
            this.subtitle = _('Off');
            return;
        }
        if (s.state === 'casting') {
            if (this._sessions.length > 1) {
                this.subtitle = _('Connected to %d devices').format(this._sessions.length);
            } else {
                this.subtitle = _('Connected to %s').format(s.deviceName || s.deviceId);
            }
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
        if (this._devices.length > 0) {
            this.subtitle = _('%d found').format(this._devices.length);
            return;
        }
        this.subtitle = _('Ready');
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

            const toSave = {
                ..._loadJsonMap(this._settings, 'monitor-groups'),
                ...connected,
            };
            _saveJsonMap(this._settings, 'monitor-groups', toSave);
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
        disconnect(this._disconnectSettings);

        this._disconnectMonitors = null;
        this._disconnectPresentation = null;
        this._disconnectCastAvail = null;
        this._disconnectCastDevices = null;
        this._disconnectCastSession = null;
        this._disconnectSettings = null;

        this._displayConfig = null;
        this._presentation = null;
        this._cast = null;
        this._settings = null;
        this._extension = null;
        super.destroy();
    }
});
