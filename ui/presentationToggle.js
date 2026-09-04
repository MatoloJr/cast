import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

export const PresentationToggle = GObject.registerClass(
class PresentationToggle extends QuickSettings.QuickToggle {
    _init(presentationMode) {
        super._init({
            title: _('Presentation mode'),
            iconName: 'preferences-desktop-screensaver-symbolic',
            toggleMode: true,
        });

        this._presentation = presentationMode;
        this._syncing = false;
        this._disconnectChanged = null;

        this.checked = this._presentation.enabled;

        this._disconnectChanged = this._presentation.connectChanged(enabled => {
            this._syncing = true;
            this.checked = enabled;
            this._syncing = false;
        });

        this.connect('notify::checked', () => {
            if (this._syncing || !this._presentation)
                return;
            const want = this.checked;
            this._presentation.setEnabled(want).then(ok => {
                if (!ok) {
                    this._syncing = true;
                    this.checked = this._presentation.enabled;
                    this._syncing = false;
                }
            }).catch(e => {
                _warn('Presentation toggle failed', e);
                this._syncing = true;
                this.checked = this._presentation?.enabled ?? false;
                this._syncing = false;
            });
        });
    }

    destroy() {
        if (this._disconnectChanged) {
            try {
                this._disconnectChanged();
            } catch (_) { /* ignore */ }
            this._disconnectChanged = null;
        }
        this._presentation = null;
        super.destroy();
    }
});
