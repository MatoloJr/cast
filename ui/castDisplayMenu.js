import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {verticalBox} from '../lib/compat.js';

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

/**
 * Per-receiver state → a short chip label the user can act on.
 *
 * Built on demand, not at module scope: from GNOME 45 `gettext` may only be
 * called while an extension is running and a module-level `_()` throws
 * "gettext can only be called from extensions" at import time.
 *
 * @param {string} state the session state reported by the helper
 * @returns {string} a label for the chip
 */
function sessionLabel(state) {
    switch (state) {
    case 'connecting':
        return _('Connecting…');
    case 'buffering':
        return _('Buffering…');
    case 'playing':
        return _('Playing');
    case 'error':
        return _('Error');
    default:
        return state;
    }
}

const SESSION_STYLES = {
    connecting: 'cast-chip-pending',
    buffering: 'cast-chip-pending',
    playing: 'cast-chip-playing',
    error: 'cast-chip-error',
};

/**
 * One device row. Created once per device and *updated* in place, so the
 * menu never rebuilds itself underneath the pointer (defect S5: the old menu
 * destroyed and recreated every row on each 12 s discovery tick, which made
 * rows flicker and swallowed clicks).
 */
const DeviceRow = GObject.registerClass(
class DeviceRow extends PopupMenu.PopupBaseMenuItem {
    _init(device, callbacks) {
        super._init({activate: true});
        this._deviceId = device.id;
        this._callbacks = callbacks;
        this._selected = false;
        this._session = null;

        this._check = new St.Icon({
            icon_name: 'object-select-symbolic',
            style_class: 'popup-menu-icon cast-check',
            opacity: 0,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._check);

        const text = verticalBox({style_class: 'cast-row-text', x_expand: true});
        this._name = new St.Label({style_class: 'cast-row-name'});
        this._detail = new St.Label({style_class: 'cast-row-detail'});
        text.add_child(this._name);
        text.add_child(this._detail);
        this.add_child(text);

        this._chip = new St.Label({
            style_class: 'cast-chip',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.add_child(this._chip);

        this._disconnect = new St.Button({
            style_class: 'cast-row-button',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                style_class: 'popup-menu-icon',
            }),
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._disconnectId = this._disconnect.connect('clicked', () => {
            this._callbacks.onDisconnect(this._deviceId);
        });
        this.add_child(this._disconnect);

        this._activateId = this.connect('activate', () => {
            this._callbacks.onToggle(this._deviceId);
        });

        this._disposed = false;
        this.connect('destroy', () => {
            this._disposed = true;
        });

        this.update(device, null, false);
    }

    get deviceId() {
        return this._deviceId;
    }

    update(device, session, selected) {
        if (this._disposed)
            return;
        this._name.text = device.name || device.id;

        let detail = device.model || '';
        if (device.protocol === 'miracast-handoff')
            detail = device.model || _('Opens Network Displays');
        else if (device.cast_type === 'audio')
            detail = _('Speaker cannot show a screen');
        else if (device.cast_type === 'group')
            detail = _('Speaker group cannot show a screen');
        this._detail.text = detail;
        this._detail.visible = !!detail;

        this._session = session;
        if (session) {
            const state = session.state || 'connecting';
            this._chip.text = sessionLabel(session.error ? 'error' : state);
            this._chip.style_class = `cast-chip ${SESSION_STYLES[state] || ''}`;
            this._chip.visible = true;
            this._disconnect.visible = true;
            this._check.opacity = 0;
            if (session.error)
                this._detail.text = session.error;
            this._detail.visible = !!this._detail.text;
        } else {
            this._chip.visible = false;
            this._disconnect.visible = false;
            this._selected = selected;
            this._check.opacity = selected ? 255 : 0;
        }

        // An audio target can never show a screen, so it is never
        // selectable. The Miracast hand-off is clickable but is an action,
        // not a selection, so it never shows a check mark.
        this._isHandoff = device.protocol === 'miracast-handoff';
        this.sensitive = this._isHandoff || device.video_capable !== false;
        if (this._isHandoff)
            this._check.opacity = 0;
    }

    destroy() {
        this._disposed = true;
        if (this._activateId) {
            this.disconnect(this._activateId);
            this._activateId = 0;
        }
        if (this._disconnectId) {
            this._disconnect.disconnect(this._disconnectId);
            this._disconnectId = 0;
        }
        super.destroy();
    }
});

export const CastDisplayMenuToggle = GObject.registerClass(
class CastDisplayMenuToggle extends QuickSettings.QuickMenuToggle {
    _init(extension, client, presentation, displayModes) {
        super._init({
            title: _('Cast Display'),
            iconName: 'video-display-symbolic',
            toggleMode: true,
        });

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = client;
        this._presentation = presentation;
        this._displayModes = displayModes ?? null;
        this._destroyed = false;

        this._rows = new Map();          // deviceId → DeviceRow
        this._selected = new Set();
        this._localOnlyItems = [];
        this._localSignature = '';
        this._localScreensPending = false;
        this._syncing = false;
        this._lastNotifiedError = '';

        this.menu.setHeader('video-display-symbolic', _('Cast Display'));

        this._buildMenu();

        this._signals = [];
        this._signals.push([this, this.connect('clicked', () => {
            if (!this._syncing)
                this._onTileClicked();
        })]);
        this._signals.push([this._client, this._client.connect(
            'changed', () => this._sync())]);
        this._signals.push([this._client, this._client.connect(
            'availability-changed', () => this._sync())]);
        this._signals.push([this._client, this._client.connect(
            'helper-error', (_c, scope, id, message) =>
                this._onHelperError(scope, id, message))]);
        this._signals.push([this.menu, this.menu.connect(
            'open-state-changed', (_m, open) => {
                if (open && this._client.available)
                    this._client.refresh().catch(() => {});
            })]);
        this._signals.push([this._settings, this._settings.connect(
            'changed::cast-show-speakers', () => this._sync())]);

        // See the note in extension.js: actors are disposed from C during
        // Shell shutdown, so the guard has to hang off the actor's own
        // destroy signal rather than only our destroy() method.
        this.connect('destroy', () => this._releaseSignals());

        this._sync();
    }

    // -- construction ------------------------------------------------------

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._statusItem.label.style_class = 'cast-status-label';
        this.menu.addMenuItem(this._statusItem);

        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);

        this._actionSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._actionSeparator);

        this._connectItem = new PopupMenu.PopupMenuItem(_('Connect'));
        this._connectItem.connect('activate', () => this._onConnect());
        this.menu.addMenuItem(this._connectItem);

        this._stopItem = new PopupMenu.PopupMenuItem(_('Stop casting'));
        this._stopItem.connect('activate', () => this._onStop());
        this.menu.addMenuItem(this._stopItem);

        this._modeItem = new PopupMenu.PopupSubMenuMenuItem(_('Mode'));
        this._mirrorItem = new PopupMenu.PopupMenuItem(_('Mirror this screen'));
        this._extendItem = new PopupMenu.PopupMenuItem(_('Extend onto the display'));
        this._mirrorItem.connect('activate', () => this._onSetMode('mirror'));
        this._extendItem.connect('activate', () => this._onSetMode('extend'));
        this._modeItem.menu.addMenuItem(this._mirrorItem);
        this._modeItem.menu.addMenuItem(this._extendItem);

        this._displayOnlyItem = new PopupMenu.PopupSwitchMenuItem(
            _('Turn off this computer\'s screens'),
            this._settings.get_boolean('cast-display-only'));
        this._displayOnlyItem.connect('toggled', (_item, value) => {
            this._settings.set_boolean('cast-display-only', value);
        });
        this._modeItem.menu.addMenuItem(this._displayOnlyItem);
        this.menu.addMenuItem(this._modeItem);

        // Only meaningful with more than one physical screen, so it is
        // added hidden and revealed once we know (see _syncLocalScreens).
        this._localItem = new PopupMenu.PopupSubMenuMenuItem(
            _('This computer\'s screens'));
        this._localMirrorItem = new PopupMenu.PopupMenuItem(_('Mirror them'));
        this._localMirrorItem.connect('activate', () => {
            this._displayModes?.mirrorLocalScreens()
                .catch(e => this._reportFailure(e));
        });
        this._localItem.menu.addMenuItem(this._localMirrorItem);
        this._localItem.visible = false;
        this.menu.addMenuItem(this._localItem);

        this._speakersItem = new PopupMenu.PopupSwitchMenuItem(
            _('Show speakers'), this._settings.get_boolean('cast-show-speakers'));
        this._speakersItem.connect('toggled', (_item, value) => {
            this._settings.set_boolean('cast-show-speakers', value);
        });
        this.menu.addMenuItem(this._speakersItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._settingsItem = new PopupMenu.PopupMenuItem(_('Cast Display settings'));
        this._settingsItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(this._settingsItem);
    }

    // -- tile --------------------------------------------------------------

    _onTileClicked() {
        // The tile means "cast or stop", not "arm a feature". Turning it off
        // stops what is running; turning it on opens the picker.
        if (this._client.isStreaming || this._client.isBusy) {
            this._onStop();
        } else {
            this._syncing = true;
            this.checked = false;
            this._syncing = false;
            this.menu.open();
        }
    }

    // -- actions -----------------------------------------------------------

    _streamOptions() {
        const options = {
            mode: this._settings.get_string('cast-mode'),
            audio: this._settings.get_boolean('cast-audio'),
            fps: this._settings.get_int('cast-fps'),
            mute_local: this._settings.get_boolean('cast-mute-local'),
        };
        const audioDelay = this._settings.get_int('cast-audio-delay-ms');
        if (audioDelay !== 0)
            options.audio_delay_ms = audioDelay;
        const height = this._settings.get_int('cast-max-height');
        if (height > 0)
            options.max_height = height;
        const bitrate = this._settings.get_int('cast-bitrate-kbps');
        if (bitrate > 0)
            options.bitrate_kbps = bitrate;
        const portMin = this._settings.get_int('cast-port-min');
        const portMax = this._settings.get_int('cast-port-max');
        if (portMin > 0 && portMax >= portMin) {
            options.port_min = portMin;
            options.port_max = portMax;
        }
        return options;
    }

    async _onConnect() {
        const ids = [...this._selected];
        if (!ids.length) {
            this._setStatus(_('Select a display first'));
            return;
        }
        try {
            const stream = this._client.activeStream;
            if (stream)
                await this._client.addDevices(stream.stream_id, ids);
            else
                await this._client.startCast(ids, this._streamOptions());
            this._selected.clear();
        } catch (e) {
            this._reportFailure(e);
        }
    }

    async _onStop() {
        try {
            await this._client.stopAll();
        } catch (e) {
            this._reportFailure(e);
        }
    }

    async _onDisconnect(deviceId) {
        try {
            await this._client.removeDevice(deviceId);
        } catch (e) {
            this._reportFailure(e);
        }
    }

    async _onSetMode(mode) {
        this._settings.set_string('cast-mode', mode);
        const stream = this._client.activeStream;
        if (!stream || stream.mode === mode)
            return;
        // Changing the capture source means a new portal session, so the
        // stream really does restart. Say so by doing it explicitly.
        const ids = this._client.sessions.map(s => s.device_id);
        try {
            await this._client.stopAll();
            if (ids.length)
                await this._client.startCast(ids, this._streamOptions());
        } catch (e) {
            this._reportFailure(e);
        }
    }

    _onToggleDevice(deviceId) {
        const device = this._client.devices.find(d => d.id === deviceId);
        if (!device)
            return;

        if (device.protocol === 'miracast-handoff') {
            // A hand-off, never a cast: no session is created and the tile
            // does not change state (defect S11).
            if (device.install_uri) {
                // The Shell opens the store page. The helper never runs
                // sudo on the user's behalf.
                try {
                    Gio.AppInfo.launch_default_for_uri(device.install_uri, null);
                } catch (e) {
                    this._reportFailure(e);
                }
            } else {
                this._client.openMiracast().catch(e => this._reportFailure(e));
            }
            this.menu.close();
            return;
        }
        if (device.video_capable === false)
            return;

        if (this._selected.has(deviceId))
            this._selected.delete(deviceId);
        else
            this._selected.add(deviceId);
        this._sync();
    }

    // -- errors ------------------------------------------------------------

    _onHelperError(scope, id, message) {
        // One specific notification per failure, not one per refresh.
        if (message === this._lastNotifiedError)
            return;
        this._lastNotifiedError = message;
        Main.notify(_('Cast Display'), message);
    }

    _reportFailure(error) {
        const message = this._friendlyError(error);
        _warn('Cast action failed', error);
        if (message !== this._lastNotifiedError) {
            this._lastNotifiedError = message;
            Main.notify(_('Cast Display'), message);
        }
    }

    _friendlyError(error) {
        const raw = error?.message ?? String(error);
        if (raw.includes('Error.PortalDenied'))
            return _('Screen sharing was not allowed, so nothing was cast.');
        if (raw.includes('Error.NoEncoder'))
            return _('No video encoder is available. Run cast_helper --doctor.');
        if (raw.includes('Error.Network'))
            return _('Could not reach the display over the network.');
        if (raw.includes('Error.Busy'))
            return _('Another cast operation is still finishing.');
        if (raw.includes('Error.NotFound'))
            return _('That display is no longer available.');
        if (raw.includes('Error.Unsupported'))
            return raw.replace(/^.*Error\.Unsupported:?\s*/, '');
        return raw;
    }

    // -- sync --------------------------------------------------------------

    _setStatus(text) {
        if (this._destroyed)
            return;
        this._statusItem.label.text = text;
        this._statusItem.visible = !!text;
    }

    _sync() {
        if (this._destroyed)
            return;

        const client = this._client;

        if (!client.available) {
            this._setStatus(_('The cast helper is not running'));
            this._showControls({connect: false, stop: false, mode: false});
            this._clearRows();
            this._syncTile(false, _('Unavailable'));
            return;
        }
        if (client.outdated) {
            this._setStatus(client.outdatedMessage);
            this._showControls({connect: false, stop: false, mode: false});
            this._clearRows();
            this._syncTile(false, _('Outdated helper'));
            return;
        }

        const state = client.state;
        const sessions = client.sessions;
        const sessionById = new Map(sessions.map(s => [s.device_id, s]));
        const streaming = state === 'streaming';

        this._syncRows(sessionById);
        this._syncStatus(state, sessions);
        this._showControls({
            connect: !streaming || this._selected.size > 0,
            stop: streaming || state === 'starting',
            mode: streaming || sessions.length === 0,
        });
        this._syncModeChecks();
        this._syncLocalScreens();
        this._syncTile(streaming || state === 'starting',
            this._subtitleFor(state, sessions));
        this._syncPresentation(streaming);
    }

    _syncRows(sessionById) {
        const showSpeakers = this._settings.get_boolean('cast-show-speakers');
        const devices = this._client.devices.filter(device => {
            // The Miracast hand-off reports video_capable false because it
            // is not a cast target, but it is not a speaker either and must
            // always be listed.
            if (device.protocol === 'miracast-handoff')
                return true;
            if (device.video_capable === false)
                return showSpeakers;
            return true;
        });

        const seen = new Set();
        for (const device of devices) {
            seen.add(device.id);
            let row = this._rows.get(device.id);
            if (!row) {
                row = new DeviceRow(device, {
                    onToggle: id => this._onToggleDevice(id),
                    onDisconnect: id => this._onDisconnect(id),
                });
                this._rows.set(device.id, row);
                this._deviceSection.addMenuItem(row);
            }
            row.update(device, sessionById.get(device.id) ?? null,
                this._selected.has(device.id));
        }

        // Remove only what actually went away.
        for (const [id, row] of [...this._rows]) {
            if (seen.has(id))
                continue;
            this._rows.delete(id);
            this._selected.delete(id);
            row.destroy();
        }
    }

    _clearRows() {
        for (const [, row] of this._rows)
            row.destroy();
        this._rows.clear();
        this._selected.clear();
    }

    _syncStatus(state, sessions) {
        if (state === 'starting') {
            this._setStatus(_('Starting…'));
            return;
        }
        if (state === 'stopping') {
            this._setStatus(_('Stopping…'));
            return;
        }
        if (state === 'error') {
            this._setStatus(this._client.lastError || _('Something went wrong'));
            return;
        }
        if (state === 'streaming') {
            const stream = this._client.activeStream;
            const mode = stream?.mode === 'extend' ? _('Extending') : _('Mirroring');
            const playing = sessions.filter(s => s.state === 'playing').length;
            this._setStatus(
                `${mode} ${playing}/${sessions.length} ${_('ready')}`);
            return;
        }
        if (!this._rows.size) {
            this._setStatus(_('Looking for displays…'));
            return;
        }
        this._setStatus(this._selected.size
            ? `${this._selected.size} ${_('selected')}`
            : _('Select a display, then Connect'));
    }

    _showControls({connect, stop, mode}) {
        this._connectItem.visible = connect;
        this._connectItem.label.text = this._client.isStreaming
            ? _('Add selected') : _('Connect');
        this._stopItem.visible = stop;
        this._modeItem.visible = mode;
        this._actionSeparator.visible = connect || stop;
        const caps = this._client.capabilities;
        this._extendItem.sensitive = caps.virtual_source !== false;
    }

    _syncLocalScreens() {
        if (!this._displayModes?.available || this._localScreensPending)
            return;
        this._localScreensPending = true;
        this._displayModes.physicalMonitors().then(monitors => {
            this._localScreensPending = false;
            if (this._destroyed)
                return;
            // The brief: show local layout actions only when 2+ physical
            // monitors exist. On a single-screen laptop they are no-ops.
            this._localItem.visible = monitors.length >= 2;
            if (monitors.length < 2)
                return;
            this._rebuildLocalScreenItems(monitors);
        }).catch(() => {
            this._localScreensPending = false;
        });
    }

    _rebuildLocalScreenItems(monitors) {
        const signature = monitors.map(m => m.connector).join(',');
        if (signature === this._localSignature)
            return;
        this._localSignature = signature;

        for (const item of this._localOnlyItems ?? [])
            item.destroy();
        this._localOnlyItems = [];

        for (const monitor of monitors) {
            const name = monitor.displayName || monitor.connector;
            const item = new PopupMenu.PopupMenuItem(
                `${_('Use only')} ${name}`);
            item.connect('activate', () => {
                this._displayModes?.useOnlyLocalScreen(monitor.connector)
                    .catch(e => this._reportFailure(e));
            });
            this._localItem.menu.addMenuItem(item);
            this._localOnlyItems.push(item);
        }
    }

    _syncModeChecks() {
        const mode = this._client.activeStream?.mode ??
            this._settings.get_string('cast-mode');
        this._mirrorItem.setOrnament(mode === 'mirror'
            ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        this._extendItem.setOrnament(mode === 'extend'
            ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }

    _subtitleFor(state, sessions) {
        if (state === 'starting')
            return _('Starting…');
        if (state === 'stopping')
            return _('Stopping…');
        if (state !== 'streaming')
            return null;
        if (sessions.length === 1)
            return sessions[0].name;
        return `${sessions.length} ${_('displays')}`;
    }

    _syncTile(active, subtitle) {
        this._syncing = true;
        this.checked = active;
        this._syncing = false;
        this.subtitle = subtitle ?? null;
    }

    _syncPresentation(streaming) {
        if (!this._presentation)
            return;
        // Presentation mode is *derived* from the helper's state rather than
        // remembered, which is what left banners switched off for ever after
        // a lock screen (gap G4).
        const wanted = streaming &&
            this._settings.get_boolean('cast-auto-presentation');
        this._presentation.setEnabled(wanted).catch(e =>
            _warn('Presentation mode toggle failed', e));
    }

    _releaseSignals() {
        this._destroyed = true;
        for (const [object, id] of this._signals) {
            try {
                object.disconnect(id);
            } catch (e) {
                _warn('Signal disconnect failed', e);
            }
        }
        this._signals = [];
    }

    destroy() {
        this._releaseSignals();
        this._clearRows();
        super.destroy();
    }
});
