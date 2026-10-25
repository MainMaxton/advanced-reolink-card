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
    header = src.split('<div class="header">', 1)[1].split("${this._multi", 1)[0]
    assert 'class="guard-open"' in header
    assert header.index("guard-open") < header.index("patrol-open")
    assert 'aria-label="Return to guard"' in header
    assert 'title="Return to guard"' in header
    assert ">Guard</span>" in header
    assert 'class="presets-open"' in header
    assert header.index("presets-open") < header.index("guard-open")
    assert 'aria-label="Presets"' in header
    assert 'title="Presets"' in header
    assert 'aria-haspopup="menu"' in header
    assert ">Presets<" not in header
    ptz = src.split('<div class="ptz"', 1)[1].split("ptznote", 1)[0]
    assert 'class="presets"' not in ptz
    assert "button.chip" not in src
    assert 'class="presets-menu"' in src
    assert 'role="menu"' in src
    assert "button.preset-option" in src
    assert "type: WS_PTZ_GUARD" in src
    assert "const showPatrol = this._patrolSetupAvailable()" in src
    assert "this._guardBtn.hidden = !showPatrol" in src
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
    assert "_lockCardHeight(true)" in select
    assert "_queueSettleCardHeight()" in select
    assert "HEIGHT_SETTLE_MS" in src
    assert "_releaseCardHeight" in src
    settle = src.split("  _settleCardHeight() {", 1)[1].split("  _releaseCardHeight()", 1)[0]
    assert "const minTo = this._cssMinHeight(card, to)" in settle
    assert "this._naturalCardHeight(card)" in settle
    assert "hostPadForHeight" in settle
    assert "_setHostPad" in settle
    assert "_holdResidualHeight" not in settle
    assert "_keepHeight" not in src
    assert "_holdResidualHeight" not in src
    assert "this.style.paddingBottom" in src
    assert "_clearHostPad()" in src.split("disconnectedCallback()", 1)[1].split("  _targetKey", 1)[0]
