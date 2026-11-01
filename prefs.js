import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CAST_BUS_NAME = 'org.cast.tools.Cast1';
const CAST_OBJECT_PATH = '/org/cast/tools/Cast1';
const CAST_IFACE = 'org.cast.tools.Cast1';

/** Ask the helper what this machine can do, so prefs do not offer fiction. */
function readCapabilities() {
    try {
        const reply = Gio.DBus.session.call_sync(
            CAST_BUS_NAME, CAST_OBJECT_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [CAST_IFACE, 'Capabilities']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000, null
        );
        const dict = reply.deep_unpack()[0].deep_unpack();
        const out = {};
        for (const key in dict) {
            const value = dict[key];
            out[key] = value instanceof GLib.Variant ? value.deep_unpack() : value;
        }
        return out;
    } catch (_e) {
        return null;
    }
}

export default class CastDisplayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const caps = readCapabilities();

        window.add(this._buildGeneralPage(settings, caps));
        window.add(this._buildQualityPage(settings, caps));
        window.add(this._buildNetworkPage(settings, caps));
        window.set_default_size(620, 680);
    }

    // -- General -----------------------------------------------------------

    _buildGeneralPage(settings, caps) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const group = new Adw.PreferencesGroup({title: _('Casting')});
        page.add(group);

        const modeRow = new Adw.ComboRow({
            title: _('Default mode'),
            subtitle: _('Mirror an existing screen, or extend onto the display'),
            model: Gtk.StringList.new([_('Mirror'), _('Extend')]),
        });
        modeRow.selected = settings.get_string('cast-mode') === 'extend' ? 1 : 0;
        modeRow.connect('notify::selected', () => {
            settings.set_string('cast-mode', modeRow.selected === 1 ? 'extend' : 'mirror');
        });
        if (caps && caps.virtual_source === false) {
            modeRow.sensitive = false;
            modeRow.subtitle = _('This desktop cannot create a virtual monitor, so only Mirror is available');
        }
        group.add(modeRow);

        const positions = ['right', 'left', 'above', 'below'];
        const positionRow = new Adw.ComboRow({
            title: _('Place the extended display'),
            subtitle: _('Where the display sits relative to your screens'),
            model: Gtk.StringList.new([
                _('To the right'), _('To the left'), _('Above'), _('Below'),
            ]),
        });
        positionRow.selected = Math.max(0,
            positions.indexOf(settings.get_string('cast-extend-position')));
        positionRow.connect('notify::selected', () => {
            settings.set_string('cast-extend-position',
                positions[positionRow.selected] ?? 'right');
        });
        group.add(positionRow);

        group.add(this._switchRow(settings, 'cast-display-only',
            _('Turn off this computer\'s screens while extending'),
            _('Like "Second screen only". Always confirmed with a 15 second timer that reverts if you do not answer.')));

        group.add(this._switchRow(settings, 'cast-auto-presentation',
            _('Presentation mode while casting'),
            _('Hide notification banners and keep the screen awake')));

        group.add(this._switchRow(settings, 'cast-show-speakers',
            _('Show speakers in the list'),
            _('Audio-only targets cannot display a screen')));

        const shortcutGroup = new Adw.PreferencesGroup({
            title: _('Keyboard shortcut'),
            description: _('Opens Quick Settings at the Cast Display menu'),
        });
        page.add(shortcutGroup);
        shortcutGroup.add(this._shortcutRow(settings, 'open-cast-menu',
            _('Open the Cast Display menu')));

        if (caps)
            page.add(this._buildStatusGroup(caps));
        else
            page.add(this._buildHelperMissingGroup());

        return page;
    }

    _buildStatusGroup(caps) {
        const group = new Adw.PreferencesGroup({
            title: _('This computer'),
            description: _('Reported by the cast helper'),
        });

        const encoder = caps.encoder
            ? `${caps.encoder}${caps.hw_encode ? _(' (hardware)') : _(' (software)')}`
            : _('none found');
        group.add(new Adw.ActionRow({
            title: _('Video encoder'),
            subtitle: caps.encoder_note ? `${encoder} ${caps.encoder_note}` : encoder,
        }));

        group.add(new Adw.ActionRow({
            title: _('Extend onto a display'),
            subtitle: caps.virtual_source
                ? _('Available')
                : _('Not available: no virtual monitor support'),
        }));

        group.add(new Adw.ActionRow({
            title: _('Audio'),
            subtitle: caps.audio
                ? `${_('Available')} (${caps.audio_encoder})`
                : _('No AAC encoder found'),
        }));

        group.add(new Adw.ActionRow({
            title: _('Stream format'),
            subtitle: Array.isArray(caps.formats) ? caps.formats.join(', ') : '',
        }));

        if (caps.miracast !== undefined) {
            group.add(new Adw.ActionRow({
                title: _('Miracast hand-off'),
                subtitle: caps.miracast
                    ? `${_('GNOME Network Displays')} ${caps.gnd_version || ''}`.trim()
                    : _('GNOME Network Displays is not installed'),
            }));
        }
        return group;
    }

    _buildHelperMissingGroup() {
        const group = new Adw.PreferencesGroup({title: _('This computer')});
        group.add(new Adw.ActionRow({
            title: _('The cast helper is not running'),
            subtitle: _('Run ./install.sh, then log out and back in'),
        }));
        return group;
    }

    // -- Quality -----------------------------------------------------------

    _buildQualityPage(settings, caps) {
        const page = new Adw.PreferencesPage({
            title: _('Quality'),
            icon_name: 'video-display-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Video'),
            description: caps && !caps.hw_encode
                ? _('This computer has no hardware encoder. 1080p30 costs more than one CPU core, so 720p is the default.')
                : null,
        });
        page.add(group);

        const heights = [0, 720, 1080];
        const heightRow = new Adw.ComboRow({
            title: _('Maximum resolution'),
            subtitle: _('A cap, not a target: a smaller screen is not upscaled'),
            model: Gtk.StringList.new([_('Automatic'), '720p', '1080p']),
        });
        heightRow.selected = Math.max(0, heights.indexOf(settings.get_int('cast-max-height')));
        heightRow.connect('notify::selected', () => {
            settings.set_int('cast-max-height', heights[heightRow.selected] ?? 0);
        });
        group.add(heightRow);

        const rates = [30, 60];
        const fpsRow = new Adw.ComboRow({
            title: _('Frame rate'),
            model: Gtk.StringList.new(['30 fps', '60 fps']),
        });
        fpsRow.selected = settings.get_int('cast-fps') >= 60 ? 1 : 0;
        fpsRow.connect('notify::selected', () => {
            settings.set_int('cast-fps', rates[fpsRow.selected] ?? 30);
        });
        if (caps && !caps.hw_encode)
            fpsRow.subtitle = _('60 fps without a hardware encoder is unlikely to keep up');
        group.add(fpsRow);

        group.add(this._spinRow(settings, 'cast-bitrate-kbps',
            _('Bitrate'), _('kbps; 0 chooses from the resolution'),
            0, 50000, 500));

        const audioGroup = new Adw.PreferencesGroup({title: _('Audio')});
        page.add(audioGroup);

        const audioRow = this._switchRow(settings, 'cast-audio',
            _('Send audio to the display'), null);
        if (caps && !caps.audio) {
            audioRow.sensitive = false;
            audioRow.subtitle = _('No AAC encoder on this system');
        }
        audioGroup.add(audioRow);

        audioGroup.add(this._switchRow(settings, 'cast-mute-local',
            _('Mute this computer while casting'), null));

        audioGroup.add(this._spinRow(settings, 'cast-audio-delay-ms',
            _('Audio delay'), _('milliseconds; positive delays the audio'),
            -2000, 2000, 10));

        return page;
    }

    // -- Network -----------------------------------------------------------

    _buildNetworkPage(settings, _caps) {
        const page = new Adw.PreferencesPage({
            title: _('Network'),
            icon_name: 'network-wireless-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Stream ports'),
            description: _('A fixed range so a firewall rule is possible. The stream is served only to the displays you cast to, on an unguessable address.'),
        });
        page.add(group);

        group.add(this._spinRow(settings, 'cast-port-min',
            _('First port'), null, 1024, 65535, 1));
        group.add(this._spinRow(settings, 'cast-port-max',
            _('Last port'), null, 1024, 65535, 1));

        const firewall = new Adw.PreferencesGroup({
            title: _('Firewall'),
            description: _('If you use ufw, allow the range from your local network only:'),
        });
        page.add(firewall);

        const min = settings.get_int('cast-port-min');
        const max = settings.get_int('cast-port-max');
        const command = `sudo ufw allow from 192.168.0.0/16 to any port ${min}:${max} proto tcp comment 'Cast Display'`;
        const row = new Adw.ActionRow({
            title: _('Command'),
            subtitle: command,
            subtitle_selectable: true,
        });
        const copy = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Copy'),
        });
        copy.connect('clicked', () => {
            Gdk.Display.get_default().get_clipboard().set(command);
        });
        row.add_suffix(copy);
        firewall.add(row);

        const privacy = new Adw.PreferencesGroup({title: _('Privacy')});
        page.add(privacy);
        privacy.add(new Adw.ActionRow({
            title: _('Who can see the stream'),
            subtitle: _('Only the displays you selected. Requests from any other address are refused and the stream address contains a 128-bit random token.'),
        }));
        return page;
    }

    // -- helpers -----------------------------------------------------------

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title});
        if (subtitle)
            row.subtitle = subtitle;
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spinRow(settings, key, title, subtitle, lower, upper, step) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({
                lower, upper,
                step_increment: step,
                page_increment: step * 10,
                value: settings.get_int(key),
            }),
        });
        if (subtitle)
            row.subtitle = subtitle;
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _shortcutRow(settings, key, title) {
        const row = new Adw.ActionRow({title});
        const label = new Gtk.ShortcutLabel({
            accelerator: settings.get_strv(key)[0] ?? '',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(label);

        const change = new Gtk.Button({
            label: _('Change'),
            valign: Gtk.Align.CENTER,
        });
        change.connect('clicked', () => {
            this._captureShortcut(row.get_root(), accelerator => {
                settings.set_strv(key, accelerator ? [accelerator] : []);
                label.accelerator = accelerator ?? '';
            });
        });
        row.add_suffix(change);

        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Remove the shortcut'),
        });
        clear.connect('clicked', () => {
            settings.set_strv(key, []);
            label.accelerator = '';
        });
        row.add_suffix(clear);
        return row;
    }

    _captureShortcut(parent, onChosen) {
        const dialog = new Adw.MessageDialog({
            transient_for: parent,
            modal: true,
            heading: _('Press a shortcut'),
            body: _('Press the key combination, or Escape to cancel.'),
        });
        dialog.add_response('cancel', _('Cancel'));

        const controller = new Gtk.EventControllerKey();
        dialog.add_controller(controller);
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape && mask === 0) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;
            onChosen(Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask));
            dialog.close();
            return Gdk.EVENT_STOP;
        });

        dialog.present();
    }
}
