import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    LayoutMode,
    Position,
    appearedConnectors,
    buildExtend,
    buildMirror,
    buildSingleOnly,
    currentMode,
    describeMirrorFailure,
    disablesAnActiveMonitor,
    findCommonMode,
    logicalSize,
    placeNewMonitor,
    preferredMode,
    sameLayout,
    scaleFor,
} from '../lib/layout.js';

import {
    laptopOnly,
    laptopPlusExternal,
    laptopPlusVirtual,
    noSharedResolution,
    threeMixedScales,
} from './fixtures/monitors.js';

const connectorsOf = entries =>
    entries.map(([, , , , , members]) => members.map(([connector]) => connector));

describe('mode selection', () => {
    it('finds the current mode', () => {
        assert.equal(currentMode(laptopOnly.monitors[0]).id, '1366x768@59.999');
    });

    it('prefers the preferred mode', () => {
        assert.equal(preferredMode(laptopOnly.monitors[0]).id, '1366x768@59.999');
    });

    it('falls back to the largest mode when none is preferred', () => {
        const monitor = {
            connector: 'X',
            modes: [
                {id: 'small', width: 800, height: 600, refresh: 60, supportedScales: [1]},
                {id: 'big', width: 1920, height: 1080, refresh: 60, supportedScales: [1]},
            ],
        };
        assert.equal(preferredMode(monitor).id, 'big');
    });

    it('returns null for a monitor with no modes', () => {
        assert.equal(preferredMode({connector: 'X', modes: []}), null);
        assert.equal(currentMode({connector: 'X', modes: []}), null);
    });
});

describe('scaleFor', () => {
    it('never invents a scale the mode does not advertise', () => {
        const mode = {supportedScales: [1, 2], preferredScale: 1};
        assert.equal(scaleFor(mode, 1.5), 1);
    });

    it('honours a wanted scale that is supported', () => {
        const mode = {supportedScales: [1, 1.5, 2], preferredScale: 1};
        assert.equal(scaleFor(mode, 1.5), 1.5);
    });

    it('falls back to the preferred scale', () => {
        const mode = {supportedScales: [1, 2], preferredScale: 2};
        assert.equal(scaleFor(mode), 2);
    });
});

describe('logicalSize', () => {
    it('divides by the scale in logical layout mode', () => {
        const size = logicalSize({width: 3840, height: 2160}, 2, LayoutMode.LOGICAL);
        assert.deepEqual(size, {width: 1920, height: 1080});
    });

    it('ignores the scale in physical layout mode', () => {
        const size = logicalSize({width: 3840, height: 2160}, 2, LayoutMode.PHYSICAL);
        assert.deepEqual(size, {width: 3840, height: 2160});
    });
});

describe('findCommonMode (gap G2)', () => {
    it('uses the preferred mode for a single monitor', () => {
        const common = findCommonMode(laptopOnly.monitors);
        assert.equal(common.width, 1366);
        assert.equal(common.height, 768);
        assert.equal(common.perMonitor.length, 1);
    });

    it('finds the largest shared resolution, not each monitor\'s own', () => {
        // 1366x768 is the laptop's native and 1920x1080 the external's, but
        // only 1280x720 and 1024x768 are offered by both. The old code used
        // each monitor's current mode and Mutter rejected the result.
        const common = findCommonMode(laptopPlusExternal.monitors);
        assert.equal(common.width, 1280);
        assert.equal(common.height, 720);
        assert.equal(common.perMonitor.length, 2);
        assert.deepEqual(
            common.perMonitor.map(p => p.connector).sort(),
            ['HDMI-1', 'eDP-1']
        );
    });

    it('picks the highest refresh rate at the shared resolution', () => {
        const common = findCommonMode(laptopPlusExternal.monitors);
        const external = common.perMonitor.find(p => p.connector === 'HDMI-1');
        assert.equal(external.mode.refresh, 60);
    });

    it('works across three monitors with different native sizes', () => {
        const common = findCommonMode(threeMixedScales.monitors);
        assert.equal(common.width, 1280);
        assert.equal(common.height, 720);
        assert.equal(common.perMonitor.length, 3);
    });

    it('returns null when nothing is shared', () => {
        assert.equal(findCommonMode(noSharedResolution.monitors), null);
    });

    it('returns null for no monitors', () => {
        assert.equal(findCommonMode([]), null);
        assert.equal(findCommonMode(undefined), null);
    });
});

