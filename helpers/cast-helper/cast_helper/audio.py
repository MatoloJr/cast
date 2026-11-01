"""Audio capture and the local mute switch.

Captures what the computer is playing, not the microphone. The source is a
PipeWire capture stream flagged `stream.capture.sink=true`, which WirePlumber
routes to the default output's monitor and keeps routed there if the user
changes their default output, which a stream bound to a fixed
`<sink>.monitor` node would not do.

Measured on the reference machine (no `pactl`; only WirePlumber's `wpctl`):

    pipewiresrc stream-properties="p,stream.capture.sink=true"
      ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2
      ! avenc_aac ! aacparse            -> aac, 48000, 2 channels

`pulsesrc device=@DEFAULT_MONITOR@` also works through pipewire-pulse and is
kept as a fallback for a system without PipeWire's GStreamer plugin.
"""

from __future__ import annotations

import logging
import shutil
import subprocess

LOG = logging.getLogger("cast-helper.audio")

# Probed in this order; fdkaacenc sounds best, voaacenc is the last resort.
AAC_ENCODERS = (
    ("fdkaacenc", "fdkaacenc bitrate=128000"),
    ("avenc_aac", "avenc_aac bitrate=128000"),
    ("voaacenc", "voaacenc bitrate=128000"),
)

SAMPLE_RATE = 48000
CHANNELS = 2


def _have(element: str) -> bool:
    from .pipeline import have

    return have(element)


def pick_encoder() -> tuple[str, str] | None:
    """(element name, launch fragment) for the first AAC encoder present."""
    for name, fragment in AAC_ENCODERS:
        if _have(name):
            return name, fragment
    return None


def available() -> bool:
    return pick_encoder() is not None and (
        _have("pipewiresrc") or _have("pulsesrc")
    )


def source_description() -> str | None:
    """A launch fragment capturing the default output.

    Returns None when no usable capture element exists.
    """
    if _have("pipewiresrc"):
        # The session manager routes this to whatever the default output is,
        # and re-routes it if that changes while we are streaming.
        return (
            'pipewiresrc do-timestamp=true keepalive-time=1000 '
            'stream-properties="p,stream.capture.sink=true"'
        )
    if _have("pulsesrc"):
        LOG.info("pipewiresrc unavailable; capturing via pulsesrc")
        return "pulsesrc device=@DEFAULT_MONITOR@ do-timestamp=true provide-clock=false"
    return None


def branch_description(delay_ms: int = 0) -> str | None:
    """The whole audio branch, ending in `mux.`

    `delay_ms` above zero holds the audio back; the video side is delayed
    instead for negative values, which the pipeline handles.
    """
    source = source_description()
    encoder = pick_encoder()
    if source is None or encoder is None:
        return None

    delay = ""
    if delay_ms > 0:
        # A queue with a minimum fill time is the simplest honest delay: it
        # holds buffers back rather than restamping them.
        delay = f"queue max-size-time=0 max-size-buffers=0 " \
                f"min-threshold-time={int(delay_ms) * 1_000_000} ! "

    return (
        f"{source} ! audioconvert ! audioresample ! "
        f"audio/x-raw,rate={SAMPLE_RATE},channels={CHANNELS} ! "
        f"{delay}{encoder[1]} ! aacparse ! mux."
    )


def video_delay_description(delay_ms: int) -> str:
    """Delay the video instead, when the offset is negative."""
    if delay_ms >= 0:
        return ""
    return (
        f"queue max-size-time=0 max-size-buffers=0 "
        f"min-threshold-time={abs(int(delay_ms)) * 1_000_000} ! "
    )


# -- the local mute switch -------------------------------------------------


def _mute_command(mute: bool) -> list[str] | None:
    if shutil.which("wpctl"):
        return ["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "1" if mute else "0"]
    if shutil.which("pactl"):
        return ["pactl", "set-sink-mute", "@DEFAULT_SINK@", "1" if mute else "0"]
    return None


def is_muted() -> bool | None:
    """Current mute state of the default output, or None if unknown."""
    if shutil.which("wpctl"):
        try:
            out = subprocess.run(
                ["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"],
                capture_output=True, text=True, timeout=5, check=False,
            )
            if out.returncode == 0:
                return "MUTED" in out.stdout.upper()
        except (OSError, subprocess.TimeoutExpired):
            pass
    if shutil.which("pactl"):
        try:
            out = subprocess.run(
                ["pactl", "get-sink-mute", "@DEFAULT_SINK@"],
                capture_output=True, text=True, timeout=5, check=False,
            )
            if out.returncode == 0:
                return out.stdout.strip().endswith("yes")
        except (OSError, subprocess.TimeoutExpired):
            pass
    return None


def set_muted(mute: bool) -> bool:
    """Mute or unmute the default output. Returns whether it worked."""
    command = _mute_command(mute)
    if command is None:
        LOG.warning("no wpctl or pactl, so the local output cannot be muted")
        return False
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        LOG.warning("could not change the mute state: %s", exc)
        return False
    if result.returncode != 0:
        LOG.warning("could not change the mute state: %s",
                    (result.stderr or "").strip())
        return False
    LOG.info("local output %s", "muted" if mute else "unmuted")
    return True


class LocalMute:
    """Mutes this computer for the duration of a cast, then puts it back.

    Only restores what it changed: if the user was already muted, or muted
    themselves during the cast, their state is left alone.
    """

    def __init__(self) -> None:
        self._engaged = False
        self._was_muted: bool | None = None

    def engage(self) -> None:
        if self._engaged:
            return
        self._was_muted = is_muted()
        if self._was_muted:
            LOG.info("the local output was already muted; leaving it")
            self._engaged = True
            return
        if set_muted(True):
            self._engaged = True

    def release(self) -> None:
        if not self._engaged:
            return
        self._engaged = False
        if self._was_muted:
            return          # it was muted before us; not ours to change
        if is_muted() is False:
            # The user unmuted during the cast; respect that.
            return
        set_muted(False)


def describe() -> dict:
    """What the audio path can do, for the Capabilities property."""
    encoder = pick_encoder()
    return {
        "audio": available(),
        "audio_encoder": encoder[0] if encoder else "",
        "audio_source": "pipewiresrc" if _have("pipewiresrc") else (
            "pulsesrc" if _have("pulsesrc") else ""),
        "can_mute_local": _mute_command(True) is not None,
    }
