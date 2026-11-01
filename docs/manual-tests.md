# Manual hardware test checklist

What cannot be verified without a real receiver and a real screen. Everything
else is covered by `make test` (see [architecture.md](architecture.md) for what
each automated test guards).

Record results inline. "Not run" is a useful answer; a guess is not.

> **Read this first.** A Cast receiver's own status is not evidence. During
> Phase 0 this TV reported `PLAYING` with a steadily advancing
> `current_time` for a stream it had **never downloaded a single byte of**.
> Judge by what you see on the screen and when in doubt check the bytes the
> receiver pulled (`dev/spike_formats.py` prints this). See
> [format-spike.md](format-spike.md).

## Environment for the run

| Field | Value |
| --- | --- |
| Date |  |
| Distro / GNOME / session |  |
| Encoder (`--doctor`) |  |
| Receiver model(s) |  |
| Network (Wi-Fi / wired, AP model) |  |

## Checklist

### 1. Single receiver, Mirror, first picture

- [ ] Quick Settings → Cast Display → **chevron** → pick one TV → **Connect**
- [ ] Approve the screen-share prompt
- [ ] **First frame on the TV within 5 s**
- [ ] Latency under 2 s put a clock or stopwatch on screen and compare

Measured on the reference machine, localhost, no TV involved: first decodable
frame **0.24 s** (1080p30) / **0.42 s** (720p30); lag behind live **0.13–1.20 s**
median **0.59 s**. Add the receiver's own buffering on top of that.

Result:

### 2. The prompt appears once, not every time

- [ ] Stop the cast, then Connect again to the same TV
- [ ] **No screen-share prompt the second time** (portal `restore_token`)
- [ ] Prompt reappears after revoking the permission in Settings → Privacy

Result:

### 3. Two receivers at once

- [ ] Select two TVs → Connect
- [ ] Both show the same desktop
- [ ] Leave it for 10 minutes: no corruption, no divergence, no drift
- [ ] `top`: only **one** encoder process worth of CPU (one encode, fanned out)

Result:

### 4. Add a third receiver mid-stream

- [ ] While two are playing, open the dialog and add a third
- [ ] **No new screen-share prompt**
- [ ] The first two **do not drop or stutter**
- [ ] The third starts within ~5 s

This is defect S7. Verified with fake receivers: `AddDevices` returns in 45 ms,
no new pipeline, no new portal request, no new server port.

Result:

### 5. Remove one of three

- [ ] Disconnect one receiver from the dialog
- [ ] The other two continue uninterrupted
- [ ] The removed one returns to its home screen

Result:

### 6. The user stops it on the device

- [ ] Press Home on the TV remote
- [ ] That session disappears from the dialog within 5 s
- [ ] Other receivers keep playing
- [ ] Tile shows the right state

Result:

### 7. GNOME's own "Stop sharing"

- [ ] While casting, click GNOME's screen-share indicator → Stop sharing
- [ ] Everything stops cleanly, every receiver released
- [ ] Tile returns to Ready, no error notification storm

Result:

### 8. Screen lock

- [ ] Cast to one TV, then lock the screen
- [ ] **The cast continues** (`disable()` must not stop it)
- [ ] Unlock: the dialog still shows the live session
- [ ] Stop the cast: notification banners come back (presentation mode off)

This is gap G4. The old code stopped the cast on lock and left presentation
mode stuck on afterwards.

Result:

### 9. Extend and TV only

- [ ] Switch the stream mode to **Extend**
- [ ] A separate desktop appears on the TV
- [ ] Windows can be dragged onto it
- [ ] It appears in Settings → Displays as a monitor
- [ ] **TV only**: physical screens switch off, TV keeps the desktop
- [ ] The "Keep these display settings?" dialog appears
- [ ] **Do nothing for 15 s → the layout reverts by itself**
- [ ] Stopping the stream restores the original layout exactly

Result:

### 10. Audio

- [ ] Enable audio in preferences, cast, play something
- [ ] Sound comes out of the TV
- [ ] A/V stays in sync for 10 minutes (under ~100 ms drift)
- [ ] "Mute this computer while casting" mutes locally and restores on stop

Result:

### 11. VPN / multiple interfaces

- [ ] Connect a VPN, or have Docker running, then cast
- [ ] The stream URL uses the LAN interface that reaches the TV, not the VPN
- [ ] If no route exists, a clear error naming the device, not a silent hang

