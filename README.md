# Cast Display

**Cast Display** is a GNOME Shell Quick Settings extension for Ubuntu / GNOME 45+ (Wayland) that combines:

1. **Wireless casting** — Chromecast smart TVs **and** Miracast wireless displays
2. **Multi-device connect** — select one or many Chromecasts and share one stream
3. **Project layouts** — Mirror, Extend, Main only, Secondary only (after you connect)

One Quick Settings tile. One install command. Turn the tile **on**, open the menu, pick devices, **Connect**.

---

## Quick start (recommended)

```bash
git clone https://github.com/MatoloJr/cast.git
cd cast
chmod +x install.sh
./install.sh
```

Then **log out and log back in** (required on Wayland).

Open the system menu (top right) → turn **Cast Display** **on** → open the menu (`>`) → select devices → **Connect**.

```bash
make uninstall   # remove extension + helper
```

---



## What it does


| Feature                  | Behavior                                                                   |
| ------------------------ | -------------------------------------------------------------------------- |
| **Tile on/off**          | Primary click activates discovery; off stops casting and hides devices     |
| **Connect (1 device)**   | Normal features: Mirror / Extend / Main only / Secondary only              |
| **Connect (2+ devices)** | Advanced features: per-device modes + Manage (mirror all / group)          |
| **Mirror all**           | Local displays mirrored; Chromecasts share the same stream                 |
| **Custom groups**        | Manage: group connected sinks; 3+ local monitors can be grouped too        |
| **Connect (Chromecast)** | Portal screen share → encode → LAN HTTP MPEG-TS → TV(s)                    |
| **Connect (Miracast)**   | Opens **gnome-network-displays** (single device; not multi-select)         |
| **Auto presentation**    | While casting, optionally inhibits idle and hides banners (no menu toggle) |


Display layouts use Mutter `org.gnome.Mutter.DisplayConfig` (not `xrandr`). Casting runs in a session helper over D-Bus so the Shell stays unload-safe.

---



## Compared to Windows Cast (Win+K)


| Windows                            | Cast Display on Linux                                           |
| ---------------------------------- | --------------------------------------------------------------- |
| Win+K opens Cast flyout            | Turn on **Cast Display**, open the menu                         |
| Auto-scans Miracast receivers      | Auto-scans when on + menu open; continuous Chromecast discovery |
| Click device to connect            | Select device(s) → **Connect** / **Disconnect**                 |
| Miracast (Wi‑Fi Direct)            | Miracast via **gnome-network-displays** (soft dependency)       |
| Duplicate / Extend / Second screen | Layout features after connect (Mutter logical monitors)         |
| Smart TV Cast apps                 | Chromecast protocol (including multi-TV mirror)                 |


**Note:** Windows Cast is primarily **Miracast**. Many TVs in East Africa also speak **Google Cast**. Cast Display covers both paths in one list (with a protocol badge: *Cast* vs *Wireless display*).

---



## Architecture

```text
GNOME Shell Quick Settings
  └─ Cast Display tile (on/off + menu)
       ├─ Mutter DisplayConfig     → layouts / grouping (after connect)
       ├─ SessionManager inhibit   → auto presentation while casting
       └─ org.cast.tools.Cast1     → cast-helper (systemd --user)
            ├─ pychromecast        → Chromecast discover + play_media (N devices)
            ├─ xdg-desktop-portal  → PipeWire screen capture
            ├─ GStreamer / ffmpeg  → H.264 MPEG-TS over LAN HTTP
            └─ gnome-network-displays → Miracast UI (optional)
```

---



## Requirements

- **GNOME Shell 45–50** (tested on Shell 50 / Ubuntu 26.04)
- **Wayland** session (recommended)
- Same LAN as your TV / wireless display (guest Wi‑Fi isolation breaks discovery)
- For Chromecast: helper deps (installed by `./install.sh`)
- For Miracast: `sudo apt install gnome-network-displays`

---



## Installation options



### A. Clone + `./install.sh` (best)

Installs the extension (symlink into `~/.local/share/gnome-shell/extensions/`) **and** the cast helper (venv + systemd user unit + D-Bus activation).

```bash
./install.sh
./install.sh --helper-only   # helper only
./install.sh --uninstall
```

Or: `make install` / `make helper` / `make uninstall`.

### B. GitHub Release zip

