import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

export const CAST_BUS_NAME = 'org.cast.tools.Cast1';
export const CAST_OBJECT_PATH = '/org/cast/tools/Cast1';
export const CAST_IFACE = 'org.cast.tools.Cast1';

export const REQUIRED_API_VERSION = 2;

/** Short, because every method on API v2 returns immediately. */
const CALL_TIMEOUT_MS = 5000;

const CAST_XML = `
<node>
  <interface name="org.cast.tools.Cast1">
    <property name="ApiVersion"   type="u"      access="read"/>
    <property name="State"        type="s"      access="read"/>
    <property name="LastError"    type="s"      access="read"/>
    <property name="Devices"      type="aa{sv}" access="read"/>
    <property name="Sessions"     type="aa{sv}" access="read"/>
    <property name="Streams"      type="aa{sv}" access="read"/>
    <property name="Capabilities" type="a{sv}"  access="read"/>
    <method name="Refresh"/>
    <method name="StartCast">
      <arg name="device_ids" type="as"    direction="in"/>
      <arg name="options"    type="a{sv}" direction="in"/>
      <arg name="stream_id"  type="s"     direction="out"/>
    </method>
    <method name="AddDevices">
      <arg name="stream_id"  type="s"  direction="in"/>
      <arg name="device_ids" type="as" direction="in"/>
    </method>
    <method name="RemoveDevice">
      <arg name="device_id" type="s" direction="in"/>
    </method>
    <method name="StopStream">
      <arg name="stream_id" type="s" direction="in"/>
    </method>
    <method name="StopAll"/>
    <method name="OpenMiracast"/>
    <signal name="Error">
      <arg name="scope"   type="s"/>
      <arg name="id"      type="s"/>
      <arg name="message" type="s"/>
    </signal>
  </interface>
</node>`;

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

/** a{sv} → a plain object, so callers never touch GLib.Variant. */
function unpackDict(variant) {
    const out = {};
    if (!variant)
        return out;
    const dict = variant.deep_unpack();
    for (const key in dict) {
        const value = dict[key];
        out[key] = value instanceof GLib.Variant ? value.deep_unpack() : value;
    }
    return out;
}

function unpackDictArray(variant) {
    if (!variant)
        return [];
    const result = [];
    const count = variant.n_children();
    for (let i = 0; i < count; i++)
        result.push(unpackDict(variant.get_child_value(i)));
    return result;
}

/**
 * Session-bus client for the cast helper, API v2.
 *
 * Reads state from the proxy's *cached* properties and reacts to
 * `g-properties-changed`. It never polls and it never asks the helper a
 * question it could have answered from the cache which is what made the
 * old client re-list devices on every menu open.
 */
