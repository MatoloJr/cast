"""StreamServer: who gets the stream, and does every client get all of it.

These run a real server on a real socket against a real GLib main loop, and
drive it with real HTTP clients, because the defects being guarded against
(F3, F4, S9) were all in the delivery path rather than in any pure function.

A fake sink stands in for `multisocketsink` so the tests do not need an
encoder: it writes the same recorded byte stream to every socket handed to
it, which is exactly the contract F3 violated.
"""

from __future__ import annotations

import hashlib
import http.client
import socket
import threading
import time

import gi
import pytest

gi.require_version("Gst", "1.0")
from gi.repository import GLib  # noqa: E402

from cast_helper import config  # noqa: E402
from cast_helper.stream_server import StreamServer  # noqa: E402

PORT_RANGE = (18765, 18790)


class FakeSink:
    """Writes an identical stream to every client, like multisocketsink.

    Includes a one-off "streamheader" prefix, so the Matroska header problem
    (a late joiner that never receives the EBML header) is representable.
    """

    HEADER = b"EBML-HEADER-" + b"h" * 52
    CHUNK = 1024

    def __init__(self, chunks: int = 24):
        self.chunks = chunks
        self.threads: list[threading.Thread] = []
        self.delivered: dict[int, bytes] = {}
        self.lock = threading.Lock()

    def payload(self) -> bytes:
        return self.HEADER + b"".join(
            bytes([i % 251]) * self.CHUNK for i in range(self.chunks)
        )

    def add(self, gsocket) -> None:
        fd = gsocket.get_fd()
        sock = socket.socket(fileno=socket.dup(fd))
        data = self.payload()

        def pump():
            written = bytearray()
            try:
                # Dribble it out so concurrent clients genuinely interleave.
                for offset in range(0, len(data), self.CHUNK):
                    piece = data[offset:offset + self.CHUNK]
                    sock.sendall(piece)
                    written.extend(piece)
                    time.sleep(0.002)
            except OSError:
                pass
            finally:
                with self.lock:
                    self.delivered[fd] = bytes(written)
                try:
                    sock.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                sock.close()

        thread = threading.Thread(target=pump, daemon=True)
        self.threads.append(thread)
        thread.start()


class Loop:
    """A GLib main loop on a background thread, so clients can block."""

    def __init__(self):
        self.context = GLib.MainContext.default()
        self.loop = GLib.MainLoop.new(self.context, False)
        self.thread = threading.Thread(target=self.loop.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.loop.quit()
        self.thread.join(timeout=5)


@pytest.fixture
def server():
    created: list[StreamServer] = []

    def make(stream_id="abc123", allowed=("127.0.0.1",)):
        instance = StreamServer(
            stream_id, config.CONTENT_TYPES[config.FORMAT_MATROSKA], PORT_RANGE
        )
        instance.set_allowed_hosts(allowed)
        created.append(instance)
        return instance

    yield make
    for instance in created:
        instance.stop()


def get(server: StreamServer, path: str | None = None, timeout: float = 5.0):
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=timeout)
    conn.request("GET", path if path is not None else server.path)
    return conn, conn.getresponse()


# -- access control (defect S9) -------------------------------------------


def test_correct_token_is_accepted(server):
    instance = server()
    sink = FakeSink()
    with Loop():
        instance.start(sink.add)
        conn, response = get(instance)
        assert response.status == 200
        assert response.getheader("Content-Type") == "video/x-matroska"
        conn.close()


def test_wrong_token_is_404(server):
    instance = server()
    with Loop():
        instance.start(lambda s: None)
        conn, response = get(
            instance, f"/s/{instance.stream_id}/{'0' * 32}/stream.mkv"
        )
        assert response.status == 404
        conn.close()


def test_missing_token_is_404(server):
    instance = server()
    with Loop():
        instance.start(lambda s: None)
        conn, response = get(instance, "/stream.mkv")
        assert response.status == 404
        conn.close()


def test_token_is_128_bits_of_randomness(server):
    first = server(stream_id="a")
    second = server(stream_id="b")
    assert len(first.token) == 32          # 32 hex chars = 128 bits
    assert first.token != second.token


def test_non_allowlisted_host_is_403_even_with_a_valid_token(server):
    """The screen must not be readable by other hosts on the LAN."""
    instance = server(allowed=("10.99.99.99",))   # loopback not included
    with Loop():
        instance.start(lambda s: None)
        conn, response = get(instance)
        assert response.status == 403
        conn.close()
    assert instance.rejections >= 1


def test_loopback_is_not_granted_to_a_lan_only_stream(server):
    """Loopback is for the dev harness, not a standing local grant."""
    instance = server(allowed=("192.168.1.50",))
    assert instance._allowed == {"192.168.1.50"}


def test_loopback_is_granted_when_a_receiver_is_itself_on_loopback(server):
    instance = server(allowed=("127.0.0.1",))
    assert "127.0.0.1" in instance._allowed
    assert "::1" in instance._allowed


