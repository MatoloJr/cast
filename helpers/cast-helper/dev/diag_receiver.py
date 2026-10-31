#!/usr/bin/env python3
"""Find out *why* a Cast receiver will not play our stream.

The format spike answers "which container plays". This answers the question
before it: can the receiver reach this computer at all, and does its media
receiver work?

Three probes, in order of increasing specificity:

  1. ``--probe public``  — load a well-known public sample MP4 over HTTPS.
     Isolates "is this receiver's media player working at all".
  2. ``--probe static``  — serve a short, complete, seekable local MP4 from
     this machine. Isolates "can the receiver reach THIS computer".
  3. ``--probe live``    — serve the live fragmented MP4, as the helper does.

Each probe reports bytes the receiver actually pulled, which is the only
signal that cannot be faked by a stale media status.
"""

from __future__ import annotations

import argparse
import http.server
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Optional

PUBLIC_SAMPLE = (
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
)

ZCONF: Any = None


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def source_ip_for(host: str) -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect((host, 8009))
        return sock.getsockname()[0]
    finally:
        sock.close()


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("0.0.0.0", 0))
        return int(sock.getsockname()[1])


class CountingServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, *args, **kwargs):
        self.hits: list[str] = []
        self.bytes_sent = 0
        super().__init__(*args, **kwargs)

    def handle_error(self, request, client_address):
        exc = sys.exception()
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def serve_file(path: str, port: int, content_type: str):
    """Serve one complete file, with Range support, counting what goes out."""
    size = os.path.getsize(path)

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            log("  http: " + (fmt % args))

        def _record(self):
            entry = f"{self.client_address[0]} {self.requestline} {dict(self.headers)}"
            self.server.hits.append(entry)
            log(f"  REQ {self.client_address[0]} {self.requestline} "
                f"Range={self.headers.get('Range')} UA={self.headers.get('User-Agent')}")

        def do_HEAD(self):  # noqa: N802
            self._record()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            self._record()
            start, end = 0, size - 1
            rng = self.headers.get("Range")
            partial = False
            if rng and rng.startswith("bytes="):
                spec = rng[6:].split("-")
                try:
                    if spec[0]:
                        start = int(spec[0])
                    if len(spec) > 1 and spec[1]:
                        end = int(spec[1])
                    partial = True
                except ValueError:
                    partial = False
            length = max(0, end - start + 1)
            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            if partial:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            sent = 0
            try:
                with open(path, "rb") as handle:
                    handle.seek(start)
                    while sent < length:
                        chunk = handle.read(min(64 * 1024, length - sent))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        sent += len(chunk)
                        self.server.bytes_sent += len(chunk)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            log(f"  sent {sent} byte(s) to {self.client_address[0]}")

    httpd = CountingServer(("0.0.0.0", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def make_sample_mp4(seconds: int = 10) -> str:
    """A small, complete, faststart MP4 — the easiest thing to play there is."""
    out = os.path.join(tempfile.mkdtemp(prefix="cast-diag-"), "sample.mp4")
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc=size=1280x720:rate=30:duration={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
        "-c:v", "libx264", "-profile:v", "main", "-level", "4.0",
        "-pix_fmt", "yuv420p", "-g", "30", "-b:v", "3000k",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
        "-movflags", "+faststart",
        "-shortest", out,
    ]
    subprocess.run(cmd, check=True, timeout=120)
    log(f"built sample: {out} ({os.path.getsize(out)} bytes)")
    return out


class Recorder:
    def __init__(self, started: float):
        self.started = started
        self.events: list[str] = []
        self.reached_playing = False
        self.idle_reason = ""

    def new_media_status(self, status):
        elapsed = time.monotonic() - self.started
        state = getattr(status, "player_state", "?")
        reason = getattr(status, "idle_reason", None)
        pos = getattr(status, "current_time", None)
        if reason:
            self.idle_reason = str(reason)
        entry = f"{elapsed:5.1f}s {state}" + (f" ({reason})" if reason else "") + \
                (f" pos={pos}" if pos is not None else "")
        if not self.events or self.events[-1].split(None, 1)[1] != entry.split(None, 1)[1]:
            self.events.append(entry)
            log(f"  status {entry}")
        if state == "PLAYING":
            self.reached_playing = True

    def load_media_failed(self, item, error_code):
        elapsed = time.monotonic() - self.started
        self.events.append(f"{elapsed:5.1f}s LOAD_FAILED code={error_code}")
        log(f"  LOAD FAILED code={error_code}")


def connect(name: str):
    global ZCONF
    import pychromecast
    import zeroconf
    from pychromecast.discovery import CastBrowser, SimpleCastListener

    ZCONF = zeroconf.Zeroconf()
    browser = CastBrowser(SimpleCastListener(lambda u, s: None), ZCONF)
    browser.start_discovery()
    time.sleep(6)
    matches = [i for i in browser.devices.values() if i.friendly_name == name]
    if not matches:
        names = [i.friendly_name for i in browser.devices.values()]
        browser.stop_discovery()
        ZCONF.close()
        raise SystemExit(f"Device {name!r} not found. Seen: {names}")
    info = matches[0]
    log(f"device: {info.friendly_name} model={info.model_name!r} "
        f"cast_type={info.cast_type!r} mf={info.manufacturer!r} "
        f"at {info.host}:{info.port}")
    cast = pychromecast.get_chromecast_from_cast_info(info, ZCONF)
    cast.wait(timeout=20)
    log(f"receiver status: app={cast.status.display_name!r} "
        f"app_id={cast.status.app_id!r} is_idle={cast.is_idle} "
        f"volume={cast.status.volume_level}")
    return cast, info, browser


# probe -> (what to serve, stream_type)
PROBES = {
    "public":        ("public", "BUFFERED"),
    "static":        ("static", "BUFFERED"),
    "static-live":   ("static", "LIVE"),
    "live-buffered": ("live", "BUFFERED"),
    "live-live":     ("live", "LIVE"),
    "live-noaudio":  ("live", "BUFFERED"),
}


def run_probe(cast, info, probe: str, duration: float) -> dict:
    result = {"probe": probe, "url": "", "bytes": 0, "hits": 0,
              "playing": False, "events": [], "verdict": ""}
    httpd = None
    tmpdir = None
    packager = None
    source = None
    serve_what, stream_type = PROBES[probe]
    try:
        if serve_what == "public":
            url, content_type = PUBLIC_SAMPLE, "video/mp4"
        elif serve_what == "static":
            sample = make_sample_mp4()
            tmpdir = os.path.dirname(sample)
            port = free_port()
            ip = source_ip_for(info.host)
            httpd = serve_file(sample, port, "video/mp4")
            url, content_type = f"http://{ip}:{port}/sample.mp4", "video/mp4"
        else:
            # Live fragmented MP4, exactly as the helper would serve it.
            import spike_formats as spike

            source = spike.TsSource(audio=probe != "live-noaudio")
            packager = spike.Fmp4Packager(source.proc.stdout)
            packager.start()
            if not packager.wait_ready(25):
                result["verdict"] = "packager produced no init segment"
                return result
            port = free_port()
            ip = source_ip_for(info.host)
            stats = spike.Stats()
            httpd = spike.serve_fmp4(packager, port, stats)
            httpd.hits = []          # shape-compatible with CountingServer
            httpd.bytes_sent = 0
            httpd._stats = stats
            url, content_type = f"http://{ip}:{port}/stream.mp4", "video/mp4"

        result["url"] = url
        log("")
        log(f"=== probe {probe}: streamType={stream_type} {url}")

        started = time.monotonic()
        recorder = Recorder(started)
        # Listeners accumulate on the controller, so a stale recorder would
        # keep logging the next probe's statuses. Keep exactly ours.
        try:
            cast.media_controller._status_listeners.clear()
        except AttributeError:
            pass
        cast.media_controller.register_status_listener(recorder)
        cast.media_controller.play_media(
            url, content_type, stream_type=stream_type,
            title=f"Cast Display diag: {probe}", autoplay=True,
        )
        try:
            cast.media_controller.block_until_active(timeout=20)
        except Exception as exc:
            log(f"  block_until_active: {exc}")

        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            time.sleep(2)
            try:
                cast.media_controller.update_status()
            except Exception:
                pass

        result["playing"] = recorder.reached_playing
        result["events"] = recorder.events
        if httpd is not None:
            stats = getattr(httpd, "_stats", None)
            if stats is not None:
                delivered = stats.summary_for(info.host)
                result["bytes"] = delivered["bytes"]
                result["hits"] = delivered["connections"]
            else:
                result["bytes"] = httpd.bytes_sent
                result["hits"] = len(httpd.hits)

        if serve_what == "public":
            result["verdict"] = (
                "receiver CAN play MP4 from the internet"
                if recorder.reached_playing
                else f"receiver could not play a public sample ({recorder.idle_reason})"
            )
        else:
            if result["bytes"] > 0:
                result["verdict"] = (
                    f"receiver reached THIS machine and pulled {result['bytes'] / 1e6:.2f} MB"
                )
            else:
                result["verdict"] = (
                    "receiver NEVER connected to this machine — "
                    "network path blocked (AP client isolation or firewall)"
                )

        try:
            cast.media_controller.stop()
        except Exception:
            pass
    finally:
        if httpd:
            httpd.shutdown()
            httpd.server_close()
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)
        if packager:
            packager.stop()
        if source:
            source.stop()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True)
    parser.add_argument("--probe", action="append",
                        choices=list(PROBES), help="repeatable")
    parser.add_argument("--duration", type=float, default=20.0)
    args = parser.parse_args()

    for tool in ("ffmpeg",):
        if not shutil.which(tool):
            print(f"missing {tool}", file=sys.stderr)
            return 1

    cast, info, browser = connect(args.device)
    results = []
    try:
        for probe in (args.probe or ["static", "live-live", "live-buffered"]):
            results.append(run_probe(cast, info, probe, args.duration))
    finally:
        try:
            cast.quit_app()
            cast.disconnect()
        except Exception:
            pass
        browser.stop_discovery()
        if ZCONF:
            ZCONF.close()

    print()
    print("Receiver diagnosis")
    print("=" * 90)
    for r in results:
        print(f"{r['probe']:8} playing={'yes' if r['playing'] else 'no':3} "
              f"hits={r['hits']:2} bytes={r['bytes'] / 1e6:7.2f} MB  {r['verdict']}")
        for e in r["events"]:
            print(f"         {e}")
    print("=" * 90)
    return 0


if __name__ == "__main__":
    sys.exit(main())
