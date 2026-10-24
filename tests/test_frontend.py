"""Frontend card: syntax check and config normalisation (no npm)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CARD = (
    ROOT
    / "custom_components"
    / "advanced_reolink_card"
    / "frontend"
    / "advanced-reolink-card.js"
)
NODE_TEST = Path(__file__).resolve().parent / "js" / "test_card_config.js"

_NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(_NODE is None, reason="node is not available")


def test_card_js_syntax() -> None:
    subprocess.run([_NODE, "--check", str(CARD)], check=True)


def test_card_config_normalisation() -> None:
    subprocess.run([_NODE, str(NODE_TEST)], check=True)


def test_card_file_has_multicam_hooks() -> None:
    src = CARD.read_text(encoding="utf-8")
    assert 'role="tablist"' in src
    assert 'role="tab"' in src
    assert "aria-selected" in src
    assert "normalizeCardConfig" in src
    assert "default_camera" in src
    assert "audiohook-talk-card" in src
    assert "getStubConfig" in src
    assert "This card uses a <code>cameras</code> list" in src
    assert "touchstart" in src
    assert "ArrowLeft" in src
    assert "grid_columns" in src
    assert "hide_grid_warning" in src
    assert "mdi:view-grid" in src
    assert "Set up patrol" in src
    assert "mdi:map-marker-path" in src
    assert 'aria-label="Set up patrol"' in src
    assert "advanced_reolink_card/ptz/set_guard" in src
    assert "advanced_reolink_card/ptz/move" in src
    assert 'role="progressbar"' in src
    assert "aria-valuetext" in src
    assert "_estimateSweepPhases" in src
    assert "HOME_RETURN_S" in src
    assert "Start test sweep" in src
    assert 'controlslist="nodownload nofullscreen noremoteplayback noplaybackrate"' in src
    assert "tilts down a little and sweeps again" in src
    assert "tilting down" in src
    assert "media.hidden = wiz.step === 2 || wiz.step === 4" in src
    select = src.split("  _selectCamera(index, opts = {}) {", 1)[1].split("  _focusActiveTab()", 1)[0]
    assert "_startListen" not in select
    assert "_startVideo()" in select
    assert '_stopTalk("camera switch")' in select
    assert "_render(" not in select
