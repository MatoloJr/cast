#!/usr/bin/env python3
"""Environment diagnostics for the Cast Display helper.

Run with ``cast_helper.py --doctor``. Prints everything needed to tell whether
this machine can capture, encode and serve a screen stream, and which Cast
devices it can see. Exits non-zero when a hard requirement is missing.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
from typing import Any, Optional

OK = "ok  "
WARN = "warn"
FAIL = "FAIL"

# Elements the pipeline needs, grouped so the report shows what each one buys.
REQUIRED_ELEMENTS = ["pipewiresrc", "videoconvert", "videoscale", "videorate", "queue"]
ENCODER_ELEMENTS = ["vah264enc", "vaapih264enc", "x264enc", "openh264enc"]
MUX_ELEMENTS = ["h264parse", "mpegtsmux", "mp4mux", "isofmp4mux", "cmafmux", "hlssink2"]
AUDIO_ELEMENTS = ["pulsesrc", "audioconvert", "audioresample", "fdkaacenc", "avenc_aac", "voaacenc", "aacparse"]
DEV_ELEMENTS = ["videotestsrc", "audiotestsrc", "appsink"]

PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"

SOURCE_TYPE_NAMES = {1: "MONITOR", 2: "WINDOW", 4: "VIRTUAL"}
CURSOR_MODE_NAMES = {1: "HIDDEN", 2: "EMBEDDED", 4: "METADATA"}


class Report:
    """Collects lines so the caller can decide the exit code."""

    def __init__(self) -> None:
        self.lines: list[str] = []
        self.failures = 0
        self.warnings = 0

    def section(self, title: str) -> None:
        self.lines.append("")
        self.lines.append(title)
        self.lines.append("-" * len(title))

    def item(self, status: str, label: str, detail: str = "") -> None:
        if status == FAIL:
            self.failures += 1
        elif status == WARN:
            self.warnings += 1
        text = f"  [{status}] {label}"
        if detail:
            text += f": {detail}"
        self.lines.append(text)

    def note(self, text: str) -> None:
        self.lines.append(f"         {text}")

    def render(self) -> str:
        return "\n".join(self.lines)


def _run(cmd: list[str], timeout: float = 5.0) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 127, str(exc)


def _load_gst() -> Optional[Any]:
    try:
        import gi

        gi.require_version("Gst", "1.0")
        from gi.repository import Gst

        Gst.init(None)
        return Gst
    except (ImportError, ValueError) as exc:
        print(f"  [{FAIL}] GStreamer python bindings unavailable: {exc}")
        return None


def _have(gst: Any, element: str) -> bool:
    return gst is not None and gst.ElementFactory.find(element) is not None


def check_system(report: Report) -> None:
    report.section("System")
    report.item(OK, "python", platform.python_version())
    report.item(OK, "kernel", platform.release())
    try:
        with open("/etc/os-release", encoding="utf-8") as handle:
            pretty = ""
            for line in handle:
                if line.startswith("PRETTY_NAME="):
                    pretty = line.split("=", 1)[1].strip().strip('"')
        report.item(OK, "distro", pretty or "unknown")
    except OSError:
        report.item(WARN, "distro", "unreadable /etc/os-release")

    session = os.environ.get("XDG_SESSION_TYPE", "")
    desktop = os.environ.get("XDG_CURRENT_DESKTOP", "")
    report.item(
        OK if session == "wayland" else WARN,
        "session",
        f"{session or 'unknown'} / {desktop or 'unknown'}",
    )
    code, out = _run(["gnome-shell", "--version"])
    report.item(OK if code == 0 else WARN, "gnome-shell", out.strip() or "not found")

    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    report.item(OK if runtime else FAIL, "XDG_RUNTIME_DIR", runtime or "unset")


def check_gstreamer(report: Report, gst: Any) -> Optional[str]:
    report.section("GStreamer")
    if gst is None:
        report.item(FAIL, "gstreamer", "python-gi / Gst 1.0 not importable")
        return None
    report.item(OK, "version", ".".join(str(n) for n in gst.version()[:3]))

    for element in REQUIRED_ELEMENTS:
        present = _have(gst, element)
        report.item(OK if present else FAIL, element, "" if present else "missing")

    encoder = None
    for element in ENCODER_ELEMENTS:
        present = _have(gst, element)
        if present and encoder is None:
            encoder = element
        report.item(OK if present else WARN, element, "" if present else "missing")
    if encoder is None:
        report.item(FAIL, "h264 encoder", "none of " + ", ".join(ENCODER_ELEMENTS))
    else:
        hw = encoder in ("vah264enc", "vaapih264enc")
        report.item(OK, "encoder chosen", f"{encoder} ({'hardware' if hw else 'software'})")
        if not hw:
            report.note("No VA-API H.264 encoder: 1080p30 will cost real CPU.")

    for element in MUX_ELEMENTS + AUDIO_ELEMENTS + DEV_ELEMENTS:
        present = _have(gst, element)
        # Only h264parse and mpegtsmux are load-bearing today; the rest are
        # alternatives probed at runtime.
        hard = element in ("h264parse", "mpegtsmux")
        report.item(OK if present else (FAIL if hard else WARN), element,
                    "" if present else "missing")

    report.item(
        WARN if _have(gst, "souphttpserver") else OK,
        "souphttpserver absent (expected)",
        "GStreamer has no such element; the helper must serve HTTP itself",
    )
    return encoder


def check_encode(report: Report, gst: Any, encoder: Optional[str]) -> None:
    """Actually encode a few frames, rather than trusting the registry."""
    report.section("Encode smoke test")
    if gst is None or encoder is None:
        report.item(FAIL, "test encode", "skipped, no encoder")
        return
    desc = (
        "videotestsrc num-buffers=10 is-live=false ! "
        "video/x-raw,width=640,height=360,framerate=30/1 ! "
        f"videoconvert ! {encoder} ! h264parse ! mpegtsmux ! fakesink sync=false"
    )
    try:
        pipeline = gst.parse_launch(desc)
    except Exception as exc:  # GLib.Error
        report.item(FAIL, "test encode", f"pipeline build failed: {exc}")
        return
    pipeline.set_state(gst.State.PLAYING)
    bus = pipeline.get_bus()
    msg = bus.timed_pop_filtered(
        10 * gst.SECOND, gst.MessageType.ERROR | gst.MessageType.EOS
    )
    pipeline.set_state(gst.State.NULL)
    if msg is None:
        report.item(WARN, "test encode", "timed out after 10 s")
    elif msg.type == gst.MessageType.ERROR:
        err, dbg = msg.parse_error()
        report.item(FAIL, "test encode", f"{err.message} ({dbg})")
    else:
        report.item(OK, "test encode", f"10 frames through {encoder} → mpegtsmux")


def check_ffmpeg(report: Report) -> None:
    report.section("ffmpeg")
    exe = shutil.which("ffmpeg")
    if not exe:
        report.item(FAIL, "ffmpeg", "not installed")
    else:
        code, out = _run([exe, "-version"])
        report.item(OK if code == 0 else FAIL, "ffmpeg", out.splitlines()[0] if out else exe)
    probe = shutil.which("ffprobe")
    report.item(OK if probe else WARN, "ffprobe", probe or "not installed (dev harness needs it)")


def _portal_props() -> Optional[dict[str, Any]]:
    try:
        import gi

        gi.require_version("Gio", "2.0")
        from gi.repository import Gio, GLib

        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        reply = bus.call_sync(
            PORTAL_BUS,
            PORTAL_PATH,
            "org.freedesktop.DBus.Properties",
            "GetAll",
            GLib.Variant("(s)", ("org.freedesktop.portal.ScreenCast",)),
            GLib.VariantType("(a{sv})"),
            Gio.DBusCallFlags.NONE,
            5000,
            None,
        )
        return reply.unpack()[0]
    except Exception:
        return None


def _decode_bits(mask: int, names: dict[int, str]) -> str:
    parts = [name for bit, name in names.items() if mask & bit]
    return f"{mask} ({'|'.join(parts) if parts else 'none'})"


def check_portal(report: Report) -> None:
    report.section("ScreenCast portal")
    props = _portal_props()
    if props is None:
        report.item(FAIL, "org.freedesktop.portal.ScreenCast", "not reachable on the session bus")
        return
    version = int(props.get("version", 0))
    report.item(OK if version >= 4 else WARN, "portal version", str(version))
    if version < 4:
        report.note("persist_mode/restore_token needs version 4+: expect a prompt every time.")
    sources = int(props.get("AvailableSourceTypes", 0))
    report.item(
        OK if sources & 1 else FAIL,
        "AvailableSourceTypes",
        _decode_bits(sources, SOURCE_TYPE_NAMES),
    )
    if not sources & 4:
        report.note("No VIRTUAL source: 'Extend onto the TV' is not available here.")
    cursors = int(props.get("AvailableCursorModes", 0))
    report.item(
        OK if cursors & 2 else WARN,
        "AvailableCursorModes",
        _decode_bits(cursors, CURSOR_MODE_NAMES),
    )


def check_network_displays(report: Report) -> None:
    report.section("Miracast (GNOME Network Displays)")
    exe = shutil.which("gnome-network-displays")
    if not exe:
        report.item(WARN, "gnome-network-displays", "not installed (Miracast hand-off unavailable)")
        return
    version = ""
    code, out = _run(["dpkg-query", "-W", "-f=${Version}", "gnome-network-displays"])
    if code == 0 and out.strip():
        version = out.strip()
    if not version:
        code, out = _run(["flatpak", "info", "--show-ref", "org.gnome.NetworkDisplays"])
        if code == 0:
            version = out.strip()
    report.item(OK, "gnome-network-displays", f"{exe} {version}".strip())
    if version and version.split("-")[0] >= "0.91":
        report.note("0.91+ supports MICE (Miracast over infrastructure).")


def _interfaces() -> list[tuple[str, str]]:
    code, out = _run(["ip", "-j", "-4", "addr", "show"])
    found: list[tuple[str, str]] = []
    if code == 0:
        try:
            for link in json.loads(out):
                name = link.get("ifname", "?")
                for addr in link.get("addr_info", []):
                    if addr.get("family") == "inet":
                        found.append((name, f"{addr.get('local')}/{addr.get('prefixlen')}"))
        except (ValueError, TypeError):
            pass
    if not found:
        try:
            found.append(("hostname", socket.gethostbyname(socket.gethostname())))
        except OSError:
            pass
    return found


def check_network(report: Report) -> None:
    report.section("Network")
    interfaces = _interfaces()
    if not interfaces:
        report.item(FAIL, "interfaces", "none found")
    for name, addr in interfaces:
        loopback = addr.startswith("127.")
        report.item(OK if not loopback else WARN, f"iface {name}", addr)
    virtual = [n for n, _ in interfaces if n.startswith(("docker", "virbr", "tun", "tap", "wg"))]
    if virtual:
        report.note(
            "Virtual interfaces present (%s): the stream URL must be chosen per "
            "receiver, not by routing to a public address." % ", ".join(virtual)
        )

    ufw = shutil.which("ufw")
    if not ufw:
        report.item(OK, "ufw", "not installed (no host firewall to open)")
    else:
        code, out = _run(["ufw", "status"])
        if code != 0:
            report.item(WARN, "ufw", "status needs root; run: sudo ufw status")
        else:
            active = "Status: active" in out
            report.item(WARN if active else OK, "ufw", "active" if active else "inactive")
            if active:
                report.note("Open the stream ports, e.g. sudo ufw allow 8765:8775/tcp")


def check_receiver_libs(report: Report) -> None:
    report.section("Cast libraries")
    try:
        import importlib.metadata as md

        import pychromecast  # noqa: F401

        report.item(OK, "pychromecast", md.version("PyChromecast"))
    except Exception as exc:
        report.item(FAIL, "pychromecast", f"not importable: {exc}")
        return
    try:
        import importlib.metadata as md

        import zeroconf  # noqa: F401

        report.item(OK, "zeroconf", md.version("zeroconf"))
    except Exception as exc:
        report.item(FAIL, "zeroconf", f"not importable: {exc}")


def check_devices(report: Report, seconds: float = 5.0) -> None:
    report.section(f"Cast devices seen in {seconds:g} s")
    try:
        import zeroconf
        from pychromecast.discovery import CastBrowser, SimpleCastListener
    except ImportError as exc:
        report.item(FAIL, "discovery", f"unavailable: {exc}")
        return

    found: dict[str, Any] = {}

    def on_add(uuid_, _service):
        info = browser.devices.get(uuid_)
        if info is not None:
            found[str(uuid_)] = info

    zconf = zeroconf.Zeroconf()
    browser = CastBrowser(SimpleCastListener(on_add), zconf)
    try:
        browser.start_discovery()
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            time.sleep(0.2)
    finally:
        try:
            browser.stop_discovery()
        except Exception:
            pass
        zconf.close()

    if not found:
        report.item(WARN, "devices", "none found (check that mDNS/UDP 5353 reaches the LAN)")
        return
    for info in found.values():
        cast_type = getattr(info, "cast_type", "?")
        video = cast_type not in ("audio",)
        report.item(
            OK,
            info.friendly_name,
            f"{info.model_name or '?'} at {info.host}:{info.port} "
            f"type={cast_type} video={'yes' if video else 'no'}",
        )


def run(argv: Optional[list[str]] = None) -> int:
    argv = list(argv or [])
    discovery_seconds = 5.0
    if "--no-discovery" in argv:
        discovery_seconds = 0.0

    report = Report()
    report.lines.append("Cast Display — doctor")
    report.lines.append("=====================")

    gst = _load_gst()
    check_system(report)
    encoder = check_gstreamer(report, gst)
    check_encode(report, gst, encoder)
    check_ffmpeg(report)
    check_portal(report)
    check_network_displays(report)
    check_network(report)
    check_receiver_libs(report)
    if discovery_seconds:
        check_devices(report, discovery_seconds)

    report.lines.append("")
    report.lines.append(
        f"Summary: {report.failures} failure(s), {report.warnings} warning(s)."
    )
    print(report.render())
    return 1 if report.failures else 0


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
