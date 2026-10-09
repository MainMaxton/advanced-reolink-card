"""Constants for Advanced Reolink Card."""

from __future__ import annotations

from datetime import timedelta
from typing import Final

DOMAIN: Final = "advanced_reolink_card"
MANUFACTURER: Final = "Reolink"

DEFAULT_PORT: Final = 9000  # Baichuan service port (configurable in the UI)
DEFAULT_VOICE: Final = "en-US-JennyNeural"
DEFAULT_VOLUME: Final = 100  # percent software gain, 100 = unchanged

# How often the NVR/camera is polled for connectivity and channel online/sleep
# state (login + ChannelInfo push, read-only, never wakes battery cameras).
STATUS_INTERVAL: Final = timedelta(minutes=2)

# config entry data
CONF_CHANNELS: Final = "channels"  # discovered channel info (list of dicts)
CONF_DEVICE: Final = "device"  # discovered host info (dict)

# options
CONF_VOICE: Final = "voice"
CONF_VOLUME: Final = "volume"
CONF_ENABLED_CHANNELS: Final = "enabled_channels"
CONF_LIVE_TALK_NON_ADMIN: Final = "live_talk_non_admin"

# channel talk status (see baichuan_talk.ChannelInfo.talk_status)
TALK_SUPPORTED: Final = "supported"
TALK_UNSUPPORTED: Final = "unsupported"
TALK_UNKNOWN: Final = "unknown"

# services
SERVICE_SAY: Final = "say"
SERVICE_PLAY_FILE: Final = "play_file"
SERVICE_START_PATROL: Final = "start_patrol"
SERVICE_STOP_PATROL: Final = "stop_patrol"

ATTR_CAMERA: Final = "camera"
ATTR_CHANNEL: Final = "channel"
ATTR_CONFIG_ENTRY_ID: Final = "config_entry_id"
ATTR_MESSAGE: Final = "message"
ATTR_VOICE: Final = "voice"
ATTR_VOLUME: Final = "volume"
ATTR_MEDIA_CONTENT_ID: Final = "media_content_id"
ATTR_DEVICE_ID: Final = "device_id"
ATTR_PATROL_ID: Final = "patrol_id"
ATTR_PRESETS: Final = "presets"
ATTR_DWELL: Final = "dwell"
ATTR_DURATION: Final = "duration"
ATTR_LOOPS: Final = "loops"
ATTR_RETURN_PRESET: Final = "return_preset"
ATTR_MODE: Final = "mode"
ATTR_SWEEP_TIME: Final = "sweep_time"
ATTR_PAUSE: Final = "pause"
ATTR_SPEED: Final = "speed"
ATTR_TILT_LEVELS: Final = "tilt_levels"
ATTR_TILT_STEP: Final = "tilt_step"
ATTR_ZOOM_OUT_FIRST: Final = "zoom_out_first"
ATTR_DISABLE_TRACKING: Final = "disable_tracking"
