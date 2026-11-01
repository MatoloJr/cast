/**
 * Monitor layout arithmetic, with no GObject imports.
 *
 * Kept free of `gi://` on purpose: everything here is a pure function over
 * the data `org.gnome.Mutter.DisplayConfig.GetCurrentState` returns, so it
 * can be unit-tested with `node --test` against recorded fixtures instead of
 * only being exercisable inside a running Shell.
 *
 * Shapes, as Mutter reports them:
 *
 *   monitor        {connector, vendor, product, serial, modes[], isBuiltin, displayName}
 *   mode           {id, width, height, refresh, preferredScale, supportedScales,
 *                   isCurrent, isPreferred}
 *   logicalMonitor {x, y, scale, transform, primary, monitors: [connector, …]}
 *
 * An "apply entry" is what ApplyMonitorsConfig wants:
 *
 *   [x, y, scale, transform, primary, [[connector, modeId, props], …]]
 */

export const Transform = {
    NORMAL: 0,
};

/** Mutter's layout-mode values. */
export const LayoutMode = {
    LOGICAL: 1,
    PHYSICAL: 2,
};

export const Position = {
    RIGHT: 'right',
    LEFT: 'left',
    ABOVE: 'above',
    BELOW: 'below',
};

/**
 * The mode a monitor is currently using.
 *
 * @param {object} monitor a parsed monitor
 * @returns {object|null} its current mode, or null
 */
export function currentMode(monitor) {
    return monitor.modes?.find(m => m.isCurrent) ?? null;
}

/**
 * The mode a monitor prefers, falling back to its largest.
 *
 * @param {object} monitor a parsed monitor
 * @returns {object|null} the preferred mode, or null
 */
export function preferredMode(monitor) {
    if (!monitor.modes?.length)
        return null;
    return monitor.modes.find(m => m.isPreferred) ??
        [...monitor.modes].sort(modeByDescendingSize)[0];
}

function modeByDescendingSize(a, b) {
    const areaDelta = b.width * b.height - a.width * a.height;
    if (areaDelta !== 0)
        return areaDelta;
    return (b.refresh ?? 0) - (a.refresh ?? 0);
}

/**
 * The scale a monitor should use for a given mode.
 *
 * Mutter rejects a scale a mode does not advertise, so never invent one.
 *
 * @param {object} mode the mode being applied
 * @param {number} [wanted] a preferred scale, if any
 * @returns {number} a scale the mode actually supports
 */
export function scaleFor(mode, wanted) {
    const supported = mode?.supportedScales?.length
        ? mode.supportedScales
        : [mode?.preferredScale ?? 1];
    if (wanted && supported.some(s => Math.abs(s - wanted) < 0.01))
        return wanted;
    if (mode?.preferredScale &&
        supported.some(s => Math.abs(s - mode.preferredScale) < 0.01))
        return mode.preferredScale;
    return supported[0] ?? 1;
}

/**
 * The size a monitor occupies in the logical coordinate space.
 *
 * In logical layout mode Mutter divides by the scale; in physical mode it
 * does not. Getting this wrong stacks monitors on top of each other.
 *
 * @param {object} mode the mode in use
 * @param {number} scale the scale in use
 * @param {number} layoutMode LayoutMode.LOGICAL or LayoutMode.PHYSICAL
 * @returns {{width: number, height: number}} logical size
 */
export function logicalSize(mode, scale, layoutMode) {
    if (layoutMode === LayoutMode.PHYSICAL || !scale)
        return {width: mode.width, height: mode.height};
    return {
        width: Math.round(mode.width / scale),
        height: Math.round(mode.height / scale),
    };
}

/**
 * The largest mode every monitor can display, for mirroring.
 *
 * Mirroring puts several monitors in one logical monitor, and Mutter rejects
 * that unless they share a mode — which is why the old code, using each
 * monitor's own current mode, always failed with "Layout could not be
 * applied" on mixed-resolution setups (gap G2).
 *
 * @param {object[]} monitors monitors to mirror
 * @returns {{width: number, height: number, perMonitor: object[]}|null}
 *   the chosen size and the matching mode for each monitor, or null when
 *   the monitors share no resolution at all
 */
