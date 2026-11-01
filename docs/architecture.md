# Architecture

Two processes. A GNOME Shell extension that owns the UI and the monitor
layout and a Python helper that owns the capture, the encode and the
receivers. They speak D-Bus.

```text
GNOME Shell (GJS)                         cast-helper (Python, systemd --user)
┌───────────────────────────────┐        ┌──────────────────────────────────────┐
│ extension.js                  │        │ __main__.py       bus name + loop    │
│   QS tile, top-bar indicator, │        │ dbus_service.py   org.cast.tools.    │
│   Super+K, lifecycle          │        │                   Cast1, API v2      │
│ ui/castDisplayMenu.js         │ D-Bus  │ state.py          the one state      │
│   incremental device rows     │◄──────►│                   machine            │
│ lib/castClient.js             │ props  │ discovery.py      CastBrowser        │
│   cached props + signals      │ + sigs │ portal.py         ScreenCast, async  │
│ lib/displayModes.js           │        │ pipeline.py       GStreamer          │
│ lib/layout.js   (pure, tested)│        │ stream_server.py  HTTP + handoff     │
│ lib/layoutGuard.js revert     │        │ receivers.py      N × Chromecast     │
│ lib/presentationMode.js       │        │ audio.py          sink capture, mute │
│ prefs.js (Adw)                │        │ miracast.py       GND hand-off       │
└───────────────────────────────┘        │ netutil.py, config.py, doctor.py     │
                                         └──────────────────────────────────────┘
                                                        │
                                         one encode ────┼────► many receivers
                                                        │
                                              multisocketsink
```

## Why two processes

The Shell is single-threaded and shared with the whole desktop. A stall in
an extension stalls the user's session. Capture, H.264 encoding, mDNS
discovery and talking to televisions are all things that block or go wrong
slowly, so they live in a separate process that can be restarted by systemd
without touching the Shell.

The helper also outlives `disable()`, which is what makes a cast survive a
screen lock (gap G4). The Shell's copy of the state is a *view*; the helper
is the truth.

## The D-Bus interface

`org.cast.tools.Cast1` at `/org/cast/tools/Cast1`, API version 2.

State is exposed as **properties**, not as methods to poll:
`ApiVersion`, `State`, `LastError`, `Devices`, `Sessions`, `Streams`,
`Capabilities`. Changes arrive through
`org.freedesktop.DBus.Properties.PropertiesChanged` and the helper compares
values before emitting, so an unchanged discovery tick does not wake the UI.

Methods are `Refresh`, `StartCast`, `AddDevices`, `RemoveDevice`,
`StopStream`, `StopAll`, `OpenMiracast`, plus an `Error(scope, id, message)`
signal. **Every method returns immediately.** `StartCast` validates its
arguments, allocates a `stream_id` and returns; the portal dialog and the
receiver connections happen afterwards and report through properties.
Measured on the reference machine: StartCast 47 ms, AddDevices 45 ms,
StopAll 34 ms.

Failures use named errors `Error.Busy`, `Error.NotFound`,
`Error.PortalDenied`, `Error.NoEncoder`, `Error.Network`,
`Error.Unsupported` so the Shell can say something specific instead of
echoing a stack trace.

## The rules the helper is built around

**One state machine.** `state.py` declares every transition in a table.
Nothing else assigns to the state, which is what keeps the `State` property
honest: it cannot say `streaming` unless a `PIPELINE_READY` event actually
arrived.

**Nothing blocks the main loop.** No nested `MainContext.iteration()`, no
operation lock. Long work runs on worker threads or as async GIO calls and
posts back with `GLib.idle_add`; only the main thread mutates state.

**Stop works in every state.** Including with a portal dialog open, which
used to deadlock the process for good (defect S1). Instead of a lock, the
state machine carries a generation counter: `STOP` bumps it and any async
callback belonging to an older generation is discarded. `tests/
test_service_integration.py` drives this against a portal that never
answers.

## The stream

One capture and one encode, fanned out to as many receivers as are
attached. Adding or removing a receiver never restarts it.

```text
pipewiresrc (portal fd)
  → [extend only: exact width/height, no framerate]
  → videoconvert → videoscale add-borders → videorate
  → video/x-raw,NV12,width=[2,W,2],height=[2,H,2],par=1/1,framerate=fps/1
  → queue leaky=downstream
  → x264enc | vah264enc | vaapih264enc | openh264enc
  → h264parse → video/x-h264,stream-format=avc,alignment=au,profile=high
  → matroskamux streamable=true
  → queue → multisocketsink
```

