import Clutter from 'gi://Clutter';
import St from 'gi://St';

/**
 * Shell API differences across the versions this extension supports.
 *
 * `St.BoxLayout`'s `vertical` property is deprecated from GNOME 48 and warns
 * on every construction; `orientation` replaces it but does not exist on
 * 45–47 (gap G7). Detect which one this Shell has by building one box and
 * seeing what happens, rather than branching on a version string, which
 * distribution builds misreport.
 */
const SUPPORTS_ORIENTATION = (() => {
    try {
        const probe = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
        });
        const ok = probe.orientation === Clutter.Orientation.VERTICAL;
        probe.destroy();
        return ok;
    } catch (_e) {
        return false;
    }
})();

function box(vertical, props) {
    if (SUPPORTS_ORIENTATION) {
        return new St.BoxLayout({
            orientation: vertical
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL,
            ...props,
        });
    }
    return new St.BoxLayout({vertical, ...props});
}

/**
 * A vertical St.BoxLayout, without the deprecation warning on GNOME 48+.
 *
 * @param {object} props extra St.BoxLayout properties
 * @returns {St.BoxLayout} a vertically stacked box
 */
export function verticalBox(props = {}) {
    return box(true, props);
}

/**
 * A horizontal St.BoxLayout, for symmetry with verticalBox.
 *
 * @param {object} props extra St.BoxLayout properties
 * @returns {St.BoxLayout} a horizontally stacked box
 */
export function horizontalBox(props = {}) {
    return box(false, props);
}

export const usesOrientation = SUPPORTS_ORIENTATION;
