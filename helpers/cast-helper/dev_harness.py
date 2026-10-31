"""Development harness: run the helper with no screen, no portal and no TV.

Everything here is opt-in through environment variables and is inert in a
normal install. Two switches:

``CAST_HELPER_TEST_SOURCE=1``
    Replace the ScreenCast portal + PipeWire capture with ``videotestsrc``
    (a bouncing ball at 720p30), so the encode → mux → serve path runs
    headless and in CI.

``CAST_HELPER_FAKE_DEVICES=N``
    Add N fake receivers to the device list. "Playing" on a fake receiver runs
    ``ffprobe`` against the stream URL and succeeds only if ffprobe decodes a
    video stream — i.e. the fake receiver is a real client that checks the
    bytes we serve are playable.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import uuid
from typing import Any, Optional

LOG = logging.getLogger("cast-helper.dev")

FAKE_PREFIX = "fake:"

# Deterministic UUIDs so a fake device keeps its identity across restarts.
_FAKE_NS = uuid.UUID("3f1a0c7e-6f3e-4a21-9c0b-0c7a5b2d9e11")

TEST_VIDEO_DESC = (
    "videotestsrc is-live=true pattern=ball ! "
    "video/x-raw,width=1280,height=720,framerate=30/1"
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


def fake_device_entries() -> list[tuple[str, str, str, str, bool]]:
    """Entries shaped like ChromecastController.list_entries()."""
    return [
        (
            fake_device_id(i),
            f"Fake Receiver {i + 1}",
            "ffprobe harness",
            "chromecast",
            True,
        )
        for i in range(fake_device_count())
    ]


def gst_source_args(pw_fd: int, node_id: int) -> list[str]:
    """gst-launch argv for the capture source, test or real."""
    if test_source_enabled():
        return [
            "videotestsrc",
            "is-live=true",
            "pattern=ball",
            "!",
            "video/x-raw,width=1280,height=720,framerate=30/1",
        ]
    return ["pipewiresrc", f"fd={pw_fd}", f"path={node_id}", "do-timestamp=true"]


def gst_source_desc(pw_fd: int, node_id: int) -> str:
    """parse_launch fragment for the capture source, test or real."""
    if test_source_enabled():
        return TEST_VIDEO_DESC
    return f"pipewiresrc fd={pw_fd} path={node_id} do-timestamp=true"


def probe_url(url: str, seconds: int = 5, timeout: float = 25.0) -> tuple[bool, str]:
    """Decode the first `seconds` of `url` with ffprobe.

    Returns (ok, detail). ok is True only when a video stream decodes.
    """
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-read_intervals",
        f"%+{seconds}",
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
        return False, (proc.stderr or "").strip().splitlines()[-1:][0] if proc.stderr else "ffprobe failed"

    try:
        streams = json.loads(proc.stdout or "{}").get("streams", [])
    except ValueError:
        return False, "ffprobe produced no JSON"

    video = [s for s in streams if s.get("codec_type") == "video"]
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if not video:
        return False, f"no video stream (found {len(streams)} stream(s))"
    v = video[0]
    detail = (
        f"{v.get('codec_name')} {v.get('width')}x{v.get('height')}"
        f" {v.get('avg_frame_rate') or v.get('r_frame_rate')}"
    )
    if audio:
        detail += f" + {audio[0].get('codec_name')}"
    return True, detail


class FakeReceiver:
    """Stands in for a Chromecast: validates the stream instead of showing it."""

    def __init__(self, device_id: str, name: str):
        self.device_id = device_id
        self.name = name
        self.playing = False
        self.detail = ""

    def play(self, url: str) -> None:
        ok, detail = probe_url(url)
        self.detail = detail
        if not ok:
            raise RuntimeError(f"{self.name}: stream not playable — {detail}")
        self.playing = True
        LOG.info("%s accepted stream: %s", self.name, detail)

    def stop(self) -> None:
        self.playing = False


def describe() -> Optional[str]:
    if not enabled():
        return None
    bits = []
    if test_source_enabled():
        bits.append("test video source (videotestsrc ball 720p30)")
    count = fake_device_count()
    if count:
        bits.append(f"{count} fake receiver(s)")
    return "DEV HARNESS ACTIVE: " + ", ".join(bits)


def log_banner(log: Any) -> None:
    message = describe()
    if message:
        log.warning("%s", message)
