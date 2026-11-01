import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {
    TileAction,
    chooseTileAction,
    rememberableDevices,
} from '../lib/tileAction.js';
import {CastDialog} from './castDialog.js';

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

/**
 * The Quick Settings tile.
 *
 * It owns the client subscriptions, the selection and every action, but no
 * picker: the chevron opens {@link CastDialog} in the middle of the screen
 * instead of a dropdown. The dropdown was replaced because it is anchored
 * under the tile with no scroll view and no height bound, so on a laptop
 * panel its lower half was unreachable.
 *
 * The tile body is therefore a plain switch: it stops a running cast, or
 * resumes the receivers the last cast went to.
 */
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

        this._selected = new Set();
        this._dialog = null;
        this._syncing = false;
        this._lastNotifiedError = '';

        this._signals = [];
        this._takeOverMenu();

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
        this._signals.push([this._settings, this._settings.connect(
            'changed::cast-show-speakers', () => this._sync())]);
        this._signals.push([this._settings, this._settings.connect(
            'changed::cast-mode', () => this._sync())]);
        this._signals.push([this._settings, this._settings.connect(
            'changed::cast-display-only', () => this._sync())]);

        // See the note in extension.js: actors are disposed from C during
        // Shell shutdown, so the guard has to hang off the actor's own
        // destroy signal rather than only our destroy() method.
        this.connect('destroy', () => this._releaseSignals());

        this._sync();
    }

    // -- taking the chevron over -------------------------------------------

    /**
     * Point every route into the dropdown at the dialog instead.
     *
     * The chevron's handler is wired inside `QuickMenuToggle._init()` as an
     * anonymous `() => this.menu.open()` closure and GJS cannot disconnect
     * a handler it has no id for. The arrow button itself is no better a
     * target: it is `this._menuButton` on GNOME 50 but not under a name
     * worth relying on across 45-50 and the style class it carries was
     * renamed between 44 and 45. That one method, though, is what the
     * chevron, the Menu key via `popup-menu` and our own Super+K all call,
     * so it is the only thing worth intercepting.
     *
     * Nothing is ever added to the dropdown, so the worst case for a future
     * Shell that finds another way in is an empty popup, not a broken tile.
     */
    _takeOverMenu() {
        if (!this.menu || typeof this.menu.open !== 'function') {
            _warn('This Shell has no quick-toggle menu to intercept; ' +
                'use the keyboard shortcut to open the dialog');
            return;
        }

        this._realMenuOpen = this.menu.open.bind(this.menu);
        this.menu.open = () => this.openDialog();

        // Belt, for a Shell that stops routing through menu.open(). It does
        // not flicker: QuickToggleMenu.open() sets box.opacity = 0 and only
        // eases it back once the height animation finishes, so closing it in
        // the same frame means nothing was ever drawn.
        this._signals.push([this.menu, this.menu.connect(
            'open-state-changed', (menu, open) => {
                if (!open)
                    return;
                menu.close(PopupAnimation.NONE);
                this.openDialog();
            })]);
    }

    /** Show the picker. Also the Super+K entry point. */
    openDialog() {
        if (this._destroyed)
            return;

        // A modal dialog over an open quick-settings popup is wrong twice:
        // the popup stays drawn underneath and pushModal() has to take the
        // keyboard off the panel's own grab. The panel drops it on close.
        Main.panel.statusArea.quickSettings?.menu.close();

        if (!this._dialog) {
            this._dialog = new CastDialog({
                client: this._client,
                settings: this._settings,
                displayModes: this._displayModes,
                // The same Set the toggle filters: ticking two displays and
                // then closing the dialog by accident must not lose them.
                selection: this._selected,
                actions: {
                    connect: () => this._onConnect(),
                    stop: () => this._onStop(),
                    disconnect: id => this._onDisconnect(id),
                    setMode: mode => this._onSetMode(mode),
                    toggleDevice: id => this._onToggleDevice(id),
                    openPreferences: () => this._extension.openPreferences(),
                    report: e => this._reportFailure(e),
                },
            });
            // ModalDialog destroys itself on close, so this is also how the
            // reference is dropped. A closed dialog is therefore never
            // synced: there are no actors left to update rather than a flag
            // saying not to.
            this._dialog.connect('destroy', () => {
                this._dialog = null;
            });
        }

        this._dialog.open();
        if (this._client.available)
            this._client.refresh().catch(() => {});
    }

    // -- tile --------------------------------------------------------------

    _onTileClicked() {
        const {action, deviceIds} = chooseTileAction({
            available: this._client.available,
            outdated: this._client.outdated,
            streaming: this._client.isStreaming,
            busy: this._client.isBusy,
        }, this._settings.get_strv('cast-last-devices'), this._client.devices);

        switch (action) {
        case TileAction.STOP:
            this._onStop();
            break;
        case TileAction.RESUME:
            this._resume(deviceIds);
            break;
        default:
            // PICK and NOTHING both open the dialog, for different reasons:
            // one to choose a receiver, one to read why there is none to
            // choose. _sync() un-latches the tile that toggleMode just
            // checked, so it never claims to cast while the picker is up.
            this._sync();
            this.openDialog();
        }
    }

    async _resume(ids) {
        // Optimistic and corrected by the next _sync(): StartCast returns
        // in tens of milliseconds but the receivers take seconds and a tile
        // that sits unchecked in between reads as "the click did nothing".
        this._syncTile(true, _('Starting…'));
        try {
            await this._client.startCast(ids, this._streamOptions());
            this._rememberDevices(ids);
        } catch (e) {
            this._reportFailure(e);
            this._sync();
            // The resume failed, so the picker is the honest next step.
            this.openDialog();
        }
    }

    _rememberDevices(ids) {
        const keep = rememberableDevices(ids, this._client.devices);
        if (keep.length)
            this._settings.set_strv('cast-last-devices', keep);
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
            this._dialog?.sync();
            return;
        }
        try {
            const stream = this._client.activeStream;
            if (stream)
                await this._client.addDevices(stream.stream_id, ids);
            else
                await this._client.startCast(ids, this._streamOptions());
            this._rememberDevices(ids);
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
            this._dialog?.close();
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

    _sync() {
        if (this._destroyed)
            return;

        const client = this._client;

        // Forget a ticked display that stopped being discovered. This used
        // to happen alongside the rows, which cannot work now the picker may
        // be closed. The emptiness guard matters: a transient empty Devices
        // property is routine and must not wipe what the user ticked.
        if (client.devices.length) {
            const known = new Set(client.devices.map(d => d.id));
            for (const id of [...this._selected]) {
                if (!known.has(id))
                    this._selected.delete(id);
            }
        }

        const streaming = client.isStreaming;
        this._syncTile(streaming || client.state === 'starting',
            this._subtitleFor(client.state, client.sessions));
        this._syncPresentation(streaming);
        this._dialog?.sync();
    }

    _subtitleFor(state, sessions) {
        if (!this._client.available)
            return _('Unavailable');
        if (this._client.outdated)
            return _('Outdated helper');
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

        // Hand the dropdown back, so nothing is left holding a closure over
        // a destroyed toggle.
        if (this._realMenuOpen && this.menu) {
            this.menu.open = this._realMenuOpen;
            this._realMenuOpen = null;
        }

        if (this._dialog) {
            try {
                this._dialog.destroy();
            } catch (e) {
                _warn('Cast dialog destroy failed', e);
            }
            this._dialog = null;
        }
    }

    destroy() {
        this._releaseSignals();
        this._selected.clear();
        super.destroy();
    }
});
