"""Add a fullscreen Live view to a storage-mode Lovelace dashboard."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from homeassistant.components.lovelace.const import LOVELACE_DATA, MODE_STORAGE, ConfigNotFound
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from .card_info import build_card_info

CARD_TYPE = "custom:advanced-reolink-card"
DEFAULT_DASH = "lovelace"
OVERVIEW_LABEL = "Overview"
YAML_NOTE = (
    " YAML dashboards are not listed because Home Assistant cannot save to them."
)


class LivePageError(Exception):
    """Raised when the Live page cannot be added. ``reason`` is a form error key."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class LivePageResult:
    """Where the Live view lives after a successful add (or a match)."""

    path: str
    link: str
    created: bool


def yaml_note(yaml_count: int) -> str:
    """Sentence appended to the form description when YAML dashboards were skipped."""
    return YAML_NOTE if yaml_count > 0 else ""


def _dashboards(hass: HomeAssistant) -> dict[str | None, Any] | None:
    data = hass.data.get(LOVELACE_DATA)
    if data is None:
        return None
    return data.dashboards


def _dash_slug(dashboard: Any) -> str:
    return dashboard.url_path or DEFAULT_DASH


def _get_dashboard(hass: HomeAssistant, url_path: str) -> Any:
    dashboards = _dashboards(hass)
    if dashboards is None:
        raise LivePageError("dashboard_missing")
    dashboard = dashboards.get(url_path)
    if dashboard is None and url_path == DEFAULT_DASH:
        dashboard = dashboards.get(None)
    if dashboard is None:
        raise LivePageError("dashboard_missing")
    return dashboard


async def list_dashboards(hass: HomeAssistant) -> tuple[list[tuple[str, str]], int]:
    """Storage dashboards with a saved config, plus how many YAML ones were skipped.

    Auto-generated Overview dashboards are omitted: saving would replace them.
    The default dashboard (key ``None``) is offered as ``lovelace`` only when no
    dashboard already uses that url path.
    """
    dashboards = _dashboards(hass)
    if not dashboards:
        return [], 0

    has_lovelace_key = DEFAULT_DASH in dashboards
    usable: list[tuple[str, str]] = []
    yaml_count = 0
    for key, dashboard in dashboards.items():
        if dashboard.mode != MODE_STORAGE:
            yaml_count += 1
            continue
        info = await dashboard.async_get_info()
        if info.get("mode") == "auto-gen":
            continue
        if key is None:
            if has_lovelace_key:
                continue
            usable.append((DEFAULT_DASH, OVERVIEW_LABEL))
            continue
        value = dashboard.url_path or key
        config = dashboard.config or {}
        label = config.get("title") or value
        usable.append((value, label))
    usable.sort(key=lambda item: item[1].casefold())
    return usable, yaml_count


def default_dashboard(usable: list[tuple[str, str]]) -> str | None:
    """Preferred dropdown value: Overview when listed, otherwise the first dashboard."""
    if any(value == DEFAULT_DASH for value, _ in usable):
        return DEFAULT_DASH
    return usable[0][0] if usable else None


def build_card(hass: HomeAssistant, entry: Any) -> dict[str, Any]:
    """Fullscreen card config for the entry's enabled speakers, sorted by channel."""
    speakers = sorted(entry.runtime_data.speakers.items(), key=lambda item: item[1])
    cameras: list[dict[str, Any]] = []
    for speaker, _channel in speakers:
        cam: dict[str, Any] = {"entity": speaker}
        try:
            info = build_card_info(hass, {"entity_id": speaker})
        except Exception:  # noqa: BLE001
            info = {}
        if camera_entity := info.get("camera_entity"):
            cam["camera_entity"] = camera_entity
        cameras.append(cam)
    return {
        "type": CARD_TYPE,
        "layout": "fullscreen",
        "video": True,
        "ptz": True,
        "listen": True,
        "talk": True,
        "mode": "hold",
        "show_level": True,
        "cameras": cameras,
    }


def _iter_view_cards(view: dict[str, Any]) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    for card in view.get("cards") or []:
        if isinstance(card, dict):
            cards.append(card)
    for section in view.get("sections") or []:
        if not isinstance(section, dict):
            continue
        for card in section.get("cards") or []:
            if isinstance(card, dict):
                cards.append(card)
    return cards


def _card_speakers(card: dict[str, Any]) -> set[str]:
    found: set[str] = set()
    if entity := card.get("entity"):
        found.add(entity)
    for item in card.get("cameras") or []:
        if isinstance(item, dict) and (entity := item.get("entity")):
            found.add(entity)
    return found


def _is_our_live_card(card: dict[str, Any], speakers: set[str]) -> bool:
    return (
        card.get("type") == CARD_TYPE
        and card.get("layout") == "fullscreen"
        and bool(_card_speakers(card) & speakers)
    )


def _view_path(view: dict[str, Any], index: int) -> str:
    return view.get("path") or str(index)


def _first_camera_param(card: dict[str, Any]) -> str:
    cameras = card.get("cameras") or []
    if cameras:
        first = cameras[0]
        return first.get("camera_entity") or first.get("entity") or ""
    return card.get("camera_entity") or card.get("entity") or ""


def _link(dash: str, path: str, card: dict[str, Any]) -> str:
    camera = _first_camera_param(card)
    link = f"/{dash}/{path}"
    if camera:
        link = f"{link}?camera={camera}"
    return link


def _pick_live_path(views: list[dict[str, Any]]) -> str:
    used = {view.get("path") for view in views if view.get("path")}
    if "live" not in used:
        return "live"
    n = 2
    while f"live-{n}" in used:
        n += 1
    return f"live-{n}"


async def async_add_live_page(
    hass: HomeAssistant, entry: Any, url_path: str
) -> LivePageResult:
    """Append a Live subview, or return the existing one for this entry's speakers."""
    dashboard = _get_dashboard(hass, url_path)
    if dashboard.mode != MODE_STORAGE:
        raise LivePageError("dashboard_yaml")
    try:
        config = await dashboard.async_load(False)
    except ConfigNotFound as err:
        raise LivePageError("dashboard_empty") from err
    if not config:
        raise LivePageError("dashboard_empty")

    speakers = set(entry.runtime_data.speakers)
    if not speakers:
        raise LivePageError("no_speakers")

    card = build_card(hass, entry)
    dash = _dash_slug(dashboard)
    views = list(config.get("views") or [])
    for index, view in enumerate(views):
        if not isinstance(view, dict):
            continue
        if any(_is_our_live_card(c, speakers) for c in _iter_view_cards(view)):
            path = _view_path(view, index)
            return LivePageResult(path=path, link=_link(dash, path, card), created=False)

    path = _pick_live_path(views)
    first_path = _view_path(views[0], 0) if views else "0"
    new_view = {
        "title": "Live",
        "path": path,
        "icon": "mdi:cctv",
        "type": "panel",
        "subview": True,
        "back_path": f"/{dash}/{first_path}",
        "cards": [card],
    }
    new_config = deepcopy(config)
    new_config["views"] = [*views, new_view]
    try:
        await dashboard.async_save(new_config)
    except (HomeAssistantError, OSError) as err:
        raise LivePageError("save_failed") from err
    return LivePageResult(path=path, link=_link(dash, path, card), created=True)
