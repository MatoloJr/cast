#!/usr/bin/env python3
"""Format spike: which stream format does a real Chromecast actually play?

Serves a synthetic 720p30 test pattern in three candidate formats and, for each
one, asks a chosen Cast device to play it while recording the media-status
transitions and how long it took to reach PLAYING.

    A. fmp4  fragmented MP4 over progressive HTTP  (video/mp4)
    B. hls   HLS live, 1 s segments                (application/x-mpegURL)
    C. ts    raw endless MPEG-TS over HTTP         (video/mp2t)  <- today's code

Usage:
    ./spike_formats.py --list
    ./spike_formats.py --local                 # no TV: serve and ffprobe locally
    ./spike_formats.py --device "Living Room TV"
    ./spike_formats.py --device "..." --only fmp4 --duration 30

Time-to-first-frame as seen by the receiver cannot be measured from here, so the
script reports time-to-PLAYING from the Cast media status and prompts you to
confirm by eye what the TV is doing.
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import shutil
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Optional

HERE = os.path.dirname(os.path.abspath(__file__))

TEST_AUDIO_DESC = "audiotestsrc is-live=true wave=ticks"

TEST_SRC = (
    "videotestsrc is-live=true pattern=ball ! "
    "video/x-raw,width=1280,height=720,framerate=30/1"
)

# ---------------------------------------------------------------- utilities


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def source_ip_for(host: str) -> str:
    """The local address that actually routes to `host` (not to 8.8.8.8)."""
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


def encoder_chain() -> str:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst

    Gst.init(None)
    for name, chain in (
        ("vah264enc", "vah264enc key-int-max=30 bitrate=6000"),
        ("vaapih264enc", "vaapih264enc keyframe-period=30 bitrate=6000"),
        ("x264enc", "x264enc tune=zerolatency speed-preset=veryfast bitrate=6000 key-int-max=30"),
        ("openh264enc", "openh264enc gop-size=30 bitrate=6000000"),
    ):
        if Gst.ElementFactory.find(name):
            return chain
    raise SystemExit("No H.264 encoder available (see --doctor)")


def audio_encoder_chain() -> str:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst

    Gst.init(None)
    for name, chain in (
        ("fdkaacenc", "fdkaacenc bitrate=128000"),
        ("avenc_aac", "avenc_aac bitrate=128000"),
        ("voaacenc", "voaacenc bitrate=128000"),
    ):
        if Gst.ElementFactory.find(name):
            return chain
    raise SystemExit("No AAC encoder available (see --doctor)")


class TsSource:
    """videotestsrc (+ optional audiotestsrc) → H.264/AAC → container on stdout.

    `container` is "mpegts" (for the ffmpeg-remux candidates) or "matroska"
    (the container GNOME Network Displays actually ships for Chromecast).
    Matroska wants stream-format=avc, MPEG-TS wants byte-stream.
    """

    def __init__(self, audio: bool = False, container: str = "mpegts") -> None:
        enc = encoder_chain()
        if container == "matroska":
            # GND's recipe: avc stream-format, high profile, streamable mux.
            stream_format = "avc"
            mux = "matroskamux name=mux streamable=true"
        else:
            stream_format = "byte-stream"
            mux = "mpegtsmux name=mux"
        desc = (
            f"{TEST_SRC} ! videoconvert ! "
            f"{enc} ! h264parse config-interval=-1 ! "
            f"video/x-h264,stream-format={stream_format},alignment=au ! "
            f"{mux} ! fdsink fd=1"
        )
        if audio:
            aenc = audio_encoder_chain()
            desc += (
                f" {TEST_AUDIO_DESC} ! audioconvert ! audioresample ! "
                f"audio/x-raw,rate=48000,channels=2 ! {aenc} ! aacparse ! mux."
            )
        log(f"source: gst-launch-1.0 {desc}")
        self.proc = subprocess.Popen(
            ["gst-launch-1.0", "-q"] + desc.split(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()


# ------------------------------------------------------------- MP4 boxes


def iter_boxes(stream: Any):
    """Yield (type, bytes) for each top-level MP4 box read from `stream`."""
    while True:
        header = stream.read(8)
        if len(header) < 8:
            return
        size, btype = struct.unpack(">I4s", header)
        btype = btype.decode("ascii", "replace")
        if size == 1:
            ext = stream.read(8)
            if len(ext) < 8:
                return
            size = struct.unpack(">Q", ext)[0]
            body = stream.read(size - 16)
            yield btype, header + ext + body
        elif size == 0:
            body = stream.read()
            yield btype, header + body
            return
        else:
            body = stream.read(size - 8)
            if len(body) < size - 8:
                return
            yield btype, header + body


class Fmp4Packager(threading.Thread):
    """MPEG-TS in → fragmented MP4 out, split into init segment + fragments."""

    daemon = True

    def __init__(self, ts_stdout: Any):
        super().__init__(name="fmp4")
        self.init_segment = b""
        self.fragments: list[bytes] = []
        self.lock = threading.Condition()
        self.stopped = False
        self.proc = subprocess.Popen(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "warning",
                "-fflags", "+genpts",
                "-f", "mpegts", "-i", "pipe:0",
                "-c", "copy",
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "-frag_duration", "500000",
                "pipe:1",
            ],
            stdin=ts_stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

    def run(self) -> None:
        pending = b""   # styp/sidx that belong with the next moof
        moof = b""
        for btype, raw in iter_boxes(self.proc.stdout):
            if btype in ("ftyp", "moov"):
                with self.lock:
                    self.init_segment += raw
                    self.lock.notify_all()
            elif btype in ("styp", "sidx"):
                pending += raw
            elif btype == "moof":
                moof = pending + raw
                pending = b""
            elif btype == "mdat" and moof:
                with self.lock:
                    self.fragments.append(moof + raw)
                    if len(self.fragments) > 16:
                        self.fragments.pop(0)
                    self.lock.notify_all()
                moof = b""
        with self.lock:
            self.stopped = True
            self.lock.notify_all()

    def wait_ready(self, timeout: float = 15.0) -> bool:
        deadline = time.monotonic() + timeout
        with self.lock:
            while not (self.init_segment and self.fragments):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self.stopped:
                    return False
                self.lock.wait(remaining)
        return True

    def stop(self) -> None:
        self.stopped = True
        if self.proc.poll() is None:
            self.proc.terminate()


# ------------------------------------------------------------- servers


class ThreadingServer(socketserver.ThreadingTCPServer):
    """Clients hanging up mid-stream is normal here, not an error."""

    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        exc = sys.exception()
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


class Stats:
    """Bytes actually delivered, per client address.

    This is the only trustworthy oracle available without eyes on the TV.
    A receiver can report PLAYING with an advancing clock while showing
    nothing (observed on real hardware), but it cannot decode video it never
    downloaded. Sustained fetching at roughly the encode bitrate means the
    decoder is consuming frames; a short burst that stops means it gave up.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.by_ip: dict[str, dict[str, Any]] = {}
        self.requests: list[str] = []

    def request(self, ip: str, line: str, headers: Any) -> None:
        interesting = {
            k: v for k, v in headers.items()
            if k.lower() in ("range", "user-agent", "accept", "icy-metadata", "connection")
        }
        entry = f"{ip} {line} {interesting}"
        with self.lock:
            self.requests.append(entry)
        log(f"  REQ {entry}")

    def count(self, ip: str, nbytes: int) -> None:
        now = time.monotonic()
        with self.lock:
            rec = self.by_ip.setdefault(
                ip, {"bytes": 0, "connections": 0, "first": now, "last": now}
            )
            rec["bytes"] += nbytes
            rec["last"] = now

    def open_connection(self, ip: str) -> None:
        with self.lock:
            rec = self.by_ip.setdefault(
                ip, {"bytes": 0, "connections": 0,
                     "first": time.monotonic(), "last": time.monotonic()}
            )
            rec["connections"] += 1

    def summary_for(self, ip: str) -> dict[str, Any]:
        with self.lock:
            rec = self.by_ip.get(ip)
            if not rec:
                return {"bytes": 0, "connections": 0, "seconds": 0.0, "kbps": 0.0}
            seconds = max(0.001, rec["last"] - rec["first"])
            return {
                "bytes": rec["bytes"],
                "connections": rec["connections"],
                "seconds": seconds,
                "kbps": rec["bytes"] * 8 / seconds / 1000,
            }


