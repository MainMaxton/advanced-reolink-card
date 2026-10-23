"""Per-camera patrol settings (stored in entry options) and call precedence.

Pure helpers, no Home Assistant imports, so they are easy to unit test.

Precedence for every sweep option: action call value, then the camera's saved
setting (Configure or ``set_patrol_limits``), then the built-in default.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

CONF_PATROL: Final = "patrol"  # entry.options[CONF_PATROL][str(channel)] -> settings

# setting / action keys
S_ENABLED: Final = "enabled"
S_LEFT_TIME: Final = "left_time"
S_RIGHT_TIME: Final = "right_time"
S_SPEED: Final = "speed"
S_PAUSE: Final = "pause"
S_TILT_LEVELS: Final = "tilt_levels"
S_TILT_STEP: Final = "tilt_step"
S_DISABLE_TRACKING: Final = "disable_tracking"
S_SETTLE_TIME: Final = "settle_time"
S_SWEEP_TIME: Final = "sweep_time"

DEFAULTS: Final[dict[str, Any]] = {
    S_ENABLED: True,
    S_LEFT_TIME: 0.0,  # 0 with right_time 0: full range. 0 with right_time > 0: home is the left limit.
    S_RIGHT_TIME: 0.0,
    S_SPEED: 32,
    S_PAUSE: 2.0,
    S_TILT_LEVELS: 1,
    S_TILT_STEP: 2.0,
    S_DISABLE_TRACKING: False,
    S_SETTLE_TIME: 3.0,
    S_SWEEP_TIME: 25.0,
}

# Keys a camera can store (sweep_time is call-only: it applies without limits).
CAMERA_KEYS: Final = (
    S_ENABLED,
    S_LEFT_TIME,
    S_RIGHT_TIME,
    S_SPEED,
    S_PAUSE,
    S_TILT_LEVELS,
    S_TILT_STEP,
    S_DISABLE_TRACKING,
    S_SETTLE_TIME,
)
# Keys an action call may override.
CALL_KEYS: Final = (
    S_LEFT_TIME,
    S_RIGHT_TIME,
    S_SPEED,
    S_PAUSE,
    S_TILT_LEVELS,
    S_TILT_STEP,
    S_DISABLE_TRACKING,
    S_SETTLE_TIME,
    S_SWEEP_TIME,
)

RANGES: Final[dict[str, tuple[float, float]]] = {
    S_LEFT_TIME: (0, 300),
    S_RIGHT_TIME: (0, 300),
    S_SPEED: (1, 64),
    S_PAUSE: (0, 600),
    S_TILT_LEVELS: (1, 10),
    S_TILT_STEP: (0, 60),
    S_SETTLE_TIME: (0, 60),
    S_SWEEP_TIME: (1, 600),
}
_INT_KEYS: Final = (S_SPEED, S_TILT_LEVELS)
_BOOL_KEYS: Final = (S_ENABLED, S_DISABLE_TRACKING)


class PatrolSettingsError(ValueError):
    """Invalid patrol settings; ``key`` is a translation key."""

    def __init__(self, key: str, **placeholders: Any) -> None:
        super().__init__(key)
        self.key = key
        self.placeholders = placeholders


def _coerce(key: str, value: Any) -> Any:
    if key in _BOOL_KEYS:
        return bool(value)
    try:
        num = int(value) if key in _INT_KEYS else float(value)
    except (TypeError, ValueError) as err:
        raise PatrolSettingsError("patrol_value_range", field=key, min=RANGES[key][0], max=RANGES[key][1], value=value) from err
    lo, hi = RANGES[key]
    if not lo <= num <= hi:
        raise PatrolSettingsError("patrol_value_range", field=key, min=lo, max=hi, value=value)
    return num


def normalize_camera_settings(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and coerce a camera's settings (only known keys, defaults filled)."""
    out = dict(DEFAULTS)
    out.pop(S_SWEEP_TIME)
    for key in CAMERA_KEYS:
        if key in raw and raw[key] is not None:
            out[key] = _coerce(key, raw[key])
    check_arc(out[S_LEFT_TIME], out[S_RIGHT_TIME])
    return out


def check_arc(left: float, right: float) -> None:
    """Both 0 is a full range sweep. right_time alone starts at home.

    A left time still needs a right time.
    """
    if left > 0 and right <= 0:
        raise PatrolSettingsError("patrol_arc_incomplete", left_time=left, right_time=right)


def camera_settings(options: Mapping[str, Any], channel: int) -> dict[str, Any]:
    """Saved settings for one channel (normalized; defaults when none saved)."""
    stored = (options.get(CONF_PATROL) or {}).get(str(channel)) or {}
    out = {k: v for k, v in DEFAULTS.items() if k != S_SWEEP_TIME}
    # A broken stored value falls back to its default (per key) so it never
    # blocks a call that overrides it.
    for key in CAMERA_KEYS:
        if stored.get(key) is not None:
            try:
                out[key] = _coerce(key, stored[key])
            except (PatrolSettingsError, TypeError, ValueError):
                pass
    try:
        check_arc(out[S_LEFT_TIME], out[S_RIGHT_TIME])
    except PatrolSettingsError:
        out[S_LEFT_TIME] = out[S_RIGHT_TIME] = 0.0
    return out


def resolve_sweep_options(
    call: Mapping[str, Any], camera: Mapping[str, Any]
) -> dict[str, Any]:
    """Merge call > camera > default for every sweep option and validate."""
    call = dict(call)
    if (arc := call.pop("arc", None)) is not None:
        if len(arc) != 2:
            raise PatrolSettingsError("patrol_arc_incomplete", left_time=arc, right_time="")
        call.setdefault(S_LEFT_TIME, arc[0])
        call.setdefault(S_RIGHT_TIME, arc[1])
    out: dict[str, Any] = {}
    for key in CALL_KEYS:
        if call.get(key) is not None:
            out[key] = _coerce(key, call[key])
        elif key in camera:
            out[key] = camera[key]
        else:
            out[key] = DEFAULTS[key]
    check_arc(out[S_LEFT_TIME], out[S_RIGHT_TIME])
    return out


def with_camera_settings(
    options: Mapping[str, Any], channel: int, updates: Mapping[str, Any]
) -> dict[str, Any]:
    """New options dict with ``updates`` merged into one channel's settings."""
    current = (options.get(CONF_PATROL) or {}).get(str(channel)) or {}
    merged = normalize_camera_settings({**current, **{k: v for k, v in updates.items() if v is not None}})
    patrol = dict(options.get(CONF_PATROL) or {})
    patrol[str(channel)] = merged
    return {**options, CONF_PATROL: patrol}
