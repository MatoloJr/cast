# Cast Display

**Cast Display** is a GNOME Shell Quick Settings extension for Ubuntu / GNOME 45+ (Wayland) that combines:

1. **Multi-monitor layouts** (Extend, Mirror, Main only, Secondary only, custom groups)
2. **Presentation mode** (idle/suspend inhibit + Do Not Disturb)
3. **Wireless casting** — Chromecast smart TVs **and** Miracast wireless displays (Windows Cast–like)

One Quick Settings tile. One install command. Designed to feel like **Windows Win+K Cast**: open the menu, devices appear, click **Connect**.

---

## Quick start (recommended)

```bash
git clone https://github.com/MatoloJr/cast.git
cd cast
chmod +x install.sh
./install.sh
```

Then **log out and log back in** (required on Wayland).

Open the system menu (top right) → **Cast Display** → wait for devices → **Connect**.

```bash
make uninstall   # remove extension + helper
```

---

## What it does

| Feature | Behavior |
|--------|----------|
| **Extend** | One logical monitor per display, side by side |
| **Mirror all** | All displays share one logical monitor |
| **Main only** | Builtin/primary only |
| **Secondary only** | First external only |
| **Custom groups** | 3+ monitors: same letter = mirror within group; different letters = extend across groups |
| **Presentation mode** | Blocks idle blanking/suspend; hides notification banners |
| **Connect (Chromecast)** | Portal screen share → encode → LAN HTTP MPEG-TS → TV |
| **Connect (Miracast)** | Opens **gnome-network-displays** for Wi‑Fi Display (same class of tech as Windows Cast) |
| **Reconnect** | Remembers last device for one-click reconnect |

Display layouts use Mutter `org.gnome.Mutter.DisplayConfig` (not `xrandr`). Casting runs in a session helper over D-Bus so the Shell stays unload-safe.

---

## Compared to Windows Cast (Win+K)

| Windows | Cast Display on Linux |
|---------|------------------------|
| Win+K opens Cast flyout | Open Quick Settings → **Cast Display** |
| Auto-scans Miracast receivers | Auto-scans on menu open + continuous Chromecast discovery |
| Click device to connect | **Connect** / **Disconnect** |
| Miracast (Wi‑Fi Direct) | Miracast via **gnome-network-displays** (soft dependency) |
| Duplicate / Extend / Second screen | Layout buttons in the same menu (Mutter logical monitors) |
| Smart TV Cast apps | Chromecast protocol (very common on modern TVs) |

**Note:** Windows Cast is primarily **Miracast**. Many TVs in East Africa also speak **Google Cast**. Cast Display covers both paths in one list (with a protocol badge: *Cast* vs *Wireless display*).

---

## Architecture

```text
GNOME Shell Quick Settings
  └─ Cast Display tile
       ├─ Mutter DisplayConfig     → layouts / grouping
       ├─ SessionManager inhibit   → presentation mode
       └─ org.cast.tools.Cast1     → cast-helper (systemd --user)
            ├─ pychromecast        → Chromecast discover + play_media
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
2. Click **Cast Display**.
3. Status shows **Searching for displays…** then lists devices.
4. Click **Connect** (or **Reconnect** for the last device).
5. Approve the **screen share** portal (Chromecast path).
6. Click **Disconnect** when finished.

**Miracast row** (“Wireless displays”) opens GNOME Network Displays — pick the receiver there (PIN / Wi‑Fi Direct as required by the TV).

Presentation mode can auto-enable while casting (`cast-auto-presentation` GSettings key, default `true`).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No Cast Display tile | Log out/in; `gnome-extensions enable display-and-cast@cast.tools` |
| “Cast helper not running” | `./install.sh --helper-only` then `systemctl --user status cast-helper` |
| No Chromecast devices | Same Wi‑Fi (not guest); disable VPN; `Refresh` / reopen menu |
| TV connects then black | Firewall: allow inbound TCP to the ephemeral stream port from the TV |
| Portal cancelled | Approve Screen Share when prompted |
| No Miracast row | `sudo apt install gnome-network-displays` |
| Audio missing | Phase 3 is **video only** (see roadmap) |

### Logs

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i display-and-cast
journalctl --user -u cast-helper.service -f
gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.cast.tools.Cast1.ListDevices
```

---

## Development

```text
cast/
├── extension.js              # enable/disable, one QS indicator
├── ui/castDisplayMenu.js     # unified menu
├── lib/displayConfig.js      # Mutter layouts
├── lib/presentationMode.js   # inhibit + DND
├── lib/castService.js        # D-Bus client
├── helpers/cast-helper/      # Python session service
├── schemas/                  # GSettings
├── install.sh                # one-shot installer
└── Makefile                  # install / pack / uninstall
```

Helper D-Bus API (`org.cast.tools.Cast1`):

- `ListDevices() → a(ssssb)` — id, name, model, protocol, online  
- `Refresh()`, `HasMiracastSupport()`, `CastDesktop(id, source)`, `Stop()`, `GetStatus()`  
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
