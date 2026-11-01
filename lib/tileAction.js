/**
 * What a click on the Quick Settings tile body should do.
 *
 * Pure on purpose. The chevron opens the picker, so the tile itself is a
 * plain on/off switch and this rule *is* the feature: it is also the one
 * part of the new UI that can be tested without a running Shell.
 */

export const TileAction = {
    /** Something is running; end it. */
    STOP: 'stop',
    /** Cast to the receivers the last cast went to. */
    RESUME: 'resume',
    /** Nothing remembered, or none of it is on the network: open the picker. */
    PICK: 'pick',
    /** No helper to talk to; never attempt a cast, just explain. */
    NOTHING: 'nothing',
};

/**
 * Decide what the tile does, from a snapshot of the client rather than the
 * client itself, so this stays testable.
 *
 * @param {object} status {available, outdated, streaming, busy}
 * @param {string[]} lastIds remembered device ids, in the order they were cast to
 * @param {object[]} devices the devices discovery currently reports
 * @returns {{action: string, deviceIds: string[]}} the action and its targets
 */
export function chooseTileAction(status, lastIds, devices) {
    if (!status?.available || status.outdated)
        return {action: TileAction.NOTHING, deviceIds: []};
    if (status.streaming || status.busy)
        return {action: TileAction.STOP, deviceIds: []};

    // A remembered id can come back as a speaker, or as the Miracast
    // hand-off after the helper rebuilt its list. Resuming to either would
    // be wrong, so the filter is on what the device is *now*, not on what it
    // was when it was remembered.
    const castable = new Set((devices ?? [])
        .filter(d => d.protocol !== 'miracast-handoff' && d.video_capable !== false)
        .map(d => d.id));
    const deviceIds = (lastIds ?? []).filter(id => castable.has(id));

    return deviceIds.length
        ? {action: TileAction.RESUME, deviceIds}
        : {action: TileAction.PICK, deviceIds: []};
}

/**
 * The ids worth remembering out of the ones a cast was started with.
 *
 * Audio targets and the Miracast hand-off can never be resumed to, so they
 * are dropped here rather than filtered again on every tile click.
 *
 * @param {string[]} ids the ids the cast was started with
 * @param {object[]} devices the devices discovery currently reports
 * @returns {string[]} the ids to persist, duplicates removed, order kept
 */
export function rememberableDevices(ids, devices) {
    const byId = new Map((devices ?? []).map(d => [d.id, d]));
    return [...new Set(ids ?? [])].filter(id => {
        const device = byId.get(id);
        return !!device && device.protocol !== 'miracast-handoff' &&
            device.video_capable !== false;
    });
}
