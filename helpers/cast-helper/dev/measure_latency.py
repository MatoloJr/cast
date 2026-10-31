#!/usr/bin/env python3
"""Measure how far behind live the served stream actually is.

`ffprobe` is the wrong instrument for this: it reads ahead to fill its own
analysis buffer, so the newest timestamp it prints lags what was really
delivered and the number comes out pessimistic by seconds.

This consumes the stream with GStreamer and, for each buffer that arrives,
compares the buffer's PTS against the pipeline's own elapsed run time. The
difference is the delay this machine contributes: encode, mux, queueing and
the keyframe-aligned join.

    ./measure_latency.py http://127.0.0.1:8765/s/<id>/<token>/stream.mkv \\
        --pipeline-start <epoch seconds>
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
import urllib.request

import gi

gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst  # noqa: E402


failure_reading: list[str] = []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--pipeline-start", type=float, required=True,
                        help="epoch seconds when the server's pipeline started")
    parser.add_argument("--seconds", type=float, default=12.0)
    args = parser.parse_args()

    Gst.init(None)
    # Deliberately not souphttpsrc: inside a snap-confined shell libsoup
    # resolves against the snap's glib and dies with a symbol lookup error.
    # urllib feeds appsrc instead, which keeps the measurement independent
    # of the shell it is run from.
    desc = (
        "appsrc name=src is-live=true format=time do-timestamp=false ! "
        "matroskademux ! h264parse ! "
        "appsink name=out emit-signals=true sync=false max-buffers=4 drop=true"
    )
    pipeline = Gst.parse_launch(desc)
    source = pipeline.get_by_name("src")
    sink = pipeline.get_by_name("out")

    samples: list[tuple[float, float]] = []   # (lag, pts)
    first_frame_at: list[float] = []
    connected_at = time.time()
    stop_reading = threading.Event()

    def feed():
        try:
            with urllib.request.urlopen(args.url, timeout=10) as response:
                while not stop_reading.is_set():
                    chunk = response.read(16384)
                    if not chunk:
                        break
                    buffer = Gst.Buffer.new_wrapped(chunk)
                    if source.emit("push-buffer", buffer) != Gst.FlowReturn.OK:
                        break
        except Exception as exc:          # noqa: BLE001 - reported below
            failure_reading.append(str(exc))
        finally:
            source.emit("end-of-stream")

    def on_sample(appsink):
        sample = appsink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.OK
        buffer = sample.get_buffer()
        pts = buffer.pts
        now = time.time()
        if not first_frame_at:
            first_frame_at.append(now)
        if pts != Gst.CLOCK_TIME_NONE:
            pts_seconds = pts / Gst.SECOND
            elapsed = now - args.pipeline_start
            samples.append((elapsed - pts_seconds, pts_seconds))
        return Gst.FlowReturn.OK

    sink.connect("new-sample", on_sample)

    loop = GLib.MainLoop()
    failure: list[str] = []

    def on_message(_bus, message):
        if message.type == Gst.MessageType.ERROR:
            err, _debug = message.parse_error()
            failure.append(err.message)
            loop.quit()
        elif message.type == Gst.MessageType.EOS:
            loop.quit()

    bus = pipeline.get_bus()
    bus.add_signal_watch()
    bus.connect("message", on_message)

    pipeline.set_state(Gst.State.PLAYING)
    threading.Thread(target=feed, daemon=True).start()
    GLib.timeout_add_seconds(int(args.seconds), lambda: (loop.quit(), False)[1])
    loop.run()
    pipeline.set_state(Gst.State.NULL)

    stop_reading.set()
    if failure_reading:
        print(f"http error: {failure_reading[0]}", file=sys.stderr)
        return 1
    if failure:
        print(f"stream error: {failure[0]}", file=sys.stderr)
        return 1
    if not samples:
        print("no buffers with timestamps arrived", file=sys.stderr)
        return 1

    lags = [lag for lag, _pts in samples]
    ttff = (first_frame_at[0] - connected_at) if first_frame_at else float("nan")
    lags_sorted = sorted(lags)
    median = lags_sorted[len(lags_sorted) // 2]

    print(f"buffers measured:      {len(samples)}")
    print(f"time to first frame:   {ttff:.2f} s after connecting")
    print(f"lag behind live (min):  {min(lags):.2f} s")
    print(f"lag behind live (med):  {median:.2f} s")
    print(f"lag behind live (max):  {max(lags):.2f} s")
    print(f"verdict: {'PASS' if median < 2.0 else 'FAIL'} (target: median under 2.00 s)")
    return 0 if median < 2.0 else 2


if __name__ == "__main__":
    sys.exit(main())
