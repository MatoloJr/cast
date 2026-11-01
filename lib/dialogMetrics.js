/**
 * How tall the cast dialog's device list may be.
 *
 * The whole point of moving the picker out of the Quick Settings dropdown is
 * that a dropdown has no height bound and runs off the bottom of a laptop
 * panel. So the replacement must derive its bound from the screen it is on,
 * which means arithmetic, which means something worth testing. No `gi://`
 * imports here: this module is loaded by `node --test`.
 */

/** Never give the list more than this share of the work area. */
export const LIST_HEIGHT_FRACTION = 0.6;

/** Logical pixels. About two rows: always enough to show that it scrolls. */
export const LIST_MIN_HEIGHT = 96;

/** Logical pixels of breathing room between the dialog and the screen edge. */
export const DIALOG_MARGIN = 48;

/**
 * The device list's max-height, in logical (CSS) pixels.
 *
 * Two bounds rather than one. Subtracting the measured chrome is what keeps
 * the buttons on screen on a 768 px laptop; the fraction is what stops the
 * dialog filling a 4K screen with empty rows.
 *
 * St measures in physical pixels and CSS lengths are logical, so the scale
 * factor is divided out once, at the end.
 *
 * @param {object} args lengths in physical pixels unless noted
 * @param {number} args.workAreaHeight the monitor work area height
 * @param {number} [args.chromeHeight] everything in the dialog but the list
 * @param {number} [args.scaleFactor] St's scale factor for that monitor
 * @param {number} [args.fraction] share of the work area the list may take
 * @param {number} [args.minHeight] floor, in logical pixels
 * @param {number} [args.margin] breathing room, in logical pixels
 * @returns {number} an integer max-height in logical pixels
 */
export function listMaxHeight({
    workAreaHeight,
    chromeHeight = 0,
    scaleFactor = 1,
    fraction = LIST_HEIGHT_FRACTION,
    minHeight = LIST_MIN_HEIGHT,
    margin = DIALOG_MARGIN,
} = {}) {
    // Every input here comes from a Shell API that can legitimately return 0
    // before the first allocation, so none of them may reach the CSS string
    // as NaN or Infinity.
    const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    const work = Number.isFinite(workAreaHeight) && workAreaHeight > 0
        ? workAreaHeight : 0;
    if (!work)
        return minHeight;

    const chrome = Number.isFinite(chromeHeight) && chromeHeight > 0
        ? chromeHeight : 0;
    const budget = Math.min(work - chrome, work * fraction) / scale - margin;
    return Math.max(minHeight, Math.floor(budget));
}