export const CastClient = GObject.registerClass({
    Signals: {
        'changed': {},
        'availability-changed': {},
        'helper-error': {param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_STRING]},
    },
}, class CastClient extends GObject.Object {
    _init() {
        super._init();

        this._proxy = null;
        this._destroyed = false;
        this._available = false;
        this._propsChangedId = 0;
        this._signalId = 0;

        this._nameWatchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            CAST_BUS_NAME,
            Gio.BusNameWatcherFlags.AUTO_START,
            () => this._connect(),
            () => this._onVanished()
        );
    }

    // -- availability ------------------------------------------------------

    get available() {
        return this._available && !!this._proxy;
    }

    get apiVersion() {
        if (!this._proxy)
            return 0;
        const variant = this._proxy.get_cached_property('ApiVersion');
        return variant ? variant.deep_unpack() : 0;
    }

    /** True when a helper is present but too old to talk to. */
    get outdated() {
        return this.available && this.apiVersion < REQUIRED_API_VERSION;
    }

    get outdatedMessage() {
        return 'Helper outdated: run ./install.sh';
    }

    _connect() {
        if (this._destroyed || this._proxy)
            return;

        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(CAST_XML);
        Gio.DBusProxy.new(
            Gio.DBus.session,
            Gio.DBusProxyFlags.NONE,
            nodeInfo.interfaces[0],
            CAST_BUS_NAME,
            CAST_OBJECT_PATH,
            CAST_IFACE,
            null,
            (_source, result) => {
                if (this._destroyed)
                    return;
                try {
                    this._proxy = Gio.DBusProxy.new_finish(result);
                } catch (e) {
                    _warn('Could not reach the cast helper', e);
                    this._available = false;
                    this.emit('availability-changed');
                    return;
                }

                this._proxy.set_default_timeout(CALL_TIMEOUT_MS);
                this._propsChangedId = this._proxy.connect(
                    'g-properties-changed', () => this.emit('changed'));
                this._signalId = this._proxy.connect(
                    'g-signal', (_p, _sender, name, params) => {
                        if (name !== 'Error')
                            return;
                        const [scope, id, message] = params.deep_unpack();
                        this.emit('helper-error', scope, id, message);
                    });

                this._available = true;
                if (this.outdated)
                    _warn(`${this.outdatedMessage} (API v${this.apiVersion})`);
                this.emit('availability-changed');
                this.emit('changed');
            }
        );
    }

    _onVanished() {
        this._teardownProxy();
        this._available = false;
        if (!this._destroyed) {
            this.emit('availability-changed');
            this.emit('changed');
        }
    }

    _teardownProxy() {
        if (!this._proxy)
            return;
        if (this._propsChangedId) {
            this._proxy.disconnect(this._propsChangedId);
            this._propsChangedId = 0;
        }
        if (this._signalId) {
            this._proxy.disconnect(this._signalId);
            this._signalId = 0;
        }
        this._proxy = null;
    }

    // -- state (all from the cache, no round trips) ------------------------

    _cachedString(name, fallback = '') {
        if (!this._proxy)
            return fallback;
        const variant = this._proxy.get_cached_property(name);
        return variant ? variant.deep_unpack() : fallback;
    }

    get state() {
        return this.available ? this._cachedString('State', 'idle') : 'unavailable';
    }

    get lastError() {
        return this._cachedString('LastError');
    }

    get devices() {
        if (!this._proxy)
            return [];
        return unpackDictArray(this._proxy.get_cached_property('Devices'));
    }

    get sessions() {
        if (!this._proxy)
            return [];
        return unpackDictArray(this._proxy.get_cached_property('Sessions'));
    }

    get streams() {
        if (!this._proxy)
            return [];
        return unpackDictArray(this._proxy.get_cached_property('Streams'));
    }

    get capabilities() {
        if (!this._proxy)
            return {};
        return unpackDict(this._proxy.get_cached_property('Capabilities'));
    }

    get isStreaming() {
        return this.state === 'streaming';
    }

    get isBusy() {
        return this.state === 'starting' || this.state === 'stopping';
    }

    get activeStream() {
        return this.streams.length ? this.streams[0] : null;
    }

    get videoDevices() {
        return this.devices.filter(d => d.video_capable !== false);
    }

    // -- calls -------------------------------------------------------------

    _call(method, params, replyType) {
        return new Promise((resolve, reject) => {
            if (!this._proxy) {
                reject(new Error('The cast helper is not running'));
                return;
            }
            this._proxy.call(
                method,
                params,
                Gio.DBusCallFlags.NONE,
                CALL_TIMEOUT_MS,
                null,
                (proxy, result) => {
                    try {
                        const reply = proxy.call_finish(result);
                        resolve(replyType ? reply.deep_unpack() : null);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    refresh() {
        return this._call('Refresh', null);
    }

    /**
     * @param {string[]} deviceIds devices to cast to
     * @param {object} options mode, format, audio, max_height, fps, bitrate_kbps
     * @returns {Promise<string>} the new stream id
     */
    async startCast(deviceIds, options = {}) {
        const packed = {};
        for (const [key, value] of Object.entries(options)) {
            if (typeof value === 'boolean') {
                packed[key] = GLib.Variant.new_boolean(value);
            } else if (typeof value === 'number') {
                // Signed: audio_delay_ms is legitimately negative and
                // packing that as uint32 would wrap it into a huge delay.
                packed[key] = Number.isInteger(value) && value < 0
                    ? GLib.Variant.new_int32(value)
                    : GLib.Variant.new_uint32(value);
            } else {
                packed[key] = GLib.Variant.new_string(String(value));
            }
        }
        const reply = await this._call(
            'StartCast',
            new GLib.Variant('(asa{sv})', [deviceIds, packed]),
            true
        );
        return reply ? reply[0] : '';
    }

    addDevices(streamId, deviceIds) {
        return this._call('AddDevices', new GLib.Variant('(sas)', [streamId, deviceIds]));
    }

    removeDevice(deviceId) {
        return this._call('RemoveDevice', new GLib.Variant('(s)', [deviceId]));
    }

    stopStream(streamId) {
        return this._call('StopStream', new GLib.Variant('(s)', [streamId]));
    }

    stopAll() {
        return this._call('StopAll', null);
    }

    openMiracast() {
        return this._call('OpenMiracast', null);
    }

    /**
     * Stop everything, synchronously. Only for `disable()` teardown, which
     * cannot await and only used when the user is really ending the
     * session, never on a lock screen.
     */
    stopAllSync() {
        if (!this._proxy)
            return;
        try {
            Gio.DBus.session.call_sync(
                CAST_BUS_NAME, CAST_OBJECT_PATH, CAST_IFACE, 'StopAll',
                null, null, Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, null
            );
        } catch (e) {
            _warn('Synchronous StopAll failed', e);
        }
    }

    destroy() {
        this._destroyed = true;
        this._teardownProxy();
        if (this._nameWatchId) {
            Gio.bus_unwatch_name(this._nameWatchId);
            this._nameWatchId = 0;
        }
        this._available = false;
    }
});
