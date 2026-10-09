"""Per-camera patrol settings: precedence, validation, options shape."""

from __future__ import annotations

import pytest

from custom_components.advanced_reolink_card.patrol_settings import (
    CONF_PATROL,
    DEFAULTS,
    PatrolSettingsError,
    camera_settings,
    resolve_sweep_options,
    with_camera_settings,
)


def test_defaults_when_nothing_saved() -> None:
    cam = camera_settings({}, 3)
    assert cam == {k: DEFAULTS[k] for k in cam}
    resolved = resolve_sweep_options({}, cam)
    assert resolved["left_time"] == 0 and resolved["right_time"] == 0
    assert resolved["speed"] == 32 and resolved["sweep_time"] == 25


def test_precedence_call_over_camera_over_default() -> None:
    options = with_camera_settings({}, 3, {"left_time": 12, "right_time": 10, "speed": 20, "pause": 4})
    cam = camera_settings(options, 3)
    resolved = resolve_sweep_options({"speed": 40, "right_time": 6}, cam)
    assert resolved["speed"] == 40  # call
    assert resolved["right_time"] == 6  # call
    assert resolved["left_time"] == 12  # camera
    assert resolved["pause"] == 4  # camera
    assert resolved["tilt_levels"] == 1  # built-in default
    # other channel untouched
    assert camera_settings(options, 4)["left_time"] == 0


def test_arc_pair_and_explicit_fields() -> None:
    cam = camera_settings({}, 3)
    assert resolve_sweep_options({"arc": [8, 9]}, cam)["left_time"] == 8
    r = resolve_sweep_options({"arc": [8, 9], "left_time": 5}, cam)
    assert (r["left_time"], r["right_time"]) == (5, 9)


def test_call_can_disable_camera_arc() -> None:
    options = with_camera_settings({}, 3, {"left_time": 12, "right_time": 10})
    r = resolve_sweep_options({"arc": [0, 0]}, camera_settings(options, 3))
    assert (r["left_time"], r["right_time"]) == (0, 0)


@pytest.mark.parametrize(
    ("updates", "key"),
    [
        ({"left_time": 10, "right_time": 0}, "patrol_arc_incomplete"),
        ({"left_time": 0, "right_time": 5}, "patrol_arc_incomplete"),
        ({"speed": 0}, "patrol_value_range"),
        ({"speed": 65}, "patrol_value_range"),
        ({"left_time": 301, "right_time": 5}, "patrol_value_range"),
        ({"tilt_levels": 11}, "patrol_value_range"),
        ({"pause": -1}, "patrol_value_range"),
    ],
)
def test_validation(updates: dict, key: str) -> None:
    with pytest.raises(PatrolSettingsError) as err:
        with_camera_settings({}, 3, updates)
    assert err.value.key == key


def test_call_arc_incomplete_rejected() -> None:
    with pytest.raises(PatrolSettingsError) as err:
        resolve_sweep_options({"left_time": 5}, camera_settings({}, 3))
    assert err.value.key == "patrol_arc_incomplete"


def test_with_camera_settings_preserves_other_options() -> None:
    options = {"voice": "en-GB-RyanNeural", CONF_PATROL: {"4": {"speed": 10}}}
    new = with_camera_settings(options, 3, {"left_time": 1, "right_time": 2})
    assert new["voice"] == "en-GB-RyanNeural"
    assert new[CONF_PATROL]["4"] == {"speed": 10}
    assert new[CONF_PATROL]["3"]["left_time"] == 1
    assert options[CONF_PATROL] == {"4": {"speed": 10}}  # input not mutated


def test_bad_stored_value_falls_back_to_default() -> None:
    cam = camera_settings({CONF_PATROL: {"3": {"speed": "fast", "pause": 5}}}, 3)
    assert cam["speed"] == 32 and cam["pause"] == 5