class _Quiet(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    stats: Optional[Stats] = None

    def log_message(self, fmt, *args):
        log("http: " + (fmt % args))

    @property
    def peer(self) -> str:
        return self.client_address[0]

    def note_request(self) -> None:
        if self.stats:
            self.stats.request(self.peer, self.requestline, self.headers)
            self.stats.open_connection(self.peer)

    def send_counted(self, data: bytes) -> None:
        if not data:
            return
        self.wfile.write(data)
        self.wfile.flush()
        if self.stats:
            self.stats.count(self.peer, len(data))


def serve_fmp4(packager: Fmp4Packager, port: int, stats: Stats):
    """Per-client queues: every client gets init + every fragment from join."""

    class Handler(_Quiet):
        def do_OPTIONS(self):  # noqa: N802
            self.note_request()
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_HEAD(self):  # noqa: N802
            self.note_request()
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "none")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            self.note_request()
            if not self.path.endswith("stream.mp4"):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Accept-Ranges", "none")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                with packager.lock:
                    init = packager.init_segment
                    cursor = len(packager.fragments)
                self.send_counted(init)
                while not packager.stopped:
                    with packager.lock:
                        while cursor >= len(packager.fragments) and not packager.stopped:
                            packager.lock.wait(1.0)
                        # Our own view of the ring; never consumed by others.
                        chunk = b"".join(packager.fragments[cursor:])
                        cursor = len(packager.fragments)
                    self.send_counted(chunk)
            except (BrokenPipeError, ConnectionResetError, OSError) as exc:
                log(f"  client {self.peer} disconnected: {type(exc).__name__}")

    Handler.stats = stats
    httpd = ThreadingServer(("0.0.0.0", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def serve_ts(ts_stdout: Any, port: int, stats: Stats,
             content_type: str = "video/mp2t",
             suffixes: tuple = (".ts", "/"),
             from_start: bool = False):
    """Deliberately reproduces today's shape, but with per-client cursors.

    Candidate C is about whether the *container* plays, not about the shared
    deque bug, so each client here does get a complete stream.
    """
    chunks: list[bytes] = []
    cond = threading.Condition()
    state = {"stopped": False}

    def pump():
        while True:
            data = ts_stdout.read(16 * 1024)
            if not data:
                break
            with cond:
                chunks.append(data)
                # Matroska's EBML header and Tracks element occur exactly once,
                # at the head of the stream, so a client that joins later cannot
                # decode without them. MPEG-TS re-sends PAT/PMT and is
                # self-synchronising, so it can be served from "now" and the
                # backlog dropped. (The real StreamServer replays the
                # streamheader per client instead of keeping everything.)
                if not from_start and len(chunks) > 512:
                    chunks.pop(0)
                cond.notify_all()
        with cond:
            state["stopped"] = True
            cond.notify_all()

    threading.Thread(target=pump, daemon=True).start()

    class Handler(_Quiet):
        def do_GET(self):  # noqa: N802
            self.note_request()
            if not self.path.endswith(suffixes):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                with cond:
                    cursor = 0 if from_start else len(chunks)
                while not state["stopped"]:
                    with cond:
                        while cursor >= len(chunks) and not state["stopped"]:
                            cond.wait(1.0)
                        data = b"".join(chunks[cursor:])
                        cursor = len(chunks)
                    self.send_counted(data)
            except (BrokenPipeError, ConnectionResetError, OSError) as exc:
                log(f"  client {self.peer} disconnected: {type(exc).__name__}")

    Handler.stats = stats
    httpd = ThreadingServer(("0.0.0.0", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, state


def serve_hls(ts_stdout: Any, port: int, workdir: str, stats: Stats):
    ff = subprocess.Popen(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "warning",
            "-fflags", "+genpts",
            "-f", "mpegts", "-i", "pipe:0",
            "-c", "copy",
            "-f", "hls",
            "-hls_time", "1",
            "-hls_list_size", "4",
            "-hls_flags", "delete_segments+independent_segments+omit_endlist",
            os.path.join(workdir, "index.m3u8"),
        ],
        stdin=ts_stdout,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    class Handler(http.server.SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=workdir, **kw)

        def log_message(self, fmt, *args):
            log("http: " + (fmt % args))

        def send_head(self):
            stats.request(self.client_address[0], self.requestline, self.headers)
            stats.open_connection(self.client_address[0])
            return super().send_head()

        def copyfile(self, source, outputfile):
            while True:
                buf = source.read(64 * 1024)
                if not buf:
                    break
                outputfile.write(buf)
                stats.count(self.client_address[0], len(buf))

        def end_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def do_OPTIONS(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

    httpd = ThreadingServer(("0.0.0.0", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, ff


# ------------------------------------------------------------- discovery


# The Zeroconf instance must outlive discovery: pychromecast resolves a
# device's cast_type lazily over mDNS when connecting and raises
# ZeroConfInstanceRequired if the instance that found it has been closed.
# (This is defect S3 in the audit, reproduced here.)
ZCONF: Any = None
BROWSER: Any = None


def discover(timeout: float = 6.0) -> dict[str, Any]:
    global ZCONF, BROWSER
    import zeroconf
    from pychromecast.discovery import CastBrowser, SimpleCastListener

    found: dict[str, Any] = {}
    ZCONF = zeroconf.Zeroconf()
    BROWSER = CastBrowser(SimpleCastListener(lambda u, s: None), ZCONF)
    BROWSER.start_discovery()
    time.sleep(timeout)
    for uuid_, info in BROWSER.devices.items():
        found[info.friendly_name] = info
    return found


def discovery_close() -> None:
    global ZCONF, BROWSER
    if BROWSER is not None:
        try:
            BROWSER.stop_discovery()
        except Exception:
            pass
        BROWSER = None
    if ZCONF is not None:
        ZCONF.close()
        ZCONF = None


class StatusRecorder:
    """Records what the receiver reports back about our stream.

    `player_state` alone is not proof of a picture: a receiver can sit in
    PLAYING with a frozen or black screen. `current_time` advancing is the
    objective signal that the decoder is consuming our frames.
    """

    def __init__(self, started: float):
        self.started = started
        self.transitions: list[tuple[float, str]] = []
        self.first_playing: Optional[float] = None
        self.positions: list[tuple[float, float]] = []
        self.idle_reason: str = ""

    def new_media_status(self, status):
        state = getattr(status, "player_state", "?")
        elapsed = time.monotonic() - self.started
        position = getattr(status, "current_time", None)
        reason = getattr(status, "idle_reason", None)
        if reason:
            self.idle_reason = str(reason)
        if not self.transitions or self.transitions[-1][1] != state:
            detail = state + (f" ({reason})" if reason and state == "IDLE" else "")
            self.transitions.append((elapsed, detail))
            log(f"  media status @{elapsed:5.1f}s: {detail}")
        if position is not None:
            self.positions.append((elapsed, float(position)))
        if state == "PLAYING" and self.first_playing is None:
            self.first_playing = elapsed

    def load_media_failed(self, item, error_code):
        elapsed = time.monotonic() - self.started
        self.transitions.append((elapsed, f"LOAD_FAILED({error_code})"))
        log(f"  LOAD FAILED @{elapsed:5.1f}s code={error_code}")

    def position_advanced(self) -> Optional[float]:
        """How far playback position moved, or None if never reported."""
        if len(self.positions) < 2:
            return None
        return self.positions[-1][1] - self.positions[0][1]


# ------------------------------------------------------------- candidates


CANDIDATES = {
    # GND's shipping recipe for Chromecast and the reason it is first here.
    "mkv": ("Matroska progressive (GND recipe)", "video/x-matroska", "stream.mkv"),
    "mkv-audio": ("Matroska + AAC progressive", "video/x-matroska", "stream.mkv"),
    "webm-h264": ("WebM container, H.264", "video/webm", "stream.webm"),
    "fmp4": ("fragmented MP4 progressive", "video/mp4", "stream.mp4"),
    "hls": ("HLS live, 1 s segments", "application/x-mpegURL", "index.m3u8"),
    "ts": ("raw MPEG-TS progressive", "video/mp2t", "stream.ts"),
}

# candidate -> (container, audio)
CANDIDATE_SOURCE = {
    "mkv": ("matroska", False),
    "mkv-audio": ("matroska", True),
    "webm-h264": ("matroska", False),
    "fmp4": ("mpegts", False),
    "hls": ("mpegts", False),
    "ts": ("mpegts", False),
}


def run_candidate(kind: str, device_info, duration: float, local_only: bool,
                  confirm: bool = True, content_type_override: str = "") -> dict:
    label, content_type, path = CANDIDATES[kind]
    content_type = content_type_override or content_type
    port = free_port()
    ip = "127.0.0.1" if local_only else source_ip_for(device_info.host)
    url = f"http://{ip}:{port}/{path}"

    log("")
    log(f"=== Candidate {kind}: {label} ===")
    result = {
        "kind": kind,
        "label": label,
        "content_type": content_type,
        "url": url,
        "played": False,
        "time_to_playing": None,
        "transitions": [],
        "ffprobe": "",
        "note": "",
        "position_advanced": None,
        "idle_reason": "",
        "eye": None,
        "receiver_bytes": 0,
        "receiver_connections": 0,
        "receiver_kbps": 0.0,
    }

    stats = Stats()
    container, want_audio = CANDIDATE_SOURCE[kind]
    source = TsSource(audio=want_audio, container=container)
    httpd = None
    packager = None
    extra_proc = None
    workdir = None
    try:
        if kind in ("mkv", "mkv-audio", "webm-h264"):
            # Already muxed by GStreamer: serve the bytes straight through.
            httpd, _ = serve_ts(source.proc.stdout, port, stats,
                                content_type=content_type,
                                suffixes=(".mkv", ".webm", "/"),
                                from_start=True)
            time.sleep(2)
        elif kind == "fmp4":
            packager = Fmp4Packager(source.proc.stdout)
            packager.start()
            if not packager.wait_ready(20):
                result["note"] = "packager produced no init segment + fragment"
                return result
            httpd = serve_fmp4(packager, port, stats)
        elif kind == "hls":
            workdir = tempfile.mkdtemp(prefix="cast-spike-hls-")
            httpd, extra_proc = serve_hls(source.proc.stdout, port, workdir, stats)
            deadline = time.monotonic() + 20
            playlist = os.path.join(workdir, "index.m3u8")
            while time.monotonic() < deadline and not os.path.exists(playlist):
                time.sleep(0.3)
            if not os.path.exists(playlist):
                result["note"] = "ffmpeg never wrote a playlist"
                return result
            # Wait for a full window of segments: a receiver that fetches a
            # one-entry live playlist can give up before the next one lands.
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                segments = len([f for f in os.listdir(workdir) if f.endswith(".ts")])
                if segments >= 4:
                    break
                time.sleep(0.5)
            log(f"hls warm-up: {segments} segment(s)")
            log("playlist:\n" + open(playlist, encoding="utf-8").read().strip())
        else:
            httpd, _ = serve_ts(source.proc.stdout, port, stats)
            time.sleep(2)

        log(f"serving {url}")

        # Always sanity-check locally first: no point blaming the TV for bytes
        # that ffprobe can't decode either.
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "stream=codec_name,width,height", "-of", "csv=p=0",
             "-read_intervals", "%+4",
             url.replace(ip, "127.0.0.1")],
            capture_output=True, text=True, timeout=40, check=False,
        )
        result["ffprobe"] = (probe.stdout or probe.stderr or "").strip().splitlines()[-1:]
        result["ffprobe"] = result["ffprobe"][0] if result["ffprobe"] else "no output"
        log(f"local ffprobe: {result['ffprobe']}")

        if local_only:
            result["played"] = probe.returncode == 0
            result["note"] = "local only, no receiver"
            return result

        import pychromecast

        cast = pychromecast.get_chromecast_from_cast_info(device_info, ZCONF)
        started = time.monotonic()
        recorder = StatusRecorder(started)
        cast.wait(timeout=20)
        cast.media_controller.register_status_listener(recorder)
        log(f"play_media({url}, {content_type}, LIVE)")
        cast.media_controller.play_media(
            url, content_type, stream_type="LIVE", title=f"Cast Display spike: {kind}",
            autoplay=True,
        )
        try:
            cast.media_controller.block_until_active(timeout=25)
        except Exception as exc:
            log(f"  block_until_active: {exc}")

        # Let it run the full duration so playback position has time to move;
        # a receiver that only *claims* PLAYING will not advance.
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            time.sleep(0.5)
            try:
                cast.media_controller.update_status()
            except Exception:
                pass
            time.sleep(1.5)

        advanced = recorder.position_advanced()
        delivered = stats.summary_for(device_info.host)
        result["transitions"] = [f"{t:.1f}s {st}" for t, st in recorder.transitions]
        result["time_to_playing"] = recorder.first_playing
        result["position_advanced"] = advanced
        result["idle_reason"] = recorder.idle_reason
        result["receiver_bytes"] = delivered["bytes"]
        result["receiver_connections"] = delivered["connections"]
        result["receiver_kbps"] = delivered["kbps"]

        # The receiver's own report is not evidence: a TV can sit in PLAYING
        # with an advancing clock and a blank screen (observed). Bytes it
        # actually pulled, sustained over the run, is evidence.
        megabytes = delivered["bytes"] / 1e6
        sustained = delivered["seconds"] >= duration * 0.6 and delivered["bytes"] > 1e6
        result["played"] = sustained
        log(f"  receiver {device_info.host} pulled {megabytes:.2f} MB over "
            f"{delivered['connections']} connection(s), {delivered['seconds']:.1f}s, "
            f"{delivered['kbps']:.0f} kbps")

        bits = [f"{megabytes:.2f} MB in {delivered['connections']} conn"]
        if recorder.first_playing is not None:
            bits.append(f"PLAYING@{recorder.first_playing:.1f}s")
        if advanced is not None:
            bits.append(f"clock+{advanced:.1f}s")
        if recorder.idle_reason:
            bits.append(f"idle={recorder.idle_reason}")
        if not sustained and delivered["bytes"] > 0:
            bits.append("fetch stopped early -> receiver gave up")
        elif delivered["bytes"] == 0:
            bits.append("NEVER FETCHED -> receiver rejected before download")
        result["note"] = "; ".join(bits)

        if confirm:
            answer = input(
                f"  Did '{device_info.friendly_name}' show a moving ball? [y/N/q] "
            ).strip().lower()
            if answer == "q":
                raise KeyboardInterrupt
            result["eye"] = answer == "y"
            result["note"] += "; picture confirmed by eye" if answer == "y" else "; no picture reported"
            result["played"] = result["played"] and answer == "y"

        try:
            cast.media_controller.stop()
            cast.quit_app()
        except Exception:
            pass
        cast.disconnect()
    finally:
        if httpd:
            httpd.shutdown()
            httpd.server_close()
        if packager:
            packager.stop()
        if extra_proc and extra_proc.poll() is None:
            extra_proc.terminate()
        source.stop()
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="list Cast devices and exit")
    parser.add_argument("--device", help="friendly name of the Cast device to test")
    parser.add_argument("--local", action="store_true",
                        help="no receiver: serve each format and ffprobe it locally")
    parser.add_argument("--only", action="append", choices=list(CANDIDATES),
                        help="run only these candidates (repeatable)")
    parser.add_argument("--duration", type=float, default=25.0,
                        help="seconds to let each candidate play (default 25)")
    parser.add_argument("--content-type", help="override the MIME type sent to the receiver")
    parser.add_argument("--no-confirm", action="store_true",
                        help="do not prompt for eye confirmation; judge from media status only")
    parser.add_argument("--json", help="also write results to this file")
    args = parser.parse_args()

    for tool in ("gst-launch-1.0", "ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            print(f"Missing required tool: {tool}", file=sys.stderr)
            return 1

    device_info = None
    if not args.local:
        log("discovering Cast devices...")
        devices = discover()
        if args.list or not args.device:
            if not devices:
                print("No Cast devices found.")
            for name, info in devices.items():
                print(f"  {name}  ({info.model_name}) {info.host}:{info.port} type={info.cast_type}")
            if args.list:
                return 0
            print("\nPick one with --device '<name>', or use --local to test without a TV.")
            return 1
        if args.device not in devices:
            print(f"Device {args.device!r} not found. Seen: {list(devices)}", file=sys.stderr)
            return 1
        device_info = devices[args.device]
    else:
        class _Local:
            friendly_name = "localhost"
            host = "127.0.0.1"
        device_info = _Local()

    kinds = args.only or ["fmp4", "hls", "ts"]
    results = []
    try:
        for kind in kinds:
            results.append(run_candidate(kind, device_info, args.duration, args.local,
                                         confirm=not args.no_confirm,
                                         content_type_override=args.content_type or ""))
    except KeyboardInterrupt:
        log("interrupted")
    finally:
        discovery_close()

    print()
    print("Format spike results")
    print("=" * 78)
    print(f"{'format':6} {'plays':6} {'fetched':10} {'kbps':7} {'toPLAYING':10} note")
    print("-" * 100)
    for r in results:
        ttp = f"{r['time_to_playing']:.1f}s" if r["time_to_playing"] is not None else "-"
        mb = f"{r.get('receiver_bytes', 0) / 1e6:.2f} MB"
        kbps = f"{r.get('receiver_kbps', 0):.0f}"
        print(f"{r['kind']:6} {('YES' if r['played'] else 'no'):6} {mb:10} {kbps:7} {ttp:10} {r['note']}")
        for t in r["transitions"]:
            print(f"       {t}")
    print("=" * 78)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(results, handle, indent=2)
        print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
