"""Device classification and change detection."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from cast_helper import discovery
from cast_helper.discovery import (
    CAST_TYPE_AUDIO,
    CAST_TYPE_CAST,
    CAST_TYPE_GROUP,
    Device,
    classify,
    device_from_cast_info,
    diff,
)


@dataclass
class FakeCastInfo:
    """Shaped like pychromecast.models.CastInfo."""

    uuid: UUID
    model_name: str
    friendly_name: str
    host: str
    port: int
    cast_type: str | None
    manufacturer: str | None


def info(**overrides):
    base = {
        "uuid": UUID("84a96440-d63a-1f8a-222a-25adbd7ea018"),
        "model_name": "Smart TV",
        "friendly_name": "Smart TV",
        "host": "192.168.100.13",
        "port": 8009,
        "cast_type": None,
        "manufacturer": None,
    }
    base.update(overrides)
    return FakeCastInfo(**base)


# -- classification --------------------------------------------------------


def test_unknown_cast_type_is_treated_as_video_capable():
    """The crucial case: pychromecast leaves cast_type None for most TVs.

    An allow-list on "cast" would hide the very device this project was
    developed against. See docs/phase-0-baseline.md.
    """
    cast_type, video = classify(None, 8009)
    assert video is True
    assert cast_type == CAST_TYPE_CAST


def test_audio_targets_are_not_video_capable():
    cast_type, video = classify(CAST_TYPE_AUDIO, 8009)
    assert cast_type == CAST_TYPE_AUDIO
    assert video is False


def test_declared_groups_are_not_video_capable():
    cast_type, video = classify(CAST_TYPE_GROUP, 8009)
    assert cast_type == CAST_TYPE_GROUP
    assert video is False


def test_non_8009_port_is_a_group():
    """pychromecast's own rule: a service off 8009 is a cast group."""
    cast_type, video = classify(None, 32768)
    assert cast_type == CAST_TYPE_GROUP
    assert video is False


def test_real_chromecast_is_video_capable():
    cast_type, video = classify(CAST_TYPE_CAST, 8009)
    assert cast_type == CAST_TYPE_CAST
    assert video is True


def test_device_from_cast_info_maps_the_real_tv():
    device = device_from_cast_info(info())
    assert device.id == "84a96440-d63a-1f8a-222a-25adbd7ea018"
    assert device.name == "Smart TV"
    assert device.model == "Smart TV"
    assert device.host == "192.168.100.13"
    assert device.video_capable is True
    assert device.protocol == discovery.PROTOCOL_CHROMECAST


def test_device_from_cast_info_falls_back_to_uuid_for_a_nameless_device():
    device = device_from_cast_info(info(friendly_name=""))
    assert device.name == "84a96440-d63a-1f8a-222a-25adbd7ea018"


def test_audio_device_round_trip():
    device = device_from_cast_info(
        info(cast_type="audio", model_name="Google Nest Mini", friendly_name="Kitchen")
    )
    assert device.video_capable is False
    assert device.to_variant_dict()["cast_type"] == "audio"


# -- diffing ---------------------------------------------------------------


def device(device_id="a", name="A", host="10.0.0.1"):
    return Device(id=device_id, name=name, host=host)


def test_no_diff_for_identical_sets():
    """Defect S5: a tick that changed nothing must not repaint the menu."""
    a = {"a": device()}
    b = {"a": device()}
    assert diff(a, b) is False


def test_diff_on_added_device():
    assert diff({"a": device()}, {"a": device(), "b": device("b", "B")}) is True


def test_diff_on_removed_device():
    assert diff({"a": device(), "b": device("b", "B")}, {"a": device()}) is True


def test_diff_on_renamed_device():
    assert diff({"a": device(name="Old")}, {"a": device(name="New")}) is True


def test_diff_on_changed_address():
    assert diff({"a": device(host="10.0.0.1")}, {"a": device(host="10.0.0.9")}) is True


def test_diff_ignores_ordering():
    first = {"a": device(), "b": device("b", "B")}
    second = {"b": device("b", "B"), "a": device()}
    assert diff(first, second) is False


# -- publishing ------------------------------------------------------------


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, devices):
        self.calls.append(dict(devices))


class StubBrowser:
    def __init__(self, devices):
        self.devices = devices

    def start_discovery(self):
        pass

    def stop_discovery(self):
        pass


def make_discovery(browser, recorder):
    disco = discovery.Discovery(on_changed=recorder)
    disco._browser = browser
    disco._started = True
    return disco


def test_publish_only_fires_on_a_real_change():
    recorder = Recorder()
    browser = StubBrowser({info().uuid: info()})
    disco = make_discovery(browser, recorder)

    disco._publish()
    assert len(recorder.calls) == 1

    disco._publish()          # nothing changed
    assert len(recorder.calls) == 1

    browser.devices = {}      # device went away
    disco._publish()
    assert len(recorder.calls) == 2
    assert recorder.calls[-1] == {}


def test_publish_skips_malformed_cast_info():
    recorder = Recorder()

    class Broken:
        uuid = "not-a-uuid"

        def __getattr__(self, name):
            raise RuntimeError("malformed")

    browser = StubBrowser({"broken": Broken(), info().uuid: info()})
    disco = make_discovery(browser, recorder)
    disco._publish()

    assert len(recorder.calls) == 1
    assert list(recorder.calls[0]) == ["84a96440-d63a-1f8a-222a-25adbd7ea018"]


def test_cast_info_lookup_by_id():
    browser = StubBrowser({info().uuid: info()})
    disco = make_discovery(browser, Recorder())
    found = disco.cast_info("84a96440-d63a-1f8a-222a-25adbd7ea018")
    assert found is not None
    assert found.friendly_name == "Smart TV"
    assert disco.cast_info("nope") is None
