"""Encoder selection, pipeline construction and the stall watchdog."""

from __future__ import annotations

import pytest

from cast_helper import audio, config, pipeline

# -- encoder settings ------------------------------------------------------


@pytest.mark.parametrize("name", ["vah264enc", "vaapih264enc", "x264enc", "openh264enc"])
def test_every_encoder_has_settings(name):
    settings = pipeline.encoder_settings(name, 30, 6000)
    assert settings.startswith(name)


def test_keyframe_interval_follows_the_framerate():
    """One keyframe per second, so a late joiner waits at most a second."""
    assert "key-int-max=30" in pipeline.encoder_settings("x264enc", 30, 6000)
    assert "key-int-max=60" in pipeline.encoder_settings("x264enc", 60, 6000)
    assert "key-int-max=25" in pipeline.encoder_settings("vah264enc", 25, 6000)
    assert "keyframe-period=25" in pipeline.encoder_settings("vaapih264enc", 25, 6000)
    assert "gop-size=25" in pipeline.encoder_settings("openh264enc", 25, 6000)


def test_openh264_takes_bits_not_kilobits():
    assert "bitrate=6000000" in pipeline.encoder_settings("openh264enc", 30, 6000)
    assert "bitrate=6000" in pipeline.encoder_settings("x264enc", 30, 6000)


def test_unknown_encoder_is_rejected():
    with pytest.raises(ValueError):
        pipeline.encoder_settings("nope", 30, 6000)


# -- verified selection ----------------------------------------------------


def test_a_working_encoder_is_found_on_this_machine():
    chosen = pipeline.select_working_encoder(force=True)
    assert chosen is not None, "no H.264 encoder works here; see --doctor"
    name, kind, _note = chosen
    assert pipeline.have(name)
    assert kind


def test_selection_actually_encodes_rather_than_trusting_the_registry():
    """A present element is not a working element."""
    chosen = pipeline.select_working_encoder(force=True)
    assert chosen is not None
    ok, detail = pipeline.test_encode(chosen[0])
    assert ok, detail


def test_selection_is_cached():
    first = pipeline.select_working_encoder(force=True)
    second = pipeline.select_working_encoder()
    assert first is second


def test_a_broken_encoder_is_skipped(monkeypatch):
    """The whole point of verifying: fall through to one that works."""
    real = pipeline.test_encode
    attempted: list[str] = []

    def fake_test_encode(name, timeout_seconds=10):
        attempted.append(name)
        if name != "x264enc":
            return False, "no VA device"
        return real(name, timeout_seconds)

    monkeypatch.setattr(pipeline, "test_encode", fake_test_encode)
    monkeypatch.setattr(pipeline, "have", lambda name: name in (
        "vah264enc", "x264enc"
    ))
    monkeypatch.setattr(pipeline, "_verified", None, raising=False)

    chosen = pipeline.select_working_encoder(force=True)
    assert chosen is not None
    assert chosen[0] == "x264enc"
    assert attempted == ["vah264enc", "x264enc"]
    assert "fell back" in chosen[2]
    assert "vah264enc" in chosen[2]


def test_no_encoder_at_all_is_reported(monkeypatch):
    monkeypatch.setattr(pipeline, "have", lambda name: False)
    monkeypatch.setattr(pipeline, "_verified", None, raising=False)
    assert pipeline.select_working_encoder(force=True) is None


# -- pipeline description --------------------------------------------------


def make_pipeline(**option_overrides):
    options = config.StreamOptions(**option_overrides)
    return pipeline.Pipeline(options, on_error=lambda message: None)


def test_description_uses_matroska_and_avc_not_mpegts():
    """The format decision from docs/format-spike.md, asserted."""
    desc = make_pipeline()._description(-1, 0)
    assert "matroskamux" in desc
    assert "streamable=true" in desc
    assert "stream-format=avc" in desc
    assert "profile=high" in desc
    assert "mpegtsmux" not in desc
    assert "mp4mux" not in desc


def test_description_fans_out_through_multisocketsink():
    """F3/F4: per-client completeness and keyframe-aligned joins."""
    desc = make_pipeline()._description(-1, 0)
    assert "multisocketsink" in desc
    assert "sync-method=latest-keyframe" in desc
    assert "recover-policy=keyframe" in desc


def test_a_slow_receiver_is_bounded_and_dropped():
    """One slow TV must not back-pressure the encoder or the others."""
    desc = make_pipeline(fps=30)._description(-1, 0)
    assert "buffers-soft-max=60" in desc     # 2 s at 30 fps
    assert "buffers-max=120" in desc         # 4 s at 30 fps
    assert "unit-format=buffers" in desc
    assert "timeout=10000000000" in desc     # 10 s of no reads = gone


def test_output_framerate_is_pinned_so_a_static_screen_still_streams():
    """An idle screen emitted 1 fps with a framerate range, which starves
    the receiver and trips the stall watchdog."""
    desc = make_pipeline(fps=30)._description(-1, 0)
    assert "framerate=30/1 !" in desc
    assert "framerate=[1/1,30/1]" not in desc
    assert "videorate" in desc


