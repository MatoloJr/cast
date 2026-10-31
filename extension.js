import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {CastClient} from './lib/castClient.js';
import {PresentationMode} from './lib/presentationMode.js';
import {CastDisplayMenuToggle} from './ui/castDisplayMenu.js';

const KEYBINDING = 'open-cast-menu';

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

const CastDisplayIndicator = GObject.registerClass(
class CastDisplayIndicator extends QuickSettings.SystemIndicator {
    _init(extension, client, presentation) {
        super._init();

        // Visible only while the screen is actually being streamed. The old
        // code created an indicator and hid it for ever, so the user had no
        // way to tell from the top bar that their screen was going out
        // (gap G7). GNOME's own screen-share indicator stays as well; this
        // one says how many receivers are attached.
        this._icon = this._addIndicator();
        this._icon.icon_name = 'video-display-symbolic';
        this._icon.visible = false;

        this._count = new St.Label({
            style_class: 'cast-indicator-count',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.add_child(this._count);

        this._client = client;
        this._destroyed = false;
        this._changedId = client.connect('changed', () => this._sync());
        this._availabilityId = client.connect('availability-changed',
            () => this._sync());

        this._menuToggle = new CastDisplayMenuToggle(extension, client, presentation);
        this.quickSettingsItems.push(this._menuToggle);

        // Clutter disposes actors from C during Shell shutdown, before any
        // JS destroy() runs. Without this, a D-Bus property change arriving
        // in that window drives _sync() into disposed actors and the Shell
        // logs a pile of "already disposed" criticals.
        this.connect('destroy', () => this._onDestroyed());

        this._sync();
    }

    _onDestroyed() {
        this._destroyed = true;
        if (this._changedId) {
            this._client.disconnect(this._changedId);
            this._changedId = 0;
        }
        if (this._availabilityId) {
            this._client.disconnect(this._availabilityId);
            this._availabilityId = 0;
        }
    }

    _sync() {
        if (this._destroyed)
            return;
        const streaming = this._client.isStreaming;
        const sessions = this._client.sessions.length;
        this._icon.visible = streaming;
        this._count.visible = streaming && sessions > 1;
        this._count.text = sessions > 1 ? String(sessions) : '';
    }

    openMenu() {
        Main.panel.statusArea.quickSettings.menu.open();
        this._menuToggle.menu.open();
    }

    destroy() {
        this._onDestroyed();
        this.quickSettingsItems.forEach(item => {
            try {
                item.destroy();
            } catch (e) {
                _warn('Failed to destroy quick settings item', e);
            }
        });
        this.quickSettingsItems.length = 0;
        super.destroy();
    }
});

export default class DisplayAndCastExtension extends Extension {
    enable() {
        this._client = null;
        this._presentation = null;
        this._indicator = null;
        this._keybindingAdded = false;

        try {
            this._client = new CastClient();
        } catch (e) {
            _warn('Failed to create the cast client', e);
            return;
        }

        try {
            this._presentation = new PresentationMode(this);
        } catch (e) {
            _warn('Failed to init PresentationMode', e);
        }

        try {
            this._indicator = new CastDisplayIndicator(
                this, this._client, this._presentation);
            Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        } catch (e) {
            _warn('Failed to add the Quick Settings indicator', e);
        }

        try {
            Main.wm.addKeybinding(
                KEYBINDING,
                this.getSettings(),
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._indicator?.openMenu()
            );
            this._keybindingAdded = true;
        } catch (e) {
            _warn('Failed to add the keyboard shortcut', e);
        }
    }

    disable() {
        // `disable()` also runs when the screen locks. It must NOT stop the
        // cast: the helper owns the session and keeps streaming across a
        // lock, which is the behaviour the user expects from a presentation
        // (gap G4). Only Shell-side resources are released here.
        if (this._keybindingAdded) {
            try {
                Main.wm.removeKeybinding(KEYBINDING);
            } catch (e) {
                _warn('Failed to remove the keyboard shortcut', e);
            }
            this._keybindingAdded = false;
        }

        try {
            this._indicator?.destroy();
        } catch (e) {
            _warn('Indicator destroy failed', e);
        }
        this._indicator = null;

        try {
            this._presentation?.destroy();
        } catch (e) {
            _warn('PresentationMode destroy failed', e);
        }
        this._presentation = null;

        try {
            this._client?.destroy();
        } catch (e) {
            _warn('Cast client destroy failed', e);
        }
        this._client = null;
    }
}
