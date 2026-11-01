import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    DIALOG_MARGIN,
    LIST_HEIGHT_FRACTION,
    LIST_MIN_HEIGHT,
    listMaxHeight,
} from '../lib/dialogMetrics.js';
import {
    TileAction,
    chooseTileAction,
    rememberableDevices,
} from '../lib/tileAction.js';

import {
    allDevices,
    bedroomTv,
    kitchenSpeaker,
    miracastHandoff,
    smartTv,
    speakerGroup,
} from './fixtures/devices.js';

const idle = {available: true, outdated: false, streaming: false, busy: false};

describe('what the tile does when it is clicked', () => {
    it('stops a running cast', () => {
        const {action} = chooseTileAction(
            {...idle, streaming: true}, [smartTv.id], allDevices);
        assert.equal(action, TileAction.STOP);
    });

    it('stops one that is still starting or stopping', () => {
        const {action} = chooseTileAction(
            {...idle, busy: true}, [smartTv.id], allDevices);
        assert.equal(action, TileAction.STOP);
    });

    it('never attempts a cast when the helper is not running', () => {
        // The regression that matters: a full history must not make the tile
        // fire StartCast at a D-Bus name that nobody owns.
        const {action, deviceIds} = chooseTileAction(
            {...idle, available: false}, [smartTv.id, bedroomTv.id], allDevices);
        assert.equal(action, TileAction.NOTHING);
        assert.deepEqual(deviceIds, []);
    });

    it('never attempts a cast against an outdated helper', () => {
        const {action} = chooseTileAction(
            {...idle, outdated: true}, [smartTv.id], allDevices);
        assert.equal(action, TileAction.NOTHING);
    });

    it('tolerates a missing status object', () => {
        assert.equal(chooseTileAction(null, [], []).action, TileAction.NOTHING);
    });

    it('resumes to everything it remembers, in the order it was stored', () => {
        const {action, deviceIds} = chooseTileAction(
            idle, [bedroomTv.id, smartTv.id], allDevices);
        assert.equal(action, TileAction.RESUME);
        assert.deepEqual(deviceIds, [bedroomTv.id, smartTv.id]);
    });

    it('resumes to the survivors when one receiver has gone', () => {
        const {action, deviceIds} = chooseTileAction(
            idle, [smartTv.id, 'uuid-sold-on-ebay'], allDevices);
        assert.equal(action, TileAction.RESUME);
        assert.deepEqual(deviceIds, [smartTv.id]);
    });

    it('opens the picker when nothing it remembers is on the network', () => {
        const {action, deviceIds} = chooseTileAction(
            idle, ['uuid-gone', 'uuid-also-gone'], allDevices);
        assert.equal(action, TileAction.PICK);
        assert.deepEqual(deviceIds, []);
    });

    it('opens the picker on a first run, with no history at all', () => {
        assert.equal(chooseTileAction(idle, [], allDevices).action, TileAction.PICK);
        assert.equal(
            chooseTileAction(idle, undefined, allDevices).action, TileAction.PICK);
    });

    it('opens the picker rather than casting to nothing', () => {
        assert.equal(
            chooseTileAction(idle, [smartTv.id], []).action, TileAction.PICK);
        assert.equal(
            chooseTileAction(idle, [smartTv.id], undefined).action, TileAction.PICK);
    });

    it('refuses to resume to a target that is now a speaker', () => {
        // A receiver can come back audio-only after a firmware change. The
        // check is on what the device is now, not on what it was.
        const {action} = chooseTileAction(idle, [kitchenSpeaker.id], allDevices);
        assert.equal(action, TileAction.PICK);
    });

    it('refuses to resume to a speaker group', () => {
        assert.equal(
            chooseTileAction(idle, [speakerGroup.id], allDevices).action,
            TileAction.PICK);
    });

    it('refuses to resume into the Miracast hand-off', () => {
        // Defect S11: that row launches another application and creates no
        // session. A tile click must never trigger it.
        assert.equal(
            chooseTileAction(idle, [miracastHandoff.id], allDevices).action,
            TileAction.PICK);
    });
});

