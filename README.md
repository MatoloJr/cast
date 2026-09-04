# Cast Display (Phase 2)

GNOME Shell Quick Settings extension for multi-monitor layouts, presentation mode, and Chromecast screen mirroring on Ubuntu / GNOME 45+ (Wayland).

One Quick Settings tile — **Cast Display** — covers:

- **Layout:** Extend, Mirror all, Main only, Secondary only
- **Custom grouping** when 3+ monitors are connected (mirror within a group, extend across groups)
- **Presentation mode:** inhibits idle/suspend and suppresses notification banners
- **Cast to…:** discover Chromecast devices, mirror the desktop, stop casting

Display changes use Mutter’s `org.gnome.Mutter.DisplayConfig` D-Bus API. Casting uses a small session helper (`cast-helper`) over D-Bus.

## Requirements

- GNOME Shell 45–50 (tested on GNOME Shell 50 / Ubuntu 26.04)
- Wayland session
- Chromecast / Cast-compatible TV on the same LAN (for casting)
- Helper dependencies (installed by `./install-helper.sh`)

## Install extension (development symlink)

```bash
glib-compile-schemas schemas/

mkdir -p ~/.local/share/gnome-shell/extensions
ln -sfn "$(pwd)" ~/.local/share/gnome-shell/extensions/display-and-cast@cast.tools

gnome-extensions enable display-and-cast@cast.tools
```

On Wayland, log out and back in after enabling (or first install).

## Install cast helper (required for Cast to…)

```bash
chmod +x install-helper.sh
./install-helper.sh
```

This installs a user systemd unit, a Python venv with `pychromecast`, and D-Bus activation for `org.cast.tools.Cast1`.

```bash
systemctl --user status cast-helper.service
gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.cast.tools.Cast1.ListDevices
```

### Helper system packages

`install-helper.sh` will try to install:

- `python3-venv`, `python3-gi`, `python3-dbus`, `ffmpeg`
- `gstreamer1.0-tools`, `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`
- `gstreamer1.0-plugins-ugly` (optional; native `x264enc` path)
- `gstreamer1.0-pipewire`
- Optional: `gstreamer1.0-vaapi` for hardware encode

If `x264enc` / `souphttpserver` are missing, the helper falls back to **ffmpeg libx264** over HTTP (recommended on Ubuntu).

## Install (packaged zip)

```bash
gnome-extensions pack . --force \
  --extra-source=lib \
  --extra-source=ui \
  --extra-source=helpers \
  --extra-source=install-helper.sh \
  --extra-source=README.md

rm -f ~/.local/share/gnome-shell/extensions/display-and-cast@cast.tools
gnome-extensions install --force display-and-cast@cast.tools.shell-extension.zip
gnome-extensions enable display-and-cast@cast.tools
./install-helper.sh
```

## Reload the shell

- **Wayland:** log out / log in (or reboot). `Alt+F2` → `r` does not reload on Wayland.
- **X11:** `Alt+F2`, type `r`, Enter.

## End-to-end checklist

1. After login, Quick Settings shows **exactly one** Cast Display tile (not separate Displays / Presentation tiles).
2. Layout buttons change monitor layout; with 3+ monitors, grouping Apply works.
3. Presentation mode switch inhibits idle/suspend and hides banners.
4. Cast helper is active (`systemctl --user is-active cast-helper`).
5. **Refresh** lists Chromecast devices on the LAN.
6. **Mirror** shows the GNOME screen-share portal; approve it; the TV shows the desktop (video only — no audio in Phase 2).
7. **Stop** ends the session on the TV and clears the tile “casting” state.
8. Disabling the extension stops an active cast.

## Firewall / network notes

- The helper serves an HTTP MPEG-TS stream on a LAN IP (not localhost). The Chromecast must reach that host:port.
- Allow ephemeral TCP from the TV to this PC while casting, or temporarily disable a host firewall to test.
- PC and Cast device must be on the same Layer-2/LAN segment (guest Wi‑Fi isolation often breaks discovery).

## Logs

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i display-and-cast
journalctl --user -u cast-helper.service -f
```

## Disable / uninstall

```bash
gnome-extensions disable display-and-cast@cast.tools
systemctl --user disable --now cast-helper.service
rm -f ~/.config/systemd/user/cast-helper.service
rm -f ~/.local/share/dbus-1/services/org.cast.tools.Cast1.service
rm -rf ~/.local/share/cast-display
rm ~/.local/share/gnome-shell/extensions/display-and-cast@cast.tools
```

## Layout notes

| Action | Behavior |
|--------|----------|
| Extend | One logical monitor per display, side by side |
| Mirror all | All displays share one logical monitor |
| Main only | Builtin (or primary) display only; others disabled |
| Secondary only | First non-main display only; others disabled |
| Custom groups | Same letter = mirrored; different letters = extended |

Group assignments are stored by connector name in extension settings.

## Phase roadmap

- **Phase 2 (current):** Chromecast desktop mirror + unified Cast Display UI
- **Phase 3:** DLNA (reuse local stream URL)
- **Phase 4:** Miracast via gnome-network-displays
