"""Entry point: `python -m cast_helper`."""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

from . import config, dev_harness  # noqa: E402

LOG = logging.getLogger("cast-helper")


def _setup_logging() -> None:
    level_name = os.environ.get("CAST_HELPER_LOG", "info").upper()
    logging.basicConfig(
        level=getattr(logging, level_name, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    parser = argparse.ArgumentParser(prog="cast_helper", add_help=True)
    parser.add_argument("--doctor", action="store_true",
                        help="print environment diagnostics and exit")
    parser.add_argument("--no-discovery", action="store_true",
                        help="with --doctor: skip the mDNS scan")
    parser.add_argument("--fake-portal", action="store_true",
                        help="dev: skip the real ScreenCast portal")
    parser.add_argument("--fake-portal-hangs", action="store_true",
                        help="dev: portal that never answers (S1 regression)")
    args = parser.parse_args(argv)

    if args.doctor:
        from . import doctor

        return doctor.run(["--no-discovery"] if args.no_discovery else [])

    _setup_logging()
    dev_harness.log_banner(LOG)

    from .dbus_service import CastService

    loop = GLib.MainLoop()
    service_holder: dict[str, CastService] = {}

    def on_bus_acquired(connection: Gio.DBusConnection, name: str) -> None:
        LOG.info("acquired %s", name)
        service = CastService(
            connection,
            fake_portal=args.fake_portal,
            fake_portal_hangs=args.fake_portal_hangs,
        )
        service.register()
        service_holder["service"] = service

    def on_name_lost(_connection, name: str) -> None:
        LOG.error("lost the bus name %s another helper is running?", name)
        loop.quit()

    owner_id = Gio.bus_own_name(
        Gio.BusType.SESSION,
        config.BUS_NAME,
        Gio.BusNameOwnerFlags.NONE,
        on_bus_acquired,
        None,
        on_name_lost,
    )

    def handle_signal(*_args) -> bool:
        LOG.info("shutting down")
        service = service_holder.get("service")
        if service is not None:
            service.shutdown()
        loop.quit()
        return False

    # Unix signal handlers on the GLib loop, so teardown runs on the main
    # thread with the loop still alive to flush D-Bus traffic.
    # GLib.unix_signal_add moved to GLibUnix in newer PyGObject; prefer the
    # new home and fall back so GNOME 45-49 still works.
    try:
        gi.require_version("GLibUnix", "2.0")
        from gi.repository import GLibUnix

        add_signal = GLibUnix.signal_add
    except (ImportError, ValueError):
        add_signal = GLib.unix_signal_add
    add_signal(GLib.PRIORITY_HIGH, signal.SIGTERM, handle_signal)
    add_signal(GLib.PRIORITY_HIGH, signal.SIGINT, handle_signal)

    LOG.info("cast helper ready on %s (API v%d)", config.BUS_NAME, config.API_VERSION)
    try:
        loop.run()
    finally:
        Gio.bus_unown_name(owner_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
