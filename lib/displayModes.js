import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DisplayConfig} from './displayConfig.js';
import {LayoutGuard} from './layoutGuard.js';
import {
    Position,
    appearedConnectors,
    buildMirror,
    buildSingleOnly,
    placeNewMonitor,
} from './layout.js';

/**
 * Seconds to wait after the stream starts before looking for the virtual
 * monitor. Mutter creates it asynchronously once PipeWire negotiates, so
 * diffing immediately finds nothing.
 */
const VIRTUAL_SETTLE_MS = 1200;
const VIRTUAL_ATTEMPTS = 8;

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

function _notify(body) {
    try {
        Main.notify(_('Cast Display'), body);
    } catch (e) {
        _warn('Could not post a notification', e);
    }
}

/**
 * Turns the helper's stream mode into a real Mutter layout.
 *
 * Mirror needs nothing from Mutter: the portal captures an existing monitor.
 * Extend is where this earns its keep the portal's VIRTUAL source makes
 * Mutter create a monitor, which then shows up in DisplayConfig, so Extend
 * and "display only" become genuine layouts that include the receiver.
 * That is the fix for gap G1, where these controls only ever rearranged
 * local monitors and were no-ops on a single-screen laptop.
 */
export class DisplayModeManager {
    constructor(client, settings) {
        this._client = client;
        this._settings = settings;
        this._displayConfig = new DisplayConfig();
        this._guard = new LayoutGuard(this._displayConfig);

        this._monitorsBefore = null;
        this._virtualConnector = null;
        this._pendingTimeout = 0;
        this._attempts = 0;
        this._lastState = client.state;

        this._changedId = client.connect('changed', () => this._onClientChanged());
    }

    get available() {
        return this._displayConfig.available;
    }

    get virtualConnector() {
        return this._virtualConnector;
    }

    // -- stream lifecycle --------------------------------------------------

    _onClientChanged() {
        const state = this._client.state;
        if (state === this._lastState)
            return;
        const previous = this._lastState;
        this._lastState = state;

        if (state === 'starting' && previous !== 'streaming') {
            this._snapshot();
            return;
        }
        if (state === 'streaming' && previous !== 'streaming') {
            this._onStreamStarted();
            return;
        }
        if (previous === 'streaming' || previous === 'starting') {
            if (state === 'idle' || state === 'error' || state === 'stopping')
                this._onStreamEnded(state === 'error');
        }
    }

    async _snapshot() {
        if (!this._displayConfig.available)
            return;
        try {
            const state = await this._displayConfig.getCurrentState();
            this._monitorsBefore = state.monitors;
        } catch (e) {
            _warn('Could not read the monitor layout before casting', e);
            this._monitorsBefore = null;
        }
    }

    _onStreamStarted() {
        const stream = this._client.activeStream;
        if (!stream || stream.mode !== 'extend')
            return;
        if (!this._displayConfig.available) {
            _notify(_('Extending needs Mutter\'s display service, which is unavailable.'));
            return;
        }
        this._attempts = 0;
        this._scheduleVirtualLookup();
    }

