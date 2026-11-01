"""ScreenCast portal client, fully asynchronous.

Nothing here blocks. The old implementation pumped a nested
`MainContext.iteration()` loop from inside a D-Bus handler while holding a
non-reentrant lock, so a `Stop()` arriving during the portal dialog
deadlocked the process for good (defect S1). This module instead:

* subscribes to the `Response` signal on the predicted request path *before*
  issuing the call, so no response can be missed;
* returns immediately, delivering results through callbacks on the main loop;
* can be cancelled at any point, including while the dialog is open, by
  calling `Request.Close` on whatever request is outstanding.

It also asks for `persist_mode=2` and replays a saved `restore_token`, so the
user approves the share once rather than on every connect (gap G5).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any, Callable, Optional

from gi.repository import Gio, GLib

from . import config

LOG = logging.getLogger("cast-helper.portal")

PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SCREENCAST_IFACE = "org.freedesktop.portal.ScreenCast"
REQUEST_IFACE = "org.freedesktop.portal.Request"
SESSION_IFACE = "org.freedesktop.portal.Session"

# SelectSources `types` bitmask.
SOURCE_MONITOR = 1
SOURCE_WINDOW = 2
SOURCE_VIRTUAL = 4

CURSOR_EMBEDDED = 2

PERSIST_UNTIL_REVOKED = 2


class PortalError(Exception):
    def __init__(self, message: str, denied: bool = False):
        super().__init__(message)
        self.denied = denied


def _tokens_load() -> dict[str, str]:
    try:
        with open(config.portal_token_path(), encoding="utf-8") as handle:
            data = json.load(handle)
        return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _tokens_save(tokens: dict[str, str]) -> None:
    path = config.portal_token_path()
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(tokens, handle)
        os.replace(tmp, path)
    except OSError as exc:
        LOG.warning("could not save portal restore token: %s", exc)


class ScreenCastSession:
    """One portal session: CreateSession → SelectSources → Start → fd.

    Usage is callback-driven:

        session = ScreenCastSession(bus)
        session.start(mode, on_ready=..., on_error=..., on_closed=...)
        ...
        session.cancel()      # safe at any time
    """

    def __init__(self, bus: Gio.DBusConnection):
        self._bus = bus
        self._sender = bus.get_unique_name()[1:].replace(".", "_")
        self._session_handle: Optional[str] = None
        self._pending_request: Optional[str] = None
        self._subscriptions: list[int] = []
        self._closed_subscription: Optional[int] = None
        self._cancelled = False
        self._mode = config.MODE_MIRROR
        self._on_ready: Optional[Callable[[int, int], None]] = None
        self._on_error: Optional[Callable[[PortalError], None]] = None
        self._on_closed: Optional[Callable[[], None]] = None
        self._fd: Optional[int] = None
        self._node_id: Optional[int] = None

    # -- public ------------------------------------------------------------

    def start(
        self,
        mode: str,
        on_ready: Callable[[int, int], None],
        on_error: Callable[[PortalError], None],
        on_closed: Optional[Callable[[], None]] = None,
    ) -> None:
        self._mode = mode
        self._on_ready = on_ready
        self._on_error = on_error
        self._on_closed = on_closed
        self._create_session()

    def cancel(self) -> None:
        """Abandon the session, closing a dialog that is still open."""
        if self._cancelled:
            return
        self._cancelled = True
        LOG.info("cancelling portal session")
        if self._pending_request:
            self._close_request(self._pending_request)
            self._pending_request = None
        self.close()

    def close(self) -> None:
        for sub in self._subscriptions:
            self._bus.signal_unsubscribe(sub)
        self._subscriptions.clear()
        if self._closed_subscription is not None:
            self._bus.signal_unsubscribe(self._closed_subscription)
            self._closed_subscription = None
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None
        if self._session_handle:
            handle, self._session_handle = self._session_handle, None
            try:
                self._bus.call(
                    PORTAL_BUS, handle, SESSION_IFACE, "Close",
                    None, None, Gio.DBusCallFlags.NONE, 5000, None, None,
                )
            except Exception:
                LOG.debug("session Close failed", exc_info=True)

    def release_fd(self) -> None:
        """Hand fd ownership to the pipeline; we must not close it."""
        self._fd = None

    @property
    def node_id(self) -> Optional[int]:
        return self._node_id

    # -- internals ---------------------------------------------------------

    def _fail(self, message: str, denied: bool = False) -> None:
        if self._cancelled:
            return
        LOG.warning("portal failed: %s", message)
        callback, self._on_error = self._on_error, None
        if callback:
            callback(PortalError(message, denied))

    def _request_path(self, token: str) -> str:
        return f"{PORTAL_PATH}/request/{self._sender}/{token}"

    def _close_request(self, path: str) -> None:
        try:
            self._bus.call(
                PORTAL_BUS, path, REQUEST_IFACE, "Close",
                None, None, Gio.DBusCallFlags.NONE, 5000, None, None,
            )
        except Exception:
            LOG.debug("Request.Close failed", exc_info=True)

    def _call(
        self,
        method: str,
        args: GLib.Variant,
        options: dict[str, GLib.Variant],
        on_response: Callable[[int, dict], None],
        timeout_ms: int = 180000,
    ) -> None:
        """Issue a portal request, subscribing to Response first."""
        token = uuid.uuid4().hex
        options = dict(options)
        options["handle_token"] = GLib.Variant("s", token)
        path = self._request_path(token)

        def handler(_conn, _sender, _path, _iface, _signal, params):
            LOG.debug("%s: Response on %s", method, _path)
            if self._cancelled:
                return
            self._pending_request = None
            response, results = params.unpack()
            on_response(int(response), results or {})

        # Subscribe *before* calling: otherwise a fast portal can answer
        # before we are listening and the request hangs for ever.
        sub = self._bus.signal_subscribe(
            PORTAL_BUS, REQUEST_IFACE, "Response", path, None,
            Gio.DBusSignalFlags.NONE, handler,
        )
        self._subscriptions.append(sub)
        self._pending_request = path
        LOG.debug("%s: subscribed to %s", method, path)

        payload = GLib.Variant.new_tuple(
            *(list(args) if args is not None else []),
            GLib.Variant("a{sv}", options),
        )

        def on_call_done(conn, result):
            try:
                reply = conn.call_finish(result)
                LOG.debug("%s accepted, request=%s", method, reply.unpack()[0])
            except GLib.Error as exc:
                self._pending_request = None
                self._fail(f"{method}: {exc.message}")

        self._bus.call(
            PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, method,
            payload, GLib.VariantType("(o)"),
            Gio.DBusCallFlags.NONE, timeout_ms, None, on_call_done,
        )

    def _create_session(self) -> None:
        token = uuid.uuid4().hex

        def on_response(response: int, results: dict) -> None:
            if response != 0:
                self._fail("screen share cancelled", denied=response == 1)
                return
            handle = results.get("session_handle")
            if not handle:
                self._fail("portal returned no session handle")
                return
            self._session_handle = str(handle)
            self._watch_session_closed()
            self._select_sources()

        self._call(
            "CreateSession",
            None,
            {"session_handle_token": GLib.Variant("s", token)},
            on_response,
            timeout_ms=30000,
        )

    def _watch_session_closed(self) -> None:
        """GNOME's own "Stop sharing" button closes the session (G5/portal)."""

        def handler(*_args):
            LOG.info("portal session closed by the user")
            callback = self._on_closed
            if callback:
                callback()

        self._closed_subscription = self._bus.signal_subscribe(
            PORTAL_BUS, SESSION_IFACE, "Closed", self._session_handle, None,
            Gio.DBusSignalFlags.NONE, handler,
        )

    def _available_source_types(self) -> int:
        try:
            reply = self._bus.call_sync(
                PORTAL_BUS, PORTAL_PATH, "org.freedesktop.DBus.Properties", "Get",
                GLib.Variant("(ss)", (SCREENCAST_IFACE, "AvailableSourceTypes")),
                GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 3000, None,
            )
            return int(reply.unpack()[0])
        except Exception:
            return SOURCE_MONITOR

    def _select_sources(self) -> None:
        available = self._available_source_types()
        if self._mode == config.MODE_EXTEND:
            if not available & SOURCE_VIRTUAL:
                self._fail(
                    "this desktop cannot create a virtual monitor, so Extend "
                    "is unavailable; use Mirror"
                )
                return
            types = SOURCE_VIRTUAL
        else:
            types = SOURCE_MONITOR

        options: dict[str, GLib.Variant] = {
            "types": GLib.Variant("u", types),
            "multiple": GLib.Variant("b", False),
            "cursor_mode": GLib.Variant("u", CURSOR_EMBEDDED),
            "persist_mode": GLib.Variant("u", PERSIST_UNTIL_REVOKED),
        }
        token = _tokens_load().get(self._mode)
        if token:
            LOG.info("replaying portal restore token for %s", self._mode)
            options["restore_token"] = GLib.Variant("s", token)

        def on_response(response: int, _results: dict) -> None:
            if response != 0:
                self._fail("screen share cancelled", denied=response == 1)
                return
            self._start()

        self._call(
            "SelectSources",
            [GLib.Variant("o", self._session_handle)],
            options,
            on_response,
            timeout_ms=30000,
        )

    def _start(self) -> None:
        def on_response(response: int, results: dict) -> None:
            if response != 0:
                self._fail("screen share cancelled", denied=response == 1)
                return
            streams = results.get("streams") or []
            if not streams:
                self._fail("portal returned no streams")
                return
            self._node_id = int(streams[0][0])

            token = results.get("restore_token")
            if token:
                tokens = _tokens_load()
                tokens[self._mode] = str(token)
                _tokens_save(tokens)
                LOG.info("saved portal restore token for %s", self._mode)

            self._open_pipewire_remote()

        self._call(
            "Start",
            [GLib.Variant("o", self._session_handle), GLib.Variant("s", "")],
            {},
            on_response,
            # The dialog waits for a human. Keep this generous, but note the
            # client never blocks on it: StartCast returned long ago.
            timeout_ms=300000,
        )

    def _open_pipewire_remote(self) -> None:
        def on_done(conn, result):
            if self._cancelled:
                return
            try:
                reply, fd_list = conn.call_with_unix_fd_list_finish(result)
            except GLib.Error as exc:
                self._fail(f"OpenPipeWireRemote: {exc.message}")
                return
            index = reply.unpack()[0]
            try:
                self._fd = fd_list.get(index)
            except Exception as exc:
                self._fail(f"could not take the PipeWire fd: {exc}")
                return
            LOG.info("portal ready: fd=%s node=%s", self._fd, self._node_id)
            callback, self._on_ready = self._on_ready, None
            if callback:
                callback(self._fd, int(self._node_id or 0))

        self._bus.call_with_unix_fd_list(
            PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (self._session_handle, {})),
            GLib.VariantType("(h)"),
            Gio.DBusCallFlags.NONE, 10000, None, None, on_done,
        )


class FakePortal:
    """Test-source stand-in. Also the vehicle for the S1 regression test.

    With `never_answers=True` it starts a session that never completes, which
    is exactly the state the old code deadlocked in.
    """

    def __init__(self, never_answers: bool = False):
        self.never_answers = never_answers
        self.cancelled = False
        self.node_id = 0
        self._timeout: Optional[int] = None

    def start(self, mode, on_ready, on_error, on_closed=None) -> None:
        if self.never_answers:
            LOG.warning("fake portal: never answering (S1 regression mode)")
            return

        def deliver() -> bool:
            self._timeout = None
            if not self.cancelled:
                on_ready(-1, 0)
            return False

        self._timeout = GLib.timeout_add(10, deliver)

    def cancel(self) -> None:
        self.cancelled = True
        if self._timeout is not None:
            GLib.source_remove(self._timeout)
            self._timeout = None

    def close(self) -> None:
        self.cancel()

    def release_fd(self) -> None:
        pass
