import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {verticalBox, horizontalBox} from './compat.js';
import {ApplyMethod} from './displayConfig.js';
import {disablesAnActiveMonitor, sameLayout} from './layout.js';

/** Seconds the user has to confirm a layout that switches a screen off. */
export const REVERT_SECONDS = 15;

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

/**
 * "Keep these display settings?" with a countdown that reverts on its own.
 *
 * Applying a layout that switches off the screen the user is looking at can
 * leave them with nothing to click (gap G3). Mutter's own Settings panel
 * solves this with a timed confirmation and anything here that disables a
 * live monitor goes through the same flow.
 */
const KeepChangesDialog = GObject.registerClass(
class KeepChangesDialog extends ModalDialog.ModalDialog {
    _init(seconds, onKeep, onRevert) {
        super._init({styleClass: 'prompt-dialog'});

        this._remaining = seconds;
        this._onKeep = onKeep;
        this._onRevert = onRevert;
        this._settled = false;
        this._timeoutId = 0;

        const content = horizontalBox({
            style_class: 'prompt-dialog-main-layout',
        });
        this.contentLayout.add_child(content);

        const text = verticalBox({
            style_class: 'prompt-dialog-message-layout',
            x_expand: true,
        });
        content.add_child(text);

        text.add_child(new St.Label({
            style_class: 'prompt-dialog-headline headline',
            text: _('Keep these display settings?'),
        }));

        this._body = new St.Label({style_class: 'prompt-dialog-description'});
        this._body.clutter_text.line_wrap = true;
        text.add_child(this._body);
        this._updateBody();

        this.addButton({
            label: _('Revert'),
            action: () => this._settle(false),
            key: Clutter.KEY_Escape,
        });
        this._keepButton = this.addButton({
            label: _('Keep changes'),
            action: () => this._settle(true),
            default: true,
        });

        // GLib rather than setInterval: it is what the rest of the Shell
        // uses, it is available on every version this extension supports,
        // and the source id can be removed deterministically on destroy.
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1, () => this._tick());
    }

    _updateBody() {
        this._body.text = _(
            'Reverting to the previous display settings in %d seconds.'
        ).replace('%d', String(this._remaining));
    }

    _tick() {
        this._remaining -= 1;
        if (this._remaining <= 0) {
            this._timeoutId = 0;
            this._settle(false);
            return GLib.SOURCE_REMOVE;
        }
        this._updateBody();
        return GLib.SOURCE_CONTINUE;
    }

    _settle(keep) {
        if (this._settled)
            return;
        this._settled = true;
        this._stopTimer();
        this.close();
        try {
            if (keep)
                this._onKeep();
            else
                this._onRevert();
        } catch (e) {
            _warn('Keep-changes callback failed', e);
        }
    }

    _stopTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    /** Called when the stream dies underneath the dialog. */
    forceRevert() {
        this._settle(false);
    }

    destroy() {
        this._stopTimer();
        super.destroy();
    }
});

/**
 * Applies monitor layouts, reverting anything the user does not confirm.
 */
export class LayoutGuard {
    constructor(displayConfig) {
        this._displayConfig = displayConfig;
        this._dialog = null;
        this._savedLayout = null;
    }

    get hasPendingConfirmation() {
        return !!this._dialog;
    }

    /**
     * Apply a layout, with a revert timer when it would blank a screen.
     *
     * @param {object[]} entries apply entries from lib/layout.js
     * @param {object} options behaviour switches
     * @param {boolean} [options.persistOnConfirm] write the layout permanently
     *   once the user keeps it
     * @returns {Promise<{applied: boolean, needsConfirmation: boolean}>}
     *   whether Mutter took the layout and whether a dialog is now up
     */
    async apply(entries, {persistOnConfirm = false} = {}) {
        const before = await this._displayConfig.getCurrentState();
        const risky = disablesAnActiveMonitor(entries, before.logicalMonitors);

        // Remember the layout to go back to, before changing anything.
        this._savedLayout = before;

        await this._displayConfig.apply(entries, {
            serial: before.serial,
            method: ApplyMethod.TEMPORARY,
        });

        if (!risky) {
            if (persistOnConfirm)
                await this._persist(entries);
            return {applied: true, needsConfirmation: false};
        }

        this._confirm(entries, persistOnConfirm);
        return {applied: true, needsConfirmation: true};
    }

    _confirm(entries, persistOnConfirm) {
        this._dismissDialog();

        this._dialog = new KeepChangesDialog(
            REVERT_SECONDS,
            () => {
                this._dialog = null;
                if (persistOnConfirm) {
                    this._persist(entries).catch(e =>
                        _warn('Could not persist the layout', e));
                }
            },
            () => {
                this._dialog = null;
                this.restore().catch(e =>
                    _warn('Could not revert the layout', e));
            }
        );
        this._dialog.open();
    }

    async _persist(entries) {
        const state = await this._displayConfig.getCurrentState();
        await this._displayConfig.apply(entries, {
            serial: state.serial,
            method: ApplyMethod.PERSISTENT,
        });
    }

    /**
     * Put the pre-cast layout back.
     *
     * @returns {Promise<boolean>} whether the layout now matches the saved one
     */
    async restore() {
        const saved = this._savedLayout;
        if (!saved)
            return true;
        this._savedLayout = null;

        const entries = [];
        for (const logical of saved.logicalMonitors) {
            const members = [];
            for (const connector of logical.monitors) {
                const monitor = saved.monitors.find(m => m.connector === connector);
                const mode = monitor?.modes?.find(m => m.isCurrent) ??
                    monitor?.modes?.find(m => m.isPreferred);
                if (mode)
                    members.push([connector, mode.id, {}]);
            }
            if (members.length) {
                entries.push([logical.x, logical.y, logical.scale,
                    logical.transform, logical.primary, members]);
            }
        }
        if (!entries.length)
            return false;

        const current = await this._displayConfig.getCurrentState();
        await this._displayConfig.apply(entries, {
            serial: current.serial,
            method: ApplyMethod.TEMPORARY,
        });

        const after = await this._displayConfig.getCurrentState();
        const restored = sameLayout(saved.logicalMonitors, after.logicalMonitors);
        if (!restored)
            _warn('The display layout did not return to its previous arrangement');
        return restored;
    }

    /** The stream died while a confirmation was up: revert immediately. */
    streamLost() {
        if (this._dialog) {
            this._dialog.forceRevert();
            return;
        }
        this.restore().catch(e => _warn('Could not revert the layout', e));
    }

    _dismissDialog() {
        if (!this._dialog)
            return;
        try {
            this._dialog.destroy();
        } catch (e) {
            _warn('Could not close the keep-changes dialog', e);
        }
        this._dialog = null;
    }

    destroy() {
        this._dismissDialog();
        this._savedLayout = null;
        this._displayConfig = null;
    }
}