export function findCommonMode(monitors) {
    if (!monitors?.length)
        return null;
    if (monitors.length === 1) {
        const only = preferredMode(monitors[0]);
        if (!only)
            return null;
        return {
            width: only.width,
            height: only.height,
            perMonitor: [{connector: monitors[0].connector, mode: only}],
        };
    }

    // Candidate resolutions: those offered by the first monitor, largest
    // first, keeping only the ones every other monitor also offers.
    const candidates = [...(monitors[0].modes ?? [])].sort(modeByDescendingSize);

    for (const candidate of candidates) {
        const perMonitor = [];
        let shared = true;
        for (const monitor of monitors) {
            const matches = (monitor.modes ?? []).filter(
                m => m.width === candidate.width && m.height === candidate.height);
            if (!matches.length) {
                shared = false;
                break;
            }
            // Highest refresh rate available at that resolution.
            matches.sort((a, b) => (b.refresh ?? 0) - (a.refresh ?? 0));
            perMonitor.push({connector: monitor.connector, mode: matches[0]});
        }
        if (shared) {
            return {
                width: candidate.width,
                height: candidate.height,
                perMonitor,
            };
        }
    }
    return null;
}

/**
 * Human-readable reason mirroring is impossible, for the UI to show.
 *
 * @param {object[]} monitors monitors that could not be mirrored
 * @returns {string} an explanation naming the resolutions involved
 */
export function describeMirrorFailure(monitors) {
    const described = monitors.map(m => {
        const mode = currentMode(m) ?? preferredMode(m);
        const name = m.displayName || m.connector;
        return mode ? `${name} (${mode.width}×${mode.height})` : name;
    });
    return `These screens can't mirror: no shared resolution between ${described.join(' and ')}`;
}

function entry(x, y, scale, primary, monitorModes) {
    return [
        x, y, scale, Transform.NORMAL, primary,
        monitorModes.map(({connector, mode}) => [connector, mode.id, {}]),
    ];
}

/**
 * Mirror every given monitor into one logical monitor.
 *
 * @param {object[]} monitors monitors to mirror
 * @param {number} layoutMode the current layout mode
 * @returns {{entries: object[]}|{error: string}} apply entries, or why not
 */
export function buildMirror(monitors, layoutMode = LayoutMode.LOGICAL) {
    const common = findCommonMode(monitors);
    if (!common)
        return {error: describeMirrorFailure(monitors)};

    // One scale for the whole logical monitor, and Mutter rejects any scale
    // a member's mode does not advertise. So intersect the supported sets
    // and take the largest that survives, falling back to 1.
    const supportedByAll = common.perMonitor
        .map(({mode}) => mode.supportedScales?.length
            ? mode.supportedScales
            : [mode.preferredScale ?? 1])
        .reduce((shared, scales) =>
            shared.filter(s => scales.some(t => Math.abs(s - t) < 0.01)));
    const scale = supportedByAll.length ? Math.max(...supportedByAll) : 1;

    void layoutMode;
    return {entries: [entry(0, 0, scale, true, common.perMonitor)]};
}

/**
 * Lay monitors side by side, each at its own mode.
 *
 * @param {object[]} monitors monitors to place, in order
 * @param {number} layoutMode the current layout mode
 * @param {string} primaryConnector which monitor is primary
 * @returns {{entries: object[]}|{error: string}} apply entries, or why not
 */
export function buildExtend(monitors, layoutMode = LayoutMode.LOGICAL,
    primaryConnector = null) {
    if (!monitors?.length)
        return {error: 'No monitors to arrange'};

    const entries = [];
    let x = 0;
    for (const monitor of monitors) {
        const mode = currentMode(monitor) ?? preferredMode(monitor);
        if (!mode)
            return {error: `${monitor.connector} reports no usable mode`};
        const scale = scaleFor(mode);
        const isPrimary = primaryConnector
            ? monitor.connector === primaryConnector
            : entries.length === 0;
        entries.push(entry(x, 0, scale, isPrimary, [{connector: monitor.connector, mode}]));
        x += logicalSize(mode, scale, layoutMode).width;
    }
    return {entries};
}

/**
 * Enable exactly one monitor and disable the rest.
 *
 * @param {object[]} monitors every known monitor
 * @param {string} connector the monitor to keep on
 * @param {number} layoutMode the current layout mode
 * @returns {{entries: object[]}|{error: string}} apply entries, or why not
 */
export function buildSingleOnly(monitors, connector, layoutMode = LayoutMode.LOGICAL) {
    const chosen = monitors.find(m => m.connector === connector);
    if (!chosen)
        return {error: `${connector} is not connected`};
    const mode = currentMode(chosen) ?? preferredMode(chosen);
    if (!mode)
        return {error: `${connector} reports no usable mode`};
    void layoutMode;
    return {
        entries: [entry(0, 0, scaleFor(mode), true,
            [{connector: chosen.connector, mode}])],
    };
}

