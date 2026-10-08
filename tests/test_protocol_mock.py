"""Protocol-level tests against the in-process mock Baichuan server (localhost only).

Covers login, discovery rules (sleeping cameras are never woken during discovery,
only a definite answer counts as "no talk"), the channel guard, a full talk
session with TalkReset, and waking a sleeping battery camera before talking.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "audiohook_offline_checks", Path(__file__).parent.parent / "scripts" / "offline_checks.py"
)
offline_checks = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(offline_checks)


def test_static_protocol_and_audio() -> None:
    offline_checks.check_static()


@pytest.mark.enable_socket
async def test_mock_device_flow(socket_enabled: None) -> None:
    await offline_checks.check_mock_flow()
