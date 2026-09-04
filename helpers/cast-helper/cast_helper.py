#!/usr/bin/env python3
"""Cast Display session helper Chromecast + Miracast (GND) bridge."""

from __future__ import annotations

import http.server
import ipaddress
import logging
import os
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
import traceback
import uuid
from collections import deque
from shutil import which
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

MIRACAST_OPEN_ID = "miracast:gnome-network-displays"
DISCOVERY_INTERVAL_SEC = 12


def _sender_token(bus: dbus.SessionBus) -> str:
    unique = bus.get_unique_name()
    return unique[1:].replace(".", "_")


def _lan_ip() -> str:
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


def _gst_has(element: str) -> bool:
    try:
        out = subprocess.run(
            ["gst-inspect-1.0", element],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return out.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _encoder_chain() -> Optional[str]:
    if _gst_has("vah264enc"):
        return "vah264enc ! video/x-h264,profile=constrained-baseline ! h264parse"
    if _gst_has("x264enc"):
        return (
            "x264enc tune=zerolatency speed-preset=ultrafast bitrate=4000 "
            "key-int-max=30 ! video/x-h264,profile=constrained-baseline ! h264parse"
        )
    if _gst_has("openh264enc"):
        return (
            "openh264enc ! video/x-h264,profile=constrained-baseline ! h264parse"
        )
    return None


def _gnd_available() -> bool:
    return which("gnome-network-displays") is not None


def _launch_gnome_network_displays() -> None:
    exe = which("gnome-network-displays")
    if not exe:
        raise RuntimeError(
            "gnome-network-displays is not installed. "
            "Install it with: sudo apt install gnome-network-displays"
        )
    subprocess.Popen(
        [exe],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


class PortalScreenCast:
    def __init__(self, bus: dbus.SessionBus):
        self._bus = bus
        self._portal = bus.get_object(PORTAL_BUS, PORTAL_PATH)
        self._session: Optional[str] = None
        self._node_id: Optional[int] = None
        self._pw_fd: Optional[int] = None
        self._sender = _sender_token(bus)

    def _call_with_response(
        self,
        method: Callable,
        *args: Any,
        options: Optional[dict] = None,
        timeout: float = 120.0,
        timeout_message: str = "Portal request timed out",
    ) -> dict:
        """Invoke a portal request and wait for Response on the GLib main loop.

        Portal APIs + signal matching must run on the main thread; callers may
        block from a worker while the D-Bus service pumps MainContext.
        """
        options = dict(options or {})
        request_token = uuid.uuid4().hex
        options["handle_token"] = request_token
        request_path = (
            f"/org/freedesktop/portal/desktop/request/{self._sender}/{request_token}"
        )
        done = threading.Event()
        result: dict[str, Any] = {
            "response": None,
            "results": None,
            "error": None,
            "match": None,
        }

        def on_response(response, results):
            result["response"] = int(response)
            result["results"] = results
            done.set()

        def invoke_on_main() -> bool:
            try:
                result["match"] = self._bus.add_signal_receiver(
                    on_response,
                    signal_name="Response",
                    dbus_interface=REQUEST_IFACE,
                    path=request_path,
                )
                method(*(args + (options,)), dbus_interface=SCREENCAST_IFACE)
            except Exception as exc:
                result["error"] = exc
                done.set()
            return False

        # Always schedule on the GLib main thread so Response matching works.
        GLib.idle_add(invoke_on_main)

        if threading.current_thread() is threading.main_thread():
            deadline = time.monotonic() + timeout
            ctx = GLib.MainContext.default()
            while not done.is_set():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                ctx.iteration(True)
        else:
            done.wait(timeout)

        try:
            if result["match"]:
                result["match"].remove()
        except Exception:
            pass

        if result["error"] is not None:
            raise result["error"]

        if not done.is_set() or result["response"] is None:
            raise TimeoutError(timeout_message)

        if result["response"] != 0:
            raise RuntimeError(
                "Screen share cancelled or denied"
                if result["response"] == 1
                else f"Portal request failed (code {result['response']})"
            )
        return dict(result["results"] or {})

    def start(self, multiple: bool = False) -> tuple[int, int]:
        session_token = uuid.uuid4().hex
        results = self._call_with_response(
            self._portal.CreateSession,
            options={"session_handle_token": session_token},
            timeout=30.0,
            timeout_message="Portal session failed CreateSession timed out",
        )
        self._session = str(results["session_handle"])
        self._call_with_response(
            self._portal.SelectSources,
            self._session,
            options={
                "multiple": bool(multiple),
                "types": dbus.UInt32(1),
                "cursor_mode": dbus.UInt32(2),
            },
            timeout=30.0,
            timeout_message="Portal session failed SelectSources timed out",
        )
        start_results = self._call_with_response(
            self._portal.Start,
            self._session,
            "",
            options={},
            timeout=180.0,
            timeout_message=(
                "Screen share dialog timed out approve the portal prompt"
            ),
        )
        streams = start_results.get("streams")
        if not streams:
            raise RuntimeError("Portal returned no streams")
        self._node_id = int(streams[0][0])
        empty = dbus.Dictionary(signature="sv")
        fd_list = self._portal.OpenPipeWireRemote(
            self._session, empty, dbus_interface=SCREENCAST_IFACE
        )
        self._pw_fd = int(fd_list.take())
        return self._pw_fd, self._node_id

    def release_fd(self) -> None:
        """Transfer FD ownership to the pipeline; portal must not close it."""
        self._pw_fd = None

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
                session_obj.Close(dbus_interface="org.freedesktop.portal.Session")
            except Exception as exc:
                LOG.debug("Close portal session: %s", exc)
            self._session = None
        self._node_id = None


class LiveMpegTsServer:
    """Multi-client HTTP server streaming live MPEG-TS bytes."""

    def __init__(self, port: int):
        self.port = port
        self._chunks: deque[bytes] = deque(maxlen=512)
        self._cond = threading.Condition()
        self._closed = False
        self._httpd: Optional[socketserver.ThreadingTCPServer] = None
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        chunks = self._chunks
        cond = self._cond
        closed_flag = lambda: self._closed  # noqa: E731

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                LOG.debug("http: " + fmt, *args)

            def do_GET(self):  # noqa: N802
                if self.path not in ("/", "/stream.ts", "/stream.mp2t"):
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "video/mp2t")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    while not closed_flag():
                        with cond:
                            while not chunks and not closed_flag():
                                cond.wait(timeout=1.0)
                            if closed_flag():
                                break
                            data = b"".join(chunks)
                            chunks.clear()
                        if data:
                            self.wfile.write(data)
                            self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass

        self._httpd = socketserver.ThreadingTCPServer(
            ("0.0.0.0", self.port), Handler
        )
        self._httpd.daemon_threads = True
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def feed(self, data: bytes) -> None:
        if not data or self._closed:
            return
        with self._cond:
            self._chunks.append(data)
            self._cond.notify_all()

    def stop(self) -> None:
        self._closed = True
        with self._cond:
            self._cond.notify_all()
        if self._httpd:
            try:
                self._httpd.shutdown()
            except Exception:
                pass
            try:
                self._httpd.server_close()
            except Exception:
                pass
        self._httpd = None


class StreamPipeline:
    """Capture → H.264 MPEG-TS HTTP (GStreamer or ffmpeg + multi-client server)."""

    def __init__(self):
        self._pipeline = None
        self._gst_proc: Optional[subprocess.Popen] = None
        self._ffmpeg_proc: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None
        self._http: Optional[LiveMpegTsServer] = None
        self._port: Optional[int] = None
        self._owned_fd: Optional[int] = None
        self._use_ffmpeg = False

    @property
    def port(self) -> Optional[int]:
        return self._port

    def start(self, pw_fd: int, node_id: int) -> int:
        self._port = _pick_free_port()
        self._owned_fd = pw_fd
        enc = _encoder_chain()
        if enc and _gst_has("souphttpserver"):
            try:
                self._start_gst(pw_fd, node_id, enc)
                return self._port
            except Exception:
                LOG.exception("GStreamer pipeline failed; trying ffmpeg fallback")
                # Do NOT close portal FD only tear down GST objects.
                self._abort_gst_only()
                self._port = _pick_free_port()
        self._start_ffmpeg(pw_fd, node_id)
        return self._port

    def _abort_gst_only(self) -> None:
        if self._pipeline is not None:
            try:
                import gi

                gi.require_version("Gst", "1.0")
                from gi.repository import Gst

                self._pipeline.set_state(Gst.State.NULL)
            except Exception:
                pass
            self._pipeline = None

    def _start_gst(self, pw_fd: int, node_id: int, enc: str) -> None:
        import gi

        gi.require_version("Gst", "1.0")
        from gi.repository import Gst

        Gst.init(None)
        desc = (
            f"pipewiresrc fd={pw_fd} path={node_id} do-timestamp=true ! "
            f"videoconvert ! videoscale ! "
            f"video/x-raw,max-framerate=30/1 ! "
            f"queue max-size-buffers=3 leaky=downstream ! "
            f"{enc} ! "
            f"mpegtsmux alignment=7 ! "
            f"souphttpserver service={self._port}"
        )
        LOG.info("Starting GStreamer pipeline on port %s", self._port)
        self._pipeline = Gst.parse_launch(desc)
        ret = self._pipeline.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            self._pipeline = None
            raise RuntimeError("Failed to start GStreamer pipeline")
        bus = self._pipeline.get_bus()
        msg = bus.timed_pop_filtered(
            3 * Gst.SECOND,
            Gst.MessageType.ERROR
            | Gst.MessageType.ASYNC_DONE
            | Gst.MessageType.STATE_CHANGED,
        )
        if msg and msg.type == Gst.MessageType.ERROR:
            err, debug = msg.parse_error()
            raise RuntimeError(f"GStreamer error: {err} ({debug})")

    def _start_ffmpeg(self, pw_fd: int, node_id: int) -> None:
        if not _gst_has("pipewiresrc") or not _gst_has("y4menc"):
            raise RuntimeError(
                "Need GStreamer pipewiresrc/y4menc, or install "
                "gstreamer1.0-plugins-ugly for x264enc"
            )
        if not which("ffmpeg"):
            raise RuntimeError(
                "ffmpeg not found; install ffmpeg or gstreamer1.0-plugins-ugly"
            )

        assert self._port is not None
        self._http = LiveMpegTsServer(self._port)
        self._http.start()
        self._use_ffmpeg = True
        LOG.info("Starting ffmpeg → multi-client HTTP on port %s", self._port)

        gst_cmd = [
            "gst-launch-1.0",
            "-q",
            "pipewiresrc",
            f"fd={pw_fd}",
            f"path={node_id}",
            "do-timestamp=true",
            "!",
            "videoconvert",
            "!",
            "videorate",
            "!",
            "video/x-raw,format=I420,framerate=30/1",
            "!",
            "y4menc",
            "!",
            "fdsink",
            "fd=1",
        ]
        ff_cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "yuv4mpegpipe",
            "-i",
            "pipe:0",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-g",
            "30",
            "-f",
            "mpegts",
            "pipe:1",
        ]

        self._gst_proc = subprocess.Popen(
            gst_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(pw_fd,),
        )
        assert self._gst_proc.stdout is not None
        self._ffmpeg_proc = subprocess.Popen(
            ff_cmd,
            stdin=self._gst_proc.stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._gst_proc.stdout.close()

        def _reader():
            assert self._ffmpeg_proc and self._ffmpeg_proc.stdout
            try:
                while True:
                    data = self._ffmpeg_proc.stdout.read(64 * 1024)
                    if not data:
                        break
                    if self._http:
                        self._http.feed(data)
            except Exception:
                LOG.debug("ffmpeg reader ended", exc_info=True)

        self._reader = threading.Thread(target=_reader, daemon=True)
        self._reader.start()

        time.sleep(0.8)
        if self._gst_proc.poll() is not None:
            err = (self._gst_proc.stderr.read() or b"").decode(errors="replace")
            raise RuntimeError(
                f"gst-launch exited early: {err or self._gst_proc.returncode}"
            )
        if self._ffmpeg_proc.poll() is not None:
            err = (self._ffmpeg_proc.stderr.read() or b"").decode(errors="replace")
            raise RuntimeError(
                f"ffmpeg exited early: {err or self._ffmpeg_proc.returncode}"
            )

    def stream_url(self, lan_ip: str) -> str:
        if self._use_ffmpeg:
            return f"http://{lan_ip}:{self._port}/stream.ts"
        return f"http://{lan_ip}:{self._port}/"

    def stop(self) -> None:
        self._abort_gst_only()
        for proc in (self._ffmpeg_proc, self._gst_proc):
            if proc is None:
                continue
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
            except Exception as exc:
                LOG.debug("proc stop: %s", exc)
        self._ffmpeg_proc = None
        self._gst_proc = None
        if self._http:
            try:
                self._http.stop()
            except Exception:
                pass
            self._http = None
        if self._owned_fd is not None:
            try:
                os.close(self._owned_fd)
            except OSError:
                pass
            self._owned_fd = None
        self._port = None
        self._use_ffmpeg = False


class ChromecastController:
    def __init__(self):
        self._casts: dict[str, Any] = {}
        self._lock = threading.Lock()
        self._active: dict[str, Any] = {}

    def refresh(self, timeout: float = 5.0) -> None:
        import pychromecast

        chromecasts, browser = pychromecast.get_chromecasts(timeout=timeout)
        try:
            browser.stop_discovery()
        except Exception:
            pass
        with self._lock:
            self._casts = {}
            for cc in chromecasts:
                uid = str(cc.uuid)
                self._casts[uid] = {
                    "id": uid,
                    "name": cc.name or uid,
                    "model": getattr(cc.cast_info, "model_name", "") or "",
                    "host": cc.cast_info.host,
                    "port": cc.cast_info.port,
                    "online": True,
                    "protocol": "chromecast",
                    "_cc": cc,
                }
        LOG.info("Discovered %d Chromecast device(s)", len(self._casts))

    def list_entries(self) -> list[tuple[str, str, str, str, bool]]:
        with self._lock:
            return [
                (
                    d["id"],
                    d["name"],
                    d["model"],
                    "chromecast",
                    bool(d["online"]),
                )
                for d in self._casts.values()
            ]

    def device_name(self, device_id: str) -> str:
        with self._lock:
            info = self._casts.get(device_id)
            if info:
                return info.get("name") or device_id
        return device_id

    def get_cast(self, device_id: str):
        import pychromecast

        with self._lock:
            info = self._casts.get(device_id)
            if info and info.get("_cc"):
                return info["_cc"]
        self.refresh(timeout=4.0)
        with self._lock:
            info = self._casts.get(device_id)
            if info and info.get("_cc"):
                return info["_cc"]
            if not info:
                raise RuntimeError(f"Device not found: {device_id}")
        return pychromecast.Chromecast(
            host=info["host"], port=info.get("port") or 8009
        )

    def play_url(self, device_id: str, url: str, content_type: str = "video/mp2t"):
        import pychromecast

        cast = self.get_cast(device_id)
        cast.wait(timeout=15)
        mc = cast.media_controller
        kwargs = {
            "stream_type": getattr(pychromecast, "STREAM_TYPE_LIVE", "LIVE"),
        }
        try:
            mc.play_media(url, content_type, **kwargs)
        except TypeError:
            mc.play_media(url, content_type)
        try:
            mc.block_until_active(timeout=20)
        except Exception as exc:
            LOG.warning("block_until_active: %s", exc)
        with self._lock:
            self._active[device_id] = cast
        return cast

    def stop_device(self, device_id: str) -> bool:
        with self._lock:
            cast = self._active.pop(device_id, None)
        if not cast:
            return False
        try:
            cast.media_controller.stop()
        except Exception as exc:
            LOG.debug("media stop: %s", exc)
        try:
            cast.quit_app()
        except Exception as exc:
            LOG.debug("quit_app: %s", exc)
        return True

    def stop(self) -> None:
        with self._lock:
            casts = list(self._active.items())
            self._active.clear()
        for _device_id, cast in casts:
            try:
                cast.media_controller.stop()
            except Exception as exc:
                LOG.debug("media stop: %s", exc)
            try:
                cast.quit_app()
            except Exception as exc:
                LOG.debug("quit_app: %s", exc)

    def active_ids(self) -> list[str]:
        with self._lock:
            return list(self._active.keys())


class CastService(dbus.service.Object):
    def __init__(self, bus: dbus.SessionBus):
        bus_name = dbus.service.BusName(BUS_NAME, bus)
        super().__init__(bus_name, OBJECT_PATH)

        self._bus = bus
        self._cc = ChromecastController()
        self._portal: Optional[PortalScreenCast] = None
        self._pipeline: Optional[StreamPipeline] = None
        self._stream_url: str = ""
        self._sessions: dict[str, dict[str, str]] = {}
        self._status = ("idle", "", "", "")
        self._op_lock = threading.Lock()
        self._gnd_proc: Optional[subprocess.Popen] = None

        self._discover_once()
        GLib.timeout_add_seconds(DISCOVERY_INTERVAL_SEC, self._periodic_discover)

    def _periodic_discover(self) -> bool:
        threading.Thread(target=self._discover_once, daemon=True).start()
        return True

    def _discover_once(self) -> None:
        try:
            self._cc.refresh()
            GLib.idle_add(self.DevicesChanged)
        except Exception:
            LOG.exception("Discovery failed")

    def _unified_devices(self) -> list[tuple[str, str, str, str, bool]]:
        devices = list(self._cc.list_entries())
        if _gnd_available():
            devices.append(
                (
                    MIRACAST_OPEN_ID,
                    "Wireless displays",
                    "Miracast (gnome-network-displays)",
                    "miracast",
                    True,
                )
            )
        return devices

    def _status_label(self, device_ids: list[str], names: list[str]) -> tuple[str, str]:
        if not device_ids:
            return "", ""
        if len(device_ids) == 1:
            return device_ids[0], names[0] if names else device_ids[0]
        primary_id = ",".join(device_ids)
        primary_name = f"{names[0]} + {len(names) - 1}"
        return primary_id, primary_name

    def _refresh_status_from_sessions(self, state: str = "casting", error: str = "") -> None:
        ids = list(self._sessions.keys())
        if not ids:
            self._set_status("idle", "", "", error)
            return
        names = [self._sessions[i].get("name", i) for i in ids]
        device_id, device_name = self._status_label(ids, names)
        self._set_status(state, device_id, device_name, error)

    def _set_status(
        self, state: str, device_id: str = "", device_name: str = "", error: str = ""
    ) -> None:
        self._status = (state, device_id, device_name, error)
        status = self._status

        def emit():
            self.SessionChanged(status)
            return False

        GLib.idle_add(emit)

    def _run_locked(self, work_fn: Callable[[], None]) -> None:
        if not self._op_lock.acquire(blocking=False):
            raise dbus.DBusException(
                "org.cast.tools.Cast1.Busy",
                "A cast operation is already in progress",
            )

        result: dict[str, Any] = {"exc": None}
        done = threading.Event()

        def work():
            try:
                work_fn()
            except Exception as exc:
                result["exc"] = exc
            finally:
                done.set()

        threading.Thread(target=work, daemon=True).start()
        ctx = GLib.MainContext.default()
        while not done.is_set():
            ctx.iteration(True)

        self._op_lock.release()
        exc = result["exc"]
        if exc is None:
            return
        if isinstance(exc, dbus.DBusException):
            raise exc
        raise dbus.DBusException(
            "org.cast.tools.Cast1.Failed",
            str(exc) or "Cast failed",
        )

    @dbus.service.method(IFACE, in_signature="", out_signature="a(ssssb)")
    def ListDevices(self):
        return self._unified_devices()

    @dbus.service.method(IFACE, in_signature="", out_signature="")
    def Refresh(self):
        self._cc.refresh()
        self.DevicesChanged()

    @dbus.service.method(IFACE, in_signature="", out_signature="b")
    def HasMiracastSupport(self):
        return bool(_gnd_available())

    @dbus.service.method(IFACE, in_signature="ss", out_signature="")
    def CastDesktop(self, device_id: str, source: str):
        device_id = str(device_id)
        source = str(source or "primary")

        def work():
            if device_id.startswith("miracast:"):
                self._cast_miracast_impl(device_id)
            else:
                self._cast_devices_impl([device_id], source)

        self._run_locked(work)

    @dbus.service.method(IFACE, in_signature="ass", out_signature="")
    def CastDevices(self, device_ids, source):
        ids = [str(d) for d in (device_ids or [])]
        source = str(source or "primary")
        if not ids:
            raise dbus.DBusException(
                "org.cast.tools.Cast1.Failed",
                "No devices selected",
            )

        def work():
            if any(i.startswith("miracast:") for i in ids):
                if len(ids) != 1:
                    raise dbus.DBusException(
                        "org.cast.tools.Cast1.Failed",
                        "Miracast cannot be combined with other devices",
                    )
                self._cast_miracast_impl(ids[0])
            else:
                self._cast_devices_impl(ids, source)

        self._run_locked(work)

    def _cast_miracast_impl(self, device_id: str) -> None:
        name = "Wireless displays"
        try:
            self._teardown_stream(stop_cast=True)
            self._sessions = {
                device_id: {"name": name, "state": "connecting", "protocol": "miracast"}
            }
            self._set_status("connecting", device_id, name, "")
            _launch_gnome_network_displays()
            self._sessions[device_id]["state"] = "casting"
            self._set_status("casting", device_id, name, "")
            GLib.idle_add(self.DevicesChanged)
        except Exception as exc:
            LOG.exception("Miracast open failed")
            err = str(exc)
            self._sessions.clear()
            self._set_status("error", device_id, name, err)
            raise dbus.DBusException("org.cast.tools.Cast1.Failed", err)

    def _ensure_pipeline(self, source: str) -> str:
        if self._pipeline and self._stream_url:
            return self._stream_url

        multiple = source == "all"
        portal = PortalScreenCast(self._bus)
        pw_fd, node_id = portal.start(multiple=multiple)
        self._portal = portal

        pipeline = StreamPipeline()
        pipeline.start(pw_fd, node_id)
        self._pipeline = pipeline
        portal.release_fd()

        lan = _lan_ip()
        self._stream_url = pipeline.stream_url(lan)
        return self._stream_url

    def _cast_devices_impl(self, device_ids: list[str], source: str) -> None:
        names = [self._cc.device_name(d) for d in device_ids]
        primary_id, primary_name = self._status_label(device_ids, names)
        try:
            # Replace previous sessions with the new set.
            self._teardown_stream(stop_cast=True)
            self._sessions = {
                d: {
                    "name": names[i],
                    "state": "connecting",
                    "protocol": "chromecast",
                }
                for i, d in enumerate(device_ids)
            }
            self._set_status("connecting", primary_id, primary_name, "")

            url = self._ensure_pipeline(source)
            for device_id, name in zip(device_ids, names):
                LOG.info("Casting %s → %s (%s)", name, url, device_id)
                self._cc.play_url(device_id, url, "video/mp2t")
                self._sessions[device_id]["state"] = "casting"

            self._refresh_status_from_sessions("casting")
            GLib.idle_add(self.DevicesChanged)
        except Exception as exc:
            LOG.exception("CastDevices failed")
            err = str(exc) or traceback.format_exc(limit=1)
            self._teardown_stream(stop_cast=True)
            self._sessions.clear()
            self._set_status("error", primary_id, primary_name, err)
            raise dbus.DBusException("org.cast.tools.Cast1.Failed", err)

    def _cast_desktop_impl(self, device_id: str, source: str) -> None:
        self._cast_devices_impl([device_id], source)

    @dbus.service.method(IFACE, in_signature="s", out_signature="")
    def DisconnectDevice(self, device_id: str):
        device_id = str(device_id)

        def work():
            if device_id not in self._sessions:
                return
            protocol = self._sessions[device_id].get("protocol", "chromecast")
            if protocol == "miracast" or device_id.startswith("miracast:"):
                self._teardown_stream(stop_cast=True)
                self._sessions.clear()
                self._set_status("idle", "", "", "")
                return

            self._cc.stop_device(device_id)
            self._sessions.pop(device_id, None)
            if not self._sessions:
                self._teardown_stream(stop_cast=False)
                self._stream_url = ""
                self._set_status("idle", "", "", "")
            else:
                self._refresh_status_from_sessions("casting")
            GLib.idle_add(self.DevicesChanged)

        self._run_locked(work)

    @dbus.service.method(IFACE, in_signature="", out_signature="")
    def Stop(self):
        with self._op_lock:
            self._teardown_stream(stop_cast=True)
            self._sessions.clear()
            self._set_status("idle", "", "", "")

    @dbus.service.method(IFACE, in_signature="", out_signature="(ssss)")
    def GetStatus(self):
        return self._status

    @dbus.service.method(IFACE, in_signature="", out_signature="a(sss)")
    def ListSessions(self):
        return [
            (device_id, info.get("name", device_id), info.get("state", "casting"))
            for device_id, info in self._sessions.items()
        ]

    @dbus.service.signal(IFACE, signature="")
    def DevicesChanged(self):
        pass

    @dbus.service.signal(IFACE, signature="(ssss)")
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
        self._stream_url = ""

    def shutdown(self) -> None:
        self._teardown_stream(stop_cast=True)
        self._sessions.clear()


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
