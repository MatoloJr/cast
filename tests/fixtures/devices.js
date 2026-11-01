/**
 * Device dicts in the shape the helper publishes them.
 *
 * Matches `Device.to_variant_dict` in
 * `helpers/cast-helper/cast_helper/discovery.py` and the synthetic Miracast
 * row `dbus_service.py` appends, trimmed to the fields the Shell side reads.
 */

function device(id, name, props = {}) {
    return {
        id,
        name,
        model: name,
        manufacturer: '',
        protocol: 'chromecast',
        cast_type: 'cast',
        host: '192.168.100.13',
        video_capable: true,
        install_uri: '',
        ...props,
    };
}

/** A real receiver, from the reference machine's mDNS capture. */
export const smartTv = device('uuid-smart-tv', 'Smart TV');

/** A second television, so "several receivers" has something to mean. */
export const bedroomTv = device('uuid-bedroom-tv', 'Bedroom TV');

/** Audio-only: discovery marks these not video capable (discovery.py:56-70). */
export const kitchenSpeaker = device('uuid-kitchen', 'Kitchen speaker', {
    cast_type: 'audio',
    video_capable: false,
});

export const speakerGroup = device('uuid-group', 'Downstairs', {
    cast_type: 'group',
    video_capable: false,
});

/**
 * The one synthetic row. It is a hand-off, never a cast target, and
 * `StartCast` on it returns Unsupported (defect S11).
 */
export const miracastHandoff = device('miracast', 'Other wireless displays (Miracast)', {
    protocol: 'miracast-handoff',
    cast_type: 'handoff',
    host: '',
    video_capable: false,
});

/** What a typical living room looks like to the helper. */
export const allDevices = [
    smartTv,
    bedroomTv,
    kitchenSpeaker,
    speakerGroup,
    miracastHandoff,
];
