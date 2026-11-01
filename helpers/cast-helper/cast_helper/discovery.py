"""Cast device discovery.

One long-lived `CastBrowser` over one long-lived `Zeroconf`, started once.
This replaces the old per-refresh `get_chromecasts()` (a fresh Zeroconf and a
5 s block every 12 s, whose `stop_discovery()` then invalidated the very
Chromecast objects it had returned — defects S3, S4).

Device identity is the mDNS UUID, and `Devices` is only published when the set
actually differs, so the UI stops rebuilding its rows every 12 s (S5).
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any

from . import dev_harness

LOG = logging.getLogger("cast-helper.discovery")

PROTOCOL_CHROMECAST = "chromecast"
PROTOCOL_MIRACAST = "miracast-handoff"

CAST_TYPE_CAST = "cast"
CAST_TYPE_AUDIO = "audio"
CAST_TYPE_GROUP = "group"


@dataclass(frozen=True)
class Device:
    id: str
    name: str
    model: str = ""
    manufacturer: str = ""
    protocol: str = PROTOCOL_CHROMECAST
    cast_type: str = CAST_TYPE_CAST
    host: str = ""
    port: int = 8009
    video_capable: bool = True

    def to_variant_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "model": self.model,
            "manufacturer": self.manufacturer,
            "protocol": self.protocol,
            "cast_type": self.cast_type,
            "host": self.host,
            "video_capable": self.video_capable,
            "install_uri": "",
        }


def classify(cast_type: str | None, port: int) -> tuple[str, bool]:
    """(cast_type, video_capable) from what mDNS actually gave us.

    This is a **deny-list**, deliberately. pychromecast only fills `cast_type`
    for models in its own hardcoded table and leaves it `None` otherwise —
    including for the TV used to develop this. An allow-list on "cast" would
    hide most real televisions. See docs/phase-0-baseline.md.
    """
    if cast_type == CAST_TYPE_AUDIO:
        return CAST_TYPE_AUDIO, False
    if cast_type == CAST_TYPE_GROUP or port != 8009:
        # Google Cast groups are audio groups; they cannot take video.
        return CAST_TYPE_GROUP, False
    return cast_type or CAST_TYPE_CAST, True


def device_from_cast_info(info: Any) -> Device:
    cast_type, video = classify(getattr(info, "cast_type", None), int(info.port))
    return Device(
        id=str(info.uuid),
        name=info.friendly_name or str(info.uuid),
        model=info.model_name or "",
        manufacturer=getattr(info, "manufacturer", None) or "",
        protocol=PROTOCOL_CHROMECAST,
        cast_type=cast_type,
        host=info.host,
        port=int(info.port),
        video_capable=video,
    )


def diff(old: dict[str, Device], new: dict[str, Device]) -> bool:
    """True when the published device set would actually change."""
    return old != new


class Discovery:
    """Owns the browser and publishes device-set changes.

    `on_changed(devices)` is invoked only on a real diff. It is called from a
    Zeroconf thread, so the service wraps it in GLib.idle_add.
    """

    def __init__(self, on_changed: Callable[[dict[str, Device]], None]):
        self._on_changed = on_changed
        self._lock = threading.Lock()
        self._devices: dict[str, Device] = {}
        self._zconf: Any = None
        self._browser: Any = None
        self._started = False

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._started:
            return
        try:
            import zeroconf
            from pychromecast.discovery import CastBrowser, SimpleCastListener
        except ImportError as exc:
            # No pychromecast: real discovery is impossible, but the dev
            # harness and the Miracast entry must still work, and CI runs
            # without it.
            LOG.error("Cast discovery unavailable: %s", exc)
            self._started = True
            self._publish()
            return

        # The Zeroconf instance must outlive discovery: pychromecast resolves
        # a device's cast_type lazily when connecting and raises
        # ZeroConfInstanceRequired if the instance that found it is closed.
        self._zconf = zeroconf.Zeroconf()
        self._browser = CastBrowser(
            SimpleCastListener(
                add_callback=self._on_add,
                remove_callback=self._on_remove,
                update_callback=self._on_add,
            ),
            self._zconf,
        )
        self._browser.start_discovery()
        self._started = True
        LOG.info("discovery started")
        self._publish()

    def stop(self) -> None:
        if self._browser is not None:
            try:
                self._browser.stop_discovery()
            except Exception:
                LOG.debug("stop_discovery failed", exc_info=True)
            self._browser = None
        if self._zconf is not None:
            try:
                self._zconf.close()
            except Exception:
                LOG.debug("zeroconf close failed", exc_info=True)
            self._zconf = None
        self._started = False

    def refresh(self) -> None:
        """Kick the browser's queries. Must not block (defect S4)."""
        if not self._started:
            self.start()
            return
        browser = self._browser
        if browser is None:
            return
        # Re-send mDNS queries without tearing anything down. The exact method
        # name has moved across pychromecast releases, so probe for it.
        for attr in ("start_discovery", "_async_start_discovery"):
            method = getattr(browser, attr, None)
            if callable(method):
                try:
                    method()
                    break
                except Exception:
                    LOG.debug("refresh via %s failed", attr, exc_info=True)
        self._publish()

    # -- browser callbacks (Zeroconf threads) ------------------------------

    def _on_add(self, uuid_, _service) -> None:
        self._publish()

    def _on_remove(self, uuid_, _service, _cast_info=None) -> None:
        self._publish()

    # -- state -------------------------------------------------------------

    def _collect(self) -> dict[str, Device]:
        devices: dict[str, Device] = {}
        browser = self._browser
        if browser is not None:
            for info in list(getattr(browser, "devices", {}).values()):
                try:
                    device = device_from_cast_info(info)
                except Exception:
                    LOG.debug("skipping malformed CastInfo %r", info, exc_info=True)
                    continue
                devices[device.id] = device
        for entry in dev_harness.fake_devices():
            devices[entry.id] = entry
        return devices

    def _publish(self) -> None:
        devices = self._collect()
        with self._lock:
            if not diff(self._devices, devices):
                return
            self._devices = devices
        LOG.info("devices changed: %d known", len(devices))
        self._on_changed(devices)

    @property
    def devices(self) -> dict[str, Device]:
        with self._lock:
            return dict(self._devices)

    def get(self, device_id: str) -> Device | None:
        with self._lock:
            return self._devices.get(device_id)

    def cast_info(self, device_id: str) -> Any | None:
        """The raw pychromecast CastInfo, needed to build a Chromecast."""
        browser = self._browser
        if browser is None:
            return None
        for info in list(getattr(browser, "devices", {}).values()):
            if str(info.uuid) == device_id:
                return info
        return None

    @property
    def zconf(self) -> Any:
        return self._zconf

    def set_name(self, device_id: str, name: str) -> None:
        """Only used by tests and the dev harness."""
        with self._lock:
            current = self._devices.get(device_id)
            if current:
                self._devices[device_id] = replace(current, name=name)
