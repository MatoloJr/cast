"""The org.cast.tools.Cast1 service, API v2, on Gio's GDBus.

Rules this module exists to enforce:

* **Every method returns immediately.** Validation happens inline; the work is
  async. `StartCast` hands back a `stream_id` as soon as the request is
  well-formed, so the Shell never waits on a portal dialog or a TV.
* **Only the main thread mutates state.** Worker threads post back with
  `GLib.idle_add`.
* **Stop works in every state**, including with a portal dialog open. There is
  no operation lock to deadlock on (defect S1); the state machine's generation
  counter tells stale async work that it has been abandoned.
* **Properties only change when the value changes**, so the UI stops
  rebuilding itself every discovery tick (defect S5).
"""

from __future__ import annotations

import logging
import secrets
import time
from typing import Any, Optional

from gi.repository import Gio, GLib

from . import (
    config,
    dev_harness,
    discovery,
    miracast,
    pipeline,
    portal,
    receivers,
    stream_server,
)
from .state import Event, State, StateMachine, Step

LOG = logging.getLogger("cast-helper.service")

INTROSPECTION = """
<node>
  <interface name="org.cast.tools.Cast1">
    <property name="ApiVersion"   type="u"      access="read"/>
    <property name="State"        type="s"      access="read"/>
    <property name="LastError"    type="s"      access="read"/>
    <property name="Devices"      type="aa{sv}" access="read"/>
    <property name="Sessions"     type="aa{sv}" access="read"/>
    <property name="Streams"      type="aa{sv}" access="read"/>
    <property name="Capabilities" type="a{sv}"  access="read"/>
    <method name="Refresh"/>
    <method name="StartCast">
      <arg name="device_ids" type="as"   direction="in"/>
      <arg name="options"    type="a{sv}" direction="in"/>
      <arg name="stream_id"  type="s"    direction="out"/>
    </method>
    <method name="AddDevices">
      <arg name="stream_id"  type="s"  direction="in"/>
      <arg name="device_ids" type="as" direction="in"/>
    </method>
    <method name="RemoveDevice">
      <arg name="device_id" type="s" direction="in"/>
    </method>
    <method name="StopStream">
      <arg name="stream_id" type="s" direction="in"/>
    </method>
    <method name="StopAll"/>
    <method name="OpenMiracast"/>
    <signal name="Error">
      <arg name="scope"   type="s"/>
      <arg name="id"      type="s"/>
      <arg name="message" type="s"/>
    </signal>
  </interface>
</node>
"""


class Stream:
    """One capture + encode, shared by every receiver attached to it."""

    def __init__(self, stream_id: str, options: config.StreamOptions):
        self.stream_id = stream_id
        self.options = options
        self.started_at = int(time.time())
        self.portal: Any = None
        self.pipeline: Optional[pipeline.Pipeline] = None
        self.server: Any = None
        self.grace_timeout: Optional[int] = None

    def to_variant_dict(self, receiver_ids: list[str]) -> dict[str, Any]:
        return {
            "stream_id": self.stream_id,
            "mode": self.options.mode,
            "format": self.options.fmt,
            "audio": self.options.audio,
            "receivers": receiver_ids,
            "started_at": self.started_at,
            "encoder": self.pipeline.encoder if self.pipeline else "",
        }


