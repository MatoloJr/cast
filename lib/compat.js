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

/**
 * St.ScrollView's scrollbar policy enum.
 *
 * The property changed type from `Gtk.PolicyType` to `St.PolicyType` in
 * GNOME 46. The two number their members identically
 * (ALWAYS 0, AUTOMATIC 1, NEVER 2, EXTERNAL 3), so the integer fallback is
 * exact rather than approximate.
 */
export const ScrollPolicy = {
    ALWAYS: St.PolicyType?.ALWAYS ?? 0,
    AUTOMATIC: St.PolicyType?.AUTOMATIC ?? 1,
    NEVER: St.PolicyType?.NEVER ?? 2,
};

/**
 * An St.ScrollView holding one child.
 *
 * St.ScrollView became an St.Bin in GNOME 46 and gained `set_child()`; on 45
 * the child goes in with `add_actor()`. Feature-detected like the BoxLayout
 * orientation above, rather than branched on a version string that
 * distribution builds misreport.
 *
 * @param {object} props St.ScrollView properties, plus `child`
 * @returns {St.ScrollView} the scroll view, with the child already in it
 */
export function scrollView({child = null, ...props} = {}) {
    const view = new St.ScrollView(props);
    if (child) {
        if (typeof view.set_child === 'function')
            view.set_child(child);
        else
            view.add_actor(child);
    }
    return view;
}

/**
 * Scroll `actor` into view inside `scroll`.
 *
 * Reimplemented rather than imported: the Shell's own
 * `ensureActorVisibleInScrollView` lives in `misc/util.js` on GNOME 45 and
 * moved to `misc/animationUtils.js` in 46, so a static import of either
 * breaks half of the supported range.
 *
 * @param {St.ScrollView} scroll the scroll view
 * @param {Clutter.Actor} actor a descendant of its child
 */
export function ensureVisibleInScrollView(scroll, actor) {
    const adjustment = scroll.vscroll?.adjustment ?? scroll.vadjustment;
    if (!adjustment)
        return;

    const [value, , upper, , , pageSize] = adjustment.get_values();
    let offset = 0;
    let box = actor.get_allocation_box();
    let y1 = box.y1;
    let y2 = box.y2;

    // Walk up to the scrolled child, accumulating offsets, because the row
    // is a grandchild of the scroll view, not its child.
    let parent = actor.get_parent();
    while (parent && parent !== scroll) {
        if (!(parent instanceof St.Widget))
            return;
        box = parent.get_allocation_box();
        offset += box.y1;
        parent = parent.get_parent();
    }
    y1 += offset;
    y2 += offset;

    let newValue = value;
    if (y1 < value)
        newValue = Math.max(0, y1);
    else if (y2 > value + pageSize)
        newValue = Math.min(upper, y2 - pageSize);

    if (newValue !== value)
        adjustment.set_value(newValue);
}
