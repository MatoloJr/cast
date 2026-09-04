import GObject from 'gi://GObject';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {DisplayConfig} from './lib/displayConfig.js';
import {PresentationMode} from './lib/presentationMode.js';
import {CastService} from './lib/castService.js';
import {CastDisplayMenuToggle} from './ui/castDisplayMenu.js';

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

const CastDisplayIndicator = GObject.registerClass(
class CastDisplayIndicator extends QuickSettings.SystemIndicator {
    _init(extension, displayConfig, presentationMode, castService) {
        super._init();

        // No persistent top-bar icon; Quick Settings tile only.
        const icon = this._addIndicator();
        icon.visible = false;

        this._menuToggle = new CastDisplayMenuToggle(
            extension,
            displayConfig,
            presentationMode,
            castService
        );
        this.quickSettingsItems.push(this._menuToggle);
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
        this._castService = null;
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
            this._castService = new CastService();
        } catch (e) {
            _warn('Failed to init CastService', e);
        }

        try {
            if (!this._displayConfig || !this._presentation || !this._castService) {
                _warn('Skipping Quick Settings indicator; backend init incomplete');
            } else {
                this._indicator = new CastDisplayIndicator(
                    this,
                    this._displayConfig,
                    this._presentation,
                    this._castService
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
            if (this._castService?.available)
                this._castService.stop().catch(() => {});
        } catch (e) {
            _warn('Stop cast on disable failed', e);
        }

        try {
            if (this._indicator)
                this._indicator.destroy();
        } catch (e) {
            _warn('Indicator destroy failed', e);
        }
        this._indicator = null;

        try {
            if (this._castService)
                this._castService.destroy();
        } catch (e) {
            _warn('CastService destroy failed', e);
        }
        this._castService = null;

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
    }
}
