"""Capture → H.264 → Matroska → many sockets, in process.

The format and the element choices here are not guesses. They are what
GNOME Network Displays 0.99 ships for Chromecast, which is the one
configuration measured to be accepted; fragmented MP4, progressive MPEG-TS
and HLS were all refused by the test receiver without it even downloading
them. See docs/format-spike.md.

Two decisions worth stating:

* **Matroska, `stream-format=avc`, `profile=high`.** Not MPEG-TS (defect F2:
  measured not to play) and not fMP4 (refused; and disabled in GND's own
  profile table next to the comment "investigate mp4").

* **`multisocketsink` for fan-out.** It caches the muxer's `streamheader` and
  replays it to each new client, then bursts from the most recent keyframe.
  That fixes, in one element, the shared-deque corruption (F3), unaligned
  late joins (F4) and Matroska's once-only EBML header — none of which a
  hand-rolled per-client deque gets right.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gio, GLib, Gst  # noqa: E402

from . import config, dev_harness  # noqa: E402

LOG = logging.getLogger("cast-helper.pipeline")

_initialised = False


def init_gst() -> None:
    global _initialised
    if not _initialised:
        Gst.init(None)
        _initialised = True


# Probed in order. Hardware first, then software.
ENCODERS = (
    ("vah264enc", "hardware (VA-API)"),
    ("vaapih264enc", "hardware (VA-API, legacy)"),
    ("x264enc", "software (x264)"),
    ("openh264enc", "software (openh264)"),
)

AUDIO_ENCODERS = ("fdkaacenc", "avenc_aac", "voaacenc")


def have(element: str) -> bool:
    init_gst()
    return Gst.ElementFactory.find(element) is not None


def available_encoders() -> list[str]:
    return [name for name, _ in ENCODERS if have(name)]


def pick_encoder() -> Optional[tuple[str, str]]:
    for name, kind in ENCODERS:
        if have(name):
            return name, kind
    return None


def pick_audio_encoder() -> Optional[str]:
    for name in AUDIO_ENCODERS:
        if have(name):
            return name
    return None


def encoder_settings(name: str, fps: int, bitrate_kbps: int) -> str:
    """Per-encoder properties. Keyframe interval = fps, i.e. one per second."""
    if name == "vah264enc":
        return f"vah264enc key-int-max={fps} bitrate={bitrate_kbps} target-usage=6"
    if name == "vaapih264enc":
        return (
            f"vaapih264enc keyframe-period={fps} bitrate={bitrate_kbps} "
            f"tune=none rate-control=cbr"
        )
    if name == "x264enc":
        return (
            f"x264enc tune=zerolatency speed-preset=veryfast "
            f"bitrate={bitrate_kbps} key-int-max={fps} b-adapt=false"
        )
    if name == "openh264enc":
        return (
            f"openh264enc gop-size={fps} bitrate={bitrate_kbps * 1000} "
            f"complexity=low"
        )
    raise ValueError(f"no settings for encoder {name}")


def test_encode(encoder: str, timeout_seconds: int = 10) -> tuple[bool, str]:
    """Encode a few frames for real before trusting the registry.

    A present element is not a working element: VA-API in particular can be
    installed and still fail to open a device.
    """
    init_gst()
    desc = (
        "videotestsrc num-buffers=10 is-live=false ! "
        "video/x-raw,width=640,height=360,framerate=30/1 ! videoconvert ! "
        f"{encoder_settings(encoder, 30, 2000)} ! h264parse ! "
        "video/x-h264,stream-format=avc,alignment=au ! "
        "matroskamux streamable=true ! fakesink sync=false"
    )
    try:
        pipeline = Gst.parse_launch(desc)
    except GLib.Error as exc:
        return False, f"pipeline would not build: {exc.message}"
    pipeline.set_state(Gst.State.PLAYING)
    bus = pipeline.get_bus()
    message = bus.timed_pop_filtered(
        timeout_seconds * Gst.SECOND, Gst.MessageType.ERROR | Gst.MessageType.EOS
    )
    pipeline.set_state(Gst.State.NULL)
    if message is None:
        return False, f"timed out after {timeout_seconds}s"
    if message.type == Gst.MessageType.ERROR:
        err, _debug = message.parse_error()
        return False, err.message
    return True, "ok"


class PipelineError(Exception):
    pass


class Pipeline:
    """One capture + encode, fanned out to many receiver sockets."""

    def __init__(
        self,
        options: config.StreamOptions,
        on_error: Callable[[str], None],
    ):
        init_gst()
        self._options = options
        self._on_error = on_error
        self._pipeline: Optional[Gst.Element] = None
        self._sink: Optional[Gst.Element] = None
        self._bus_watch: Optional[int] = None
        self._owned_fd: Optional[int] = None
        self._encoder_name = ""
        self._encoder_kind = ""
        self._clients = 0

    # -- properties --------------------------------------------------------

    @property
    def encoder(self) -> str:
        return self._encoder_name

    @property
    def encoder_kind(self) -> str:
        return self._encoder_kind

    @property
    def clients(self) -> int:
        return self._clients

    # -- lifecycle ---------------------------------------------------------

    def _description(self, fd: int, node_id: int) -> str:
        opts = self._options
        chosen = pick_encoder()
        if chosen is None:
            raise PipelineError(
                "no H.264 encoder available; install gstreamer1.0-plugins-ugly "
                "(x264enc) or gstreamer1.0-plugins-bad (VA-API)"
            )
        self._encoder_name, self._encoder_kind = chosen

        height = min(opts.max_height, 1080)
        width = int(height * 16 / 9)
        # Encoders need even dimensions.
        width -= width % 2
        height -= height % 2

        source = dev_harness.source_description(fd, node_id, opts.audio)
        encoder = encoder_settings(self._encoder_name, opts.fps, opts.effective_bitrate())

        desc = (
            f"{source} ! "
            f"videoconvert ! videoscale add-borders=true ! videorate ! "
            f"video/x-raw,format=NV12,width={width},height={height},"
            f"framerate={opts.fps}/1 ! "
            f"queue leaky=downstream max-size-buffers=3 ! "
            f"{encoder} ! h264parse config-interval=-1 ! "
            f"video/x-h264,stream-format=avc,alignment=au,profile=high ! "
            f"matroskamux name=mux streamable=true ! "
            f"queue max-size-buffers=64 ! "
            f"multisocketsink name=sink "
            # sync-method=2 (latest-keyframe) and recover-policy=3
            # (most-recent-keyframe) are what make a late joiner decodable.
            f"blocksize=32768 burst-format=buffers "
            f"sync-method=latest-keyframe recover-policy=keyframe "
            f"timeout=20000000000"
        )

        if opts.audio:
            audio_encoder = pick_audio_encoder()
            audio_source = dev_harness.audio_source_description()
            if audio_encoder and audio_source:
                desc += (
                    f" {audio_source} ! audioconvert ! audioresample ! "
                    f"audio/x-raw,rate=48000,channels=2 ! "
                    f"{audio_encoder} ! aacparse ! mux."
                )
            else:
                LOG.warning("audio requested but unavailable; continuing without it")
        return desc

    def start(self, fd: int, node_id: int) -> None:
        desc = self._description(fd, node_id)
        LOG.info("pipeline: %s", desc)
        self._owned_fd = fd if fd is not None and fd >= 0 else None
        try:
            self._pipeline = Gst.parse_launch(desc)
        except GLib.Error as exc:
            raise PipelineError(f"could not build the pipeline: {exc.message}") from exc

        self._sink = self._pipeline.get_by_name("sink")
        if self._sink is None:
            raise PipelineError("pipeline has no multisocketsink")
        self._sink.connect("client-socket-removed", self._on_client_removed)

        bus = self._pipeline.get_bus()
        bus.add_signal_watch()
        self._bus_watch = bus.connect("message", self._on_bus_message)

        result = self._pipeline.set_state(Gst.State.PLAYING)
        if result == Gst.StateChangeReturn.FAILURE:
            raise PipelineError("pipeline refused to start")
        LOG.info(
            "pipeline started with %s (%s)", self._encoder_name, self._encoder_kind
        )

    def stop(self) -> None:
        if self._pipeline is not None:
            bus = self._pipeline.get_bus()
            if self._bus_watch is not None:
                bus.disconnect(self._bus_watch)
                self._bus_watch = None
            bus.remove_signal_watch()
            self._pipeline.set_state(Gst.State.NULL)
            self._pipeline = None
        self._sink = None
        if self._owned_fd is not None:
            try:
                import os

                os.close(self._owned_fd)
            except OSError:
                pass
            self._owned_fd = None
        self._clients = 0

    # -- clients -----------------------------------------------------------

    def add_client(self, socket: Gio.Socket) -> None:
        """Hand a connected socket to multisocketsink.

        From here on GStreamer owns writing to it: streamheader first, then
        a burst from the most recent keyframe, then live data.
        """
        if self._sink is None:
            raise PipelineError("pipeline is not running")
        self._sink.emit("add", socket)
        self._clients += 1
        LOG.info("client added to sink (%d total)", self._clients)

    def _on_client_removed(self, _sink: Gst.Element, socket: Gio.Socket) -> None:
        self._clients = max(0, self._clients - 1)
        LOG.info("client removed from sink (%d left)", self._clients)
        try:
            socket.close()
        except GLib.Error:
            pass

    # -- bus ---------------------------------------------------------------

    def _on_bus_message(self, _bus: Gst.Bus, message: Gst.Message) -> None:
        if message.type == Gst.MessageType.ERROR:
            err, debug = message.parse_error()
            LOG.error("pipeline error: %s (%s)", err.message, debug)
            self._on_error(err.message)
        elif message.type == Gst.MessageType.EOS:
            LOG.error("pipeline reached end of stream")
            self._on_error("the capture stream ended")
        elif message.type == Gst.MessageType.WARNING:
            warn, debug = message.parse_warning()
            LOG.warning("pipeline warning: %s (%s)", warn.message, debug)


def capabilities() -> dict[str, Any]:
    """What this machine can actually do, for the Capabilities property."""
    init_gst()
    encoders = available_encoders()
    chosen = pick_encoder()
    audio_encoder = pick_audio_encoder()
    virtual = False
    try:
        from .portal import SOURCE_VIRTUAL

        # Cheap, synchronous property read; only used at startup.
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        reply = bus.call_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.DBus.Properties", "Get",
            GLib.Variant("(ss)", ("org.freedesktop.portal.ScreenCast",
                                  "AvailableSourceTypes")),
            GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 3000, None,
        )
        virtual = bool(int(reply.unpack()[0]) & SOURCE_VIRTUAL)
    except Exception:
        LOG.debug("could not read AvailableSourceTypes", exc_info=True)

    return {
        "encoders": encoders,
        "encoder": chosen[0] if chosen else "",
        "hw_encode": bool(chosen and "hardware" in chosen[1]),
        "virtual_source": virtual,
        "audio": bool(audio_encoder),
        "audio_encoder": audio_encoder or "",
        "formats": list(config.ENABLED_FORMATS),
        "mux": "matroskamux",
    }
