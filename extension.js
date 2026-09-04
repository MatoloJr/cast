import GObject from 'gi://GObject';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {DisplayConfig} from './lib/displayConfig.js';
import {PresentationMode} from './lib/presentationMode.js';
import {DisplaysMenuToggle} from './ui/displaysMenu.js';
import {PresentationToggle} from './ui/presentationToggle.js';

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

const DisplaysIndicator = GObject.registerClass(
class DisplaysIndicator extends QuickSettings.SystemIndicator {
    _init(extension, displayConfig, presentationMode) {
        super._init();

        // No persistent top-bar icon; Quick Settings tiles only.
        const icon = this._addIndicator();
        icon.visible = false;

        this._displaysToggle = new DisplaysMenuToggle(extension, displayConfig);
        this._presentationToggle = new PresentationToggle(presentationMode);

        this.quickSettingsItems.push(this._displaysToggle);
        this.quickSettingsItems.push(this._presentationToggle);
    }

    destroy() {
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
        this._displayConfig = null;
        this._presentation = null;
        this._indicator = null;

        try {
            this._displayConfig = new DisplayConfig();
        } catch (e) {
            _warn('Failed to init DisplayConfig', e);
        }

        try {
            this._presentation = new PresentationMode(this);
        } catch (e) {
            _warn('Failed to init PresentationMode', e);
        }

        try {
            if (!this._displayConfig || !this._presentation) {
                _warn('Skipping Quick Settings indicator; backend init incomplete');
            } else {
                this._indicator = new DisplaysIndicator(
                    this,
                    this._displayConfig,
                    this._presentation
                );
                Main.panel.statusArea.quickSettings.addExternalIndicator(
                    this._indicator
                );
            }
        } catch (e) {
            _warn('Failed to add Quick Settings indicator', e);
        }

        if (this._presentation) {
            this._presentation.restoreIfNeeded().catch(e =>
                _warn('restoreIfNeeded failed', e));
        }
    }

    disable() {
        try {
            if (this._presentation)
                this._presentation.destroy();
        } catch (e) {
            _warn('PresentationMode destroy failed', e);
        }
        this._presentation = null;

        try {
            if (this._displayConfig)
                this._displayConfig.destroy();
        } catch (e) {
            _warn('DisplayConfig destroy failed', e);
        }
        this._displayConfig = null;

        try {
            if (this._indicator)
                this._indicator.destroy();
        } catch (e) {
            _warn('Indicator destroy failed', e);
        }
        this._indicator = null;
    }
}
