# Phase 5 audio

## Capturing what the computer plays, not the microphone

```text
pipewiresrc do-timestamp=true keepalive-time=1000
            stream-properties="p,stream.capture.sink=true"
  ! audioconvert ! audioresample
  ! audio/x-raw,rate=48000,channels=2
  ! avenc_aac bitrate=128000 ! aacparse ! mux.
```

`stream.capture.sink=true` asks PipeWire for a capture stream against the
**default output** and WirePlumber does the routing. That matters for the
brief's "follow default-sink changes while streaming": a stream bound to a
specific `<sink>.monitor` node stays on that node when the user switches
output, whereas a stream the session manager routes gets moved with the
default.

The reference machine has **no `pactl`** pulseaudio-utils is not
installed, only WirePlumber's `wpctl` so anything that shelled out to
`pactl get-default-sink` would have failed here. Nothing does;
`stream.capture.sink=true` needs no sink name at all.

`pulsesrc device=@DEFAULT_MONITOR@` is kept as a fallback for a system
without PipeWire's GStreamer plugin. Both were verified by capture:

```text
$ gst-launch-1.0 pulsesrc device=@DEFAULT_MONITOR@ num-buffers=50 \
    ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 \
    ! avenc_aac ! aacparse ! matroskamux ! filesink location=aud.mkv
$ ffprobe -show_entries stream=codec_name,channels,sample_rate aud.mkv
aac,48000,2
```

AAC encoders are probed `fdkaacenc` → `avenc_aac` → `voaacenc`. This machine
has `avenc_aac` and `voaacenc` but not `fdkaacenc`, so `avenc_aac` is used
and reported in `Capabilities`:

```text
'audio': true
'audio_encoder': 'avenc_aac'
'audio_source': 'pipewiresrc'
'can_mute_local': true
```

With no AAC encoder, `Capabilities.audio` is false and the preference is
disabled with the reason shown, rather than offering a switch that does
nothing.

## Verified

Dev harness, `audiotestsrc wave=ticks` alongside the bouncing ball, through
the full pipeline to a receiver that decodes with ffprobe:

```text
fake receiver Fake Receiver 1 accepted the stream: h264 1280x720 30/1 + aac
pipeline started with x264enc (software (x264)) + audio
```

And with the **real** capture source, extending at 1080p:

```text
fake receiver Fake Receiver 1 accepted the stream: h264 1920x1080 30/1 + aac
```

## A bug this phase exposed: a static screen stops streaming

The first real-audio run reported the video as `h264 1920x1080 **1/1**`  
one frame per second. An extended desktop with nothing moving on it produces
almost no frames and the downstream caps allowed a framerate *range*, so
nothing filled the gaps. Two consequences, neither acceptable:

- the receiver is starved and shows a frozen or stalled picture;
- the Phase 2 stall watchdog, which errors after 5 s without an encoded
  frame, would declare a perfectly healthy idle desktop dead.

The output framerate is now **pinned** (`framerate=30/1` rather than
`[1/1,30/1]`), so `videorate` duplicates frames to hold the rate. An
unchanged frame costs x264 very little and it keeps the one-per-second
keyframes flowing for late joiners. Re-measured on the same idle desktop:
`h264 1920x1080 30/1 + aac`.

Width and height remain a capped range, which is what lets a smaller screen
pass through unscaled only the framerate needed pinning.

## A/V offset

`audio-delay-ms`, −2000 to 2000, clamped in the helper. A positive value
holds the audio back with a `queue min-threshold-time`; a negative value
delays the *video* branch by the same means. Buffers are held rather than
restamped, so timestamps stay honest.

A bug caught while wiring this through: the Shell client packed every numeric
option as `uint32`, which would have turned a −250 ms offset into a vast
positive delay. Negative integers now pack as `int32`.

## Mute this computer while casting

Verified end to end with `wpctl`:

```text
mute BEFORE:          Volume: 1.00
mute WHILE CASTING:   Volume: 1.00 [MUTED]
mute AFTER:           Volume: 1.00
```

`LocalMute` only restores what it changed. If the output was already muted
before the cast, or the user unmutes during it, their state is left alone
rather than being overwritten on stop.

## Still needs hardware and ears

- **Drift under 100 ms over 10 minutes**, judged by ear and eye on a real
  receiver. Checklist item 10 in [manual-tests.md](manual-tests.md). Both
  sources are live with `do-timestamp=true` and share the pipeline clock,
  and `matroskamux` interleaves them, but sync on a real receiver depends on
  its own buffering and cannot be measured from this end.
- **Following a default-output change mid-cast.** The mechanism is the right
  one, but this machine has a single sink ("Built-in Audio Analog Stereo"),
  so there is no second output to switch to. Unverified, not assumed.
