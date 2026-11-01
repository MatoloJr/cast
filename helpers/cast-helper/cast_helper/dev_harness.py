"""Development harness: run the helper with no screen, no portal and no TV.

Everything here is opt-in through environment variables and inert in a normal
install. Two switches:

``CAST_HELPER_TEST_SOURCE=1``
    Replace the ScreenCast portal + PipeWire capture with ``videotestsrc``
    (a bouncing ball at 720p30), so the encode → mux → serve path runs
    headless and in CI.

``CAST_HELPER_FAKE_DEVICES=N``
    Add N fake receivers. "Playing" on a fake receiver runs ``ffprobe``
    against the stream URL and succeeds only if ffprobe decodes a video
    stream — so a fake receiver is a real client that checks the bytes we
    serve are playable, not a stub that always says yes.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import uuid
from typing import Any

LOG = logging.getLogger("cast-helper.dev")

FAKE_PREFIX = "fake:"

# Deterministic UUIDs so a fake device keeps its identity across restarts.
_FAKE_NS = uuid.UUID("3f1a0c7e-6f3e-4a21-9c0b-0c7a5b2d9e11")

def test_source_size() -> tuple[int, int, int]:
    """CAST_HELPER_TEST_SIZE=WxH[@fps], default 1280x720@30."""
    raw = os.environ.get("CAST_HELPER_TEST_SIZE", "1280x720@30")
    try:
        geometry, _, fps = raw.partition("@")
        width, _, height = geometry.partition("x")
        return int(width), int(height), int(fps or 30)
    except ValueError:
        return 1280, 720, 30


def test_video_description() -> str:
    width, height, fps = test_source_size()
    return (
        "videotestsrc is-live=true pattern=ball ! "
        f"video/x-raw,width={width},height={height},framerate={fps}/1"
    )
TEST_AUDIO_DESC = "audiotestsrc is-live=true wave=ticks"


def test_source_enabled() -> bool:
    return os.environ.get("CAST_HELPER_TEST_SOURCE", "") == "1"


def fake_device_count() -> int:
    try:
        return max(0, int(os.environ.get("CAST_HELPER_FAKE_DEVICES", "0")))
    except ValueError:
        return 0


def enabled() -> bool:
    return test_source_enabled() or fake_device_count() > 0


def fake_device_id(index: int) -> str:
    return FAKE_PREFIX + str(uuid.uuid5(_FAKE_NS, f"receiver-{index}"))


def is_fake_device(device_id: str) -> bool:
    return str(device_id).startswith(FAKE_PREFIX)


def fake_devices() -> list[Any]:
    """Fake devices as discovery.Device, imported lazily to avoid a cycle."""
    count = fake_device_count()
    if not count:
        return []
    from .discovery import PROTOCOL_CHROMECAST, Device

    return [
        Device(
            id=fake_device_id(i),
            name=f"Fake Receiver {i + 1}",
            model="ffprobe harness",
            manufacturer="cast-display dev",
            protocol=PROTOCOL_CHROMECAST,
            cast_type="cast",
            host="127.0.0.1",
            port=8009,
            video_capable=True,
        )
        for i in range(count)
    ]


def source_description(fd: int, node_id: int, audio: bool = False) -> str:
    """parse_launch fragment for the capture source, test or real."""
    if test_source_enabled():
        return test_video_description()
    return (
        f"pipewiresrc fd={fd} path={node_id} do-timestamp=true "
        f"keepalive-time=1000 always-copy=false"
    )


def audio_source_description() -> str:
    if test_source_enabled():
        return TEST_AUDIO_DESC
    return ""


def probe_url(url: str, seconds: int = 5, timeout: float = 25.0) -> tuple[bool, str]:
    """Decode the first `seconds` of `url` with ffprobe.

    Returns (ok, detail). ok is True only when a video stream decodes.
    """
    cmd = [
        "ffprobe", "-v", "error",
        "-print_format", "json",
        "-show_streams",
        "-read_intervals", f"%+{seconds}",
        url,
    ]
    LOG.info("fake receiver probing %s", url)
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except FileNotFoundError:
        return False, "ffprobe not installed"
    except subprocess.TimeoutExpired:
        return False, f"ffprobe timed out after {timeout:g}s (no decodable data)"

    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()
        return False, tail[-1] if tail else "ffprobe failed"

    try:
        streams = json.loads(proc.stdout or "{}").get("streams", [])
    except ValueError:
        return False, "ffprobe produced no JSON"

    video = [s for s in streams if s.get("codec_type") == "video"]
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if not video:
        return False, f"no video stream (found {len(streams)} stream(s))"
    first = video[0]
    detail = (
        f"{first.get('codec_name')} {first.get('width')}x{first.get('height')}"
        f" {first.get('avg_frame_rate') or first.get('r_frame_rate')}"
    )
    if audio:
        detail += f" + {audio[0].get('codec_name')}"
    return True, detail


def describe() -> str | None:
    if not enabled():
        return None
    bits = []
    if test_source_enabled():
        width, height, fps = test_source_size()
        bits.append(f"test video source (videotestsrc ball {width}x{height}@{fps})")
    count = fake_device_count()
    if count:
        bits.append(f"{count} fake receiver(s)")
    return "DEV HARNESS ACTIVE: " + ", ".join(bits)


def log_banner(log: logging.Logger) -> None:
    message = describe()
    if message:
        log.warning("%s", message)
