"""Pure helper tests: talk status, selectable channels, merge, labels."""

from custom_components.advanced_reolink_card.channels import (
    channel_label,
    known_channels,
    merge_channels,
    selectable_channels,
    talk_status,
)
from custom_components.advanced_reolink_card import resolve_enabled_channels
from custom_components.advanced_reolink_card.const import CONF_ENABLED_CHANNELS

from .conftest import channel_dicts


def test_talk_status_and_selectable() -> None:
    chans = channel_dicts()
    assert [talk_status(c) for c in chans] == ["supported", "unknown", "unsupported"]
    # asleep / unknown stays selectable, only a positive "no talk" is excluded
    assert selectable_channels(chans) == [0, 1]


def test_empty_nvr_slots_are_not_selectable() -> None:
    chans = [
        {"channel": 0, "name": "Cam", "online": False, "talk_status": "unknown"},  # offline camera
        {"channel": 9, "name": None, "online": False, "talk_status": "unknown"},  # empty slot
    ]
    assert selectable_channels(chans) == [0]


def test_legacy_entries_without_talk_status() -> None:
    assert talk_status({"channel": 0, "talk_supported": True}) == "supported"
    assert talk_status({"channel": 0, "talk_supported": False}) == "unknown"


def test_merge_keeps_known_ability_when_asleep() -> None:
    old = [{"channel": 0, "name": "Cam", "talk_status": "supported", "sample_rate": 16000}]
    new = [{"channel": 0, "name": None, "talk_status": "unknown", "sleeping": True}]
    merged = merge_channels(old, new)
    assert merged[0]["talk_status"] == "supported"
    assert merged[0]["sample_rate"] == 16000
    assert merged[0]["name"] == "Cam"
    assert merged[0]["sleeping"] is True


def test_merge_takes_new_definite_answer_and_new_channels() -> None:
    old = [{"channel": 0, "talk_status": "unknown"}]
    new = [{"channel": 0, "talk_status": "supported"}, {"channel": 5, "talk_status": "unknown"}]
    merged = merge_channels(old, new)
    assert [c["channel"] for c in merged] == [0, 5]
    assert merged[0]["talk_status"] == "supported"


def test_labels() -> None:
    chans = channel_dicts()
    assert channel_label(chans[0], True) == "Camera A (ch 0)"
    assert channel_label(chans[1], True) == "Camera B (ch 1, asleep)"
    assert channel_label({**chans[0], "online": False}, False) == "Camera A (offline)"
    assert channel_label({"channel": 0, "talk_status": "unknown"}, False) == (
        "Channel 0 (talk support not confirmed yet)"
    )


def _cam(channel: int, name: str, **kwargs: object) -> dict:
    base = {
        "channel": channel,
        "name": name,
        "online": True,
        "talk_status": "supported",
        "talk_supported": True,
        "sample_rate": 16000,
        "uid": f"UID{channel}",
        "model": "Cam",
    }
    base.update(kwargs)
    return base


def test_merge_partial_rescan_keeps_missing_known_cameras() -> None:
    """A partial ChannelInfo push must not drop cameras absent from the scan."""
    old = [_cam(0, "Garage"), _cam(3, "Front Yard"), _cam(8, "Front Door", sleeping=True, talk_status="unknown", talk_supported=False)]
    # Rescan only reports ch0 (as if the push was truncated).
    new = [_cam(0, "Garage")]
    merged = merge_channels(old, new)
    by_ch = {int(c["channel"]): c for c in merged}
    assert set(by_ch) == {0, 3, 8}
    assert by_ch[0]["online"] is True
    assert by_ch[3]["name"] == "Front Yard"
    assert by_ch[3]["online"] is False
    assert by_ch[8]["name"] == "Front Door"
    assert by_ch[8]["online"] is False
    assert by_ch[8]["talk_status"] == "unknown"
    assert selectable_channels(merged) == [0, 3, 8]


def test_merge_empty_rescan_keeps_all_known_cameras() -> None:
    old = [_cam(0, "Garage"), _cam(1, "Hallway")]
    merged = merge_channels(old, [])
    assert [c["channel"] for c in merged] == [0, 1]
    assert all(c["online"] is False for c in merged)
    assert selectable_channels(merged) == [0, 1]


def test_merge_empty_rescan_drops_only_empty_slots() -> None:
    old = [
        _cam(0, "Garage"),
        {"channel": 9, "name": None, "online": False, "talk_status": "unknown"},
    ]
    merged = merge_channels(old, [])
    assert [c["channel"] for c in merged] == [0]
    assert merged[0]["name"] == "Garage"


def test_merge_sleeping_battery_camera_never_dropped() -> None:
    old = [
        _cam(
            8,
            "Front Door",
            sleeping=True,
            talk_status="supported",
            sample_rate=16000,
        )
    ]
    # Asleep in the new scan (still present).
    new = [
        {
            "channel": 8,
            "name": "Front Door",
            "online": True,
            "sleeping": True,
            "talk_status": "unknown",
            "talk_supported": False,
            "uid": "UID8",
            "model": "Doorbell",
        }
    ]
    merged = merge_channels(old, new)
    assert len(merged) == 1
    assert merged[0]["talk_status"] == "supported"
    assert merged[0]["sleeping"] is True
    assert selectable_channels(merged) == [8]

    # Entirely omitted from a partial scan, still kept.
    merged_missing = merge_channels(old, [_cam(0, "Garage")])
    by_ch = {int(c["channel"]): c for c in merged_missing}
    assert 8 in by_ch
    assert by_ch[8]["name"] == "Front Door"
    assert by_ch[8]["online"] is False
    assert selectable_channels(merged_missing) == [0, 8]


def test_merge_new_camera_appears() -> None:
    old = [_cam(0, "Garage")]
    new = [_cam(0, "Garage"), _cam(2, "Backyard Right")]
    merged = merge_channels(old, new)
    assert [c["channel"] for c in merged] == [0, 2]
    assert merged[1]["name"] == "Backyard Right"


def test_merge_renamed_camera() -> None:
    old = [_cam(0, "Old Name")]
    new = [_cam(0, "New Name")]
    merged = merge_channels(old, new)
    assert merged[0]["name"] == "New Name"
    assert merged[0]["uid"] == "UID0"


def test_resolve_enabled_keeps_user_selection_despite_unselectable() -> None:
    """Rescan marking talk unsupported must not disable a user-enabled camera."""
    channels = [
        _cam(0, "Garage"),
        _cam(1, "Hallway", talk_status="unsupported", talk_supported=False),
    ]
    options = {CONF_ENABLED_CHANNELS: [0, 1]}
    assert resolve_enabled_channels(channels, options) == {0, 1}
    assert known_channels(channels) == {0, 1}
