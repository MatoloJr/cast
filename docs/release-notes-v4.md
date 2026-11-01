# Cast Display 4.0.0

A rewrite of both halves. The helper is a new package on a new D-Bus API,
and the extension no longer polls it. Every defect below was reproduced by
measurement before it was fixed, and the measurements are in `docs/`.

## The headline

**It did not work before.** The shipped code sent a raw, endless MPEG-TS
stream over plain HTTP, which the test receiver refuses outright, and it
split that stream between receivers so none of them got a decodable copy.
Both of those are now measured rather than argued about:
[docs/format-spike.md](format-spike.md),
[docs/phase-0-baseline.md](phase-0-baseline.md).

## Fatal

| ID | Defect | Fix |
| --- | --- | --- |
| **F1** | The in-process GStreamer path required `souphttpserver`, an element GStreamer does not have, so the whole branch was dead code and every cast fell through to a `gst-launch` → `ffmpeg` subprocess chain. | Confirmed absent by probe. The pipeline is now in-process with `multisocketsink`; no subprocess chain, no mythical element. |
| **F2** | Raw MPEG-TS over progressive HTTP as `video/mp2t`. | **Measured:** the receiver goes IDLE ~4 s after load, having downloaded nothing. The format is now Matroska, which is what the working reference implementation ships. Raw TS removed, not demoted. |
| **F3** | One shared deque that every client `clear()`ed, so receivers got slices of the stream. | **Measured at 78.6% / 21.4%** of disjoint bytes between two concurrent clients — a race, not the documented 50/50, and undecodable for both. `multisocketsink` now gives every client a byte-identical stream; verified by sha256. |
| **F4** | Late joiners got no PAT/PMT, no init segment and no keyframe alignment. | `sync-method=latest-keyframe` plus `streamheader` replay. Also fixes Matroska's once-only EBML header, which a per-client deque cannot. |
| **F5** | `install.sh` did not install `gstreamer1.0-plugins-bad`, which provides `h264parse` and `mpegtsmux`. | Installed, along with `gstreamer1.0-libav`. `python3-dbus` dropped. |

## Severe

| ID | Defect | Fix |
| --- | --- | --- |
| **S1** | `_run_locked` took a non-reentrant lock on the main thread and then pumped the main loop, so a `Stop()` during the portal dialog deadlocked the process permanently. | No operation lock at all. The state machine carries a generation counter and `STOP` is accepted in every state. A regression test drives a portal that never answers: StopAll returns in under 2 s and leaves `State=idle`. |
| **S2** | `pychromecast.Chromecast(host=…, port=…)` — a signature that no longer exists. | `get_chromecast_from_cast_info(info, zconf)`. Confirmed against pychromecast 14.0.10. |
| **S3** | Each refresh built a new Zeroconf, blocked 5 s, then closed the Zeroconf the returned objects depended on. | One long-lived `CastBrowser` over one long-lived `Zeroconf`. Reproduced the failure directly: closing it raises `ZeroConfInstanceRequired` on connect. |
| **S4** | `Refresh()` ran a 5 s blocking discovery on the main thread, on every menu open. | Non-blocking re-query. Measured under 1 s, repeatedly. |
| **S5** | `DevicesChanged` fired every 12 s regardless, and the UI rebuilt every row. | Devices are published only on a real diff, `PropertiesChanged` compares before emitting, and the menu updates rows in place. `destroy_all_children` is gone from the codebase. |
| **S6** | Receivers connected sequentially; three TVs could outlast the client's D-Bus timeout. | Parallel on a thread pool, each with its own timeout, one failure contained to its own session. Two receivers took 19.0 s before; `StartCast` now returns in 47 ms and connects concurrently. |
| **S7** | "Add device" re-cast everything, tearing down the pipeline and re-prompting. | `AddDevices` attaches to the running stream. Verified: no new pipeline, no new portal request, no new port, both receivers playing. |
| **S8** | `source == "all"` set `multiple=True` but used only `streams[0]`. | The "all" source is gone. The portal picker chooses the screen. |
| **S9** | The server bound `0.0.0.0` on a guessable path, so anyone on the LAN could watch the screen. | 128-bit token in the URL plus an IP allowlist of just the attached receivers. Verified: 200 for an allowlisted host, 404 for a wrong token, **403 for a correct token from any other address**. A hole in the first version of the fix — loopback granted unconditionally — was caught by its own test and closed. |
| **S10** | The LAN IP came from routing to 8.8.8.8, wrong under VPN, Docker or multiple NICs. | `netutil.source_ip_for(host)` per receiver. This machine has three candidate interfaces. |
| **S11** | Miracast was marked "casting" the moment the GND window opened, and Disconnect did nothing. | It is a hand-off that creates no session. `StartCast` on it returns `Unsupported` and leaves the state idle; `tests/test_miracast.py` keeps it that way. |
| **S12** | Audio-only targets were listed as displays. | Video capability is a **deny-list** on `cast_type == 'audio'` plus non-8009 groups. An allow-list on `'cast'` would have hidden most real TVs, because pychromecast leaves `cast_type` as `None` for any model outside its own table — including the TV this was developed against. |

