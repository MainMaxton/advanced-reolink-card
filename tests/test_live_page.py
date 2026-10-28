"""Live page: dashboard listing, view append, setup hook, options-off is unchanged."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.advanced_reolink_card import _async_finish_live_page
from custom_components.advanced_reolink_card.const import CONF_LIVE_PAGE_PENDING, DOMAIN
from custom_components.advanced_reolink_card.live_page import (
    LivePageError,
    async_add_live_page,
    build_card,
    default_dashboard,
    list_dashboards,
    yaml_note,
)
from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.components.lovelace.dashboard import LovelaceStorage, LovelaceYAML
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from .conftest import DEVICE, USER_INPUT, channel_dicts

SPEAKER_A = "media_player.camera_a_speaker"
SPEAKER_B = "media_player.camera_b_speaker"
HOME_VIEW = {"title": "Home", "path": "home", "cards": [{"type": "weather-forecast"}]}
SAVED = {"views": [HOME_VIEW]}


def _entry(speakers: dict[str, int] | None = None) -> SimpleNamespace:
    if speakers is None:
        speakers = {SPEAKER_A: 0, SPEAKER_B: 1}
    return SimpleNamespace(runtime_data=SimpleNamespace(speakers=dict(speakers)))


async def _setup_lovelace(hass: HomeAssistant) -> None:
    assert await async_setup_component(hass, "lovelace", {})
    await hass.async_block_till_done()


async def _save_overview(hass: HomeAssistant, config: dict) -> LovelaceStorage:
    dash = hass.data[LOVELACE_DATA].dashboards[None]
    await dash.async_save(config)
    return dash


async def _add_storage(hass: HomeAssistant, url_path: str, title: str, config: dict) -> LovelaceStorage:
    dash = LovelaceStorage(
        hass,
        {
            "id": url_path,
            "url_path": url_path,
            "title": title,
            "require_admin": False,
            "show_in_sidebar": True,
        },
    )
    await dash.async_save(config)
    hass.data[LOVELACE_DATA].dashboards[url_path] = dash
    return dash


def _add_yaml(hass: HomeAssistant, url_path: str, title: str) -> LovelaceYAML:
    dash = LovelaceYAML(
        hass,
        url_path,
        {
            "filename": "ui-lovelace.yaml",
            "title": title,
            "show_in_sidebar": True,
            "require_admin": False,
        },
    )
    hass.data[LOVELACE_DATA].dashboards[url_path] = dash
    return dash


@pytest.fixture
def mock_card_info():
    with patch(
        "custom_components.advanced_reolink_card.live_page.build_card_info",
        return_value={"camera_entity": "camera.front_door"},
    ) as mock:
        yield mock


async def test_list_dashboards_skips_autogen_and_yaml(hass: HomeAssistant) -> None:
    await _setup_lovelace(hass)
    usable, yaml_count = await list_dashboards(hass)
    assert usable == []
    assert yaml_count == 0

    await _save_overview(hass, SAVED)
    await _add_storage(hass, "dashboard-yard", "Yard", SAVED)
    _add_yaml(hass, "dashboard-yaml", "YAML cams")

    usable, yaml_count = await list_dashboards(hass)
    values = {value for value, _label in usable}
    labels = {label for _value, label in usable}
    assert yaml_count >= 1
    assert "lovelace" in values
    assert "dashboard-yard" in values
    assert "Overview" in labels
    assert "Yard" in labels
    assert "dashboard-yaml" not in values
    assert default_dashboard(usable) == "lovelace"
    assert "YAML dashboards are not listed" in yaml_note(yaml_count)


async def test_list_dashboards_empty_without_lovelace(hass: HomeAssistant) -> None:
    usable, yaml_count = await list_dashboards(hass)
    assert usable == []
    assert yaml_count == 0
    assert yaml_note(0) == ""


async def test_build_card_sorts_by_channel_and_drops_failed_camera(
    hass: HomeAssistant,
) -> None:
    entry = _entry({SPEAKER_B: 1, SPEAKER_A: 0})

    def _info(hass_arg, target):  # noqa: ANN001
        if target["entity_id"] == SPEAKER_A:
            return {"camera_entity": "camera.front_door"}
        raise RuntimeError("no match")

    with patch(
        "custom_components.advanced_reolink_card.live_page.build_card_info",
        side_effect=_info,
    ):
        card = build_card(hass, entry)
    assert card["type"] == "custom:advanced-reolink-card"
    assert card["layout"] == "fullscreen"
    assert card["video"] is True
    assert card["cameras"] == [
        {"entity": SPEAKER_A, "camera_entity": "camera.front_door"},
        {"entity": SPEAKER_B},
    ]


async def test_add_live_page_appends_view(
    hass: HomeAssistant, mock_card_info: MagicMock
) -> None:
    await _setup_lovelace(hass)
    dash = await _save_overview(hass, SAVED)
    result = await async_add_live_page(hass, _entry(), "lovelace")
    assert result.created is True
    assert result.path == "live"
    assert result.link == "/lovelace/live?camera=camera.front_door"
    config = await dash.async_load(False)
    assert config["views"][0] == HOME_VIEW
    live = config["views"][1]
    assert live["path"] == "live"
    assert live["type"] == "panel"
    assert live["subview"] is True
    assert live["icon"] == "mdi:cctv"
    assert live["back_path"] == "/lovelace/home"
    assert live["cards"][0]["layout"] == "fullscreen"


async def test_add_live_page_is_idempotent(
    hass: HomeAssistant, mock_card_info: MagicMock
) -> None:
    await _setup_lovelace(hass)
    dash = await _save_overview(hass, SAVED)
    first = await async_add_live_page(hass, _entry(), "lovelace")
    second = await async_add_live_page(hass, _entry(), "lovelace")
    assert first.created is True
    assert second.created is False
    assert second.path == "live"
    config = await dash.async_load(False)
    live_views = [v for v in config["views"] if v.get("path", "").startswith("live")]
    assert len(live_views) == 1


async def test_add_live_page_avoids_path_collision(
    hass: HomeAssistant, mock_card_info: MagicMock
) -> None:
    await _setup_lovelace(hass)
    existing = {
        "views": [
            HOME_VIEW,
            {"title": "Other", "path": "live", "cards": [{"type": "markdown", "content": "x"}]},
        ]
    }
    dash = await _save_overview(hass, existing)
    result = await async_add_live_page(hass, _entry(), "lovelace")
    assert result.path == "live-2"
    config = await dash.async_load(False)
    assert config["views"][1]["path"] == "live"
    assert config["views"][1]["cards"][0]["type"] == "markdown"
    assert config["views"][2]["path"] == "live-2"


async def test_add_live_page_finds_card_in_sections(
    hass: HomeAssistant, mock_card_info: MagicMock
) -> None:
    await _setup_lovelace(hass)
    await _save_overview(
        hass,
        {
            "views": [
                {
                    "title": "Home",
                    "path": "home",
                    "sections": [
                        {
                            "cards": [
                                {
                                    "type": "custom:advanced-reolink-card",
                                    "layout": "fullscreen",
                                    "entity": SPEAKER_A,
                                }
                            ]
                        }
                    ],
                }
            ]
        },
    )
    result = await async_add_live_page(hass, _entry(), "lovelace")
    assert result.created is False
    assert result.path == "home"


async def test_add_live_page_rejects_yaml_empty_missing_and_no_speakers(
    hass: HomeAssistant, mock_card_info: MagicMock
) -> None:
    await _setup_lovelace(hass)
    _add_yaml(hass, "dashboard-yaml", "YAML cams")
    with pytest.raises(LivePageError) as err:
        await async_add_live_page(hass, _entry(), "dashboard-yaml")
    assert err.value.reason == "dashboard_yaml"

    with pytest.raises(LivePageError) as err:
        await async_add_live_page(hass, _entry(), "missing-dash")
    assert err.value.reason == "dashboard_missing"

    with pytest.raises(LivePageError) as err:
        await async_add_live_page(hass, _entry(), "lovelace")
    assert err.value.reason == "dashboard_empty"

    await _save_overview(hass, SAVED)
    with pytest.raises(LivePageError) as err:
        await async_add_live_page(hass, _entry(speakers={}), "lovelace")
    assert err.value.reason == "no_speakers"


async def test_add_live_page_save_failure(
    hass: HomeAssistant, mock_card_info: MagicMock
) -> None:
    await _setup_lovelace(hass)
    dash = await _save_overview(hass, SAVED)
    dash.async_save = AsyncMock(side_effect=HomeAssistantError("disk"))
    with pytest.raises(LivePageError) as err:
        await async_add_live_page(hass, _entry(), "lovelace")
    assert err.value.reason == "save_failed"


async def test_setup_creates_live_view_when_pending(
    hass: HomeAssistant, mock_nvr: MagicMock, mock_card_info: MagicMock
) -> None:
    await _setup_lovelace(hass)
    dash = await _save_overview(hass, SAVED)
    entry = MockConfigEntry(
        domain=DOMAIN,
        title=DEVICE["name"],
        unique_id=DEVICE["uid"],
        data={**USER_INPUT, "device": dict(DEVICE), "channels": channel_dicts(), CONF_LIVE_PAGE_PENDING: "lovelace"},
        version=1,
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert entry.state is ConfigEntryState.LOADED
    assert CONF_LIVE_PAGE_PENDING not in entry.data
    config = await dash.async_load(False)
    assert any(v.get("path") == "live" for v in config["views"])


async def test_setup_without_pending_leaves_dashboard_alone(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup_lovelace(hass)
    dash = await _save_overview(hass, SAVED)
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert CONF_LIVE_PAGE_PENDING not in config_entry.data
    config = await dash.async_load(False)
    assert config["views"] == [HOME_VIEW]


async def test_setup_clears_pending_when_add_fails(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    config_entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(
        config_entry, data={**config_entry.data, CONF_LIVE_PAGE_PENDING: "lovelace"}
    )
    with (
        patch(
            "custom_components.advanced_reolink_card.async_add_live_page",
            side_effect=LivePageError("save_failed"),
        ),
        patch(
            "custom_components.advanced_reolink_card.persistent_notification.async_create"
        ) as notify,
    ):
        assert await hass.config_entries.async_setup(config_entry.entry_id)
        await hass.async_block_till_done(wait_background_tasks=True)
    assert config_entry.state is ConfigEntryState.LOADED
    assert CONF_LIVE_PAGE_PENDING not in config_entry.data
    notify.assert_called()
    assert notify.call_args.kwargs["title"] == "Live page not added"


async def test_finish_live_page_hook_notifies_link(
    hass: HomeAssistant, mock_card_info: MagicMock
) -> None:
    await _setup_lovelace(hass)
    await _save_overview(hass, SAVED)
    entry = MockConfigEntry(
        domain=DOMAIN,
        title=DEVICE["name"],
        unique_id="live-hook",
        data={**USER_INPUT, "device": dict(DEVICE), "channels": channel_dicts(), CONF_LIVE_PAGE_PENDING: "lovelace"},
        version=1,
    )
    entry.add_to_hass(hass)
    entry.runtime_data = SimpleNamespace(speakers={SPEAKER_A: 0})
    with patch(
        "custom_components.advanced_reolink_card.persistent_notification.async_create"
    ) as notify:
        await _async_finish_live_page(hass, entry)
    notify.assert_called_once()
    assert notify.call_args.kwargs["title"] == "Live page added"
    assert "/lovelace/live?camera=camera.front_door" in notify.call_args.args[1]
    assert CONF_LIVE_PAGE_PENDING not in entry.data