def test_options_preflight(server):
    instance = server()
    with Loop():
        instance.start(lambda s: None)
        conn = http.client.HTTPConnection("127.0.0.1", instance.port, timeout=5)
        conn.request("OPTIONS", instance.path)
        response = conn.getresponse()
        assert response.status == 204
        assert response.getheader("Access-Control-Allow-Origin") == "*"
        conn.close()


def test_head_does_not_hand_off_a_socket(server):
    instance = server()
    handed: list = []
    with Loop():
        instance.start(handed.append)
        conn = http.client.HTTPConnection("127.0.0.1", instance.port, timeout=5)
        conn.request("HEAD", instance.path)
        response = conn.getresponse()
        assert response.status == 200
        conn.close()
    assert handed == []


def test_unsupported_method_is_405(server):
    instance = server()
    with Loop():
        instance.start(lambda s: None)
        conn = http.client.HTTPConnection("127.0.0.1", instance.port, timeout=5)
        conn.request("DELETE", instance.path)
        assert conn.getresponse().status == 405
        conn.close()


# -- delivery (defects F3, F4) --------------------------------------------


def _read_all(server: StreamServer, delay: float = 0.0) -> bytes:
    if delay:
        time.sleep(delay)
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
    conn.request("GET", server.path)
    response = conn.getresponse()
    try:
        return response.read()
    finally:
        conn.close()


def test_two_concurrent_clients_each_receive_the_whole_stream(server):
    """Defect F3: the old server split the bytes between clients.

    Measured before the fix: 78.6% / 21.4% of disjoint, undecodable data.
    """
    instance = server()
    sink = FakeSink(chunks=24)
    results: dict[int, bytes] = {}

    with Loop():
        instance.start(sink.add)

        def client(index: int):
            results[index] = _read_all(instance)

        threads = [threading.Thread(target=client, args=(i,)) for i in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

    assert len(results) == 2, "a client never finished"
    expected = sink.payload()
    for index, data in results.items():
        assert data == expected, (
            f"client {index} got {len(data)} of {len(expected)} bytes"
        )
    digests = {hashlib.sha256(d).hexdigest() for d in results.values()}
    assert len(digests) == 1, "clients received different bytes"


def test_three_concurrent_clients_all_complete(server):
    instance = server()
    sink = FakeSink(chunks=16)
    results: dict[int, bytes] = {}

    with Loop():
        instance.start(sink.add)
        threads = [
            threading.Thread(
                target=lambda i=i: results.__setitem__(i, _read_all(instance))
            )
            for i in range(3)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=25)

    assert len(results) == 3
    expected = sink.payload()
    assert all(data == expected for data in results.values())


def test_a_late_joiner_receives_the_stream_header(server):
    """Defect F4, and Matroska's once-only EBML header.

    A client that joins mid-stream must still get the header, or it can
    never decode. Measured without this: "Invalid data found when
    processing input".
    """
    instance = server()
    sink = FakeSink(chunks=20)
    results: dict[str, bytes] = {}

    with Loop():
        instance.start(sink.add)
        early = threading.Thread(
            target=lambda: results.__setitem__("early", _read_all(instance))
        )
        late = threading.Thread(
            target=lambda: results.__setitem__("late", _read_all(instance, delay=0.05))
        )
        early.start()
        late.start()
        early.join(timeout=20)
        late.join(timeout=20)

    assert results["late"].startswith(FakeSink.HEADER), (
        "a late joiner did not receive the stream header"
    )
    assert results["early"] == results["late"]


def test_a_client_that_hangs_up_does_not_disturb_the_others(server):
    """One receiver unplugged must not take the rest of the stream down."""
    instance = server()
    sink = FakeSink(chunks=24)
    survivor: dict[str, bytes] = {}

    with Loop():
        instance.start(sink.add)

        # A client that reads one byte and vanishes.
        rude = http.client.HTTPConnection("127.0.0.1", instance.port, timeout=5)
        rude.request("GET", instance.path)
        rude.getresponse().read(1)
        rude.close()

        thread = threading.Thread(
            target=lambda: survivor.__setitem__("data", _read_all(instance))
        )
        thread.start()
        thread.join(timeout=20)

    assert survivor.get("data") == sink.payload()


def test_server_binds_inside_the_configured_range(server):
    instance = server()
    assert PORT_RANGE[0] <= instance.port <= PORT_RANGE[1]


def test_url_for_uses_a_routable_local_address(server):
    instance = server()
    url = instance.url_for("127.0.0.1")
    assert url.startswith("http://127.0.0.1:")
    assert url.endswith(instance.path)
    assert instance.token in url


def test_stop_releases_the_port(server):
    instance = server()
    with Loop():
        instance.start(lambda s: None)
        port = instance.port
        instance.stop()
        time.sleep(0.2)
        # Binding again proves the listener is gone.
        probe = socket.socket()
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", port))
        probe.close()
