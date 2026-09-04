import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const OBJECT_PATH = '/org/gnome/Mutter/DisplayConfig';

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

const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DISPLAY_CONFIG_XML);

function _log(message) {
    console.debug(`[display-and-cast] ${message}`);
}

function _warn(message, error) {
    if (error)
        console.warn(`[display-and-cast] ${message}: ${error}`);
    else
        console.warn(`[display-and-cast] ${message}`);
}

function _variantToObject(variant) {
    if (variant === null || variant === undefined)
        return {};
    if (variant instanceof GLib.Variant)
        return variant.deep_unpack();
    return variant;
}

function _propBool(props, key, fallback = false) {
    const value = props?.[key];
    if (value === undefined || value === null)
        return fallback;
    if (typeof value === 'boolean')
        return value;
    if (value instanceof GLib.Variant)
        return value.deep_unpack();
    return Boolean(value);
}

function _propNumber(props, key, fallback = null) {
    const value = props?.[key];
    if (value === undefined || value === null)
        return fallback;
    if (typeof value === 'number')
        return value;
    if (value instanceof GLib.Variant)
        return value.deep_unpack();
    return fallback;
}

function _groupLetter(index) {
    return String.fromCharCode('A'.charCodeAt(0) + (index % 26));
}

function _parseMonitor(raw, logicalMonitors) {
    const [spec, modes, propsRaw] = raw;
    const [connector, vendor, product, serial] = spec;
    const props = _variantToObject(propsRaw) || {};

    let currentMode = null;
    let preferredMode = null;
    for (const mode of modes) {
        const [id, width, height, refreshRate, preferredScale, supportedScales, modePropsRaw] = mode;
        const modeProps = _variantToObject(modePropsRaw) || {};
        const parsed = {
            id,
            width,
            height,
            refreshRate,
            preferredScale,
            supportedScales,
            isCurrent: _propBool(modeProps, 'is-current'),
            isPreferred: _propBool(modeProps, 'is-preferred'),
        };
        if (parsed.isCurrent)
            currentMode = parsed;
        if (parsed.isPreferred)
            preferredMode = parsed;
    }

    const mode = currentMode || preferredMode || (modes.length
        ? {
            id: modes[0][0],
            width: modes[0][1],
            height: modes[0][2],
            refreshRate: modes[0][3],
            preferredScale: modes[0][4],
            supportedScales: modes[0][5],
            isCurrent: false,
            isPreferred: false,
        }
        : null);

    let scale = 1.0;
    let isPrimary = false;
    let logicalX = 0;
    let logicalY = 0;
    for (const lm of logicalMonitors) {
        const [x, y, lmScale, , primary, monitors] = lm;
        for (const m of monitors) {
            if (m[0] === connector) {
                scale = lmScale || 1.0;
                isPrimary = primary;
                logicalX = x;
                logicalY = y;
                break;
            }
        }
    }

    let displayName = props['display-name'];
    if (displayName instanceof GLib.Variant)
        displayName = displayName.deep_unpack();

    return {
        connector,
        vendor,
        product,
        serial,
        displayName: displayName || connector,
        isBuiltin: _propBool(props, 'is-builtin'),
        mode,
        scale,
        isPrimary,
        logicalX,
        logicalY,
        properties: props,
    };
}

export class DisplayConfig {
    constructor() {
        this._proxy = null;
        this._changedId = 0;
        this._changedCallbacks = new Set();
        this._initProxy();
    }

    _initProxy() {
        try {
            this._proxy = new DisplayConfigProxy(
                Gio.BusType.SESSION,
                BUS_NAME,
                OBJECT_PATH,
                (_proxy, error) => {
                    if (error)
                        _warn('DisplayConfig proxy init error', error);
                }
            );
            this._changedId = this._proxy.connectSignal('MonitorsChanged', () => {
                for (const cb of this._changedCallbacks) {
                    try {
                        cb();
                    } catch (e) {
                        _warn('MonitorsChanged callback failed', e);
                    }
                }
            });
        } catch (e) {
            _warn('Failed to create DisplayConfig proxy', e);
            this._proxy = null;
        }
    }