describe('buildMirror', () => {
    it('puts every monitor in one logical monitor', () => {
        const result = buildMirror(laptopPlusExternal.monitors);
        assert.ok(result.entries, result.error);
        assert.equal(result.entries.length, 1);
        assert.deepEqual(connectorsOf(result.entries)[0].sort(), ['HDMI-1', 'eDP-1']);
    });

    it('marks the mirrored logical monitor primary and at the origin', () => {
        const [x, y, , , primary] = buildMirror(laptopPlusExternal.monitors).entries[0];
        assert.equal(x, 0);
        assert.equal(y, 0);
        assert.equal(primary, true);
    });

    it('chooses a scale every member supports', () => {
        const result = buildMirror(threeMixedScales.monitors);
        assert.ok(result.entries, result.error);
        const scale = result.entries[0][2];
        for (const monitor of threeMixedScales.monitors) {
            const mode = monitor.modes.find(m => m.width === 1280 && m.height === 720);
            assert.ok(
                mode.supportedScales.some(s => Math.abs(s - scale) < 0.01),
                `${monitor.connector} cannot do scale ${scale}`
            );
        }
    });

    it('explains itself instead of failing silently', () => {
        const result = buildMirror(noSharedResolution.monitors);
        assert.equal(result.entries, undefined);
        assert.match(result.error, /can't mirror/);
        assert.match(result.error, /1366×768/);
        assert.match(result.error, /1920×1200/);
    });

    it('describeMirrorFailure names both screens', () => {
        const message = describeMirrorFailure(noSharedResolution.monitors);
        assert.match(message, /Odd panel/);
        assert.match(message, /Odd external/);
    });
});

describe('buildExtend', () => {
    it('places monitors left to right without overlapping', () => {
        const result = buildExtend(laptopPlusExternal.monitors, LayoutMode.LOGICAL);
        assert.ok(result.entries, result.error);
        assert.equal(result.entries.length, 2);
        assert.equal(result.entries[0][0], 0);
        assert.equal(result.entries[1][0], 1366);
    });

    it('accounts for scale when positioning', () => {
        const result = buildExtend(threeMixedScales.monitors, LayoutMode.LOGICAL);
        assert.ok(result.entries, result.error);
        // eDP-1 1366 wide, HDMI-1 1920 wide, so DP-2 starts at 3286.
        assert.equal(result.entries[2][0], 3286);
        // 3840 at scale 2 occupies 1920 logical pixels.
        assert.equal(result.entries[2][2], 2);
    });

    it('makes the first monitor primary by default', () => {
        const result = buildExtend(laptopPlusExternal.monitors);
        assert.equal(result.entries[0][4], true);
        assert.equal(result.entries[1][4], false);
    });

    it('honours an explicit primary', () => {
        const result = buildExtend(laptopPlusExternal.monitors,
            LayoutMode.LOGICAL, 'HDMI-1');
        assert.equal(result.entries[0][4], false);
        assert.equal(result.entries[1][4], true);
    });

    it('errors on an empty list', () => {
        assert.match(buildExtend([]).error, /No monitors/);
    });
});

describe('buildSingleOnly', () => {
    it('keeps only the chosen monitor', () => {
        const result = buildSingleOnly(laptopPlusExternal.monitors, 'HDMI-1');
        assert.ok(result.entries, result.error);
        assert.equal(result.entries.length, 1);
        assert.deepEqual(connectorsOf(result.entries)[0], ['HDMI-1']);
        assert.equal(result.entries[0][4], true);
    });

    it('errors for a monitor that is not connected', () => {
        assert.match(
            buildSingleOnly(laptopOnly.monitors, 'HDMI-9').error,
            /not connected/
        );
    });
});

describe('placeNewMonitor (Extend onto a receiver)', () => {
    it('places the new monitor to the right by default', () => {
        const result = placeNewMonitor(
            laptopPlusVirtual.monitors, laptopOnly.logicalMonitors, 'Meta-0');
        assert.ok(result.entries, result.error);
        const added = result.entries.at(-1);
        assert.deepEqual(connectorsOf([added])[0], ['Meta-0']);
        assert.equal(added[0], 1366);
        assert.equal(added[1], 0);
    });

    it('can place it to the left', () => {
        const result = placeNewMonitor(
            laptopPlusVirtual.monitors, laptopOnly.logicalMonitors, 'Meta-0',
            Position.LEFT);
        assert.equal(result.entries.at(-1)[0], -1920);
    });

    it('can place it above', () => {
        const result = placeNewMonitor(
            laptopPlusVirtual.monitors, laptopOnly.logicalMonitors, 'Meta-0',
            Position.ABOVE);
        assert.equal(result.entries.at(-1)[1], -1080);
    });

    it('keeps the existing monitors where they were', () => {
        const result = placeNewMonitor(
            laptopPlusVirtual.monitors, laptopOnly.logicalMonitors, 'Meta-0');
        const existing = result.entries[0];
        assert.deepEqual(connectorsOf([existing])[0], ['eDP-1']);
        assert.equal(existing[0], 0);
        assert.equal(existing[4], true);
    });

    it('does not make the new monitor primary', () => {
        const result = placeNewMonitor(
            laptopPlusVirtual.monitors, laptopOnly.logicalMonitors, 'Meta-0');
        assert.equal(result.entries.at(-1)[4], false);
    });
});

describe('appearedConnectors', () => {
    it('spots the monitor the portal created', () => {
        assert.deepEqual(
            appearedConnectors(laptopOnly.monitors, laptopPlusVirtual.monitors),
            ['Meta-0']
        );
    });

    it('is empty when nothing changed', () => {
        assert.deepEqual(appearedConnectors(laptopOnly.monitors, laptopOnly.monitors), []);
    });

    it('does not report removals', () => {
        assert.deepEqual(appearedConnectors(laptopPlusVirtual.monitors, laptopOnly.monitors), []);
    });
});

describe('disablesAnActiveMonitor (gap G3)', () => {
    it('is true when a layout drops a live monitor', () => {
        const result = buildSingleOnly(laptopPlusExternal.monitors, 'HDMI-1');
        assert.equal(
            disablesAnActiveMonitor(result.entries, laptopPlusExternal.logicalMonitors),
            true
        );
    });

    it('is false when every live monitor stays on', () => {
        const result = buildExtend(laptopPlusExternal.monitors);
        assert.equal(
            disablesAnActiveMonitor(result.entries, laptopPlusExternal.logicalMonitors),
            false
        );
    });

    it('is false for mirroring, which keeps all monitors on', () => {
        const result = buildMirror(laptopPlusExternal.monitors);
        assert.equal(
            disablesAnActiveMonitor(result.entries, laptopPlusExternal.logicalMonitors),
            false
        );
    });

    it('treats TV-only as disabling, since the laptop goes dark', () => {
        const result = buildSingleOnly(laptopPlusVirtual.monitors, 'Meta-0');
        assert.equal(
            disablesAnActiveMonitor(result.entries, laptopOnly.logicalMonitors),
            true
        );
    });
});

describe('sameLayout', () => {
    it('matches a layout against itself', () => {
        assert.equal(sameLayout(laptopPlusExternal.logicalMonitors,
            laptopPlusExternal.logicalMonitors), true);
    });

    it('ignores ordering', () => {
        const reversed = [...laptopPlusExternal.logicalMonitors].reverse();
        assert.equal(sameLayout(laptopPlusExternal.logicalMonitors, reversed), true);
    });

    it('notices a moved monitor', () => {
        const moved = laptopPlusExternal.logicalMonitors.map(
            (l, i) => i === 1 ? {...l, x: 9999} : l);
        assert.equal(sameLayout(laptopPlusExternal.logicalMonitors, moved), false);
    });

    it('notices a missing monitor', () => {
        assert.equal(sameLayout(laptopPlusExternal.logicalMonitors,
            laptopOnly.logicalMonitors), false);
    });
});

describe('the 2x2 virtual monitor trap', () => {
    it('a 2x2 virtual monitor is still placed, but is plainly unusable', async () => {
        const {laptopPlusTinyVirtual} = await import('./fixtures/monitors.js');
        const result = placeNewMonitor(
            laptopPlusTinyVirtual.monitors,
            laptopPlusTinyVirtual.logicalMonitors,
            'Meta-0'
        );
        assert.ok(result.entries, result.error);
        const added = result.entries.at(-1);
        // Nothing in the layout code can rescue this: the fix has to be in
        // the pipeline caps, which is why extend requests an exact size.
        assert.equal(added[0], 1366);
        const monitor = laptopPlusTinyVirtual.monitors.find(m => m.connector === 'Meta-0');
        assert.equal(currentMode(monitor).width, 2);
    });
});