    _scheduleVirtualLookup() {
        this._cancelPending();
        this._pendingTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, VIRTUAL_SETTLE_MS, () => {
                this._pendingTimeout = 0;
                this._findVirtualMonitor().catch(e =>
                    _warn('Could not arrange the extended display', e));
                return GLib.SOURCE_REMOVE;
            });
    }

    async _findVirtualMonitor() {
        if (this._client.state !== 'streaming')
            return;

        const state = await this._displayConfig.getCurrentState();
        const appeared = this._monitorsBefore
            ? appearedConnectors(this._monitorsBefore, state.monitors)
            : [];

        if (!appeared.length) {
            this._attempts += 1;
            if (this._attempts < VIRTUAL_ATTEMPTS) {
                this._scheduleVirtualLookup();
                return;
            }
            // Honest about the limitation rather than pretending.
            _notify(_(
                'The display was connected, but this desktop did not create a ' +
                'separate screen for it, so it is mirroring instead of extending.'
            ));
            return;
        }

        this._virtualConnector = appeared[0];
        const monitor = state.monitors.find(m => m.connector === this._virtualConnector);
        const mode = monitor?.modes?.find(m => m.isCurrent) ?? monitor?.modes?.[0];
        console.debug(
            `[display-and-cast] virtual monitor ${this._virtualConnector} ` +
            `at ${mode ? `${mode.width}x${mode.height}` : 'unknown size'}`
        );

        await this._arrangeExtended(state);
    }

    async _arrangeExtended(state) {
        const position = this._positionSetting();
        const displayOnly = this._settings.get_boolean('cast-display-only');

        if (displayOnly) {
            // "Second screen only": the receiver is the one live monitor.
            const result = buildSingleOnly(
                state.monitors, this._virtualConnector, state.layoutMode);
            if (result.error) {
                _notify(result.error);
                return;
            }
            const outcome = await this._guard.apply(result.entries);
            if (outcome.needsConfirmation) {
                console.debug('[display-and-cast] awaiting keep-changes confirmation');
            }
            return;
        }

        const result = placeNewMonitor(
            state.monitors, state.logicalMonitors, this._virtualConnector,
            position, state.layoutMode);
        if (result.error) {
            _notify(result.error);
            return;
        }
        await this._guard.apply(result.entries);
    }

    _positionSetting() {
        switch (this._settings.get_string('cast-extend-position')) {
        case 'left':
            return Position.LEFT;
        case 'above':
            return Position.ABOVE;
        case 'below':
            return Position.BELOW;
        default:
            return Position.RIGHT;
        }
    }

    _onStreamEnded(wasError) {
        this._cancelPending();
        this._virtualConnector = null;
        if (!this._displayConfig.available)
            return;
        // Always put the pre-cast layout back, whether the user stopped it
        // or the stream died under a confirmation dialog.
        if (wasError)
            this._guard.streamLost();
        else
            this._guard.restore().catch(e => _warn('Could not restore the layout', e));
    }

    // -- local layouts (2+ physical monitors) ------------------------------

    /**
     * Physical monitors, excluding any virtual monitor we created.
     *
     * @returns {Promise<object[]>} the machine's real monitors
     */
    async physicalMonitors() {
        if (!this._displayConfig.available)
            return [];
        const state = await this._displayConfig.getCurrentState();
        return DisplayConfig.physicalMonitors(
            state.monitors, this._virtualConnector ? [this._virtualConnector] : []);
    }

    /**
     * Mirror this computer's own screens to one another.
     *
     * @returns {Promise<boolean>} whether the layout was applied
     */
    async mirrorLocalScreens() {
        const state = await this._displayConfig.getCurrentState();
        const monitors = DisplayConfig.physicalMonitors(
            state.monitors, this._virtualConnector ? [this._virtualConnector] : []);
        if (monitors.length < 2) {
            _notify(_('There is only one screen on this computer to mirror.'));
            return false;
        }
        const result = buildMirror(monitors, state.layoutMode);
        if (result.error) {
            // Gap G2: say which resolutions clash instead of
            // "Layout could not be applied".
            _notify(result.error);
            return false;
        }
        await this._guard.apply(result.entries);
        return true;
    }

    /**
     * Keep only one of this computer's screens on.
     *
     * @param {string} connector the monitor to keep
     * @returns {Promise<boolean>} whether the layout was applied
     */
    async useOnlyLocalScreen(connector) {
        const state = await this._displayConfig.getCurrentState();
        const result = buildSingleOnly(state.monitors, connector, state.layoutMode);
        if (result.error) {
            _notify(result.error);
            return false;
        }
        // This blanks a live screen, so it goes through the revert timer.
        await this._guard.apply(result.entries);
        return true;
    }

    // -- teardown ----------------------------------------------------------

    _cancelPending() {
        if (this._pendingTimeout) {
            GLib.source_remove(this._pendingTimeout);
            this._pendingTimeout = 0;
        }
    }

    destroy() {
        this._cancelPending();
        if (this._changedId) {
            this._client.disconnect(this._changedId);
            this._changedId = 0;
        }
        this._guard.destroy();
        this._displayConfig.destroy();
        this._monitorsBefore = null;
        this._virtualConnector = null;
    }
}