describe('what gets remembered', () => {
    it('keeps the castable ids in the order they were given', () => {
        assert.deepEqual(
            rememberableDevices([bedroomTv.id, smartTv.id], allDevices),
            [bedroomTv.id, smartTv.id]);
    });

    it('drops speakers, groups and the hand-off', () => {
        assert.deepEqual(
            rememberableDevices(
                [smartTv.id, kitchenSpeaker.id, speakerGroup.id, miracastHandoff.id],
                allDevices),
            [smartTv.id]);
    });

    it('drops ids that are not devices at all', () => {
        assert.deepEqual(rememberableDevices(['nonsense'], allDevices), []);
    });

    it('removes duplicates', () => {
        assert.deepEqual(
            rememberableDevices([smartTv.id, smartTv.id], allDevices), [smartTv.id]);
    });

    it('survives empty input', () => {
        assert.deepEqual(rememberableDevices(undefined, undefined), []);
    });
});

describe('how tall the device list may be', () => {
    // The reference machine's panel, which is where the clipping was seen.
    const laptop = {workAreaHeight: 736, chromeHeight: 320};

    it('leaves the dialog chrome on screen on a 768 px panel', () => {
        const height = listMaxHeight(laptop);
        assert.ok(height + laptop.chromeHeight + DIALOG_MARGIN <= laptop.workAreaHeight,
            `list ${height} + chrome ${laptop.chromeHeight} overflows 736`);
        assert.ok(height > LIST_MIN_HEIGHT);
    });

    it('never takes more than its share of a big screen', () => {
        const work = 2096;
        assert.ok(listMaxHeight({workAreaHeight: work, chromeHeight: 0}) <=
            work * LIST_HEIGHT_FRACTION);
    });

    it('returns logical pixels, so HiDPI does not double the dialog', () => {
        const physical = {workAreaHeight: 2096, chromeHeight: 640};
        const atOne = listMaxHeight({...physical, scaleFactor: 1});
        const atTwo = listMaxHeight({...physical, scaleFactor: 2});
        assert.ok(atTwo < atOne);
        assert.ok(Math.abs(atTwo - ((atOne + DIALOG_MARGIN) / 2 - DIALOG_MARGIN)) <= 1);
    });

    it('clamps at the floor when the chrome alone fills the screen', () => {
        assert.equal(listMaxHeight({workAreaHeight: 736, chromeHeight: 900}),
            LIST_MIN_HEIGHT);
    });

    it('never returns zero, a negative or a fraction', () => {
        for (const args of [
            {},
            {workAreaHeight: 0},
            {workAreaHeight: NaN},
            {workAreaHeight: -100},
            {workAreaHeight: 736, scaleFactor: 0},
            {workAreaHeight: 736, scaleFactor: NaN},
            {workAreaHeight: 736, chromeHeight: NaN},
            {workAreaHeight: 1080, scaleFactor: 1.25},
        ]) {
            const height = listMaxHeight(args);
            assert.ok(Number.isInteger(height), `${JSON.stringify(args)} -> ${height}`);
            assert.ok(height >= LIST_MIN_HEIGHT, `${JSON.stringify(args)} -> ${height}`);
        }
    });

    it('treats a missing scale factor as 1', () => {
        assert.equal(listMaxHeight({workAreaHeight: 1200, chromeHeight: 300}),
            listMaxHeight({workAreaHeight: 1200, chromeHeight: 300, scaleFactor: 1}));
    });

    it('is monotonic: a taller screen never gives a shorter list', () => {
        let previous = 0;
        for (let work = 600; work <= 2160; work += 60) {
            const height = listMaxHeight({workAreaHeight: work, chromeHeight: 320});
            assert.ok(height >= previous, `${work} gave ${height} after ${previous}`);
            previous = height;
        }
    });
});
