import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Layout from './layout.js';

const BUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const OBJECT_PATH = '/org/gnome/Mutter/DisplayConfig';
const IFACE = 'org.gnome.Mutter.DisplayConfig';

/** ApplyMonitorsConfig methods, from Mutter's own enum. */
export const ApplyMethod = {
    VERIFY: 0,
    TEMPORARY: 1,
    PERSISTENT: 2,
};

const DISPLAY_CONFIG_XML = `
<node>
  <interface name="org.gnome.Mutter.DisplayConfig">
    <method name="GetCurrentState">
      <arg type="u" direction="out" name="serial"/>
      <arg type="a((ssss)a(siiddada{sv})a{sv})" direction="out" name="monitors"/>
      <arg type="a(iiduba(ssss)a{sv})" direction="out" name="logical_monitors"/>
      <arg type="a{sv}" direction="out" name="properties"/>
    </method>
    <method name="ApplyMonitorsConfig">
      <arg type="u" direction="in" name="serial"/>
      <arg type="u" direction="in" name="method"/>
      <arg type="a(iiduba(ssa{sv}))" direction="in" name="logical_monitors"/>
      <arg type="a{sv}" direction="in" name="properties"/>
    </method>
    <signal name="MonitorsChanged"/>
  </interface>
</node>`;

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

function _unpack(value) {
    return value instanceof GLib.Variant ? value.deep_unpack() : value;
}

function _prop(props, key, fallback = null) {
    const value = _unpack(props?.[key]);
    return value === undefined || value === null ? fallback : value;
}

/** Mutter's monitor tuple → the shape lib/layout.js expects. */
function parseMonitor(raw) {
    const [spec, modes, propsRaw] = raw;
    const [connector, vendor, product, serial] = spec;
    const props = _unpack(propsRaw) ?? {};

    return {
        connector,
        vendor,
        product,
        serial,
        displayName: _prop(props, 'display-name', connector),
        isBuiltin: !!_prop(props, 'is-builtin', false),
        modes: modes.map(mode => {
            const [id, width, height, refresh, preferredScale,
                supportedScales, modePropsRaw] = mode;
            const modeProps = _unpack(modePropsRaw) ?? {};
            return {
                id,
                width,
                height,
                refresh,
                preferredScale,
                supportedScales,
                isCurrent: !!_prop(modeProps, 'is-current', false),
                isPreferred: !!_prop(modeProps, 'is-preferred', false),
            };
        }),
    };
}

function parseLogicalMonitor(raw) {
    const [x, y, scale, transform, primary, monitors] = raw;
    return {
        x,
        y,
        scale,
        transform,
        primary,
        monitors: monitors.map(spec => spec[0]),
    };
}

/**
 * Client for org.gnome.Mutter.DisplayConfig.
 *
 * All layout arithmetic lives in lib/layout.js, which has no GObject
 * imports and is unit-tested against recorded fixtures. This class only
 * talks to Mutter.
 */
export class DisplayConfig {
    constructor() {
        this._proxy = null;
        this._changedId = 0;
        this._changedCallbacks = new Set();
        this._initProxy();
    }

    _initProxy() {
        try {
            const nodeInfo = Gio.DBusNodeInfo.new_for_xml(DISPLAY_CONFIG_XML);
            // Gio.DBusProxy wants a Gio.DBusConnection. The previous code
            // passed Gio.BusType.SESSION, a plain number, so construction
            // always threw "Wrong type number; object GDBusConnection
            // expected" and every layout action was silently a no-op which
            // is the real reason Mirror/Extend/Main-only did nothing (G1).
            this._proxy = Gio.DBusProxy.new_sync(
                Gio.DBus.session,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                nodeInfo.interfaces[0],
                BUS_NAME,
                OBJECT_PATH,
                IFACE,
                null
            );
            this._changedId = this._proxy.connect('g-signal',
                (_proxy, _sender, signalName) => {
                    if (signalName !== 'MonitorsChanged')
                        return;
                    for (const callback of this._changedCallbacks) {
                        try {
                            callback();
                        } catch (e) {
                            _warn('MonitorsChanged callback failed', e);
                        }
                    }
                });
        } catch (e) {
            _warn('Failed to create the DisplayConfig proxy', e);
            this._proxy = null;
        }
    }

    get available() {
        return !!this._proxy;
    }

    destroy() {
        this._changedCallbacks.clear();
        if (this._proxy && this._changedId) {
            try {
                this._proxy.disconnect(this._changedId);
            } catch (e) {
                _warn('Failed to disconnect MonitorsChanged', e);
            }
        }
        this._changedId = 0;
        this._proxy = null;
    }

    connectMonitorsChanged(callback) {
        this._changedCallbacks.add(callback);
        return () => this._changedCallbacks.delete(callback);
    }

    _call(method, params, replyType, timeout = 5000) {
        return new Promise((resolve, reject) => {
            if (!this._proxy) {
                reject(new Error('DisplayConfig is unavailable'));
                return;
            }
            this._proxy.call(method, params, Gio.DBusCallFlags.NONE, timeout, null,
                (proxy, result) => {
                    try {
                        const reply = proxy.call_finish(result);
                        resolve(replyType ? reply.deep_unpack() : null);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    /**
     * The current monitor layout.
     *
     * @returns {Promise<object>} serial, monitors, logicalMonitors, layoutMode
     */
    async getCurrentState() {
        const [serial, monitorsRaw, logicalRaw, propsRaw] =
            await this._call('GetCurrentState', null, true, 5000);
        const props = _unpack(propsRaw) ?? {};
        return {
            serial,
            monitors: (monitorsRaw ?? []).map(parseMonitor),
            logicalMonitors: (logicalRaw ?? []).map(parseLogicalMonitor),
            layoutMode: _prop(props, 'layout-mode', Layout.LayoutMode.LOGICAL),
            supportsChangingLayoutMode:
                !!_prop(props, 'supports-changing-layout-mode', false),
        };
    }

    /**
     * Send a layout to Mutter.
     *
     * @param {object[]} entries apply entries from lib/layout.js
     * @param {object} options serial and method
     * @param {number} [options.serial] the serial the entries were built from
     * @param {number} [options.method] one of ApplyMethod
     * @returns {Promise<void>} resolves when Mutter accepted the layout
     */
    async apply(entries, {serial, method = ApplyMethod.TEMPORARY} = {}) {
        const useSerial = serial ?? (await this.getCurrentState()).serial;
        await this._call(
            'ApplyMonitorsConfig',
            new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
                [useSerial, method, entries, {}]),
            false,
            10000
        );
    }

    /** Physical monitors, excluding anything the portal conjured up. */
    static physicalMonitors(monitors, virtualConnectors = []) {
        const virtual = new Set(virtualConnectors);
        return monitors.filter(m => !virtual.has(m.connector));
    }
}

export {Layout};
