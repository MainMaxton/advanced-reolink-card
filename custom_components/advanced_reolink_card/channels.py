"""Helpers for the discovered channel list stored in the config entry.

Pure functions (no Home Assistant imports) so they are easy to unit test.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .const import TALK_SUPPORTED, TALK_UNKNOWN, TALK_UNSUPPORTED


def talk_status(info: Mapping[str, Any]) -> str:
    """Talk status of a stored channel dict (older entries only had talk_supported)."""
    status = info.get("talk_status")
    if status in (TALK_SUPPORTED, TALK_UNSUPPORTED, TALK_UNKNOWN):
        return status
    return TALK_SUPPORTED if info.get("talk_supported") else TALK_UNKNOWN


def is_empty_slot(info: Mapping[str, Any]) -> bool:
    """An NVR channel with no camera attached (offline and nothing known about it)."""
    return info.get("online") is False and not (
        info.get("name") or info.get("uid") or info.get("model")
    )


def selectable_channels(channels: Iterable[Mapping[str, Any]]) -> list[int]:
    """Channels that may be enabled for talk.

    Everything except channels that positively reported "no talk ability" and
    empty NVR slots. Sleeping, offline (known) or not-yet-probed cameras stay
    selectable.
    """
    return sorted(
        int(c["channel"])
        for c in channels
        if talk_status(c) != TALK_UNSUPPORTED and not is_empty_slot(c)
    )


def known_channels(channels: Iterable[Mapping[str, Any]]) -> set[int]:
    """Channel numbers that have (or had) a real camera, not empty NVR slots."""
    return {int(c["channel"]) for c in channels if not is_empty_slot(c)}


def merge_channels(
    old: Iterable[Mapping[str, Any]], new: Iterable[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """Merge a fresh discovery into the stored channel list.

    - Channels present in ``new`` are updated (new names/models/uids win when
      set; a fresh "unknown" talk status must not erase a previously known
      ability; missing name/model/uid keep the old values).
    - Channels only in ``new`` are added.
    - Previously known cameras (non-empty) missing from ``new`` are **kept**
      and marked offline so a partial or empty rescan cannot drop them.
      Empty NVR slots that vanish from the scan are not preserved.
    - A sleeping / talk-unknown battery camera is never dropped.
    """
    previous = {int(c["channel"]): dict(c) for c in old}
    merged: list[dict[str, Any]] = []
    seen: set[int] = set()
    for item in new:
        cur = dict(item)
        ch = int(cur["channel"])
        seen.add(ch)
        prev = previous.get(ch)
        if prev is not None:
            if talk_status(cur) == TALK_UNKNOWN and talk_status(prev) != TALK_UNKNOWN:
                for key in ("talk_status", "talk_supported", "sample_rate", "length_per_encoder"):
                    if key in prev:
                        cur[key] = prev[key]
            for key in ("name", "model", "uid"):
                if not cur.get(key) and prev.get(key):
                    cur[key] = prev[key]
        cur["talk_status"] = talk_status(cur)
        merged.append(cur)
    for ch, prev in previous.items():
        if ch in seen or is_empty_slot(prev):
            continue
        kept = dict(prev)
        kept["online"] = False
        kept["talk_status"] = talk_status(kept)
        merged.append(kept)
    return sorted(merged, key=lambda c: int(c["channel"]))


def channel_label(info: Mapping[str, Any], multi_channel: bool) -> str:
    """Human readable label used in the options form."""
    name = info.get("name") or f"Channel {info['channel']}"
    notes: list[str] = []
    if multi_channel:
        notes.append(f"ch {info['channel']}")
    if info.get("online") is False:
        notes.append("offline")
    elif info.get("sleeping"):
        notes.append("asleep")
    if talk_status(info) == TALK_UNKNOWN and not info.get("sleeping") and info.get("online") is not False:
        notes.append("talk support not confirmed yet")
    return f"{name} ({', '.join(notes)})" if notes else name
