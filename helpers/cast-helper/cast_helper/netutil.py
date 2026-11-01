"""Network helpers.

The important one is `source_ip_for`: the stream URL must carry the address of
the interface that actually reaches *that* receiver. Picking one address by
routing to a public resolver (defect S10) gives the wrong interface whenever a
VPN, Docker bridge or second NIC is present — and this machine has three
candidate interfaces.
"""

from __future__ import annotations

import errno
import ipaddress
import logging
import socket
from collections.abc import Iterable

LOG = logging.getLogger("cast-helper.net")

CAST_PORT = 8009


def source_ip_for(host: str, port: int = CAST_PORT) -> str:
    """The local address the kernel would use to reach `host`.

    A UDP connect() performs a route lookup without sending a packet, so this
    is cheap and does not touch the network.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(1.0)
            sock.connect((host, port))
            ip = sock.getsockname()[0]
        if ip and not ip.startswith("127."):
            return ip
        LOG.warning("route to %s resolves to loopback %s", host, ip)
        return ip
    except OSError as exc:
        LOG.warning("no route to %s: %s", host, exc)
        raise


def local_addresses() -> list[tuple[str, str]]:
    """Non-loopback IPv4 addresses as (interface, address).

    The stdlib does not expose getifaddrs, so the interface name is unknown
    here and reported as "?". `doctor` shells out to `ip -j addr` when it
    needs real names; nothing in the streaming path needs them.
    """
    found: list[tuple[str, str]] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addr = info[4][0]
            try:
                parsed = ipaddress.ip_address(addr)
            except ValueError:
                continue
            if not parsed.is_loopback and not parsed.is_link_local:
                found.append(("?", addr))
    except OSError:
        pass
    return found


def pick_port(port_range: tuple[int, int], bind_host: str = "0.0.0.0") -> int:
    """First free TCP port in `port_range`.

    A fixed range is what makes a firewall rule possible; a random high port
    cannot be allowed through in advance.
    """
    low, high = port_range
    last_error: OSError | None = None
    for port in range(low, high + 1):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind((bind_host, port))
            return port
        except OSError as exc:
            if exc.errno not in (errno.EADDRINUSE, errno.EACCES):
                raise
            last_error = exc
    raise OSError(
        f"no free port in {low}-{high}"
        + (f" (last: {last_error})" if last_error else "")
    )


def same_subnet(a: str, b: str, prefix: int = 24) -> bool:
    try:
        net = ipaddress.ip_network(f"{a}/{prefix}", strict=False)
        return ipaddress.ip_address(b) in net
    except ValueError:
        return False


LOOPBACK = frozenset({"127.0.0.1", "::1"})


def allowlist_for(hosts: Iterable[str], include_loopback: bool = False) -> set[str]:
    """The receiver hosts attached to a stream, and nothing else.

    Loopback is **not** granted by default. The brief allows it "for the dev
    harness", but adding it unconditionally would let any local process that
    guessed the token read the user's screen, which is a hole on a
    multi-user machine for no benefit in production. It is therefore granted
    only when the dev harness is running, or when a receiver genuinely is on
    loopback (which is what a fake receiver is).
    """
    allowed = {h for h in hosts if h}
    if include_loopback or allowed & LOOPBACK:
        allowed |= set(LOOPBACK)
    return allowed