Format choices are measured, not assumed; see
[format-spike.md](format-spike.md). **Matroska**, not fragmented MP4 or
MPEG-TS, because those were refused by the test receiver without it even
downloading them and because GNOME Network Displays which works ships
Matroska and has every MP4 profile commented out.

**`multisocketsink` does the fan-out.** It replays the muxer's
`streamheader` to each new client and starts them on a keyframe, which fixes
per-client completeness (F3), unaligned late joins (F4) and Matroska's
once-only EBML header in one element. A hand-rolled per-client queue got all
three wrong: two concurrent clients used to receive a race-dependent
78.6%/21.4% split of disjoint bytes; they now receive byte-identical
streams.

The encoder is **verified, not assumed**: each candidate encodes ten real
frames before it is trusted, because VA-API is routinely installed on
machines with no usable encode device. A fallback is reported in
`Capabilities.encoder_note`.

A **watchdog** fails the stream if no encoded frame arrives for 5 s, so a
dead capture becomes an error rather than a frozen picture under a UI still
claiming "Playing". The output framerate is pinned so an idle screen keeps
producing frames and does not trip it see [phase-5-audio.md](phase-5-audio.md).

## Who may watch the screen

The payload is the user's desktop, so the stream server is a door, not a
pipe.

- The URL carries a **128-bit random token**:
  `http://<ip>:<port>/s/<stream_id>/<token>/stream.mkv`. A wrong or missing
  token gets 404.
- An **IP allowlist** holds only the receivers attached to that stream. Any
  other address gets 403, *even with a valid token*. Loopback is granted
  only when the dev harness is running or a receiver genuinely is on
  loopback not unconditionally, which would let any local process with the
  token read the screen.
- The port comes from a **fixed configurable range** (8765–8775 by default),
  so a firewall rule is possible at all.
- `netutil.source_ip_for(host)` picks the interface that actually reaches
  *that* receiver, rather than whichever one routes to a public address
  (defect S10). This machine has three candidates, so it is not academic.

Once the response headers are written, the socket is handed to
`multisocketsink` and GStreamer does the writing the same arrangement
GNOME Network Displays uses, except that its allowlist is `#if 0`'d out and
this one is on.

## Display modes

Mirror asks the portal for a `MONITOR` source: the user picks a screen and
nothing about the local layout changes.

Extend asks for a `VIRTUAL` source. Mutter then creates a real monitor that
appears in `DisplayConfig`, so Extend and "turn off this computer's screens"
become genuine Mutter layouts that include the receiver. The exact caps this
requires and the 2×2 monitor you get if you get them wrong, are in
[phase-4-display-modes.md](phase-4-display-modes.md).

All layout arithmetic lives in `lib/layout.js`, which imports no `gi://`
modules and is therefore unit-testable against recorded `GetCurrentState`
fixtures. `lib/displayConfig.js` only talks to Mutter. Anything that would
switch off a live monitor goes through `lib/layoutGuard.js`, which applies
temporarily and reverts after 15 s unless the user confirms.

## Miracast

Not implemented and not pretended. Native Miracast means Wi-Fi Direct,
WFD/RTSP session negotiation and HDCP; GNOME Network Displays already does
that. The device list carries one row that opens GND, or offers to install
it and **no session or cast state is ever created for it** which defect
S11 got wrong. `tests/test_miracast.py` keeps it that way.

## Testing

| Layer | How |
| --- | --- |
| State machine, discovery, pipeline construction, config | `pytest`, pure |
| Stream server | `pytest` against real sockets and a real GLib loop |
| The whole service | `pytest` over a private `dbus-daemon`, including a portal that never answers |
| Layout arithmetic | `node --test` against recorded `GetCurrentState` fixtures |
| The extension in a real Shell | `dev/run_nested_shell.sh` |
| A real receiver | [manual-tests.md](manual-tests.md) |

`make test` runs everything that does not need hardware: 107 pytest cases,
44 layout cases, ESLint, ruff and a strict schema compile.

The dev harness replaces the two things that need a human and a television:
`CAST_HELPER_TEST_SOURCE=1` swaps the portal and PipeWire for
`videotestsrc` and `CAST_HELPER_FAKE_DEVICES=N` adds receivers that "play"
by running `ffprobe` against the stream URL and fail unless a video stream
decodes. A fake receiver is a real client, not a stub that says yes.
