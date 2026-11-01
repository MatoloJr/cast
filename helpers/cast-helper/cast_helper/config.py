"""Paths, constants and the options a StartCast call may carry."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

BUS_NAME = "org.cast.tools.Cast1"
OBJECT_PATH = "/org/cast/tools/Cast1"
IFACE = "org.cast.tools.Cast1"

API_VERSION = 2

ERROR_PREFIX = f"{IFACE}.Error"
ERR_BUSY = f"{ERROR_PREFIX}.Busy"
ERR_NOT_FOUND = f"{ERROR_PREFIX}.NotFound"
ERR_PORTAL_DENIED = f"{ERROR_PREFIX}.PortalDenied"
ERR_NO_ENCODER = f"{ERROR_PREFIX}.NoEncoder"
ERR_NETWORK = f"{ERROR_PREFIX}.Network"
ERR_UNSUPPORTED = f"{ERROR_PREFIX}.Unsupported"

MIRACAST_ID = "miracast:gnome-network-displays"

# Fixed, configurable range so a firewall rule is possible at all (S9).
DEFAULT_PORT_RANGE = (8765, 8775)

# Formats. Only Matroska is enabled: it is the one the reference
# implementation ships and the only one measured to be accepted.
# See docs/format-spike.md.
FORMAT_MATROSKA = "matroska"
FORMAT_HLS = "hls"
ENABLED_FORMATS = (FORMAT_MATROSKA,)
ALL_FORMATS = (FORMAT_MATROSKA, FORMAT_HLS)

CONTENT_TYPES = {
    FORMAT_MATROSKA: "video/x-matroska",
    FORMAT_HLS: "application/x-mpegURL",
}

MODE_MIRROR = "mirror"
MODE_EXTEND = "extend"

# Receivers that leave are given a grace period before the stream stops, so
# "remove then re-add" does not trigger a fresh portal prompt.
RECEIVER_GRACE_SECONDS = 10


def state_dir() -> str:
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    path = os.path.join(base, "cast-display")
    os.makedirs(path, exist_ok=True)
    return path


def runtime_dir() -> str:
    base = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
    path = os.path.join(base, "cast-display")
    os.makedirs(path, exist_ok=True)
    return path


def portal_token_path() -> str:
    return os.path.join(state_dir(), "portal.json")


@dataclass
class StreamOptions:
    """Validated form of the a{sv} options dict passed to StartCast."""

    mode: str = MODE_MIRROR
    fmt: str = FORMAT_MATROSKA
    audio: bool = False
    max_height: int = 1080
    fps: int = 30
    bitrate_kbps: int = 0          # 0 → pick from resolution
    port_range: tuple[int, int] = DEFAULT_PORT_RANGE
    mute_local: bool = False
    audio_delay_ms: int = 0

    @property
    def content_type(self) -> str:
        return CONTENT_TYPES[self.fmt]

    def effective_bitrate(self) -> int:
        if self.bitrate_kbps > 0:
            return self.bitrate_kbps
        return 6000 if self.max_height > 720 else 4000

    @classmethod
    def from_variant(
        cls, options: dict[str, Any], hw_encode: bool = True
    ) -> "StreamOptions":
        opts = cls()
        raw_mode = str(options.get("mode", opts.mode))
        if raw_mode not in (MODE_MIRROR, MODE_EXTEND):
            raise ValueError(f"unknown mode {raw_mode!r}")
        opts.mode = raw_mode

        if "max_height" not in options:
            if opts.mode == MODE_EXTEND:
                # In extend mode this number *is* the size of the desktop the
                # user gets on the receiver, so it stays at 1080p even on a
                # software encoder. A 720p extended screen is cramped, and
                # the cost is the user's to trade away in preferences.
                opts.max_height = 1080
            elif not hw_encode:
                # Mirror on a software encoder: measured 1080p30 through
                # x264enc veryfast/zerolatency costs about 1.2 cores, so
                # 720p is the honest default. Prefs can raise it.
                opts.max_height = 720

        raw_fmt = str(options.get("format", opts.fmt))
        if raw_fmt not in ALL_FORMATS:
            raise ValueError(f"unknown format {raw_fmt!r}")
        opts.fmt = raw_fmt

        opts.audio = bool(options.get("audio", opts.audio))
        opts.mute_local = bool(options.get("mute_local", opts.mute_local))
        opts.audio_delay_ms = max(-2000, min(2000, int(
            options.get("audio_delay_ms", 0))))
        opts.max_height = max(480, min(2160, int(options.get("max_height", opts.max_height))))
        opts.fps = max(10, min(60, int(options.get("fps", opts.fps))))
        opts.bitrate_kbps = max(0, min(50000, int(options.get("bitrate_kbps", 0))))

        low = int(options.get("port_min", DEFAULT_PORT_RANGE[0]))
        high = int(options.get("port_max", DEFAULT_PORT_RANGE[1]))
        if not (1024 <= low <= high <= 65535):
            raise ValueError(f"bad port range {low}-{high}")
        opts.port_range = (low, high)
        return opts
