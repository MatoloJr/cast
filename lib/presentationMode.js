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
        this._inhibitUnavailable = false;
        this._enabling = null;
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

    // There is deliberately no restoreIfNeeded(). The old code persisted
    // `presentation-mode` and replayed it on enable(), but `_castOwnedPresentation`
    // was not persisted with it, so after a screen lock the banners stayed
    // switched off with nothing left to switch them back on (gap G4).
    // Presentation state is now derived from the helper's State on every
    // sync, so there is nothing to restore and nothing to get stuck.

    /**
     * Idempotent: called on every state sync, so it must do nothing when
     * already in the requested state.
     *
     * @param {boolean} enabled whether presentation mode should be on
     * @returns {Promise<boolean>} whether the state is now as requested
     */
    async setEnabled(enabled) {
        if (enabled === this._enabled)
            return true;
        if (enabled)
            return this.enable();
        return this.disable();
    }

    async enable() {
        if (this._enabled)
            return true;
        // `enable()` awaits, so two syncs arriving close together both get
        // past the check above and both try to inhibit. Share one in-flight
        // attempt instead.
        if (this._enabling)
            return this._enabling;
        this._enabling = this._doEnable();
        try {
            return await this._enabling;
        } finally {
            this._enabling = null;
        }
    }

    async _doEnable() {
        // Hiding banners and inhibiting idle are independent. Treating them
        // as one unit meant a session without org.gnome.SessionManager made
        // enable() fail, leave _enabled false and get retried and logged  
        // on every single state sync.
        try {
            if (this._notifSettings) {
                this._savedShowBanners =
                    this._notifSettings.get_boolean('show-banners');
                this._notifSettings.set_boolean('show-banners', false);
            }
        } catch (e) {
            _warn('Could not hide notification banners', e);
        }

        if (!this._inhibitUnavailable) {
            try {
                this._cookie = await this._inhibit();
            } catch (e) {
                // Log once, then stop trying for the rest of this session.
                this._inhibitUnavailable = true;
                _warn('Keeping the screen awake is unavailable; ' +
                      'presentation mode will only hide notifications', e);
            }
        }

        this._enabled = true;
        this._emitChanged();
        return true;
    }

    /** True when banners are hidden but idle could not be inhibited. */
    get degraded() {
        return this._enabled && this._inhibitUnavailable;
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
        this._notifSettings = null;
        this._settings = null;
        this._extension = null;
    }
}