This is defect S10. The reference machine has three candidate interfaces
(`wlo1`, `docker0`, a bridge), so this is not hypothetical.

Result:

### 12. Another host cannot watch your screen

- [ ] While casting, find the stream URL: `journalctl --user -u cast-helper -f`
- [ ] From **another machine** on the LAN, open that exact URL
- [ ] **It must return 403**, not video

Verified locally: valid token from a non-receiver IP → **403**; wrong or
missing token → **404**. Do it from real hardware too, because that exercises
the receiver allowlist rather than loopback.

Result:

### 13. Helper restart under the UI

- [ ] While casting: `systemctl --user restart cast-helper.service`
- [ ] The UI notices and says the helper stopped, rather than claiming to cast
- [ ] systemd restarts it; the tile recovers to Ready
- [ ] No stale session rows left behind

Result:

### 14. Miracast entry is honest

- [ ] The list shows one "Other wireless displays (Miracast)" entry
- [ ] Clicking it opens GNOME Network Displays
- [ ] **No cast session is created**, the tile does not say casting
- [ ] It cannot be selected together with Cast devices
- [ ] With GND uninstalled, it offers to install instead

This is defect S11. Covered by an automated test too: `StartCast` on the
Miracast id returns `Unsupported` and leaves `State=idle`.

Result:

### 15. Hardware encoder (needs a machine with VA-API)

The reference machine has **no working VA-API encoder** (`vah264enc` and
`vaapih264enc` absent; the `va` plugin loads but exposes no encoder), so the
hardware path is unverified.

- [ ] On a machine with VA-API: `--doctor` reports `hw_encode: true`
- [ ] Casting 1080p30 uses markedly less CPU than the software numbers below
- [ ] If the hardware encoder fails at runtime, the helper falls back to x264
      automatically and says so in `Capabilities.encoder_note`

Result:

### 16. The dialog fits the screen it is on

This is the defect the dialog exists for: the old Quick Settings dropdown
ran off the bottom of a laptop panel and its lower half could not be
reached at all.

Verified headlessly on a 1366x768 virtual monitor with 12 devices: work
area 736 px, device list clamped from a natural 768 px to **393 px**, whole
dialog **697 px**. Repeat it on real hardware, because a theme with a
larger font changes the chrome height:

- [ ] On the smallest screen you have, with as many receivers as you can
      get listed, open the dialog
- [ ] **Connect**, **Stop casting** and **Close** are all on screen
- [ ] The device list scrolls; nothing else does
- [ ] Mode, the switches and the settings link are all reachable
- [ ] Drag the dialog's monitor out (unplug a second screen) while it is
      open: it re-sizes rather than being clipped

Result:

### 17. The tile is a switch, not a second menu

- [ ] With no cast history, clicking the **tile body** opens the dialog and
      the tile does **not** latch on
- [ ] Cast to a TV, stop, then click the tile body: it casts to that same
      TV again **without** opening the dialog
- [ ] Switch that TV off, then click the tile: it opens the dialog rather
      than hanging on a receiver that is not there
- [ ] Preferences → *Forget* clears it, and the tile opens the dialog again
- [ ] `Super`+`K` opens the dialog with Quick Settings closed, and from the
      overview, with no panel flashing open behind it
- [ ] The chevron never shows an empty dropdown

Result:

## Reference CPU numbers (software encode, for comparison)

Reference machine, `videotestsrc` through the full pipeline, one receiver,
measured with `dev/measure_stream.sh`:

| Encode | CPU (one core = 100%) | RSS | First frame | Lag behind live |
| --- | --- | --- | --- | --- |
| 720p30, x264enc veryfast/zerolatency | **61%** | ~100 MB | 0.42 s | 0.13 s |
| 1080p30, x264enc veryfast/zerolatency | **114–132%** | ~135 MB | 0.24 s | 1.20 s |

Because 1080p software encode costs more than a full core, the helper
**defaults to 720p when there is no hardware encoder**. Preferences can raise
it. With VA-API the default is 1080p.

Reproduce:

```bash
cd helpers/cast-helper
systemctl --user stop cast-helper.service
./dev/measure_stream.sh 1280x720@30
./dev/measure_stream.sh 1920x1080@30 1080
```

Note: `ffprobe` is the wrong tool for measuring latency its read-ahead
inflated the figure to 3.16 s where a GStreamer client measured 0.59 s median
on the same stream. `dev/measure_latency.py` does it properly.
