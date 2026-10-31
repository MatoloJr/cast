"""Chromecast receiver sessions.

Each receiver is connected on a worker thread so three TVs take as long as the
slowest one, not the sum (defect S6: sequential `wait(15)` +
`block_until_active(20)` could outlast the client's own D-Bus timeout).
Results are posted back to the main loop with `GLib.idle_add`; only the main
thread mutates service state.

Per-receiver failure is contained: one TV that cannot be reached marks its own
session `error` and leaves the stream running for the others.
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from gi.repository import GLib

from . import dev_harness

LOG = logging.getLogger("cast-helper.receivers")

CONNECT_TIMEOUT = 15.0
PLAYING_TIMEOUT = 20.0
MAX_RECONNECTS = 3

STATE_CONNECTING = "connecting"
STATE_BUFFERING = "buffering"
STATE_PLAYING = "playing"
STATE_ERROR = "error"


@dataclass
class Session:
    device_id: str
    name: str
    stream_id: str
    state: str = STATE_CONNECTING
    error: str = ""

    def to_variant_dict(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "name": self.name,
            "stream_id": self.stream_id,
            "state": self.state,
            "error": self.error,
        }


class _MediaListener:
    """Watches one receiver and reports meaningful changes to the service."""

    def __init__(self, device_id: str, report: Callable[[str, str, str], None]):
        self._device_id = device_id
        self._report = report
        self._last = ""

    def new_media_status(self, status) -> None:
        player_state = getattr(status, "player_state", "") or ""
        idle_reason = getattr(status, "idle_reason", "") or ""
        if player_state == self._last:
            return
        self._last = player_state

        if player_state == "PLAYING":
            self._report(self._device_id, STATE_PLAYING, "")
        elif player_state == "BUFFERING":
            self._report(self._device_id, STATE_BUFFERING, "")
        elif player_state == "IDLE":
            # The user pressed Home, or another app took the receiver over.
            if idle_reason in ("CANCELLED", "INTERRUPTED", "FINISHED", "ERROR"):
                self._report(
                    self._device_id, STATE_ERROR,
                    {
                        "CANCELLED": "stopped on the device",
                        "INTERRUPTED": "another app took over the device",
                        "FINISHED": "the device stopped playback",
                        "ERROR": "the device could not play the stream",
                    }[idle_reason],
                )

    def load_media_failed(self, item, error_code) -> None:
        self._report(
            self._device_id, STATE_ERROR,
            f"the device rejected the stream (code {error_code})",
        )


class _ConnectionListener:
    def __init__(self, device_id: str, report: Callable[[str, str, str], None]):
        self._device_id = device_id
        self._report = report

    def new_connection_status(self, status) -> None:
        state = getattr(status, "status", "")
        if state == "LOST":
            self._report(self._device_id, STATE_ERROR, "lost connection to the device")


class ReceiverManager:
    """Owns the live Chromecast objects and the session table."""

    def __init__(
        self,
        on_session_changed: Callable[[], None],
        on_error: Callable[[str, str, str], None],
    ):
        self._sessions: dict[str, Session] = {}
        self._casts: dict[str, Any] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="receiver")
        self._on_session_changed = on_session_changed
        self._on_error = on_error

    # -- queries -----------------------------------------------------------

    @property
    def sessions(self) -> list[Session]:
        with self._lock:
            return list(self._sessions.values())

    def session_ids(self) -> list[str]:
        with self._lock:
            return list(self._sessions)

    def has(self, device_id: str) -> bool:
        with self._lock:
            return device_id in self._sessions

    def count(self) -> int:
        with self._lock:
            return len(self._sessions)

    # -- attach / detach ---------------------------------------------------

    def attach(
        self,
        devices: list[Any],
        stream_id: str,
        url_for: Callable[[str], str],
        content_type: str,
        zconf: Any,
        cast_info_for: Callable[[str], Any],
    ) -> None:
        """Connect every device in parallel. Returns immediately."""
        with self._lock:
            for device in devices:
                self._sessions[device.id] = Session(
                    device_id=device.id, name=device.name, stream_id=stream_id
                )
        self._notify()
        for device in devices:
            self._pool.submit(self._attach_one, device, stream_id, url_for,
                              content_type, zconf, cast_info_for)

    def _attach_one(self, device, stream_id, url_for, content_type, zconf,
                    cast_info_for) -> None:
        """Runs on a worker thread. Never touches service state directly."""
        try:
            url = url_for(device.host)
        except OSError as exc:
            self._post_state(device.id, STATE_ERROR,
                             f"no network route to {device.name}: {exc}")
            return

        if dev_harness.is_fake_device(device.id):
            ok, detail = dev_harness.probe_url(url)
            if ok:
                LOG.info("fake receiver %s accepted the stream: %s", device.name, detail)
                self._post_state(device.id, STATE_PLAYING, "")
            else:
                self._post_state(device.id, STATE_ERROR, detail)
            return

        try:
            import pychromecast

            info = cast_info_for(device.id)
            if info is None:
                self._post_state(device.id, STATE_ERROR, "device went away")
                return
            # Built from CastInfo with a live Zeroconf, which is the only
            # supported construction in pychromecast 14 (defect S2 used a
            # host=/port= signature that no longer exists).
            cast = pychromecast.get_chromecast_from_cast_info(info, zconf)
            cast.wait(timeout=CONNECT_TIMEOUT)

            media_listener = _MediaListener(device.id, self._post_state)
            cast.media_controller.register_status_listener(media_listener)
            cast.register_connection_listener(
                _ConnectionListener(device.id, self._post_state)
            )

            with self._lock:
                self._casts[device.id] = cast

            LOG.info("casting to %s: %s (%s)", device.name, url, content_type)
            cast.media_controller.play_media(
                url,
                content_type,
                stream_type="LIVE",
                title="Cast Display",
                autoplay=True,
            )
            self._post_state(device.id, STATE_BUFFERING, "")
            try:
                cast.media_controller.block_until_active(timeout=PLAYING_TIMEOUT)
            except Exception as exc:
                LOG.warning("%s did not become active: %s", device.name, exc)
        except Exception as exc:
            LOG.exception("could not cast to %s", device.name)
            self._post_state(device.id, STATE_ERROR, str(exc) or "connection failed")

    def detach(self, device_id: str) -> bool:
        with self._lock:
            session = self._sessions.pop(device_id, None)
            cast = self._casts.pop(device_id, None)
        if session is None:
            return False
        if cast is not None:
            self._pool.submit(self._quit, cast, session.name)
        self._notify()
        return True

    def detach_all(self) -> None:
        with self._lock:
            casts = list(self._casts.items())
            self._casts.clear()
            self._sessions.clear()
        for device_id, cast in casts:
            self._pool.submit(self._quit, cast, device_id)
        self._notify()

    def _quit(self, cast: Any, name: str) -> None:
        try:
            cast.media_controller.stop()
        except Exception:
            LOG.debug("media stop for %s failed", name, exc_info=True)
        try:
            cast.quit_app()
        except Exception:
            LOG.debug("quit_app for %s failed", name, exc_info=True)
        try:
            cast.disconnect(blocking=False)
        except Exception:
            LOG.debug("disconnect for %s failed", name, exc_info=True)

    def shutdown(self) -> None:
        self.detach_all()
        self._pool.shutdown(wait=False, cancel_futures=True)

    # -- state plumbing ----------------------------------------------------

    def _post_state(self, device_id: str, state: str, error: str) -> None:
        """Called from worker threads and pychromecast's own threads."""
        GLib.idle_add(self._apply_state, device_id, state, error)

    def _apply_state(self, device_id: str, state: str, error: str) -> bool:
        changed = False
        name = device_id
        with self._lock:
            session = self._sessions.get(device_id)
            if session is not None:
                name = session.name
                if session.state != state or session.error != error:
                    session.state = state
                    session.error = error
                    changed = True
        if changed:
            self._notify()
            if state == STATE_ERROR:
                self._on_error("receiver", device_id, f"{name}: {error}")
        return False

    def _notify(self) -> None:
        self._on_session_changed()
