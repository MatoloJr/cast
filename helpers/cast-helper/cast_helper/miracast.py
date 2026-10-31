"""Miracast: an honest hand-off to GNOME Network Displays.

This extension does not implement Miracast. Native Miracast means Wi-Fi
Direct, WFD/RTSP session negotiation and HDCP, which GNOME Network Displays
already does. So the device list carries exactly one Miracast entry, it opens
GND, and **no session or "casting" state is ever created for it** — which is
what defect S11 got wrong: it marked the cast active the moment the GND window
opened, and Disconnect then did nothing at all.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from typing import Optional

LOG = logging.getLogger("cast-helper.miracast")

GND_BINARY = "gnome-network-displays"
GND_APP_ID = "org.gnome.NetworkDisplays"
GND_PACKAGE = "gnome-network-displays"

# MICE (Miracast over infrastructure) landed in 0.91.
MICE_MIN_VERSION = (0, 91)


def available() -> bool:
    return shutil.which(GND_BINARY) is not None


def version() -> str:
    """Best-effort version string. GND has no --version flag."""
    for cmd in (
        ["dpkg-query", "-W", "-f=${Version}", GND_PACKAGE],
        ["flatpak", "info", "--show-ref", GND_APP_ID],
        ["rpm", "-q", "--qf", "%{VERSION}", GND_PACKAGE],
    ):
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=5, check=False
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    return ""


def _version_tuple(raw: str) -> tuple[int, ...]:
    digits: list[int] = []
    for part in raw.split("-")[0].split("."):
        if part.isdigit():
            digits.append(int(part))
        else:
            break
    return tuple(digits)


def supports_mice() -> bool:
    parsed = _version_tuple(version())
    return bool(parsed) and parsed >= MICE_MIN_VERSION


def hint() -> str:
    if not available():
        return "Install Network Displays to use Miracast"
    if supports_mice():
        return "Opens Network Displays (supports Miracast over Wi-Fi and infrastructure)"
    return "Opens Network Displays"


def open_app() -> None:
    """Launch GND, or raise with something the user can act on."""
    executable = shutil.which(GND_BINARY)
    if executable:
        LOG.info("launching %s", executable)
        subprocess.Popen(
            [executable],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return
    raise RuntimeError(
        "GNOME Network Displays is not installed. "
        "Install it from the App Center, or run: "
        f"sudo apt install {GND_PACKAGE}"
    )


def store_uri() -> str:
    """Where the Shell should send the user to install GND.

    The Shell opens this; the helper never runs sudo on the user's behalf.
    """
    return f"appstream://{GND_APP_ID}.desktop"
