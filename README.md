# Cast Display

Cast your screen to Chromecast and Google TV displays from GNOME's Quick
Settings. Pick one display or several, mirror an existing screen or extend
your desktop onto the TV, and hand off to GNOME Network Displays for
Miracast.

One encode is fanned out to every receiver, so a second television costs
network bandwidth rather than another encoder.

> **Status.** Everything described below has been exercised end to end on
> Ubuntu 26.04 / GNOME Shell 50.1 with the development harness, and the
> display and portal behaviour on real hardware. The items in
> [docs/manual-tests.md](docs/manual-tests.md) marked *needs hardware* —
> above all **a picture on a real television** — have not been confirmed
> yet. Nothing here is described as working on a TV that has not been seen
> working on one; read [docs/format-spike.md](docs/format-spike.md) before
> trusting the format choice.

## What it does

|  |  |
| --- | --- |
| **Mirror** | Share an existing screen. The portal asks which one. |
| **Extend** | Create a virtual monitor for the TV, so it is a second desktop you can drag windows onto. It appears in Settings → Displays. |
| **TV only** | Extend, then switch this computer's screens off, with a 15 second "keep these settings?" timer that reverts if you do not answer. |
| **Several receivers** | Select more than one, or add one mid-stream without re-prompting and without interrupting the others. |
| **Audio** | Send what the computer is playing, with an A/V offset control and an optional "mute this computer while casting". |
| **Miracast** | One row that opens GNOME Network Displays, or offers to install it. |

While casting, a cast icon appears in the top bar with the receiver count,
and notification banners can be hidden automatically.

## Requirements

- GNOME Shell 45–50. Developed and verified on **50.1**, Wayland.
- PipeWire and a working `xdg-desktop-portal` with the ScreenCast interface.
  Portal version 4+ is needed to avoid a permission prompt on every connect;
  **Extend additionally needs the portal to offer the `VIRTUAL` source
  type**, which `--doctor` reports.
- An H.264 encoder GStreamer can use. VA-API (`vah264enc`) if you have it,
  otherwise `x264enc`.
- Python 3.9+ with PyGObject, and `ffmpeg` for the diagnostics.

## Install

```bash
git clone https://github.com/MatoloJr/cast
cd cast
./install.sh
```

Then **log out and back in**. On Wayland the Shell cannot reload itself, so
the tile will not appear until the session restarts. No reboot is needed, and
the helper starts immediately.

The installer puts the extension in
`~/.local/share/gnome-shell/extensions/`, the helper and its virtualenv in
`~/.local/share/cast-display/`, and a systemd user unit that starts with the
graphical session. It also offers to add a `ufw` rule if your firewall is
active, printing the command either way rather than changing anything
silently.

```bash
./install.sh --helper-only   # just the Python side
./install.sh --uninstall     # remove everything, including the saved
                             # screen-share permission
```

## Using it

Quick Settings → **Cast Display**. The chevron opens the menu; tick one or
more displays and press **Connect**. The tile turns off the cast.

`Super`+`K` opens the menu. Everything else lives in the preferences:
mode, resolution, frame rate, bitrate, audio, port range and the shortcut.

## If something goes wrong

Start here. It checks everything the helper depends on and tells you what is
missing:

```bash
~/.local/share/cast-display/cast-helper/venv/bin/python -m cast_helper --doctor
```

A sample of its output on a healthy machine is in
[docs/doctor-sample.txt](docs/doctor-sample.txt).

| Symptom | What `--doctor` shows | What to do |
| --- | --- | --- |
| The tile never appears | — | Log out and back in; check `gnome-extensions info display-and-cast@cast.tools` |
| "The cast helper is not running" | — | `systemctl --user status cast-helper.service`, then `journalctl --user -u cast-helper.service -f` |
| "Helper outdated: run ./install.sh" | — | The extension was updated but the helper was not. Re-run `./install.sh` |
| No displays listed | `devices: none found` | mDNS is not reaching the LAN. Check that UDP 5353 is not blocked and that you are not on a guest network with client isolation |
| The TV connects, then goes black | `encoder chosen: …` is fine | Almost certainly the receiver refusing the stream format. Run `helpers/cast-helper/dev/spike_formats.py --device "<name>"` and add the result to [docs/format-spike.md](docs/format-spike.md) |
| "No video encoder is available" | `[FAIL] h264 encoder` | `sudo apt install gstreamer1.0-plugins-ugly gstreamer1.0-plugins-bad` |
| Casting works but the TV shows nothing | `ufw: active` | Open the stream ports: `sudo ufw allow from <your subnet> to any port 8765:8775 proto tcp` |
| Extend only mirrors | `AvailableSourceTypes` without `VIRTUAL` | Your portal cannot create a virtual monitor. Mirror is all that is available |
| Audio switch is greyed out | `[FAIL] audio` | No AAC encoder: `sudo apt install gstreamer1.0-libav` |
| Wrong network interface used | several `iface` lines | The stream URL is chosen per receiver, so this should not happen; if it does, file it with the `--doctor` output |

