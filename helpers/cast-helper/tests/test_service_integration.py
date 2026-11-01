"""End-to-end service tests on a private session bus.

These are the tests that would have caught defect S1: a `Stop()` arriving
while the ScreenCast portal dialog is open used to deadlock the helper for
good, because `_run_locked` held a non-reentrant lock on the main thread and
then pumped the main loop, so the Stop was dispatched onto the very thread
that was holding the lock.

`--fake-portal-hangs` reproduces that situation exactly: a portal that accepts
the request and never answers.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time

import pytest

HELPER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BUS = "org.cast.tools.Cast1"
OBJ = "/org/cast/tools/Cast1"

pytestmark = pytest.mark.skipif(
    not shutil.which("dbus-daemon") or not shutil.which("gdbus"),
    reason="needs dbus-daemon and gdbus",
)


class Helper:
    """The helper running on its own private session bus."""

    def __init__(self, *extra_args: str, fake_devices: int = 2):
        self.bus_proc: subprocess.Popen | None = None
        self.helper: subprocess.Popen | None = None
        self.address = ""
        self.extra_args = extra_args
        self.fake_devices = fake_devices

    def __enter__(self) -> Helper:
        self.bus_proc = subprocess.Popen(
            ["dbus-daemon", "--session", "--print-address", "--nofork"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        assert self.bus_proc.stdout is not None
        self.address = self.bus_proc.stdout.readline().strip()
        assert self.address, "dbus-daemon printed no address"

        env = dict(os.environ)
        env["DBUS_SESSION_BUS_ADDRESS"] = self.address
        env["CAST_HELPER_TEST_SOURCE"] = "1"
        env["CAST_HELPER_FAKE_DEVICES"] = str(self.fake_devices)
        env["CAST_HELPER_LOG"] = "debug"
        env["PYTHONPATH"] = HELPER_DIR

        self.helper = subprocess.Popen(
            [sys.executable, "-m", "cast_helper", *self.extra_args],
            cwd=HELPER_DIR,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self._wait_for_name()
        return self

    def __exit__(self, *_exc) -> None:
        for proc in (self.helper, self.bus_proc):
            if proc is None or proc.poll() is not None:
                continue
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    # -- D-Bus helpers -----------------------------------------------------

    def _run(self, args: list[str], timeout: float) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["DBUS_SESSION_BUS_ADDRESS"] = self.address
        return subprocess.run(
            args, env=env, capture_output=True, text=True,
            timeout=timeout, check=False,
        )

    def _wait_for_name(self, timeout: float = 25.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.helper is not None and self.helper.poll() is not None:
                raise AssertionError(f"helper exited early:\n{self.logs()}")
            proc = self._run(
                ["gdbus", "call", "--session", "-d", BUS, "-o", OBJ,
                 "-m", "org.freedesktop.DBus.Properties.Get", BUS, "ApiVersion"],
                timeout=10,
            )
            if proc.returncode == 0:
                return
            time.sleep(0.25)
        raise AssertionError(f"helper never took the bus name:\n{self.logs()}")

    def call(self, method: str, *args: str, timeout: float = 20.0):
        """(elapsed_seconds, CompletedProcess)"""
        argv = ["gdbus", "call", "--session", "--timeout", str(int(timeout)),
                "-d", BUS, "-o", OBJ, "-m", f"{BUS}.{method}", *args]
        started = time.monotonic()
        proc = self._run(argv, timeout=timeout + 10)
        return time.monotonic() - started, proc

    def get(self, name: str) -> str:
        _elapsed, proc = self.call_raw_get(name)
        assert proc.returncode == 0, proc.stderr
        return proc.stdout.strip()

    def call_raw_get(self, name: str, timeout: float = 15.0):
        argv = ["gdbus", "call", "--session", "--timeout", str(int(timeout)),
                "-d", BUS, "-o", OBJ,
                "-m", "org.freedesktop.DBus.Properties.Get", BUS, name]
        started = time.monotonic()
        proc = self._run(argv, timeout=timeout + 5)
        return time.monotonic() - started, proc

    def state(self) -> str:
        raw = self.get("State")
        # (<'idle'>,)
        return raw.split("'")[1] if "'" in raw else raw

    def device_ids(self) -> list[str]:
        raw = self.get("Devices")
        return [part for part in raw.split("'") if part.startswith("fake:")]

    def introspect(self) -> str:
        proc = self._run(
            ["gdbus", "introspect", "--session", "-d", BUS, "-o", OBJ, "--xml"],
            timeout=15,
        )
        assert proc.returncode == 0, proc.stderr
        return proc.stdout

    def logs(self) -> str:
        if self.helper is None or self.helper.stdout is None:
            return ""
        self.helper.send_signal(signal.SIGTERM)
        try:
            return self.helper.communicate(timeout=5)[0] or ""
        except subprocess.TimeoutExpired:
            self.helper.kill()
            return ""


# -- API shape -------------------------------------------------------------


def test_api_v2_is_introspectable():
    with Helper() as helper:
        xml = helper.introspect()
        for member in (
            "ApiVersion", "State", "LastError", "Devices", "Sessions",
            "Streams", "Capabilities", "StartCast", "AddDevices",
            "RemoveDevice", "StopStream", "StopAll", "OpenMiracast", "Error",
        ):
            assert member in xml, f"{member} missing from the interface"
        assert helper.get("ApiVersion") == "(<uint32 2>,)"
        assert helper.state() == "idle"


def test_fake_devices_are_listed():
    with Helper(fake_devices=2) as helper:
        deadline = time.monotonic() + 15
        ids: list[str] = []
        while time.monotonic() < deadline and len(ids) < 2:
            ids = helper.device_ids()
            if len(ids) < 2:
                time.sleep(0.5)
        assert len(ids) == 2, f"expected 2 fake devices, saw {ids}"


# -- the S1 regression -----------------------------------------------------


def test_start_cast_returns_immediately_even_though_the_portal_hangs():
    """StartCast must not wait on the portal. It used to."""
    with Helper("--fake-portal-hangs") as helper:
        ids = _wait_for_devices(helper, 1)
        elapsed, proc = helper.call(
            "StartCast", f"['{ids[0]}']", "{}", timeout=20
        )
        assert proc.returncode == 0, proc.stderr
        assert elapsed < 2.0, f"StartCast took {elapsed:.2f}s"
        # It returns a stream id, not a promise of success.
        assert proc.stdout.strip().startswith("('")


def test_stop_all_while_the_portal_is_pending_is_the_s1_regression():
    """Click Connect, then turn the tile off while the dialog is open.

    Before the rewrite this deadlocked the helper permanently.
    """
    with Helper("--fake-portal-hangs") as helper:
        ids = _wait_for_devices(helper, 1)

        _elapsed, proc = helper.call("StartCast", f"['{ids[0]}']", "{}")
        assert proc.returncode == 0, proc.stderr
        assert helper.state() == "starting"

        elapsed, proc = helper.call("StopAll", timeout=15)
        assert proc.returncode == 0, f"StopAll failed: {proc.stderr}"
        assert elapsed < 2.0, f"StopAll took {elapsed:.2f}s — the deadlock is back"
        assert helper.state() == "idle"

        # And the helper is still alive and responsive afterwards.
        elapsed, proc = helper.call_raw_get("Capabilities")
        assert proc.returncode == 0
        assert elapsed < 2.0


def test_helper_survives_repeated_start_stop_with_a_hanging_portal():
    with Helper("--fake-portal-hangs") as helper:
        ids = _wait_for_devices(helper, 1)
        for attempt in range(5):
            _elapsed, proc = helper.call("StartCast", f"['{ids[0]}']", "{}")
            assert proc.returncode == 0, f"attempt {attempt}: {proc.stderr}"
            elapsed, proc = helper.call("StopAll")
            assert proc.returncode == 0, f"attempt {attempt}: {proc.stderr}"
            assert elapsed < 2.0, f"attempt {attempt} took {elapsed:.2f}s"
        assert helper.state() == "idle"


def test_stop_all_is_safe_when_idle():
    with Helper() as helper:
        elapsed, proc = helper.call("StopAll")
        assert proc.returncode == 0, proc.stderr
        assert elapsed < 2.0
        assert helper.state() == "idle"


# -- validation ------------------------------------------------------------


def test_unknown_device_is_a_named_error():
    with Helper() as helper:
        _elapsed, proc = helper.call("StartCast", "['nope']", "{}")
        assert proc.returncode != 0
        assert "NotFound" in proc.stderr


def test_empty_device_list_is_rejected():
    with Helper() as helper:
        _elapsed, proc = helper.call("StartCast", "[]", "{}")
        assert proc.returncode != 0
        assert "NotFound" in proc.stderr


def test_miracast_cannot_be_a_cast_target():
    """Defect S11: Miracast must never become a cast session."""
    with Helper() as helper:
        _elapsed, proc = helper.call(
            "StartCast", "['miracast:gnome-network-displays']", "{}"
        )
        assert proc.returncode != 0
        assert "Unsupported" in proc.stderr
        assert helper.state() == "idle"


def test_disabled_format_is_rejected():
    """HLS is implemented but unverified, so it must not be selectable."""
    with Helper() as helper:
        ids = _wait_for_devices(helper, 1)
        _elapsed, proc = helper.call(
            "StartCast", f"['{ids[0]}']", "{'format': <'hls'>}"
        )
        assert proc.returncode != 0
        assert "Unsupported" in proc.stderr


def test_refresh_is_non_blocking():
    """Defect S4: Refresh used to run a 5 s blocking discovery."""
    with Helper() as helper:
        for _ in range(3):
            elapsed, proc = helper.call("Refresh")
            assert proc.returncode == 0, proc.stderr
            assert elapsed < 1.0, f"Refresh took {elapsed:.2f}s"


def test_capabilities_reports_this_machine():
    with Helper() as helper:
        raw = helper.get("Capabilities")
        assert "encoder" in raw
        assert "formats" in raw
        # Matroska is the only enabled format (docs/format-spike.md).
        assert "matroska" in raw
        assert "fmp4" not in raw


def _wait_for_devices(helper: Helper, count: int, timeout: float = 15.0) -> list[str]:
    deadline = time.monotonic() + timeout
    ids: list[str] = []
    while time.monotonic() < deadline:
        ids = helper.device_ids()
        if len(ids) >= count:
            return ids
        time.sleep(0.4)
    raise AssertionError(f"only saw {ids}, wanted {count} fake device(s)")
