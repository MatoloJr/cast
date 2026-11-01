/**
 * Recorded GetCurrentState shapes, for layout tests.
 *
 * `laptopOnly` is a real capture from the reference machine
 * (`gdbus call -m org.gnome.Mutter.DisplayConfig.GetCurrentState`), trimmed
 * to the fields the layout code reads. The rest are built from it to cover
 * the mixed-resolution and mixed-scale cases that gap G2 is about.
 */

/**
 * Mutter reports a mode as
 * `(s id, i width, i height, d refresh, d preferred_scale, ad supported_scales, a{sv} props)`,
 * so `preferred_scale` is its own field and is not simply the first
 * supported scale — a 4K panel supports 1.0 but prefers 2.0.
 */
function mode(id, width, height, refresh, scales = [1.0], flags = {}) {
    return {
        id,
        width,
        height,
        refresh,
        preferredScale: flags.preferredScale ?? scales[0],
        supportedScales: scales,
        isCurrent: !!flags.current,
        isPreferred: !!flags.preferred,
    };
}

/** The reference machine: one built-in 1366x768 panel. */
export const laptopOnly = {
    layoutMode: 1,
    monitors: [
        {
            connector: 'eDP-1',
            vendor: 'BOE',
            product: '0x05f5',
            serial: '0x00000000',
            isBuiltin: true,
            displayName: 'Built-in display',
            modes: [
                mode('1366x768@59.999', 1366, 768, 59.9985, [1.0], {current: true, preferred: true}),
                mode('1366x768@40.000', 1366, 768, 40.0),
                mode('1280x720@59.745', 1280, 720, 59.7447, [1.0, 1.25, 1.3333]),
                mode('1024x768@59.920', 1024, 768, 59.9201, [1.0, 1.3333]),
                mode('800x600@59.861', 800, 600, 59.8614),
            ],
        },
    ],
    logicalMonitors: [
        {x: 0, y: 0, scale: 1.0, transform: 0, primary: true, monitors: ['eDP-1']},
    ],
};

/** Laptop plus an external 1080p screen: no shared native resolution. */
export const laptopPlusExternal = {
    layoutMode: 1,
    monitors: [
        laptopOnly.monitors[0],
        {
            connector: 'HDMI-1',
            vendor: 'DEL',
            product: 'U2412M',
            serial: '0x1234',
            isBuiltin: false,
            displayName: 'Dell 24"',
            modes: [
                mode('1920x1080@60.000', 1920, 1080, 60.0, [1.0], {current: true, preferred: true}),
                mode('1600x900@60.000', 1600, 900, 60.0),
                mode('1280x720@60.000', 1280, 720, 60.0, [1.0, 1.25, 1.3333]),
                mode('1024x768@60.000', 1024, 768, 60.0, [1.0, 1.3333]),
            ],
        },
    ],
    logicalMonitors: [
        {x: 0, y: 0, scale: 1.0, transform: 0, primary: true, monitors: ['eDP-1']},
        {x: 1366, y: 0, scale: 1.0, transform: 0, primary: false, monitors: ['HDMI-1']},
    ],
};

/** Three screens, one of them HiDPI at scale 2. */
export const threeMixedScales = {
    layoutMode: 1,
    monitors: [
        laptopOnly.monitors[0],
        laptopPlusExternal.monitors[1],
        {
            connector: 'DP-2',
            vendor: 'LG',
            product: '27UK850',
            serial: '0x9999',
            isBuiltin: false,
            displayName: 'LG UltraFine',
            modes: [
                mode('3840x2160@60.000', 3840, 2160, 60.0, [1.0, 1.5, 2.0, 3.0],
                    {current: true, preferred: true, preferredScale: 2.0}),
                mode('1920x1080@60.000', 1920, 1080, 60.0, [1.0, 1.25]),
                mode('1280x720@60.000', 1280, 720, 60.0, [1.0, 1.25, 1.3333]),
            ],
        },
    ],
    logicalMonitors: [
        {x: 0, y: 0, scale: 1.0, transform: 0, primary: true, monitors: ['eDP-1']},
        {x: 1366, y: 0, scale: 1.0, transform: 0, primary: false, monitors: ['HDMI-1']},
        {x: 3286, y: 0, scale: 2.0, transform: 0, primary: false, monitors: ['DP-2']},
    ],
};

/** Two screens that genuinely share nothing. */
export const noSharedResolution = {
    layoutMode: 1,
    monitors: [
        {
            connector: 'eDP-1',
            isBuiltin: true,
            displayName: 'Odd panel',
            modes: [mode('1366x768@60', 1366, 768, 60, [1.0], {current: true, preferred: true})],
        },
        {
            connector: 'HDMI-1',
            isBuiltin: false,
            displayName: 'Odd external',
            modes: [mode('1920x1200@60', 1920, 1200, 60, [1.0], {current: true, preferred: true})],
        },
    ],
    logicalMonitors: [
        {x: 0, y: 0, scale: 1.0, transform: 0, primary: true, monitors: ['eDP-1']},
        {x: 1366, y: 0, scale: 1.0, transform: 0, primary: false, monitors: ['HDMI-1']},
    ],
};

/**
 * The laptop after the ScreenCast portal created a virtual monitor.
 *
 * Captured from the reference machine while extending, so the connector
 * name, vendor, product string and advertised scales are the real ones
 * xdg-desktop-portal-gnome 50 produces, not invented.
 */
export const laptopPlusVirtual = {
    layoutMode: 1,
    monitors: [
        laptopOnly.monitors[0],
        {
            connector: 'Meta-0',
            vendor: 'MetaVendor',
            product: 'Virtual remote monitor',
            serial: '0x000005',
            isBuiltin: false,
            displayName: 'MetaVendor',
            modes: [
                mode('1920x1080@60.000', 1920, 1080, 60.0,
                    [1.0, 1.25, 1.3333333730697632, 1.5, 1.6666666269302368, 2.0],
                    {current: true, preferred: true}),
            ],
        },
    ],
    logicalMonitors: laptopOnly.logicalMonitors,
};

/**
 * What a *range* caps filter gets you: a 2x2 placeholder monitor.
 *
 * Kept as a fixture because it is the failure mode that made "Extend" look
 * like it worked while being unusable. See docs/phase-4-display-modes.md.
 */
export const laptopPlusTinyVirtual = {
    layoutMode: 1,
    monitors: [
        laptopOnly.monitors[0],
        {
            connector: 'Meta-0',
            vendor: 'MetaVendor',
            product: 'Virtual remote monitor',
            serial: '0x000001',
            isBuiltin: false,
            displayName: 'MetaVendor',
            modes: [mode('2x2@60.000', 2, 2, 60.0, [1.0],
                {current: true, preferred: true})],
        },
    ],
    logicalMonitors: laptopOnly.logicalMonitors,
};