Useful commands:

```bash
journalctl --user -u cast-helper.service -f

gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.freedesktop.DBus.Properties.Get org.cast.tools.Cast1 Devices

gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.cast.tools.Cast1.StopAll
```

## Supported receivers

Honestly short, because it only lists what has been measured.

| Receiver | Matroska | Notes |
| --- | --- | --- |
| "Smart TV" (mDNS model `Smart TV`, Default Media Receiver) | *not yet confirmed* | fragmented MP4, HLS and raw MPEG-TS were all **measured to be refused** on this device; see [docs/format-spike.md](docs/format-spike.md) |

If you have a receiver, please run

```bash
helpers/cast-helper/dev/spike_formats.py --device "<name>"
```

and send the table it prints. It is the one thing that cannot be worked out
from this end.

## Privacy

The stream is your screen, so it is treated as such.

- The URL contains a **128-bit random token**. Without it you get 404.
- Only the receivers you cast to may fetch it. Any other address gets
  **403, even with the correct token**.
- The server binds a **fixed port range** (8765–8775 by default) so you can
  firewall it deliberately, rather than a random high port that cannot be
  allowed in advance.
- The URL uses the network interface that reaches that particular receiver,
  not whichever one happens to route to the internet.
- Nothing is sent anywhere else. There is no telemetry, no account and no
  cloud service. The only outbound connections are mDNS discovery on your
  LAN and the Cast protocol to the receivers you chose.
- The screen-share permission you grant is stored in
  `~/.local/state/cast-display/portal.json` so you are not asked every time.
  `./install.sh --uninstall` deletes it.

## Miracast is out of scope

This extension does not implement Miracast, and the device list says so.

Native Miracast means Wi-Fi Direct (P2P) group negotiation, a WFD/RTSP
session, and usually HDCP. That is a wireless-stack problem rather than a
streaming one, it needs a compatible driver and firmware, and
[GNOME Network Displays](https://gitlab.gnome.org/GNOME/gnome-network-displays)
already does it properly — including MICE, Miracast over existing
infrastructure, from version 0.91.

So the list carries exactly one Miracast row. It opens GND, or the software
centre if GND is not installed, and **no cast session is ever created for
it**: the tile does not change state and there is nothing to disconnect.
The previous version marked the cast active the moment the GND window
opened, which meant the UI claimed to be casting when it was not.

## Development

```bash
make test        # pytest + node --test + eslint + ruff + schema check
make pack        # the extension zip, without the helper
make release     # a tarball with the extension, helper and installer
```

Neither a television nor a second monitor is needed for `make test`. The
harness replaces both:

```bash
cd helpers/cast-helper
./dev/run_helper.sh --testsrc --fake 2    # no screen, no portal, no TV
./dev/run_nested_shell.sh                 # the extension in a real Shell
./dev/measure_stream.sh 1280x720@30       # CPU, latency, time to first frame
./dev/spike_formats.py --local            # serve each format and decode it
```

A fake receiver is not a stub: "playing" runs `ffprobe` against the stream
URL and fails unless a video stream actually decodes.

Further reading:

- [docs/architecture.md](docs/architecture.md) — how the two processes fit
  together and why
- [docs/format-spike.md](docs/format-spike.md) — which stream format a
  Chromecast plays, and how that was established
- [docs/phase-4-display-modes.md](docs/phase-4-display-modes.md) — the exact
  caps that make a virtual monitor usable
- [docs/manual-tests.md](docs/manual-tests.md) — the hardware checklist
- [docs/phase-0-baseline.md](docs/phase-0-baseline.md) — the defects this
  rewrite fixed, each reproduced by measurement first

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