/**
 * Place a newly appeared monitor relative to the existing layout.
 *
 * Used for Extend: the portal's VIRTUAL source makes Mutter create a monitor,
 * and it has to be put somewhere sensible rather than on top of the primary.
 *
 * @param {object[]} monitors every known monitor
 * @param {object[]} logicalMonitors the current logical layout
 * @param {string} newConnector the monitor that just appeared
 * @param {string} position one of Position.*
 * @param {number} layoutMode the current layout mode
 * @returns {{entries: object[]}|{error: string}} apply entries, or why not
 */
export function placeNewMonitor(monitors, logicalMonitors, newConnector,
    position = Position.RIGHT, layoutMode = LayoutMode.LOGICAL) {
    const incoming = monitors.find(m => m.connector === newConnector);
    if (!incoming)
        return {error: `${newConnector} is not connected`};
    const incomingMode = currentMode(incoming) ?? preferredMode(incoming);
    if (!incomingMode)
        return {error: `${newConnector} reports no usable mode`};

    const entries = [];
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;

    for (const logical of logicalMonitors) {
        const members = [];
        for (const connector of logical.monitors) {
            const monitor = monitors.find(m => m.connector === connector);
            if (!monitor)
                continue;
            const mode = currentMode(monitor) ?? preferredMode(monitor);
            if (mode)
                members.push({connector, mode});
        }
        if (!members.length)
            continue;
        entries.push(entry(logical.x, logical.y, logical.scale, logical.primary, members));

        const size = logicalSize(members[0].mode, logical.scale, layoutMode);
        minX = Math.min(minX, logical.x);
        minY = Math.min(minY, logical.y);
        maxX = Math.max(maxX, logical.x + size.width);
        maxY = Math.max(maxY, logical.y + size.height);
    }

    const scale = scaleFor(incomingMode);
    const size = logicalSize(incomingMode, scale, layoutMode);
    let x = maxX;
    let y = 0;
    switch (position) {
    case Position.LEFT:
        x = minX - size.width;
        y = 0;
        break;
    case Position.ABOVE:
        x = 0;
        y = minY - size.height;
        break;
    case Position.BELOW:
        x = 0;
        y = maxY;
        break;
    case Position.RIGHT:
    default:
        x = maxX;
        y = 0;
        break;
    }

    entries.push(entry(x, y, scale, false, [{connector: newConnector, mode: incomingMode}]));
    return {entries};
}

/**
 * Connectors present in `after` but not in `before`.
 *
 * How Extend finds the virtual monitor the portal just created: diff the
 * monitor list around starting the stream rather than guessing at a name,
 * because Mutter's connector naming for virtual outputs is not contractual.
 *
 * @param {object[]} before monitors before the stream started
 * @param {object[]} after monitors afterwards
 * @returns {string[]} connectors that appeared
 */
export function appearedConnectors(before, after) {
    const known = new Set(before.map(m => m.connector));
    return after.filter(m => !known.has(m.connector)).map(m => m.connector);
}

/**
 * Whether a layout would switch off a monitor that is currently on.
 *
 * Anything that answers true needs the "Keep these display settings?"
 * revert timer, because a bad apply can leave the user with no visible
 * screen and no way to undo it (gap G3).
 *
 * @param {object[]} entries the apply entries about to be sent
 * @param {object[]} logicalMonitors the current logical layout
 * @returns {boolean} true when at least one active monitor would go dark
 */
export function disablesAnActiveMonitor(entries, logicalMonitors) {
    const willBeOn = new Set();
    for (const [, , , , , members] of entries) {
        for (const [connector] of members)
            willBeOn.add(connector);
    }
    for (const logical of logicalMonitors) {
        for (const connector of logical.monitors) {
            if (!willBeOn.has(connector))
                return true;
        }
    }
    return false;
}

/**
 * Compare two layouts for equality, for verifying a restore.
 *
 * @param {object[]} a one logical layout
 * @param {object[]} b another logical layout
 * @returns {boolean} whether they place the same monitors identically
 */
export function sameLayout(a, b) {
    const normalise = layout => (layout ?? []).map(l => ({
        x: l.x, y: l.y, scale: l.scale, primary: !!l.primary,
        monitors: [...l.monitors].sort(),
    })).sort((p, q) => (p.x - q.x) || (p.y - q.y) ||
        p.monitors.join().localeCompare(q.monitors.join()));
    return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}
