import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    ScrollPolicy,
    horizontalBox,
    scrollView,
    verticalBox,
} from '../lib/compat.js';
import {listMaxHeight} from '../lib/dialogMetrics.js';

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
 * list never rebuilds itself underneath the pointer (defect S5: the old menu
 * destroyed and recreated every row on each 12 s discovery tick, which made
 * rows flicker and swallowed clicks). The dialog is short-lived, but a
 * discovery tick arriving while it is open is not, which is why this still
 * matters here.
 *
 * It stays a PopupBaseMenuItem outside a menu on purpose: `_getTopMenu()`
 * returns itself when it has no parent menu, and the hover, `:selected` and
 * keyboard-activate behaviour are all things an St.Button would have to
 * re-implement.
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

/**
 * The cast picker, as a dialog in the middle of the screen.
 *
 * It used to be the tile's Quick Settings dropdown. A dropdown is anchored
 * under its tile, has no scroll view and no height bound, so on a laptop
 * panel the lower half the mode control, the switches and the settings
 * link simply ran off the bottom of the screen with no way to reach it.
 * A dialog can be measured against the work area, and only its device list
 * grows.
 *
 * It owns no subscriptions. The toggle keeps those and calls `sync()`, so a
 * dialog can never outlive what drives it.
 */
export const CastDialog = GObject.registerClass(
class CastDialog extends ModalDialog.ModalDialog {
    _init({client, settings, displayModes, selection, actions}) {
        super._init({styleClass: 'cast-dialog'});

        this._client = client;
        this._settings = settings;
        this._displayModes = displayModes ?? null;
        this._selected = selection;
        this._actions = actions;

        this._rows = new Map();          // deviceId → DeviceRow
        this._switchRows = [];
        this._localOnlyItems = [];
        this._localSignature = '';
        this._localScreensPending = false;
        this._listStyle = '';
        this._destroyed = false;

        this._build();

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._applyHeightBudget());
        // `opened` fires from the fade's onComplete, so this is the first
        // moment the content has a real allocation to measure against.
        this.connect('opened', () => this._applyHeightBudget());
        this.connect('destroy', () => this._onDestroyed());

        this.sync();
    }

    // -- construction ------------------------------------------------------

    _build() {
        const content = verticalBox({
            style_class: 'cast-dialog-content',
            x_expand: true,
        });
        this.contentLayout.add_child(content);

        const header = horizontalBox({style_class: 'cast-dialog-header'});
        header.add_child(new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'cast-dialog-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const headerText = verticalBox({x_expand: true});
        headerText.add_child(new St.Label({
            style_class: 'cast-dialog-title headline',
            text: _('Cast Display'),
        }));
        this._status = new St.Label({style_class: 'cast-status-label'});
        this._status.clutter_text.line_wrap = true;
        headerText.add_child(this._status);
        header.add_child(headerText);
        content.add_child(header);

        this._list = verticalBox({style_class: 'cast-dialog-list', x_expand: true});
        this._listScroll = scrollView({
            style_class: 'cast-dialog-list-scroll',
            hscrollbar_policy: ScrollPolicy.NEVER,
            vscrollbar_policy: ScrollPolicy.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._list,
        });
        content.add_child(this._listScroll);

        content.add_child(this._buildModeSection());

        this._displayOnlyRow = this._switchRow(
            _('Turn off this computer\'s screens'), 'cast-display-only');
        content.add_child(this._displayOnlyRow);

        this._speakersRow = this._switchRow(
            _('Show speakers'), 'cast-show-speakers');
        content.add_child(this._speakersRow);

        content.add_child(this._buildLocalSection());

        this._settingsLink = new St.Button({
            style_class: 'cast-dialog-link button flat',
            label: _('Cast Display settings'),
            can_focus: true,
            x_expand: true,
        });
        this._settingsLink.connect('clicked', () => {
            this._actions.openPreferences();
            this.close();
        });
        content.add_child(this._settingsLink);

        this.addButton({
            label: _('Close'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        });
        this._stopButton = this.addButton({
            label: _('Stop casting'),
            action: () => this._actions.stop(),
        });
        this._connectButton = this.addButton({
            label: _('Connect'),
            action: () => {
                // Enter reaches the default button's action even while it is
                // hidden, so the visibility check belongs here rather than
                // only on the actor.
                if (this._connectButton.visible)
                    this._actions.connect();
            },
            default: true,
        });
    }

    _buildModeSection() {
        this._modeSection = verticalBox({style_class: 'cast-dialog-section'});
        this._modeSection.add_child(new St.Label({
            style_class: 'cast-dialog-section-title',
            text: _('Mode'),
        }));

        const segmented = horizontalBox({
            style_class: 'cast-dialog-segmented',
            x_expand: true,
        });
        // Short labels: at the dialog's 28em the long wording from the old
        // menu ("Extend onto the display") ellipsizes in a half-width
        // button. The description below carries the meaning instead.
        this._mirrorButton = this._segment(_('Mirror'), 'mirror');
        this._extendButton = this._segment(_('Extend'), 'extend');
        segmented.add_child(this._mirrorButton);
        segmented.add_child(this._extendButton);
        this._modeSection.add_child(segmented);

        this._modeDetail = new St.Label({style_class: 'cast-dialog-section-detail'});
        this._modeDetail.clutter_text.line_wrap = true;
        this._modeSection.add_child(this._modeDetail);

        return this._modeSection;
    }

    _segment(label, mode) {
        const button = new St.Button({
            style_class: 'button cast-dialog-segment',
            label,
            toggle_mode: true,
            can_focus: true,
            x_expand: true,
        });
        button.connect('clicked', () => this._actions.setMode(mode));
        return button;
    }

    _switchRow(label, key) {
        const row = new St.Button({
            style_class: 'cast-dialog-row button flat',
            can_focus: true,
            x_expand: true,
        });
        const box = horizontalBox({x_expand: true});
        box.add_child(new St.Label({
            text: label,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const toggle = new PopupMenu.Switch(this._settings.get_boolean(key));
        box.add_child(toggle);
        row.set_child(box);

        // The row is the hit target, not the switch: a 20 px switch is a bad
        // thing to ask somebody to hit.
        row.connect('clicked', () =>
            this._settings.set_boolean(key, !this._settings.get_boolean(key)));

        // Re-read rather than flip, so the prefs window open beside the
        // dialog stays in step with it.
        this._switchRows.push(() => {
            toggle.state = this._settings.get_boolean(key);
        });
        return row;
    }

    _buildLocalSection() {
        // Only meaningful with more than one physical screen, so it starts
        // hidden and is revealed once we know (see _syncLocalScreens).
        this._localSection = verticalBox({
            style_class: 'cast-dialog-section',
            visible: false,
        });
        this._localSection.add_child(new St.Label({
            style_class: 'cast-dialog-section-title',
            text: _('This computer\'s screens'),
        }));

        this._localButtons = horizontalBox({
            style_class: 'cast-dialog-segmented',
            x_expand: true,
        });
        const mirror = new St.Button({
            style_class: 'button flat',
            label: _('Mirror them'),
            can_focus: true,
            x_expand: true,
        });
        mirror.connect('clicked', () => {
            this._displayModes?.mirrorLocalScreens()
                .catch(e => this._actions.report(e));
        });
        this._localButtons.add_child(mirror);
        this._localSection.add_child(this._localButtons);

        return this._localSection;
    }

    // -- sizing ------------------------------------------------------------

    /**
     * Bound the device list to what this screen can actually show.
     *
     * The budget comes from the monitor the dialog is on, which is the one
     * under the pointer: ModalDialog._fadeOpen sets its monitor constraint
     * from global.display.get_current_monitor(), not from the primary.
     */
    _applyHeightBudget() {
        if (this._destroyed)
            return;

        const index = global.display.get_current_monitor();
        const work = Main.layoutManager.getWorkAreaForMonitor(index);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = this.dialogLayout.width || -1;

        // Measured, never guessed: the chrome's height moves with the user's
        // font size, the theme's padding and which sections are showing.
        let chromeHeight = this.buttonLayout.get_preferred_height(width)[1];
        for (const child of this.contentLayout.get_children()) {
            if (child.visible)
                chromeHeight += child.get_preferred_height(width)[1];
        }
        chromeHeight -= this._listScroll.get_preferred_height(width)[1];

        const style = `max-height: ${listMaxHeight({
            workAreaHeight: work?.height ?? 0,
            chromeHeight,
            scaleFactor: scale,
        })}px;`;

        // set_style() invalidates the style tree and sync() runs on every
        // D-Bus tick, so only write when the number actually moved.
        if (style !== this._listStyle) {
            this._listStyle = style;
            this._listScroll.set_style(style);
        }
    }

    // -- sync --------------------------------------------------------------

    _setStatus(text) {
        this._status.text = text;
        this._status.visible = !!text;
    }

    /**
     * Bring the dialog in line with the helper. Idempotent and cheap enough
     * to call on every property change.
     */
    sync() {
        if (this._destroyed)
            return;

        const client = this._client;

        if (!client.available) {
            this._setStatus(_('The cast helper is not running'));
            this._showControls({connect: false, stop: false, mode: false});
            this._clearRows();
            this._applyHeightBudget();
            return;
        }
        if (client.outdated) {
            this._setStatus(client.outdatedMessage);
            this._showControls({connect: false, stop: false, mode: false});
            this._clearRows();
            this._applyHeightBudget();
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
        for (const syncSwitch of this._switchRows)
            syncSwitch();
        this._syncLocalScreens();
        this._applyHeightBudget();
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
                    onToggle: id => this._actions.toggleDevice(id),
                    onDisconnect: id => this._actions.disconnect(id),
                });
                this._rows.set(device.id, row);
                this._list.add_child(row);
            }
            row.update(device, sessionById.get(device.id) ?? null,
                this._selected.has(device.id));
        }

        // Remove only what actually went away.
        for (const [id, row] of [...this._rows]) {
            if (seen.has(id))
                continue;
            this._rows.delete(id);
            row.destroy();
        }
    }

    _clearRows() {
        for (const [, row] of this._rows)
            row.destroy();
        this._rows.clear();
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
        this._connectButton.visible = connect;
        this._connectButton.label = this._client.isStreaming
            ? _('Add selected') : _('Connect');
        this._stopButton.visible = stop;
        this._modeSection.visible = mode;

        const caps = this._client.capabilities;
        const canExtend = caps.virtual_source !== false;
        this._extendButton.reactive = canExtend;
        this._extendButton.can_focus = canExtend;
        if (canExtend)
            this._extendButton.remove_style_pseudo_class('insensitive');
        else
            this._extendButton.add_style_pseudo_class('insensitive');
    }

    _syncModeChecks() {
        const mode = this._client.activeStream?.mode ??
            this._settings.get_string('cast-mode');
        this._mirrorButton.checked = mode === 'mirror';
        this._extendButton.checked = mode === 'extend';

        if (this._extendButton.reactive) {
            this._modeDetail.text = mode === 'extend'
                ? _('The display becomes a second desktop you can drag windows onto.')
                : _('The display shows one of this computer\'s screens.');
        } else {
            this._modeDetail.text =
                _('Extend needs a portal that can make a virtual monitor; this one cannot.');
        }
        this._displayOnlyRow.visible = mode === 'extend';
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
            this._localSection.visible = monitors.length >= 2;
            if (monitors.length < 2)
                return;
            this._rebuildLocalScreenItems(monitors);
            this._applyHeightBudget();
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
            const button = new St.Button({
                style_class: 'button flat',
                label: `${_('Use only')} ${name}`,
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', () => {
                this._displayModes?.useOnlyLocalScreen(monitor.connector)
                    .catch(e => this._actions.report(e));
            });
            this._localButtons.add_child(button);
            this._localOnlyItems.push(button);
        }
    }

    // -- teardown ----------------------------------------------------------

    open(...args) {
        // Budget once up front so nothing unbounded is ever drawn, and again
        // from the `opened` signal, which is the first point the labels have
        // a real width to wrap against.
        this._applyHeightBudget();
        return super.open(...args);
    }

    _onDestroyed() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._monitorsChangedId) {
            try {
                Main.layoutManager.disconnect(this._monitorsChangedId);
            } catch (e) {
                _warn('Monitor signal disconnect failed', e);
            }
            this._monitorsChangedId = 0;
        }
        this._rows.clear();
    }

    destroy() {
        this._onDestroyed();
        super.destroy();
    }
});
