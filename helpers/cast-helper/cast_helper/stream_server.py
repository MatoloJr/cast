"""HTTP front door for the stream.

Its whole job is to decide *who* may watch the screen and then get out of the
way: once the response headers are written, the connected socket is handed to
the pipeline's `multisocketsink` and GStreamer does the writing.

Two defences, because the payload is the user's screen (defect S9: the old
server bound 0.0.0.0 on a guessable path, so anyone on the LAN could watch):

* an unguessable 128-bit token in the path;
* an IP allowlist containing only the receivers actually attached to this
  stream, plus loopback for the dev harness.

Built on `Gio.SocketService`, so accepting and reading requests happens on the
GLib main loop without a thread and without blocking.
"""

from __future__ import annotations

import logging
import secrets
from collections.abc import Callable
from typing import Any

from gi.repository import Gio, GLib

from . import config, dev_harness, netutil

LOG = logging.getLogger("cast-helper.server")

MAX_REQUEST_BYTES = 8192


class StreamServer:
    """Serves exactly one stream, on one port, to an allowlisted set of hosts."""

    def __init__(
        self,
        stream_id: str,
        content_type: str,
        port_range: tuple[int, int] = config.DEFAULT_PORT_RANGE,
    ):
        self.stream_id = stream_id
        self.content_type = content_type
        self.token = secrets.token_hex(16)          # 128 bits
        self.port = netutil.pick_port(port_range)
        self._service: Gio.SocketService | None = None
        self._allowed: set[str] = set()
        self._on_client: Callable[[Gio.Socket], None] | None = None
        # Keep connections referenced: multisocketsink writes to the fd and
        # letting Python drop the GSocketConnection would close it underneath.
        self._handed_off: dict[int, Any] = {}
        self._rejections = 0

    # -- lifecycle ---------------------------------------------------------

    @property
    def path(self) -> str:
        return f"/s/{self.stream_id}/{self.token}/stream.mkv"

    def url_for(self, receiver_host: str) -> str:
        """Stream URL using the interface that actually reaches this receiver.

        Chosen per receiver rather than once globally, which is what defect
        S10 got wrong on any machine with a VPN or a Docker bridge.
        """
        ip = netutil.source_ip_for(receiver_host)
        return f"http://{ip}:{self.port}{self.path}"

    def set_allowed_hosts(self, hosts) -> None:
        self._allowed = netutil.allowlist_for(
            hosts, include_loopback=dev_harness.enabled()
        )
        LOG.info("allowlist for %s: %s", self.stream_id, sorted(self._allowed))

    def start(self, on_client: Callable[[Gio.Socket], None]) -> None:
        self._on_client = on_client
        self._service = Gio.SocketService.new()
        self._service.add_inet_port(self.port, None)
        self._service.connect("incoming", self._on_incoming)
        self._service.start()
        LOG.info("stream server listening on port %d", self.port)

    def stop(self) -> None:
        if self._service is not None:
            self._service.stop()
            self._service.close()
            self._service = None
        self._handed_off.clear()

    def forget(self, fd: int) -> None:
        self._handed_off.pop(fd, None)

    # -- request handling --------------------------------------------------

    def _peer_address(self, connection: Gio.SocketConnection) -> str:
        try:
            remote = connection.get_remote_address()
            return remote.get_address().to_string()
        except Exception:
            return ""

    def _on_incoming(self, _service, connection: Gio.SocketConnection, _source) -> bool:
        peer = self._peer_address(connection)
        if peer not in self._allowed:
            self._rejections += 1
            LOG.warning("refusing stream request from %s (not a receiver)", peer)
            self._respond_and_close(connection, 403, "Forbidden")
            return True

        stream = connection.get_input_stream()
        buffer = bytearray()

        def on_read(input_stream, result):
            try:
                data = input_stream.read_bytes_finish(result).get_data()
            except GLib.Error as exc:
                LOG.debug("read from %s failed: %s", peer, exc.message)
                return
            if not data:
                return
            buffer.extend(data)
            if b"\r\n\r\n" in buffer or b"\n\n" in buffer:
                self._dispatch(connection, peer, bytes(buffer))
                return
            if len(buffer) >= MAX_REQUEST_BYTES:
                self._respond_and_close(
                    connection, 431, "Request Header Fields Too Large")
                return
            input_stream.read_bytes_async(
                MAX_REQUEST_BYTES, GLib.PRIORITY_DEFAULT, None, on_read
            )

        stream.read_bytes_async(MAX_REQUEST_BYTES, GLib.PRIORITY_DEFAULT, None, on_read)
        return True

    def _dispatch(self, connection: Gio.SocketConnection, peer: str, raw: bytes) -> None:
        try:
            head = raw.split(b"\r\n\r\n", 1)[0].decode("latin-1")
            request_line = head.splitlines()[0]
            method, target, _version = request_line.split(None, 2)
        except (ValueError, IndexError):
            self._respond_and_close(connection, 400, "Bad Request")
            return

        LOG.info("%s %s from %s", method, target, peer)

        if method == "OPTIONS":
            self._respond_and_close(
                connection, 204, "No Content",
                extra=[
                    "Access-Control-Allow-Origin: *",
                    "Access-Control-Allow-Methods: GET, HEAD, OPTIONS",
                ],
            )
            return

        if target != self.path:
            # Wrong or missing token: do not hint that the path exists.
            self._rejections += 1
            LOG.warning("bad stream token from %s", peer)
            self._respond_and_close(connection, 404, "Not Found")
            return

        if method not in ("GET", "HEAD"):
            self._respond_and_close(connection, 405, "Method Not Allowed")
            return

        headers = [
            f"Content-Type: {self.content_type}",
            "Cache-Control: no-cache, no-store",
            "Access-Control-Allow-Origin: *",
            "Accept-Ranges: none",
            # No Content-Length: the stream is live and close-delimited,
            # which is what the working reference implementation does.
            "Connection: close",
        ]
        if method == "HEAD":
            self._respond_and_close(connection, 200, "OK", extra=headers)
            return

        if not self._write_headers(connection, 200, "OK", headers):
            return

        socket = connection.get_socket()
        fd = socket.get_fd()
        self._handed_off[fd] = connection
        LOG.info("handing socket fd=%d (%s) to the pipeline", fd, peer)
        if self._on_client:
            try:
                self._on_client(socket)
            except Exception:
                LOG.exception("could not attach client %s to the pipeline", peer)
                self._handed_off.pop(fd, None)

    # -- low-level responses ----------------------------------------------

    def _write_headers(
        self, connection: Gio.SocketConnection, code: int, reason: str, extra: list[str]
    ) -> bool:
        payload = f"HTTP/1.1 {code} {reason}\r\n" + "\r\n".join(extra) + "\r\n\r\n"
        try:
            connection.get_output_stream().write_all(payload.encode("latin-1"), None)
            return True
        except GLib.Error as exc:
            LOG.debug("could not write response headers: %s", exc.message)
            return False

    def _respond_and_close(
        self,
        connection: Gio.SocketConnection,
        code: int,
        reason: str,
        extra: list[str] | None = None,
    ) -> None:
        headers = list(extra or [])
        headers.append("Content-Length: 0")
        headers.append("Connection: close")
        self._write_headers(connection, code, reason, headers)
        try:
            connection.close(None)
        except GLib.Error:
            pass

    @property
    def rejections(self) -> int:
        return self._rejections
