"""Miracast is a hand-off, never a cast session.

Defect S11: the old helper marked the session "casting" the moment the
GNOME Network Displays window opened and Disconnect then did nothing at
all, because there was never anything to disconnect. These tests exist so
that cannot come back.
"""

from __future__ import annotations

import pathlib
import re

from cast_helper import config, miracast

HELPER_ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKAGE = HELPER_ROOT / "cast_helper"
REPO_ROOT = HELPER_ROOT.parent.parent


# -- the capability probe --------------------------------------------------


def test_availability_is_a_real_check():
    """Whatever it reports, it reports from the filesystem, not a guess."""
    import shutil

    assert miracast.available() == (shutil.which("gnome-network-displays") is not None)


def test_hint_matches_availability():
    hint = miracast.hint()
    assert hint
    if miracast.available():
        assert "Install" not in hint
        assert "Network Displays" in hint
    else:
        assert "Install" in hint


def test_mice_claim_requires_a_new_enough_version():
    """0.91 brought MICE; the hint must not promise it below that."""
    assert miracast._version_tuple("0.99.0-1") >= miracast.MICE_MIN_VERSION
    assert miracast._version_tuple("0.91.0") >= miracast.MICE_MIN_VERSION
    assert miracast._version_tuple("0.90.0") < miracast.MICE_MIN_VERSION
    assert miracast._version_tuple("0.88.0-2ubuntu1") < miracast.MICE_MIN_VERSION


def test_unparsable_version_does_not_claim_mice():
    assert miracast._version_tuple("") == ()
    assert miracast._version_tuple("weird") == ()


def test_store_uri_is_an_appstream_uri():
    """The Shell opens this; the helper never runs sudo."""
    uri = miracast.store_uri()
    assert uri.startswith("appstream://")
    assert "NetworkDisplays" in uri


# -- no session, ever ------------------------------------------------------


def test_miracast_id_is_not_a_chromecast_id():
    assert config.MIRACAST_ID.startswith("miracast:")


def test_the_helper_never_creates_a_session_for_miracast():
    """Static check: nothing attaches a receiver to the Miracast id.

    The receiver manager is the only thing that creates sessions and the
    only way in is ReceiverManager.attach, which is called with devices
    drawn from discovery. The Miracast row is injected by the D-Bus layer
    and is never in that dict and StartCast rejects the id outright.
    """
    service = (PACKAGE / "dbus_service.py").read_text()

    # StartCast refuses it before anything else happens.
    assert "Miracast is not a cast target" in service

    # The only Miracast call is the hand-off.
    for match in re.finditer(r"miracast\.(\w+)", service):
        assert match.group(1) in {
            "available", "hint", "version", "open_app", "store_uri",
        }, f"unexpected miracast call: {match.group(1)}"


def test_the_receiver_manager_knows_nothing_about_miracast():
    receivers = (PACKAGE / "receivers.py").read_text()
    assert "miracast" not in receivers.lower()


def test_the_pipeline_knows_nothing_about_miracast():
    pipeline = (PACKAGE / "pipeline.py").read_text()
    assert "miracast" not in pipeline.lower()


def test_no_module_marks_miracast_as_streaming():
    """Grep the package: no "casting"/"streaming" state near Miracast."""
    for path in PACKAGE.glob("*.py"):
        text = path.read_text()
        for line_number, line in enumerate(text.splitlines(), 1):
            if "miracast" not in line.lower():
                continue
            lowered = line.lower()
            if "streaming" in lowered or "casting" in lowered:
                # A comment explaining that it is *not* casting is fine.
                stripped = line.strip()
                assert stripped.startswith("#"), (
                    f"{path.name}:{line_number} ties Miracast to a cast "
                    f"state: {stripped}"
                )


def _method_body(source: str, name: str) -> str:
    """The body of a JS method, by brace matching from its signature."""
    start = source.index(f"    {name}(")
    opening = source.index("{", start)
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[opening:index + 1]
    raise AssertionError(f"unbalanced braces in {name}")


def test_the_shell_treats_the_handoff_as_an_action_not_a_selection():
    menu = (REPO_ROOT / "ui" / "castDisplayMenu.js").read_text()
    body = _method_body(menu, "_onToggleDevice")

    handoff = body[body.index("miracast-handoff"):]
    handoff = handoff[:handoff.index("return;") + len("return;")]

    # The hand-off branch acts and returns. It must not select the row or
    # start a cast.
    assert "openMiracast" in handoff or "install_uri" in handoff
    assert "this._selected.add" not in handoff
    assert "startCast" not in handoff
    # And it returns before the selection logic further down is reached.
    assert body.index("miracast-handoff") < body.index("this._selected.add")


def test_miracast_is_reported_as_not_video_capable():
    """So it can never be swept into a StartCast device list."""
    service = (PACKAGE / "dbus_service.py").read_text()
    row = service[service.index('"id": config.MIRACAST_ID'):]
    row = row[:row.index("}")]
    assert '"video_capable": False' in row