def test_resolution_is_a_cap_not_a_target():
    """A smaller screen must not be upscaled just to hit the ceiling."""
    desc = make_pipeline(max_height=1080)._description(-1, 0)
    assert "height=[2,1080,2]" in desc
    assert "width=[2,1920,2]" in desc
    # Even dimensions come from the step, aspect ratio from these two.
    assert "pixel-aspect-ratio=1/1" in desc
    assert "add-borders=true" in desc


def test_720p_cap_is_honoured():
    desc = make_pipeline(max_height=720)._description(-1, 0)
    assert "height=[2,720,2]" in desc
    assert "width=[2,1280,2]" in desc


def test_bitrate_defaults_by_resolution():
    assert config.StreamOptions(max_height=1080).effective_bitrate() == 6000
    assert config.StreamOptions(max_height=720).effective_bitrate() == 4000
    assert config.StreamOptions(max_height=1080, bitrate_kbps=2500).effective_bitrate() == 2500


def test_audio_is_muxed_into_the_same_container_when_asked(monkeypatch):
    monkeypatch.setenv("CAST_HELPER_TEST_SOURCE", "1")
    desc = make_pipeline(audio=True)._description(-1, 0)
    if audio.pick_encoder():
        assert "aacparse ! mux." in desc
        assert "audiotestsrc" in desc
        assert "rate=48000,channels=2" in desc


def test_no_audio_branch_when_not_asked():
    desc = make_pipeline(audio=False)._description(-1, 0)
    assert "aacparse" not in desc


# -- watchdog --------------------------------------------------------------


def test_watchdog_fires_when_frames_stop():
    """A frozen capture must become an error, not a frozen picture."""
    reported: list[str] = []
    instance = pipeline.Pipeline(
        config.StreamOptions(), on_error=reported.append
    )
    instance._pipeline = object()          # pretend we are running
    instance._last_buffer = 0.0            # last frame: the epoch

    assert instance._check_watchdog() is False
    assert len(reported) == 1
    assert "stopped producing frames" in reported[0]


def test_watchdog_stays_quiet_while_frames_arrive():
    from gi.repository import GLib

    reported: list[str] = []
    instance = pipeline.Pipeline(
        config.StreamOptions(), on_error=reported.append
    )
    instance._pipeline = object()
    instance._last_buffer = GLib.get_monotonic_time() / 1e6

    assert instance._check_watchdog() is True
    assert reported == []


def test_watchdog_reports_once_not_repeatedly():
    reported: list[str] = []
    instance = pipeline.Pipeline(
        config.StreamOptions(), on_error=reported.append
    )
    instance._pipeline = object()
    instance._last_buffer = 0.0

    instance._check_watchdog()
    instance._check_watchdog()
    assert len(reported) == 1


def test_watchdog_stops_once_the_pipeline_is_gone():
    instance = pipeline.Pipeline(config.StreamOptions(), on_error=lambda m: None)
    instance._pipeline = None
    assert instance._check_watchdog() is False


# -- capabilities ----------------------------------------------------------


def test_capabilities_reports_only_enabled_formats():
    caps = pipeline.capabilities()
    assert caps["formats"] == list(config.ENABLED_FORMATS)
    assert caps["formats"] == ["matroska"]
    assert caps["mux"] == "matroskamux"


def test_capabilities_shape():
    caps = pipeline.capabilities()
    for key in ("encoders", "encoder", "hw_encode", "virtual_source", "audio"):
        assert key in caps
    assert isinstance(caps["hw_encode"], bool)
    assert isinstance(caps["encoders"], list)


# -- options validation ----------------------------------------------------


def test_hls_is_a_known_but_disabled_format():
    """Implemented nowhere, rejected explicitly: see docs/format-spike.md."""
    assert config.FORMAT_HLS in config.ALL_FORMATS
    assert config.FORMAT_HLS not in config.ENABLED_FORMATS


def test_software_encode_defaults_to_720p():
    options = config.StreamOptions.from_variant({}, hw_encode=False)
    assert options.max_height == 720


def test_hardware_encode_defaults_to_1080p():
    options = config.StreamOptions.from_variant({}, hw_encode=True)
    assert options.max_height == 1080


def test_an_explicit_height_always_wins():
    options = config.StreamOptions.from_variant({"max_height": 1080}, hw_encode=False)
    assert options.max_height == 1080


def test_unknown_mode_and_format_are_rejected():
    with pytest.raises(ValueError):
        config.StreamOptions.from_variant({"mode": "sideways"})
    with pytest.raises(ValueError):
        config.StreamOptions.from_variant({"format": "theora"})


def test_port_range_is_validated():
    with pytest.raises(ValueError):
        config.StreamOptions.from_variant({"port_min": 9000, "port_max": 8000})
    with pytest.raises(ValueError):
        config.StreamOptions.from_variant({"port_min": 80, "port_max": 90})


def test_fps_and_height_are_clamped():
    options = config.StreamOptions.from_variant({"fps": 999, "max_height": 99999})
    assert options.fps == 60
    assert options.max_height == 2160
