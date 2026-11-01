# Phase 0 baseline findings

What was measured on the reference machine before any rewrite, so later phases
can be held to it. Reference machine: Ubuntu 26.04.1, GNOME Shell 50.1,
Wayland, PipeWire, Python 3.14.4, GStreamer 1.28.2, ffmpeg 8.0.1,
pychromecast 14.0.10. Full environment dump: [`doctor-sample.txt`](doctor-sample.txt).

## Defects reproduced by running, not by reading

### F1 `souphttpserver` does not exist

```
$ gst-inspect-1.0 souphttpserver ; echo $?
1
```

The soup plugin ships `souphttpsrc` and `souphttpclientsink` only. The
condition at `cast_helper.py:373` is therefore never true and the whole
in-process GStreamer branch is dead code. Every cast falls through to the
`gst-launch → ffmpeg` subprocess chain. **Confirmed.**

### F2 raw MPEG-TS is not playable by the receiver

Measured in the format spike: the Default Media Receiver goes IDLE ~4 s after
`play_media(url, "video/mp2t", LIVE)`, while fMP4 from the identical encoder
plays in real time. See [`format-spike.md`](format-spike.md). **Confirmed and
identified as the root cause of "connects, then black".**

### F3 the shared deque splits the stream between clients

`LiveMpegTsServer` keeps one deque that every client handler drains with
`clear()`. Two clients reading the live stream concurrently for 6 s:

```
client0: bytes=270336 sha=308015609714453d
client1: bytes= 73728 sha=e79bb8291cb029a8
total=344064  split=78.6%/21.4%
DIFFERENT CONTENT -> each client got a partial, undecodable stream
```

The audit predicted a 50/50 split; in practice it is a **race**, so the split
is arbitrary and neither client gets a usable stream. Two concurrent `ffprobe`
clients on the same endpoint:

- one returns `non-existing PPS 0 referenced` / `no frame!` repeatedly before
  eventually syncing;
- the other fails outright (exit 1).

**Confirmed and worse than documented.** Multi-device is not merely degraded,
it is broken for every participant including the first.

### F4 late joiners get no PAT/PMT and no keyframe alignment

Visible in the same trace: even the client that survives opens with a run of
`non-existing PPS 0 referenced` because it begins mid-GOP with no parameter
sets. **Confirmed.**

### S2 the pychromecast fallback constructor raises TypeError

```
Chromecast sig: (self, cast_info: 'CastInfo', *, tries=None, timeout=None,
                 retry_wait=None, zconf=None)
```

`cast_helper.py:632` calls `pychromecast.Chromecast(host=…, port=…)`.
**Confirmed** against pychromecast 14.0.10.

### S3 closing Zeroconf breaks the device objects it returned

Reproduced accidentally while writing the spike: calling
`get_chromecast_from_cast_info(info, None)` after the discovering `Zeroconf`
was closed raises `pychromecast.error.ZeroConfInstanceRequired`, because
pychromecast resolves `cast_type` lazily over mDNS at connect time. The
long-lived shared `Zeroconf` required by Phase 1.4 is not an optimisation, it
is a correctness requirement. **Confirmed.**

### S6 receivers are connected sequentially

`CastDevices` to two fake receivers took **19.0 s** wall clock, ~9 s each,
strictly serialised. Three real TVs would plausibly exceed the client's 120 s
D-Bus timeout. **Confirmed.**

### S10 the LAN-IP heuristic has three candidate interfaces here

`doctor` finds `wlo1 192.168.100.32/24`, `br-3a062c30c970 172.19.0.1/16` and
`docker0 172.17.0.1/16`. Routing to 8.8.8.8 happens to pick the right one on
this machine, but the per-receiver `source_ip_for(host)` approach is the only
correct one. **Confirmed as a live risk.**

## New finding, not in the audit: `cast_type` is usually `None`

S12 proposes hiding audio-only targets using `cast_type == 'audio'`. On real
hardware `cast_type` is **`None`** for any model not in pychromecast's
hardcoded `CAST_TYPES` table including the TV on this LAN:

```
model_name = 'Smart TV'
cast_type  = None
manufacturer = None
```

pychromecast only sets `cast_type` from that table (`discovery.py:241-248`),
plus `group` for any service on a port other than 8009.

**Implication for Phase 1.4:** the rule must be *deny-list*, not allow-list.
`cast_type == 'audio'` → `video_capable=false`; everything else, **`None`
included**, → `video_capable=true`. An allow-list on `'cast'` would hide most
real TVs.

## Capabilities of the reference machine

| Capability | Result |
| --- | --- |
| ScreenCast portal version | 5 (≥4, so `persist_mode`/`restore_token` are available fixes G5) |
| `AvailableSourceTypes` | 7 = MONITOR \ | WINDOW \ | **VIRTUAL** → **Extend is genuinely possible here** (G1/Phase 4) |
| `AvailableCursorModes` | 7 = HIDDEN \ | EMBEDDED \ | METADATA |
| H.264 encoder | `x264enc` only **no VA-API** (`vah264enc`/`vaapih264enc` absent, `va` plugin present but exposes no encoder) |
| fMP4 muxing | no `isofmp4mux`/`cmafmux` in GStreamer 1.28.2 here → the **ffmpeg `-c copy` remux path of Phase 2.2 is the one that will actually run** |
| AAC encoder | `avenc_aac`, `voaacenc` (no `fdkaacenc`) |
| GNOME Network Displays | 0.99.0-1 installed (≥0.91, so MICE is supported) |
| Firewall | `ufw status` needs root; unresolved, flagged by doctor |

Two consequences for later phases:

1. **Phase 2 CPU numbers on this machine will be x264 numbers.** The hardware
   encoder path cannot be measured here and must stay `needs-hardware`.
2. **Phase 2.2 should not depend on `isofmp4mux`.** It is absent on the
   reference machine, so the ffmpeg remux is the primary implementation and
   the GStreamer muxer an opportunistic optimisation.

## Dev harness

```bash
cd helpers/cast-helper
./dev/run_helper.sh --testsrc --fake 2    # no screen, no portal, no TV
./dev/run_helper.sh --doctor
```

`CAST_HELPER_TEST_SOURCE=1` swaps the portal + PipeWire capture for
`videotestsrc`; `CAST_HELPER_FAKE_DEVICES=N` adds N receivers whose "play"
runs `ffprobe` against the stream URL and succeeds only if a video stream
decodes. Verified working against the **current, unfixed** helper:

```
$ gdbus call ... ListDevices
([('84a96440-…', 'Smart TV', …), ('fake:8f0763da-…', 'Fake Receiver 1', …),
  ('fake:b1cfc71f-…', 'Fake Receiver 2', …), ('miracast:…', …)],)
$ gdbus call ... CastDevices "['fake:8f07…','fake:b1cf…']" "primary"
()   # 19.0 s
$ gdbus call ... ListSessions
([('fake:8f07…', 'Fake Receiver 1', 'casting'), ('fake:b1cf…', 'Fake Receiver 2', 'casting')],)
```

Both fake receivers decoded video but only because they probe **one after
the other**. Run concurrently they hit F3, as shown above. That is the
regression the Phase 2 StreamServer tests must lock down.

## Deferred to Phase 1

**S1 (the `_run_locked` deadlock)** is not reproduced here. Reproducing it
needs a portal dialog left open on the live desktop. Phase 1 covers it properly
with a fake portal that never answers, as a regression test, per its exit
criteria.