    destroy() {
        this._changedCallbacks.clear();
        if (this._proxy && this._changedId) {
            try {
                this._proxy.disconnectSignal(this._changedId);
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

    async getCurrentState() {
        if (!this._proxy)
            throw new Error('DisplayConfig proxy unavailable');

        try {
            const [serial, monitorsRaw, logicalMonitorsRaw, propertiesRaw] =
                await new Promise((resolve, reject) => {
                    try {
                        this._proxy.GetCurrentStateRemote((result, error) => {
                            if (error)
                                reject(error);
                            else
                                resolve(result);
                        });
                    } catch (e) {
                        reject(e);
                    }
                });

            const properties = _variantToObject(propertiesRaw) || {};
            const logicalMonitors = logicalMonitorsRaw || [];
            const monitors = (monitorsRaw || []).map(m =>
                _parseMonitor(m, logicalMonitors));

            return {
                serial,
                monitors,
                logicalMonitors,
                properties,
                layoutMode: _propNumber(properties, 'layout-mode', 1),
            };
        } catch (e) {
            _warn('GetCurrentState failed', e);
            throw e;
        }
    }

    async applyLogicalMonitors(logicalMonitors, {verify = true, method = ApplyMethod.TEMPORARY} = {}) {
        if (!this._proxy)
            return false;

        try {
            const state = await this.getCurrentState();
            const applyProps = {};
            if (state.layoutMode !== null && state.layoutMode !== undefined)
                applyProps['layout-mode'] = GLib.Variant.new_uint32(state.layoutMode);

            const applyRemote = (serial, applyMethod) => new Promise((resolve, reject) => {
                try {
                    this._proxy.ApplyMonitorsConfigRemote(
                        serial,
                        applyMethod,
                        logicalMonitors,
                        applyProps,
                        (_result, error) => {
                            if (error)
                                reject(error);
                            else
                                resolve();
                        }
                    );
                } catch (e) {
                    reject(e);
                }
            });

            if (verify) {
                try {
                    await applyRemote(state.serial, ApplyMethod.VERIFY);
                } catch (e) {
                    _warn('ApplyMonitorsConfig verify failed', e);
                    throw e;
                }
                const refreshed = await this.getCurrentState();
                await applyRemote(refreshed.serial, method);
            } else {
                await applyRemote(state.serial, method);
            }

            _log(`Applied layout with method=${method}`);
            return true;
        } catch (e) {
            _warn('applyLogicalMonitors failed', e);
            return false;
        }
    }

    _logicalWidth(monitor, layoutMode) {
        if (!monitor.mode)
            return 1920;
        const scale = monitor.scale || 1.0;
        if (layoutMode === 2)
            return monitor.mode.width;
        return Math.round(monitor.mode.width / scale);
    }

    _buildApplyEntry(monitor) {
        if (!monitor?.mode?.id)
            throw new Error(`No mode for monitor ${monitor?.connector ?? '?'}`);
        return [monitor.connector, monitor.mode.id, {}];
    }

    _pickMainMonitor(monitors, logicalMonitors) {
        const builtin = monitors.find(m => m.isBuiltin);
        if (builtin)
            return builtin;

        for (const lm of logicalMonitors) {
            if (lm[4]) {
                const connector = lm[5]?.[0]?.[0];
                const found = monitors.find(m => m.connector === connector);
                if (found)
                    return found;
            }
        }
        return monitors[0] ?? null;
    }

    _pickSecondaryMonitor(monitors, main) {
        return monitors.find(m => m.connector !== main?.connector) ?? null;
    }

    async buildExtend() {
        const state = await this.getCurrentState();
        const {monitors, logicalMonitors, layoutMode} = state;
        if (monitors.length === 0)
            return [];

        const main = this._pickMainMonitor(monitors, logicalMonitors);
        const ordered = [
            main,
            ...monitors.filter(m => m.connector !== main.connector),
        ];

        let x = 0;
        return ordered.map((monitor, index) => {
            const entry = [
                x,
                0,
                monitor.scale || 1.0,
                0,
                index === 0,
                [this._buildApplyEntry(monitor)],
            ];
            x += this._logicalWidth(monitor, layoutMode);
            return entry;
        });
    }

    async buildMirrorAll() {
        const state = await this.getCurrentState();
        const {monitors} = state;
        if (monitors.length === 0)
            return [];

        const main = this._pickMainMonitor(monitors, state.logicalMonitors);
        return [[
            0,
            0,
            main?.scale || 1.0,
            0,
            true,
            monitors.map(m => this._buildApplyEntry(m)),
        ]];
    }

    async buildMainOnly() {
        const state = await this.getCurrentState();
        const {monitors, logicalMonitors} = state;
        const main = this._pickMainMonitor(monitors, logicalMonitors);
        if (!main)
            return [];

        return [[
            0,
            0,
            main.scale || 1.0,
            0,
            true,
            [this._buildApplyEntry(main)],
        ]];
    }

    async buildSecondaryOnly() {
        const state = await this.getCurrentState();
        const {monitors, logicalMonitors} = state;
        const main = this._pickMainMonitor(monitors, logicalMonitors);
        const secondary = this._pickSecondaryMonitor(monitors, main);
        if (!secondary) {
            _warn('Secondary only: no secondary monitor found');
            return null;
        }

        return [[
            0,
            0,
            secondary.scale || 1.0,
            0,
            true,
            [this._buildApplyEntry(secondary)],
        ]];
    }

    async buildCustomGroups(groupMap) {
        const state = await this.getCurrentState();
        const {monitors, layoutMode} = state;
        if (monitors.length === 0)
            return [];

        const groups = new Map();
        for (const monitor of monitors) {
            const letter = groupMap[monitor.connector] || _groupLetter(0);
            if (!groups.has(letter))
                groups.set(letter, []);
            groups.get(letter).push(monitor);
        }

        const letters = [...groups.keys()].sort();
        let x = 0;
        const logical = [];

        for (let i = 0; i < letters.length; i++) {
            const members = groups.get(letters[i]);
            const representative = members[0];
            const scale = representative.scale || 1.0;
            logical.push([
                x,
                0,
                scale,
                0,
                i === 0,
                members.map(m => this._buildApplyEntry(m)),
            ]);
            x += this._logicalWidth(representative, layoutMode);
        }

        return logical;
    }

    async applyExtend() {
        const layout = await this.buildExtend();
        return this.applyLogicalMonitors(layout);
    }

    async applyMirrorAll() {
        const layout = await this.buildMirrorAll();
        return this.applyLogicalMonitors(layout);
    }

    async applyMainOnly() {
        const layout = await this.buildMainOnly();
        return this.applyLogicalMonitors(layout);
    }

    async applySecondaryOnly() {
        const layout = await this.buildSecondaryOnly();
        if (!layout)
            return false;
        return this.applyLogicalMonitors(layout);
    }

    async applyCustomGroups(groupMap) {
        const layout = await this.buildCustomGroups(groupMap);
        return this.applyLogicalMonitors(layout);
    }

    static defaultGroupMap(monitors) {
        const map = {};
        monitors.forEach((m, i) => {
            map[m.connector] = _groupLetter(i);
        });
        return map;
    }

    static groupLetter(index) {
        return _groupLetter(index);
    }
}
