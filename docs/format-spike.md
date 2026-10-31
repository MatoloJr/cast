# Format spike — which stream format does a Chromecast actually play?

Phase 0 deliverable. Run with
[`helpers/cast-helper/dev/spike_formats.py`](../helpers/cast-helper/dev/spike_formats.py).

The spike serves one synthetic 720p30 H.264 source (`videotestsrc pattern=ball`,
x264enc, 1 s keyframes) in three candidate containers and asks a real receiver
to play each one, recording the Cast media-status transitions.

## How a result is judged

`player_state == PLAYING` on its own is **not** evidence of a picture: a
receiver can sit in PLAYING with a black screen. The spike therefore also polls
`current_time`. A candidate counts as played only when the receiver reaches
PLAYING **and** the playback position advances in real time, which can only
happen if the decoder is consuming our frames. Eye confirmation is still
prompted for interactively (omit `--no-confirm`).

## Results

Hardware: **"Smart TV"** (mDNS model `Smart TV`, 192.168.100.13:8009, Google
Cast Default Media Receiver), over Wi-Fi from Ubuntu 26.04 / GNOME 50.1.
Date: 2026-10-31. Source machine had no VA-API encoder, so x264enc was used.

| # | Format | MIME | Played? | To PLAYING | Position advanced | Verdict |
|---|--------|------|---------|-----------|-------------------|---------|
| A | fragmented MP4, progressive HTTP | `video/mp4` | **yes** | 0.1 s | **24.6 s in 25 s** | **works, real time** |
| B | HLS live, 1 s TS segments | `application/x-mpegURL` | no | — | 0.0 s | IDLE, `idle_reason=ERROR` after 0.3–4.5 s |
| B′ | same, alternate MIME | `application/vnd.apple.mpegurl` | no | — | 0.0 s | IDLE, `idle_reason=ERROR` after 4.5 s |
| C | raw MPEG-TS, progressive HTTP | `video/mp2t` | no | — | 0.0 s | IDLE after 4.3 s — **this is what ships today** |

All three candidates decoded correctly in `ffprobe` from localhost
(`h264, 1280x720`), so the failures are receiver-side rejections of the
container/delivery combination, not broken bytes.

### A — fragmented MP4 (the winner)

`ftyp`+`moov` cached as an init segment, then each `moof`+`mdat` pair emitted as
a fragment, produced by piping the MPEG-TS from GStreamer through

```
ffmpeg -fflags +genpts -f mpegts -i pipe:0 -c copy \
       -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof \
       -frag_duration 500000 pipe:1
```

Reached PLAYING in 0.1 s and tracked wall-clock 1:1 for the whole run. This is
the format Phase 2 builds on.

### B — HLS: rejected by this receiver

Eliminated as confounders before recording the failure:

- playlist shape — the receiver was served a complete 4-segment window:
  ```
  #EXTM3U
  #EXT-X-VERSION:6
  #EXT-X-TARGETDURATION:1
  #EXT-X-MEDIA-SEQUENCE:1
  #EXT-X-INDEPENDENT-SEGMENTS
  #EXTINF:1.000000,
  index1.ts
  ... (4 segments)
  ```
- segment availability — waited for ≥4 segments on disk before loading;
- CORS — `Access-Control-Allow-Origin: *` on both playlist and segments;
- MIME type — tried both `application/x-mpegURL` and
  `application/vnd.apple.mpegurl`.

It still went straight to IDLE with `idle_reason=ERROR`. **The cause has not
been isolated to a single variable** and may be specific to this receiver's
firmware. Honest conclusion: HLS is *not* a verified fallback. See "Decision".

### C — raw MPEG-TS: confirms defect F2

The current shipping code sends exactly this (`cast_helper.py:903`,
`content_type="video/mp2t"`). The receiver goes IDLE after ~4 s. **F2 is
confirmed as the root cause of "TV connects, then nothing".** It is not a
network, encoder or firewall problem.

## Decision

**fMP4 is the primary and, on the evidence, the only verified format.**

Phase 2 therefore:

- implements fMP4 as the default and the only path enabled out of the box;
- keeps HLS behind a pref, clearly labelled as unverified, because the spike
  could not make it work on the one receiver available. It is not presented to
  the user as a working fallback until some receiver is shown to play it;
- **removes** the raw-TS path rather than keeping it as a fallback: it is
  measured not to work.

## Re-running the spike on other hardware

```bash
cd helpers/cast-helper/dev
./spike_formats.py --list                       # see what is on the LAN
./spike_formats.py --local                      # no TV: serve + ffprobe locally
./spike_formats.py --device "Living Room TV"    # interactive, confirms by eye
./spike_formats.py --device "Living Room TV" --no-confirm --json out.json
./spike_formats.py --device "..." --only hls --content-type application/vnd.apple.mpegurl
```

Please append results for any additional receiver to the table above —
especially any receiver that **does** play HLS, which would turn the fallback
from unverified into real.
