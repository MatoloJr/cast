import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SESSION_BUS = 'org.gnome.SessionManager';
const SESSION_PATH = '/org/gnome/SessionManager';
const SESSION_IFACE = 'org.gnome.SessionManager';

/** Inhibit suspend (4) and idle/blank (8). */
const INHIBIT_FLAGS = 4 | 8;

const APP_ID = 'display-and-cast@cast.tools';

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

export class PresentationMode {
    /**
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension
     */
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._notifSettings = null;
        this._cookie = null;
        this._savedShowBanners = undefined;
        this._enabled = false;
        this._listeners = new Set();

        try {
            this._notifSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.notifications',
            });
        } catch (e) {
            _warn('Failed to open notifications settings', e);
        }
    }

    get enabled() {
        return this._enabled;
    }

    connectChanged(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    _emitChanged() {
        for (const cb of this._listeners) {
            try {
                cb(this._enabled);
            } catch (e) {
                _warn('PresentationMode listener failed', e);
            }
        }
    }

    /**
     * Restore presentation mode if it was left on across a Shell restart.
     */
    async restoreIfNeeded() {
        try {
            if (this._settings.get_boolean('presentation-mode'))
                await this.enable();
        } catch (e) {
            _warn('Failed to restore presentation mode', e);
        }
    }

    async setEnabled(enabled) {
        if (enabled)
            return this.enable();
        return this.disable();
    }

    async enable() {
        if (this._enabled)
            return true;

        try {
            if (this._notifSettings) {
                this._savedShowBanners =
                    this._notifSettings.get_boolean('show-banners');
                this._notifSettings.set_boolean('show-banners', false);
            }

            this._cookie = await this._inhibit();
            this._enabled = true;
            try {
                this._settings.set_boolean('presentation-mode', true);
            } catch (e) {
                _warn('Failed to persist presentation-mode setting', e);
            }
            this._emitChanged();
            return true;
        } catch (e) {
            _warn('Failed to enable presentation mode', e);
            try {
                await this._uninhibit();
            } catch (_) { /* ignore */ }
            try {
                if (this._notifSettings && this._savedShowBanners !== undefined)
                    this._notifSettings.set_boolean('show-banners', this._savedShowBanners);
            } catch (_) { /* ignore */ }
            this._savedShowBanners = undefined;
            this._enabled = false;
            return false;
        }
    }

    async disable() {
        try {
            await this._uninhibit();
        } catch (e) {
            _warn('Uninhibit failed', e);
        }

        try {
            if (this._notifSettings && this._savedShowBanners !== undefined)
                this._notifSettings.set_boolean('show-banners', this._savedShowBanners);
        } catch (e) {
            _warn('Failed to restore show-banners', e);
        }
        this._savedShowBanners = undefined;

        const wasEnabled = this._enabled;
        this._enabled = false;

        try {
            this._settings.set_boolean('presentation-mode', false);
        } catch (e) {
            _warn('Failed to clear presentation-mode setting', e);
        }

        if (wasEnabled)
            this._emitChanged();

        return true;
    }

    _inhibit() {
        return new Promise((resolve, reject) => {
            try {
                Gio.DBus.session.call(
                    SESSION_BUS,
                    SESSION_PATH,
                    SESSION_IFACE,
                    'Inhibit',
                    new GLib.Variant('(susu)', [
                        APP_ID,
                        0,
                        'Presentation mode',
                        INHIBIT_FLAGS,
                    ]),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (connection, result) => {
                        try {
                            const reply = connection.call_finish(result);
                            const [cookie] = reply.deep_unpack();
                            resolve(cookie);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            } catch (e) {
                reject(e);
            }
        });
    }

    _uninhibit() {
        if (this._cookie === null || this._cookie === undefined)
            return Promise.resolve();

        const cookie = this._cookie;
        this._cookie = null;

        return new Promise((resolve, reject) => {
            try {
                Gio.DBus.session.call(
                    SESSION_BUS,
                    SESSION_PATH,
                    SESSION_IFACE,
                    'Uninhibit',
                    new GLib.Variant('(u)', [cookie]),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (connection, result) => {
                        try {
                            connection.call_finish(result);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            } catch (e) {
                reject(e);
            }
        });
    }

    destroy() {
        this._listeners.clear();
        if (this._cookie !== null && this._cookie !== undefined) {
            try {
                Gio.DBus.session.call_sync(
                    SESSION_BUS,
                    SESSION_PATH,
                    SESSION_IFACE,
                    'Uninhibit',
                    new GLib.Variant('(u)', [this._cookie]),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null
                );
            } catch (e) {
                _warn('Sync Uninhibit failed', e);
            }
            this._cookie = null;
        }

        try {
            if (this._notifSettings && this._savedShowBanners !== undefined)
                this._notifSettings.set_boolean('show-banners', this._savedShowBanners);
        } catch (e) {
            _warn('Failed to restore show-banners on destroy', e);
        }
        this._savedShowBanners = undefined;
        this._enabled = false;
        // Keep presentation-mode GSettings so enable() can restore after a
        // Shell reload. Only the user toggle clears that key.

        this._notifSettings = null;
        this._settings = null;
        this._extension = null;
    }
}
