#!/usr/bin/env python3
"""Cast Display session helper — Chromecast discovery and desktop mirroring."""

from __future__ import annotations

import ipaddress
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
import uuid
from typing import Any, Callable, Optional

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

LOG = logging.getLogger("cast-helper")

BUS_NAME = "org.cast.tools.Cast1"
OBJECT_PATH = "/org/cast/tools/Cast1"
IFACE = "org.cast.tools.Cast1"

PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SCREENCAST_IFACE = "org.freedesktop.portal.ScreenCast"
REQUEST_IFACE = "org.freedesktop.portal.Request"

# Idle | connecting | casting | error
StatusTuple = tuple  # (state, device_id, device_name, error)


def _lan_ip() -> str:
    """Best-effort LAN IPv4 the Chromecast can reach."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.5)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            try:
                addr = ipaddress.ip_address(ip)
            except ValueError:
                continue
            if not addr.is_loopback and not addr.is_link_local:
                return ip
    except OSError:
        pass
    return "127.0.0.1"


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("0.0.0.0", 0))
        return int(sock.getsockname()[1])


def _encoder_chain() -> str:
    """Prefer VA-API when available, else software x264."""
    try:
        out = subprocess.run(
            ["gst-inspect-1.0", "vah264enc"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if out.returncode == 0:
            return (
                "vah264enc ! video/x-h264,profile=constrained-baseline ! h264parse"
            )
    except (OSError, subprocess.TimeoutExpired):
        pass
    return (
        "x264enc tune=zerolatency speed-preset=ultrafast bitrate=4000 "
        "key-int-max=30 ! video/x-h264,profile=constrained-baseline ! h264parse"
    )


class PortalScreenCast:
    """xdg-desktop-portal ScreenCast → PipeWire node + fd."""

    def __init__(self, bus: dbus.SessionBus):
        self._bus = bus
        self._portal = bus.get_object(PORTAL_BUS, PORTAL_PATH)
        self._session: Optional[str] = None
        self._node_id: Optional[int] = None
        self._pw_fd: Optional[int] = None
        self._sender_token = dbus.safe_name_encode(
            bus.get_unique_name().replace(".", "_").lstrip(":")
        )

    def _new_token(self) -> str:
        return uuid.uuid4().hex

    def _call_with_response(
        self,
        method: Callable,
        *args: Any,
        options: Optional[dict] = None,
        timeout: float = 120.0,
    ) -> dict:
        options = dict(options or {})
        request_token = self._new_token()
        options["handle_token"] = request_token
        request_path = f"/org/freedesktop/portal/desktop/request/{self._sender_token}/{request_token}"

        done = threading.Event()
        result: dict[str, Any] = {"response": None, "results": None, "error": None}

        def on_response(response, results):
            result["response"] = int(response)
            result["results"] = results
            done.set()

        match = self._bus.add_signal_receiver(
            on_response,
            signal_name="Response",
            dbus_interface=REQUEST_IFACE,
            path=request_path,
        )
        try:
            method(*(args + (options,)), dbus_interface=SCREENCAST_IFACE)
            if not done.wait(timeout):
                raise TimeoutError("Portal request timed out")
        finally:
            try:
                match.remove()
            except Exception:
                pass

        if result["error"]:
            raise RuntimeError(result["error"])
        if result["response"] != 0:
            raise RuntimeError(
                f"Portal request denied or failed (code {result['response']})"
            )
        return dict(result["results"] or {})

    def start(self, multiple: bool = False) -> tuple[int, int]:
        """Return (pipewire_fd, node_id). Shows the portal picker UI."""
        session_token = self._new_token()
        results = self._call_with_response(
            self._portal.CreateSession,
            options={"session_handle_token": session_token},
        )
        self._session = str(results["session_handle"])

        self._call_with_response(
            self._portal.SelectSources,
            self._session,
            options={
                "multiple": bool(multiple),
                "types": dbus.UInt32(1),  # monitor
                "cursor_mode": dbus.UInt32(2),  # embedded
            },
        )

        start_results = self._call_with_response(
            self._portal.Start,
            self._session,
            "",  # parent window
            options={},
            timeout=180.0,
        )
        streams = start_results.get("streams")
        if not streams:
            raise RuntimeError("Portal returned no streams")

        # streams: a(ua{sv}) → [(node_id, props), ...]
        first = streams[0]
        self._node_id = int(first[0])

        empty = dbus.Dictionary(signature="sv")
        fd_list = self._portal.OpenPipeWireRemote(
            self._session, empty, dbus_interface=SCREENCAST_IFACE
        )
        self._pw_fd = int(fd_list.take())
        return self._pw_fd, self._node_id

    def stop(self) -> None:
        if self._pw_fd is not None:
            try:
                os.close(self._pw_fd)
            except OSError:
                pass
            self._pw_fd = None
        if self._session:
            try:
                session_obj = self._bus.get_object(PORTAL_BUS, self._session)
                session_obj.Close(
                    dbus_interface="org.freedesktop.portal.Session"
                )
            except Exception as exc:
                LOG.debug("Close portal session: %s", exc)
            self._session = None
        self._node_id = None


class StreamPipeline:
    """GStreamer: pipewiresrc → H.264 → MPEG-TS → souphttpserver."""

    def __init__(self):
        self._pipeline = None
        self._port: Optional[int] = None

    @property
    def port(self) -> Optional[int]:
        return self._port

    def start(self, pw_fd: int, node_id: int) -> int:
        import gi

        gi.require_version("Gst", "1.0")
        from gi.repository import Gst

        Gst.init(None)

        self._port = _pick_free_port()
        enc = _encoder_chain()
        desc = (
            f"pipewiresrc fd={pw_fd} path={node_id} do-timestamp=true ! "
            f"videoconvert ! videoscale ! "
            f"video/x-raw,max-framerate=30/1 ! "
            f"queue max-size-buffers=3 leaky=downstream ! "
            f"{enc} ! "
            f"mpegtsmux alignment=7 ! "
            f"souphttpserver service={self._port}"
        )
        LOG.info("Starting pipeline on port %s", self._port)
        LOG.debug("Pipeline: %s", desc)

        self._pipeline = Gst.parse_launch(desc)
        ret = self._pipeline.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            self._pipeline = None
            raise RuntimeError("Failed to start GStreamer pipeline")

        # Wait briefly for PLAYING
        bus = self._pipeline.get_bus()
        msg = bus.timed_pop_filtered(
            3 * Gst.SECOND,
            Gst.MessageType.ERROR | Gst.MessageType.ASYNC_DONE | Gst.MessageType.STATE_CHANGED,
        )
        if msg and msg.type == Gst.MessageType.ERROR:
            err, debug = msg.parse_error()
            self.stop()
            raise RuntimeError(f"GStreamer error: {err} ({debug})")

        return self._port

    def stop(self) -> None:
        if self._pipeline is None:
            return
        try:
            import gi

            gi.require_version("Gst", "1.0")
            from gi.repository import Gst

            self._pipeline.set_state(Gst.State.NULL)
        except Exception as exc:
            LOG.debug("pipeline stop: %s", exc)
        self._pipeline = None
        self._port = None


class ChromecastController:
    def __init__(self):
        self._casts: dict[str, Any] = {}
        self._browser = None
        self._lock = threading.Lock()
        self._active = None  # Chromecast instance

    def refresh(self, timeout: float = 5.0) -> None:
        import zeroconf
        import pychromecast
        from pychromecast.discovery import CastBrowser, SimpleCastListener

        discovered: dict[str, Any] = {}

        def add_cast(uuid_str, service):
            discovered[str(uuid_str)] = service

        def update_cast(uuid_str, service):
            discovered[str(uuid_str)] = service

        def remove_cast(uuid_str, service):
            discovered.pop(str(uuid_str), None)

        zc = zeroconf.Zeroconf()
        listener = SimpleCastListener(add_cast, remove_cast, update_cast)
        browser = CastBrowser(listener, zc)
        browser.start_discovery()
        time.sleep(timeout)
        browser.stop_discovery()
        try:
            zc.close()
        except Exception:
            pass

        with self._lock:
            self._casts = {}
            for uid, service in discovered.items():
                host = getattr(service, "host", None) or getattr(service, "ip", None)
                name = getattr(service, "friendly_name", None) or getattr(
                    service, "name", uid
                )
                model = getattr(service, "model_name", None) or ""
                port = getattr(service, "port", 8009) or 8009
                if not host:
                    continue
                self._casts[uid] = {
                    "id": uid,
                    "name": str(name),
                    "model": str(model),
                    "host": str(host),
                    "port": int(port),
                    "online": True,
                }

        # Also try get_chromecasts as a fallback / supplement
        try:
            import pychromecast

            chromecasts, browser = pychromecast.get_chromecasts(timeout=timeout)
            try:
                browser.stop_discovery()
            except Exception:
                pass
            with self._lock:
                for cc in chromecasts:
                    uid = str(cc.uuid)
                    self._casts[uid] = {
                        "id": uid,
                        "name": cc.name or uid,
                        "model": getattr(cc.cast_info, "model_name", "") or "",
                        "host": cc.cast_info.host,
                        "port": cc.cast_info.port,
                        "online": True,
                        "_cc": cc,
                    }
        except Exception as exc:
            LOG.debug("get_chromecasts fallback: %s", exc)

    def list_devices(self) -> list[tuple[str, str, str, bool]]:
        with self._lock:
            return [
                (d["id"], d["name"], d["model"], bool(d["online"]))
                for d in self._casts.values()
            ]

    def get_cast(self, device_id: str):
        import pychromecast

        with self._lock:
            info = self._casts.get(device_id)
            if info and info.get("_cc"):
                return info["_cc"]

        # Resolve by uuid via discovery
        self.refresh(timeout=4.0)
        with self._lock:
            info = self._casts.get(device_id)
            if not info:
                raise RuntimeError(f"Device not found: {device_id}")
            if info.get("_cc"):
                return info["_cc"]

        chromecasts, browser = pychromecast.get_chromecasts(timeout=5.0)
        try:
            browser.stop_discovery()
        except Exception:
            pass
        for cc in chromecasts:
            if str(cc.uuid) == device_id:
                return cc
        # Try connect by host
        with self._lock:
            info = self._casts.get(device_id)
        if not info:
            raise RuntimeError(f"Device not found: {device_id}")
        cast = pychromecast.Chromecast(info["host"], port=info["port"])
        return cast

    def play_url(self, device_id: str, url: str, content_type: str = "video/mp2t"):
        cast = self.get_cast(device_id)
        cast.wait(timeout=10)
        mc = cast.media_controller
        mc.play_media(url, content_type)
        mc.block_until_active(timeout=15)
        self._active = cast
        return cast

    def stop(self) -> None:
        cast = self._active
        self._active = None
        if not cast:
            return
        try:
            cast.media_controller.stop()
        except Exception as exc:
            LOG.debug("media stop: %s", exc)
        try:
            cast.quit_app()
        except Exception as exc:
            LOG.debug("quit_app: %s", exc)


class CastService(dbus.service.Object):
    def __init__(self, bus: dbus.SessionBus):
        self._bus = bus
        bus_name = dbus.service.BusName(BUS_NAME, bus)
        super().__init__(bus_name, OBJECT_PATH)

        self._cc = ChromecastController()
        self._portal: Optional[PortalScreenCast] = None
        self._pipeline: Optional[StreamPipeline] = None
        self._status: StatusTuple = ("idle", "", "", "")
        self._lock = threading.Lock()
        self._worker: Optional[threading.Thread] = None

        # Initial discovery in background
        threading.Thread(target=self._bg_refresh, daemon=True).start()

    def _bg_refresh(self) -> None:
        try:
            self._cc.refresh()
            GLib.idle_add(self.DevicesChanged)
        except Exception:
            LOG.exception("Initial discovery failed")

    def _set_status(
        self, state: str, device_id: str = "", device_name: str = "", error: str = ""
    ) -> None:
        self._status = (state, device_id, device_name, error)
        status = self._status
        GLib.idle_add(lambda: self.SessionChanged(status) or False)

    @dbus.service.method(IFACE, in_signature="", out_signature="a(sssb)")
    def ListDevices(self):
        return self._cc.list_devices()

    @dbus.service.method(IFACE, in_signature="", out_signature="")
    def Refresh(self):
        self._cc.refresh()
        self.DevicesChanged()

    @dbus.service.method(IFACE, in_signature="ss", out_signature="")
    def CastDesktop(self, device_id: str, source: str):
        device_id = str(device_id)
        source = str(source or "primary")
        with self._lock:
            if self._worker and self._worker.is_alive():
                raise dbus.DBusException(
                    "org.cast.tools.Cast1.Busy",
                    "A cast operation is already in progress",
                )
            self._worker = threading.Thread(
                target=self._cast_desktop_worker,
                args=(device_id, source),
                daemon=True,
            )
            self._worker.start()

    def _cast_desktop_worker(self, device_id: str, source: str) -> None:
        device_name = device_id
        try:
            self._teardown_stream(stop_cast=True)
            devices = {d[0]: d for d in self._cc.list_devices()}
            if device_id in devices:
                device_name = devices[device_id][1]
            self._set_status("connecting", device_id, device_name, "")

            multiple = source == "all"
            portal = PortalScreenCast(self._bus)
            pw_fd, node_id = portal.start(multiple=multiple)
            self._portal = portal

            pipeline = StreamPipeline()
            port = pipeline.start(pw_fd, node_id)
            self._pipeline = pipeline

            lan = _lan_ip()
            url = f"http://{lan}:{port}/"
            LOG.info("Casting %s → %s (%s)", device_name, url, device_id)

            self._cc.play_url(device_id, url, "video/mp2t")
            self._set_status("casting", device_id, device_name, "")
            GLib.idle_add(self.DevicesChanged)
        except Exception as exc:
            LOG.exception("CastDesktop failed")
            err = str(exc) or traceback.format_exc(limit=1)
            self._teardown_stream(stop_cast=True)
            self._set_status("error", device_id, device_name, err)
            # Surface as D-Bus error for the blocking caller — already async;
            # SessionChanged carries the error for the UI.

    @dbus.service.method(IFACE, in_signature="", out_signature="")
    def Stop(self):
        self._teardown_stream(stop_cast=True)
        self._set_status("idle", "", "", "")

    @dbus.service.method(IFACE, in_signature="", out_signature="(siss)")
    def GetStatus(self):
        return self._status

    @dbus.service.signal(IFACE, signature="")
    def DevicesChanged(self):
        pass

    @dbus.service.signal(IFACE, signature="(siss)")
    def SessionChanged(self, status):
        pass

    def _teardown_stream(self, stop_cast: bool = True) -> None:
        if stop_cast:
            try:
                self._cc.stop()
            except Exception:
                LOG.debug("cc stop failed", exc_info=True)
        if self._pipeline:
            try:
                self._pipeline.stop()
            except Exception:
                LOG.debug("pipeline stop failed", exc_info=True)
            self._pipeline = None
        if self._portal:
            try:
                self._portal.stop()
            except Exception:
                LOG.debug("portal stop failed", exc_info=True)
            self._portal = None

    def shutdown(self) -> None:
        self._teardown_stream(stop_cast=True)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    service = CastService(bus)
    loop = GLib.MainLoop()

    def handle_signal(*_args):
        LOG.info("Shutting down")
        try:
            service.shutdown()
        finally:
            loop.quit()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    LOG.info("Cast helper listening on %s", BUS_NAME)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
