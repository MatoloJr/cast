import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const CAST_BUS_NAME = 'org.cast.tools.Cast1';
export const CAST_OBJECT_PATH = '/org/cast/tools/Cast1';
export const CAST_IFACE = 'org.cast.tools.Cast1';

const CAST_XML = `
<node>
  <interface name="org.cast.tools.Cast1">
    <method name="ListDevices">
      <arg type="a(ssssb)" direction="out" name="devices"/>
    </method>
    <method name="Refresh"/>
    <method name="HasMiracastSupport">
      <arg type="b" direction="out" name="available"/>
    </method>
    <method name="CastDesktop">
      <arg type="s" direction="in" name="device_id"/>
      <arg type="s" direction="in" name="source"/>
    </method>
    <method name="CastDevices">
      <arg type="as" direction="in" name="device_ids"/>
      <arg type="s" direction="in" name="source"/>
    </method>
    <method name="DisconnectDevice">
      <arg type="s" direction="in" name="device_id"/>
    </method>
    <method name="Stop"/>
    <method name="GetStatus">
      <arg type="(ssss)" direction="out" name="status"/>
    </method>
    <method name="ListSessions">
      <arg type="a(sss)" direction="out" name="sessions"/>
    </method>
    <signal name="DevicesChanged"/>
    <signal name="SessionChanged">
      <arg type="(ssss)" name="status"/>
    </signal>
  </interface>
</node>`;

const CastProxy = Gio.DBusProxy.makeProxyWrapper(CAST_XML);

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

/**
 * Session-bus client for the cast-helper service.
 */
export class CastService {
    constructor() {
        this._proxy = null;
        this._destroyed = false;
        this._nameWatch = 0;
        this._available = false;
        this._availabilityListeners = new Set();
        this._devicesListeners = new Set();
        this._sessionListeners = new Set();
        this._devicesChangedId = 0;
        this._sessionChangedId = 0;

        this._nameWatch = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            CAST_BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._onNameAppeared(),
            () => this._onNameVanished()
        );

