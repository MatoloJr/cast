# Format spike which stream format does a Chromecast actually play?

Phase 0 deliverable. Tools:
[`dev/spike_formats.py`](../helpers/cast-helper/dev/spike_formats.py) (serves
candidates to a receiver) and
[`dev/diag_receiver.py`](../helpers/cast-helper/dev/diag_receiver.py) (isolates
*why* a receiver refuses one).

Hardware: **"Smart TV"** (mDNS model `Smart TV`, 192.168.100.13:8009), over
Wi-Fi from Ubuntu 26.04.1 / GNOME 50.1, x264enc (no VA-API on this machine).
Date: 2026-10-31.

> ## Correction
>
> An earlier revision of this document concluded "fMP4 works, 24.6 s of
> playback in 25 s". **That was wrong.** It trusted the receiver's own
> `MEDIA_STATUS`, which reported `PLAYING` with an advancing `current_time`
> while the TV displayed nothing. Byte accounting later showed the receiver
> **never opened a single TCP connection** for that run: the "playback
> position" was a stale status from a previous session. The conclusion below
> replaces it.

## How a result is judged

Three oracles, in increasing order of trustworthiness:

1. **`player_state == PLAYING`** worthless on its own. Observed reporting
   PLAYING for a stream the receiver never fetched.
2. **`current_time` advancing** also forgeable. Advanced 24.6 s for a
   stream that was never downloaded.
3. **Bytes the receiver actually pulled from our HTTP server**, sustained
   over the run. A receiver cannot decode what it never downloaded. This is
   the oracle the tools now use and the only one that caught the error above.

Eye confirmation is still prompted interactively (omit `--no-confirm`) and
remains the final word.

## Results

| # | Format | MIME | Receiver fetched | Verdict |
| --- | --- | --- | --- | --- |
| A | fragmented MP4, progressive | `video/mp4` | **0 bytes, 0 connections** | rejected before download |
| B | HLS live, 1 s TS segments | `application/x-mpegURL` | 0 bytes | IDLE / `ERROR` |
| B′ | same, alternate MIME | `application/vnd.apple.mpegurl` | 0 bytes | IDLE / `ERROR` |
| C | raw MPEG-TS, progressive | `video/mp2t` | 0 bytes | IDLE after 4.3 s **what ships today** |
| D | **Matroska, progressive** | `video/x-matroska` | *needs-hardware* | **decodes locally; GND ships this** |

All candidates decode correctly in local `ffprobe`, so none of these failures
are broken bytes.

### The network path is fine proved separately

`diag_receiver.py --probe static` serves a short, complete, faststart
H.264+AAC MP4 with `Content-Length` and `Range` support from this machine:

```text
static  playing=yes hits=1 bytes=1.23 MB  receiver reached THIS machine and pulled 1.23 MB
        0.2s PLAYING ... 10.0s PLAYING pos=8.503458 ... 11.5s IDLE (FINISHED)
```

So: **no AP client isolation, no firewall block and the receiver's media
player works.** (`ufw` is `ENABLED=no` on this machine.) Every failure above
is the receiver refusing the *delivery format*, not a connectivity problem.
This also rules out S9's firewall theory as the cause here.

A `--probe public` run against a public HTTPS sample failed on this TV, so it
likely has no working internet route; irrelevant to the local-streaming case.

### Why fMP4, HLS and TS all fail and what works

The decisive evidence is not from our own experiments but from
**GNOME Network Displays 0.99**, which streams to Chromecast successfully and
which the brief nominates as the reference implementation. Its shipping recipe
(`src/cc/cc-media-factory.{c,h}`, `src/cc/cc-http-server.c`,
`src/cc/cc-ctrl.c`):

| Choice | GND's value |
| --- | --- |
| Container | **`matroskamux streamable=true`** `video/x-matroska` |
| Video | H.264, **`profile=high`**, **`stream-format=avc`** (not byte-stream) |
| Audio | Opus, or AAC (`fdkaacenc`/`avenc_aac`/`faac`), or none |
| `streamType` | `"LIVE"` |
| URL | `http://<ip>:<port>/` |
| Transfer | `SOUP_ENCODING_EOF` no `Content-Length`, close-delimited |
| Fan-out | **`multisocketsink`**, `sync-method=latest-keyframe`, `recover-policy=most-recent-keyframe`, `burst-format=buffers` |