1. Download `display-and-cast@cast.tools.shell-extension.zip` from [Releases](https://github.com/MatoloJr/cast/releases).
2. Extract or `gnome-extensions install --force` the zip.
3. From the extracted tree (or a clone), run `./install.sh --helper-only`.
4. Log out / in and enable the extension if needed.



### C. Pack from source

```bash
make pack
# → display-and-cast@cast.tools.shell-extension.zip
```

**Why not Flatpak?** GNOME Shell extensions must load inside the host Shell process. A one-shot user install script + Release zip is the right distribution model.

---



## Usage

1. Open **Quick Settings** (top-right system menu).
2. Click the **Cast Display** tile to turn it **on**.
3. Open the menu with `>`.
4. Select one or more devices (Miracast is exclusive), then **Connect** (or **Connect (N)**).
5. Approve the **screen share** portal (Chromecast path).
6. **One device:** use Mirror / Extend / Main only / Secondary only.
7. **Multiple devices:** use per-device modes or **Manage** (Mirror all / group).
8. **Disconnect** a device or turn the tile **off** when finished.

**Miracast row** (“Wireless displays”) opens GNOME Network Displays — pick the receiver there (PIN / Wi‑Fi Direct as required by the TV).

Presentation mode can auto-enable while casting (`cast-auto-presentation` GSettings key, default `true`). There is no presentation toggle in the menu.

---



## Troubleshooting


| Symptom                   | Fix                                                                     |
| ------------------------- | ----------------------------------------------------------------------- |
| No Cast Display tile      | Log out/in; `gnome-extensions enable display-and-cast@cast.tools`       |
| Menu empty / “is off”     | Click the tile to turn Cast Display **on**                              |
| “Cast helper not running” | `./install.sh --helper-only` then `systemctl --user status cast-helper` |
| No Chromecast devices     | Same Wi‑Fi (not guest); disable VPN; `Refresh` / reopen menu            |
| TV connects then black    | Firewall: allow inbound TCP to the ephemeral stream port from the TV    |
| Portal cancelled          | Approve Screen Share when prompted                                      |
| No Miracast row           | `sudo apt install gnome-network-displays`                               |
| Multi-connect fails       | Restart helper after upgrade: `systemctl --user restart cast-helper`    |
| Audio missing             | Phase 3 is **video only** (see roadmap)                                 |




### Logs

```bash
jsournalctl -f -o cat /usr/bin/gnome-shell | grep -i display-and-cast
journalctl --user -u cast-helper.service -f
gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.cast.tools.Cast1.ListDevice
```

---



## Development

```text
cast/
├── extension.js              # enable/disable, one QS indicator
├── ui/castDisplayMenu.js     # activation, devices, connect branch
├── lib/displayConfig.js      # Mutter layouts
├── lib/presentationMode.js   # inhibit + DND (auto while casting)
├── lib/castService.js        # D-Bus client
├── helpers/cast-helper/      # Python session service
├── schemas/                  # GSettings
├── install.sh                # one-shot installer
└── Makefile                  # install / pack / uninstall
```

Helper D-Bus API (`org.cast.tools.Cast1`):

- `ListDevices() → a(ssssb)` — id, name, model, protocol, online  
- `CastDesktop(id, source)`, `CastDevices(as ids, source)`, `DisconnectDevice(id)`  
- `ListSessions() → a(sss)`, `Stop()`, `GetStatus()`, `Refresh()`, `HasMiracastSupport()`  
- Signals: `DevicesChanged`, `SessionChanged`

---



## Roadmap (enhance next)

- **Audio** in the mirror pipeline (PipeWire audio → AAC/Opus)
- Fewer portal prompts (restore tokens where the portal allows)
- Research **extend desktop onto** a wireless sink (virtual monitor)
- **DLNA/UPnP** renderers (reuse HTTP URL)
- Preferences UI (bitrate, source, auto-reconnect)
- Keyboard shortcut similar to Win+K
- Translations (`po/`)
- CI pack + schema checks; [extensions.gnome.org](https://extensions.gnome.org) listing
- Optional `.deb` package

---



## Uninstall

```bash
./install.sh --uninstall
# or: make uninstall
```

---



## License

MIT — see [LICENSE](LICENSE).

---



## Credits

Built on Mutter DisplayConfig, xdg-desktop-portal ScreenCast, pychromecast, GStreamer/ffmpeg, and optionally [GNOME Network Displays](https://gitlab.gnome.org/GNOME/gnome-network-displays) for Miracast.