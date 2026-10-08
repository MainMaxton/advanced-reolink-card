"""Pure helper tests: talk status, selectable channels, merge, labels."""

from custom_components.advanced_reolink_card.channels import (
    channel_label,
    merge_channels,
    selectable_channels,
    talk_status,
)

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