        this._tryConnect();
        this.ensureStarted().catch(e =>
            _warn('ensureStarted failed', e));
    }

    get available() {
        return this._available && !!this._proxy;
    }

    connectAvailability(callback) {
        this._availabilityListeners.add(callback);
        return () => this._availabilityListeners.delete(callback);
    }

    connectDevicesChanged(callback) {
        this._devicesListeners.add(callback);
        return () => this._devicesListeners.delete(callback);
    }

    connectSessionChanged(callback) {
        this._sessionListeners.add(callback);
        return () => this._sessionListeners.delete(callback);
    }

    _emitAvailability() {
        for (const cb of this._availabilityListeners) {
            try {
                cb(this.available);
            } catch (e) {
                _warn('availability listener failed', e);
            }
        }
    }

    _onNameAppeared() {
        this._tryConnect();
    }

    _onNameVanished() {
        this._disconnectProxySignals();
        this._proxy = null;
        this._available = false;
        this._emitAvailability();
    }

    _tryConnect() {
        if (this._destroyed)
            return;

        try {
            this._disconnectProxySignals();
            this._proxy = new CastProxy(
                Gio.DBus.session,
                CAST_BUS_NAME,
                CAST_OBJECT_PATH,
                (proxy, error) => {
                    if (this._destroyed)
                        return;
                    if (error) {
                        this._proxy = null;
                        this._available = false;
                        this._emitAvailability();
                        return;
                    }
                    this._proxy = proxy;
                    this._available = true;
                    this._devicesChangedId = proxy.connectSignal(
                        'DevicesChanged',
                        () => {
                            for (const cb of this._devicesListeners) {
                                try {
                                    cb();
                                } catch (e) {
                                    _warn('DevicesChanged listener failed', e);
                                }
                            }
                        }
                    );
                    this._sessionChangedId = proxy.connectSignal(
                        'SessionChanged',
                        (_p, _sender, params) => {
                            let status = ['idle', '', '', ''];
                            try {
                                const unpacked = params?.deep_unpack?.() ?? params;
                                status = Array.isArray(unpacked?.[0])
                                    ? unpacked[0]
                                    : (unpacked ?? status);
                            } catch (e) {
                                _warn('Failed to unpack SessionChanged', e);
                            }
                            for (const cb of this._sessionListeners) {
                                try {
                                    cb(this._normalizeStatus(status));
                                } catch (e) {
                                    _warn('SessionChanged listener failed', e);
                                }
                            }
                        }
                    );
                    this._emitAvailability();
                }
            );
        } catch (e) {
            _warn('Failed to create Cast proxy', e);
            this._proxy = null;
            this._available = false;
            this._emitAvailability();
        }
    }

    _disconnectProxySignals() {
        if (!this._proxy)
            return;
        try {
            if (this._devicesChangedId)
                this._proxy.disconnectSignal(this._devicesChangedId);
        } catch (_) { /* ignore */ }
        try {
            if (this._sessionChangedId)
                this._proxy.disconnectSignal(this._sessionChangedId);
        } catch (_) { /* ignore */ }
        this._devicesChangedId = 0;
        this._sessionChangedId = 0;
    }

    _normalizeStatus(raw) {
        return {
            state: raw?.[0] ?? 'idle',
            deviceId: raw?.[1] ?? '',
            deviceName: raw?.[2] ?? '',
            error: raw?.[3] ?? '',
        };
    }

    async ensureStarted() {
        if (this._destroyed)
            return false;
        if (this.available)
            return true;

        try {
            await this._startServiceByName();
        } catch (e) {
            _warn('StartServiceByName failed (helper may not be installed)', e);
        }

        for (let i = 0; i < 20; i++) {
            if (this.available)
                return true;
            await this._sleep(100);
        }
        return this.available;
    }

    _startServiceByName() {
        return new Promise((resolve, reject) => {
            try {
                Gio.DBus.session.call(
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    'StartServiceByName',
                    new GLib.Variant('(su)', [CAST_BUS_NAME, 0]),
                    null,
                    Gio.DBusCallFlags.NONE,
                    5000,
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

    _sleep(ms) {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _call(method, args = null, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            if (!this._proxy) {
                reject(new Error('Cast helper is not available'));
                return;
            }
            try {
                this._proxy.call(
                    method,
                    args,
                    Gio.DBusCallFlags.NONE,
                    timeoutMs,
                    null,
                    (proxy, result) => {
                        try {
                            const reply = proxy.call_finish(result);
                            resolve(reply);
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

    async listDevices() {
        const reply = await this._call('ListDevices', null, 15000);
        const [devices] = reply.deep_unpack();
        return (devices || []).map(([id, name, model, protocol, online]) => ({
            id,
            name,
            model,
            protocol: protocol || 'chromecast',
            online: !!online,
        }));
    }

    async refresh() {
        await this._call('Refresh', null, 20000);
    }

    async hasMiracastSupport() {
        try {
            const reply = await this._call('HasMiracastSupport', null, 5000);
            const [ok] = reply.deep_unpack();
            return !!ok;
        } catch (_) {
            return false;
        }
    }

    async castDesktop(deviceId, source = 'primary') {
        await this._call(
            'CastDesktop',
            new GLib.Variant('(ss)', [deviceId, source]),
            120000
        );
    }

    async castDevices(deviceIds, source = 'primary') {
        const ids = Array.isArray(deviceIds) ? deviceIds.map(String) : [];
        await this._call(
            'CastDevices',
            new GLib.Variant('(ass)', [ids, source]),
            120000
        );
    }

    async disconnectDevice(deviceId) {
        await this._call(
            'DisconnectDevice',
            new GLib.Variant('(s)', [String(deviceId)]),
            30000
        );
    }

    async stop() {
        await this._call('Stop', null, 30000);
    }

    async getStatus() {
        const reply = await this._call('GetStatus', null, 5000);
        const [status] = reply.deep_unpack();
        return this._normalizeStatus(status);
    }

    async listSessions() {
        const reply = await this._call('ListSessions', null, 5000);
        const [sessions] = reply.deep_unpack();
        return (sessions || []).map(([id, name, state]) => ({
            id,
            name,
            state: state || 'casting',
        }));
    }

    destroy() {
        this._destroyed = true;
        this._availabilityListeners.clear();
        this._devicesListeners.clear();
        this._sessionListeners.clear();
        this._disconnectProxySignals();
        if (this._nameWatch) {
            try {
                Gio.bus_unwatch_name(this._nameWatch);
            } catch (_) { /* ignore */ }
            this._nameWatch = 0;
        }
        this._proxy = null;
        this._available = false;
    }
}