## Functional gaps

| ID | Gap | Fix |
| --- | --- | --- |
| **G1** | Mirror / Extend / Main-only acted only on local monitors, so they were no-ops on a laptop. | Two separate causes. The display code never ran at all — the proxy was constructed with a bus *type* where a `GDBusConnection` was required, and threw on every enable. And a receiver was not a Mutter monitor: now Extend asks the portal for a `VIRTUAL` source, Mutter creates a real 1920×1080 monitor, and the layouts include it. |
| **G2** | Mirror put different-resolution monitors in one logical monitor using each one's own mode, which Mutter rejects. | `findCommonMode` intersects modes and supported scales. A 1366×768 panel plus a 1920×1080 external settle on 1280×720; when nothing is shared the UI says which resolutions clash. |
| **G3** | Layouts that disabled the built-in screen had no revert timer. | `LayoutGuard`: apply `TEMPORARY`, "Keep these display settings?" counting down from 15 s, revert on timeout, on Escape, or if the stream dies. Only an explicit Keep writes `PERSISTENT`. |
| **G4** | `disable()`, which also runs on screen lock, stopped the cast, and presentation mode then stuck on for ever. | `disable()` releases Shell resources only. Verified: disable/enable leaves `State=streaming`. Presentation mode is derived from helper state, not persisted and replayed, and the `presentation-mode` key is gone. |
| **G5** | No `persist_mode` or `restore_token`, so a prompt on every connect. | `persist_mode=2` with a token saved per mode. Verified: the second connect in extend mode showed no prompt. |
| **G6** | Video only. | Audio from the default output, AAC, with an A/V offset and an optional local mute. Verified `h264 + aac` through the full pipeline. |
| **G7** | Deprecated `St.BoxLayout({vertical})`; no prefs; no shortcut; the indicator was always hidden. | `lib/compat.js` feature-detects `orientation`. Full Adw preferences. `Super`+`K`. The indicator is visible while streaming, with a receiver count. |
| **G8** | The unit was `WantedBy=default.target` with no ordering, so it could start before the portal existed. README had typos. | `PartOf`/`After`/`WantedBy=graphical-session.target`, `NoNewPrivileges`, `PrivateTmp`. README rewritten. |

## Found while fixing the above

Not in the audit, but real:

- **A receiver's own status is not evidence.** The test TV reported `PLAYING`
  with a steadily advancing `current_time` for a stream it never downloaded
  a byte of. An earlier revision of the format spike concluded fMP4 worked
  on that basis. The tools now judge by bytes actually fetched.
- **An idle screen stops streaming.** With a framerate range in the caps, a
  static desktop produced 1 fps, starving the receiver and tripping the new
  stall watchdog. The output rate is now pinned.
- **A virtual monitor is 2×2 unless you ask for a size exactly.** A caps
  range negotiates the minimum, and any framerate constraint stops the
  pipeline dead. Both measured; see
  [phase-4-display-modes.md](phase-4-display-modes.md).
- **`gettext` cannot be called at module scope** on GNOME 45+. It threw at
  import time, so the menu module did not load at all. Only a real Shell
  catches this.
- **Clutter disposes actors from C before JS `destroy()` runs**, so a D-Bus
  change arriving during Shell shutdown drove `_sync()` into dead actors.
- **A presentation-mode failure retried on every sync**, logging eight times
  in a 40 s run.

## Deliberately not implemented

**Concurrent stream groups.** Phase 2 measured 1080p30 x264 at 114–132% of
one core on this i5-4300U, which has no working VA-API encoder. Two streams
would want ~2.5 of 4 threads for encoding alone. One encode fanned out to
many receivers — which is the feature that matters — costs one encoder
regardless of receiver count. `Streams` stays an array and nothing
structurally prevents a second one, but nothing creates one.

**HLS.** Implemented nowhere. It failed on the only available receiver with
a correct 4-segment playlist, CORS headers and both standard MIME types, so
it is a known-but-rejected format value rather than an unverified code path.

**Native Miracast.** Out of scope; GNOME Network Displays does it.

## Still unverified

The format decision rests on a reference implementation and on local
decoding, **not on a picture seen on a television** — the TV became occupied
mid-session and testing stopped rather than interrupting it. Run

```bash
helpers/cast-helper/dev/spike_formats.py --device "<name>" --only mkv
```

and the rest of [manual-tests.md](manual-tests.md) before trusting this on
hardware.