class CastService:
    def __init__(self, bus: Gio.DBusConnection, fake_portal: bool = False,
                 fake_portal_hangs: bool = False):
        self._bus = bus
        self._fake_portal = fake_portal or dev_harness.test_source_enabled()
        self._fake_portal_hangs = fake_portal_hangs
        self._registration_id = 0

        self._state = StateMachine(on_change=self._on_state_change)
        self._stream: Optional[Stream] = None
        self._capabilities = pipeline.capabilities()

        self._discovery = discovery.Discovery(on_changed=self._on_devices_changed)
        self._receivers = receivers.ReceiverManager(
            on_session_changed=self._on_sessions_changed,
            on_error=self.emit_error,
        )
        self._devices: dict[str, discovery.Device] = {}
        self._published: dict[str, GLib.Variant] = {}

    # -- registration ------------------------------------------------------

    def register(self) -> None:
        info = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
        self._registration_id = self._bus.register_object(
            config.OBJECT_PATH,
            info.interfaces[0],
            self._handle_method,
            self._handle_get,
            None,
        )
        LOG.info("registered %s at %s", config.IFACE, config.OBJECT_PATH)
        self._discovery.start()

    def shutdown(self) -> None:
        self._teardown_stream()
        self._receivers.shutdown()
        self._discovery.stop()
        if self._registration_id:
            self._bus.unregister_object(self._registration_id)
            self._registration_id = 0

    # -- property plumbing -------------------------------------------------

    def _devices_variant(self) -> GLib.Variant:
        entries = [d.to_variant_dict() for d in self._devices.values()]
        # Exactly one Miracast row, always present. It is a hand-off to
        # GNOME Network Displays, never a cast target, and it never gets a
        # session (defect S11). When GND is missing the row offers to
        # install it rather than disappearing.
        installed = miracast.available()
        entries.append(
            {
                "id": config.MIRACAST_ID,
                "name": ("Other wireless displays (Miracast)" if installed
                         else "Install Network Displays"),
                "model": miracast.hint(),
                "manufacturer": "",
                "protocol": discovery.PROTOCOL_MIRACAST,
                "cast_type": "cast",
                "host": "",
                "video_capable": False,
                "install_uri": "" if installed else miracast.store_uri(),
            }
        )
        return GLib.Variant("aa{sv}", [_pack(e) for e in entries])

    def _sessions_variant(self) -> GLib.Variant:
        return GLib.Variant(
            "aa{sv}", [_pack(s.to_variant_dict()) for s in self._receivers.sessions]
        )

    def _streams_variant(self) -> GLib.Variant:
        if self._stream is None:
            return GLib.Variant("aa{sv}", [])
        ids = [s.device_id for s in self._receivers.sessions]
        return GLib.Variant("aa{sv}", [_pack(self._stream.to_variant_dict(ids))])

    def _handle_get(self, _conn, _sender, _path, _iface, name) -> Optional[GLib.Variant]:
        if name == "ApiVersion":
            return GLib.Variant("u", config.API_VERSION)
        if name == "State":
            return GLib.Variant("s", str(self._state.state))
        if name == "LastError":
            return GLib.Variant("s", self._state.error)
        if name == "Devices":
            return self._devices_variant()
        if name == "Sessions":
            return self._sessions_variant()
        if name == "Streams":
            return self._streams_variant()
        if name == "Capabilities":
            caps = dict(self._capabilities)
            caps["miracast"] = miracast.available()
            caps["gnd_version"] = miracast.version()
            return GLib.Variant("a{sv}", _pack(caps))
        return None

    def _emit_changed(self, **values: GLib.Variant) -> None:
        """PropertiesChanged, but only for values that actually differ."""
        changed = {}
        for name, variant in values.items():
            previous = self._published.get(name)
            if previous is not None and previous.equal(variant):
                continue
            self._published[name] = variant
            changed[name] = variant
        if not changed:
            return
        self._bus.emit_signal(
            None,
            config.OBJECT_PATH,
            "org.freedesktop.DBus.Properties",
            "PropertiesChanged",
            GLib.Variant("(sa{sv}as)", (config.IFACE, changed, [])),
        )

    def emit_error(self, scope: str, identifier: str, message: str) -> None:
        LOG.warning("error [%s/%s]: %s", scope, identifier, message)
        self._bus.emit_signal(
            None, config.OBJECT_PATH, config.IFACE, "Error",
            GLib.Variant("(sss)", (scope, identifier, message)),
        )

    # -- change callbacks --------------------------------------------------

    def _on_state_change(self, state: State, step: Step, error: str) -> None:
        self._emit_changed(
            State=GLib.Variant("s", str(state)),
            LastError=GLib.Variant("s", error),
            Streams=self._streams_variant(),
        )

    def _on_devices_changed(self, devices: dict[str, discovery.Device]) -> None:
        def apply() -> bool:
            self._devices = devices
            self._emit_changed(Devices=self._devices_variant())
            return False

        GLib.idle_add(apply)

    def _on_sessions_changed(self) -> None:
        def apply() -> bool:
            self._emit_changed(
                Sessions=self._sessions_variant(),
                Streams=self._streams_variant(),
            )
            self._check_last_receiver_left()
            return False

        GLib.idle_add(apply)

    # -- method dispatch ---------------------------------------------------

    def _handle_method(
        self, _conn, _sender, _path, _iface, method, params, invocation
    ) -> None:
        try:
            if method == "Refresh":
                self._discovery.refresh()
                invocation.return_value(None)
            elif method == "StartCast":
                device_ids, options = params.unpack()
                stream_id = self.start_cast(list(device_ids), options or {})
                invocation.return_value(GLib.Variant("(s)", (stream_id,)))
            elif method == "AddDevices":
                stream_id, device_ids = params.unpack()
                self.add_devices(str(stream_id), list(device_ids))
                invocation.return_value(None)
            elif method == "RemoveDevice":
                (device_id,) = params.unpack()
                self.remove_device(str(device_id))
                invocation.return_value(None)
            elif method == "StopStream":
                (stream_id,) = params.unpack()
                self.stop_stream(str(stream_id))
                invocation.return_value(None)
            elif method == "StopAll":
                self.stop_all()
                invocation.return_value(None)
            elif method == "OpenMiracast":
                if not miracast.available():
                    raise _ServiceError(
                        config.ERR_NOT_FOUND,
                        "GNOME Network Displays is not installed",
                    )
                miracast.open_app()
                invocation.return_value(None)
            else:
                invocation.return_dbus_error(
                    config.ERR_UNSUPPORTED, f"unknown method {method}"
                )
        except _ServiceError as exc:
            invocation.return_dbus_error(exc.name, str(exc))
        except Exception as exc:
            LOG.exception("%s failed", method)
            invocation.return_dbus_error(config.ERR_UNSUPPORTED, str(exc))

    # -- operations --------------------------------------------------------

    def start_cast(self, device_ids: list[str], options: dict) -> str:
        if not device_ids:
            raise _ServiceError(config.ERR_NOT_FOUND, "no devices selected")

        if any(d == config.MIRACAST_ID for d in device_ids):
            raise _ServiceError(
                config.ERR_UNSUPPORTED,
                "Miracast is not a cast target; call OpenMiracast instead",
            )

        if self._state.state in (State.STARTING, State.STOPPING):
            raise _ServiceError(config.ERR_BUSY, "a cast operation is in progress")

        try:
            opts = config.StreamOptions.from_variant(
                options, hw_encode=bool(self._capabilities.get("hw_encode"))
            )
        except (ValueError, TypeError) as exc:
            raise _ServiceError(config.ERR_UNSUPPORTED, str(exc)) from exc

        if opts.fmt not in config.ENABLED_FORMATS:
            raise _ServiceError(
                config.ERR_UNSUPPORTED,
                f"format {opts.fmt!r} is not enabled; see docs/format-spike.md",
            )

        devices = []
        for device_id in device_ids:
            device = self._devices.get(device_id)
            if device is None:
                raise _ServiceError(config.ERR_NOT_FOUND, f"unknown device {device_id}")
            if not device.video_capable:
                raise _ServiceError(
                    config.ERR_UNSUPPORTED,
                    f"{device.name} is an audio-only target and cannot show a screen",
                )
            devices.append(device)

        if not self._capabilities.get("encoders"):
            raise _ServiceError(
                config.ERR_NO_ENCODER,
                "no H.264 encoder on this system; run cast_helper --doctor",
            )

        # Already streaming? Attach to the running stream instead of
        # restarting it, so adding a TV never re-prompts (defect S7).
        if self._state.state == State.STREAMING and self._stream is not None:
            self._attach(devices)
            return self._stream.stream_id

        if self._state.state == State.ERROR:
            self._state.fire(Event.RESET)

        stream_id = secrets.token_hex(8)
        self._stream = Stream(stream_id, opts)
        self._state.fire(Event.START)
        generation = self._state.generation
        LOG.info("StartCast %s → %s (%s)", stream_id,
                 [d.name for d in devices], opts.mode)

        # Everything from here is async: this call is about to return.
        GLib.idle_add(self._begin_portal, generation, devices)
        return stream_id

    def _begin_portal(self, generation: int, devices: list) -> bool:
        if generation != self._state.generation or self._stream is None:
            LOG.debug("portal step abandoned (generation changed)")
            return False

        stream = self._stream

        def on_ready(fd: int, node_id: int) -> None:
            if generation != self._state.generation:
                LOG.info("portal answered after stop; discarding")
                return
            self._state.fire_if_possible(Event.PORTAL_READY)
            self._begin_pipeline(generation, devices, fd, node_id)

        def on_error(exc: portal.PortalError) -> None:
            if generation != self._state.generation:
                return
            self._fail(
                str(exc),
                name=config.ERR_PORTAL_DENIED if exc.denied else config.ERR_NETWORK,
            )

        def on_closed() -> None:
            if generation != self._state.generation:
                return
            LOG.info("the user stopped sharing; stopping the cast")
            self.stop_all()

        if self._fake_portal:
            stream.portal = portal.FakePortal(never_answers=self._fake_portal_hangs)
        else:
            stream.portal = portal.ScreenCastSession(self._bus)
        stream.portal.start(stream.options.mode, on_ready, on_error, on_closed)
        return False

    def _begin_pipeline(self, generation: int, devices: list, fd: int, node_id: int) -> None:
        if generation != self._state.generation or self._stream is None:
            return
        stream = self._stream

        def on_pipeline_error(message: str) -> None:
            if generation != self._state.generation:
                return
            self._fail(message, name=config.ERR_NETWORK, scope="stream")

        try:
            stream.server = stream_server.StreamServer(
                stream.stream_id, stream.options.content_type, stream.options.port_range
            )
            stream.pipeline = pipeline.Pipeline(stream.options, on_pipeline_error)
            stream.pipeline.start(fd, node_id)
            if stream.portal is not None:
                # The pipeline owns the fd now; the portal must not close it.
                stream.portal.release_fd()
            stream.server.set_allowed_hosts(d.host for d in devices)
            stream.server.start(stream.pipeline.add_client)
        except Exception as exc:
            LOG.exception("pipeline setup failed")
            self._fail(str(exc), name=config.ERR_NO_ENCODER)
            return

        self._state.fire_if_possible(Event.PIPELINE_READY)
        self._attach(devices)

    def _attach(self, devices: list) -> None:
        stream = self._stream
        if stream is None or stream.server is None:
            return
        if stream.grace_timeout is not None:
            GLib.source_remove(stream.grace_timeout)
            stream.grace_timeout = None

        existing = [
            self._devices[i] for i in self._receivers.session_ids()
            if i in self._devices
        ]
        hosts = [d.host for d in existing + devices]
        stream.server.set_allowed_hosts(hosts)

        self._receivers.attach(
            devices,
            stream.stream_id,
            stream.server.url_for,
            stream.options.content_type,
            self._discovery.zconf,
            self._discovery.cast_info,
        )

    def add_devices(self, stream_id: str, device_ids: list[str]) -> None:
        if self._stream is None or self._stream.stream_id != stream_id:
            raise _ServiceError(config.ERR_NOT_FOUND, f"unknown stream {stream_id}")
        if self._state.state != State.STREAMING:
            raise _ServiceError(config.ERR_BUSY, "the stream is not running yet")
        devices = []
        for device_id in device_ids:
            device = self._devices.get(device_id)
            if device is None:
                raise _ServiceError(config.ERR_NOT_FOUND, f"unknown device {device_id}")
            if not device.video_capable:
                raise _ServiceError(
                    config.ERR_UNSUPPORTED, f"{device.name} cannot show a screen"
                )
            if not self._receivers.has(device_id):
                devices.append(device)
        if devices:
            # No portal, no new pipeline: this is the whole point of S7.
            self._attach(devices)

    def remove_device(self, device_id: str) -> None:
        if not self._receivers.detach(device_id):
            raise _ServiceError(config.ERR_NOT_FOUND, f"no session for {device_id}")

    def _check_last_receiver_left(self) -> None:
        """Stop the stream when everyone has gone, after a grace period."""
        if self._state.state != State.STREAMING or self._stream is None:
            return
        if self._receivers.count() > 0:
            return
        stream = self._stream
        if stream.grace_timeout is not None:
            return

        def expire() -> bool:
            stream.grace_timeout = None
            if (
                self._stream is stream
                and self._state.state == State.STREAMING
                and self._receivers.count() == 0
            ):
                LOG.info("no receivers left; stopping the stream")
                self.stop_all()
            return False

        LOG.info(
            "last receiver left; stopping in %ds unless one returns",
            config.RECEIVER_GRACE_SECONDS,
        )
        stream.grace_timeout = GLib.timeout_add_seconds(
            config.RECEIVER_GRACE_SECONDS, expire
        )

    def stop_stream(self, stream_id: str) -> None:
        if self._stream is None or self._stream.stream_id != stream_id:
            raise _ServiceError(config.ERR_NOT_FOUND, f"unknown stream {stream_id}")
        self.stop_all()

    def stop_all(self) -> None:
        """Works in every state, including with a portal dialog still open."""
        if self._state.state == State.IDLE:
            self._teardown_stream()
            return
        self._state.fire(Event.STOP)
        self._receivers.detach_all()
        self._teardown_stream()
        self._state.fire_if_possible(Event.STOPPED)
        self._emit_changed(
            Sessions=self._sessions_variant(), Streams=self._streams_variant()
        )

    def _teardown_stream(self) -> None:
        stream, self._stream = self._stream, None
        if stream is None:
            return
        if stream.grace_timeout is not None:
            GLib.source_remove(stream.grace_timeout)
            stream.grace_timeout = None
        if stream.server is not None:
            try:
                stream.server.stop()
            except Exception:
                LOG.debug("server stop failed", exc_info=True)
        if stream.pipeline is not None:
            try:
                stream.pipeline.stop()
            except Exception:
                LOG.debug("pipeline stop failed", exc_info=True)
        if stream.portal is not None:
            try:
                stream.portal.cancel()
            except Exception:
                LOG.debug("portal cancel failed", exc_info=True)

    def _fail(self, message: str, name: str = "", scope: str = "stream") -> None:
        identifier = self._stream.stream_id if self._stream else ""
        self._state.fire_if_possible(Event.FAIL, message)
        self._receivers.detach_all()
        self._teardown_stream()
        self.emit_error(scope, identifier, message)
        # Errors are a resting place, not a trap: return to idle so the next
        # Connect does not need the user to clear anything.
        GLib.timeout_add_seconds(1, self._reset_after_error)

    def _reset_after_error(self) -> bool:
        if self._state.state == State.ERROR:
            self._state.fire(Event.RESET)
        return False

    # -- test seams --------------------------------------------------------

    @property
    def state_machine(self) -> StateMachine:
        return self._state


class _ServiceError(Exception):
    def __init__(self, name: str, message: str):
        super().__init__(message)
        self.name = name


def _pack(data: dict[str, Any]) -> dict[str, GLib.Variant]:
    """dict → the {str: Variant} mapping that an a{sv} is built from.

    Returns a plain dict, not a Variant: GLib.Variant("aa{sv}", ...) builds
    its children itself and cannot take already-packed Variants.
    """
    packed: dict[str, GLib.Variant] = {}
    for key, value in data.items():
        if isinstance(value, bool):
            packed[key] = GLib.Variant("b", value)
        elif isinstance(value, int):
            packed[key] = GLib.Variant("x", value)
        elif isinstance(value, (list, tuple)):
            packed[key] = GLib.Variant("as", [str(v) for v in value])
        else:
            packed[key] = GLib.Variant("s", str(value))
    return packed
