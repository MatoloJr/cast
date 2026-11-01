# Dev harness

Tools for working on the cast helper without a screen, a portal prompt or a TV.
Nothing here is installed by `install.sh`.

## `run_helper.sh`

Runs the helper straight from the repo on the session bus, stopping the
installed systemd unit first and restarting it on exit.

```bash
./run_helper.sh                      # real portal, real devices
./run_helper.sh --testsrc            # videotestsrc instead of the screen
./run_helper.sh --testsrc --fake 2   # ... plus 2 ffprobe "receivers"
./run_helper.sh --doctor             # diagnostics only, no bus ownership
```

Switches are plain environment variables, so they work under
`systemd-run`, `dbus-run-session` and CI too:

| Variable | Effect |
|---|---|
| `CAST_HELPER_LOG=debug` | log level |
| `CAST_HELPER_TEST_SOURCE=1` | replace portal + PipeWire with `videotestsrc is-live=true pattern=ball` at 720p30 |
| `CAST_HELPER_FAKE_DEVICES=N` | add N fake receivers |

A **fake receiver** is not a stub: "playing" runs

```
ffprobe -v error -show_streams -read_intervals %+5 <url>
```

and reports success only if ffprobe decodes a video stream. If the helper
serves bytes a decoder cannot use, the fake receiver fails which is the
point.

## `spike_formats.py`

Determines which delivery format a real Cast receiver plays. See
[`docs/format-spike.md`](../../../docs/format-spike.md) for the method and the
recorded results.

```bash
./spike_formats.py --list
./spike_formats.py --local                    # serve + ffprobe, no TV needed
./spike_formats.py --device "Living Room TV"
```

## Doctor

```bash
python3 ../cast_helper.py --doctor
python3 ../cast_helper.py --doctor --no-discovery   # skip the 5 s mDNS scan
```

Sample output on the reference machine:
[`docs/doctor-sample.txt`](../../../docs/doctor-sample.txt).