And, decisively, **every MP4 profile in GND's table is commented out**, with
the source comments:

```c
/* TODO: investigate black screen with vp8 (audio works)
         investigate mp4 */
...
  {PROFILE_HIGH_H264, ELEMENT_VAH264, ELEMENT_OPUS, ELEMENT_MATROSKA},
//{PROFILE_HIGH_H264, ELEMENT_VAH264, ELEMENT_OPUS, ELEMENT_MP4},
```

An independent project hit the same wall with MP4 on Chromecast and shipped
Matroska instead. That matches our measurement exactly: MP4 (fragmented or
not) is rejected; MPEG-TS is rejected; HLS is rejected.

Note also that `streamType: LIVE` is **not** the problem GND uses it too.

### Matroska has a delivery requirement MPEG-TS does not

Serving Matroska from "now", the way the current `LiveMpegTsServer` does,
produces `Invalid data found when processing input`:

```text
$ ./spike_formats.py --local --only mkv     # serving from current position
local ffprobe: http://127.0.0.1:40145/stream.mkv: Invalid data found when processing input
```

Matroska's EBML header and `Tracks` element occur **exactly once**, at the head
of the stream. MPEG-TS re-sends PAT/PMT and is self-synchronising, so a late
joiner eventually recovers; a Matroska late joiner never can. With the header
replayed to each client, all three variants decode:

```text
mkv        YES   h264,1280,720
mkv-audio  YES   h264,1280,720 + aac
webm-h264  YES   h264,1280,720
```

**This is why `multisocketsink` is the right fan-out mechanism**, not a
hand-rolled per-client deque: it caches the `streamheader` from the caps and
sends it to every new client before bursting from the most recent keyframe.
It solves F3 (per-client completeness), F4 (keyframe-aligned joins) and the
Matroska header problem in one element and it is what the working reference
uses.

## Decision

**Matroska (`video/x-matroska`) is the primary and only enabled format**, with
H.264 high profile in `avc` stream-format, muxed by `matroskamux
streamable=true`, fanned out by `multisocketsink`.

This **overrides the brief's default** of "fMP4 primary, HLS as fallback",
which it explicitly made conditional on the spike ("unless the spike says
otherwise"). The spike says otherwise:

- **fMP4 is removed**, not demoted. It was measured to be rejected without
  even a download attempt and the reference implementation disabled it too.
- **Raw MPEG-TS is removed.** Measured not to work. This is defect F2.
- **HLS stays implemented but off and labelled unverified.** It failed here
  with a correct 4-segment playlist, CORS and both standard MIME types. It is
  kept only because it is the plausible path for receivers that reject
  Matroska and it is not offered as a working fallback until some receiver is
  shown to play it.

Phase 2 is built on the Matroska recipe accordingly.

## Still needs hardware

The one open item. The TV became occupied (`app='YouTube'`, in use by someone)
before Matroska could be tested on it and I stopped rather than interrupt.

```bash
cd helpers/cast-helper/dev
./spike_formats.py --device "Smart TV" --only mkv --only mkv-audio --duration 30
```

Expect, for a pass: `plays=YES`, several MB fetched at roughly the encode
bitrate and a bouncing ball visible on the TV. The script prompts for eye
confirmation; answer honestly, because the receiver's own status cannot be
trusted (see the correction above).

If Matroska also fails on this receiver, the next candidates in order are:
WebM with VP8 (`vp8enc`, GND's other shipping profile), then Matroska with
Opus audio instead of AAC.

## Re-running on other hardware

```bash
./spike_formats.py --list
./spike_formats.py --local                       # no TV: serve + ffprobe
./spike_formats.py --device "..." --only mkv     # interactive, confirms by eye
./diag_receiver.py --device "..." --probe static # is the network path OK?
```

Please append results for any additional receiver, especially any that plays
HLS or MP4 either would turn an "unverified" row into a real one.
