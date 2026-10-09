"""Minimal Reolink HTTP/CGI client for PTZ patrol (login + GET/PtzCtrl).

Uses the same host/username/password as the Baichuan talk session. The HTTP
port defaults to 80 (Reolink's api.cgi). Never logs the password.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
from typing import Any

import aiohttp

from .baichuan_talk import BaichuanAuthError, BaichuanError

_LOGGER = logging.getLogger(__name__)

DEFAULT_HTTP_PORT = 80
DEFAULT_TIMEOUT = 20.0


@dataclass
class PtzInfo:
    """Read-only PTZ facts for one channel."""

    channel: int
    ptz_supported: bool
    presets: dict[str, int] = field(default_factory=dict)  # name -> id
    patrols: dict[str, int] = field(default_factory=dict)  # name -> id
    guard: dict[str, Any] | None = None
    ptz_type: int = 0

    @property
    def guard_configured(self) -> bool:
        g = self.guard or {}
        return bool(g.get("bexistPos") == 1)

    def resolve_preset(self, preset: int | str) -> int:
        if isinstance(preset, int):
            if preset in self.presets.values():
                return preset
            # allow bare ids even when the name map is sparse
            return preset
        key = str(preset)
        if key in self.presets:
            return self.presets[key]
        # case-insensitive name match
        lowered = {n.casefold(): i for n, i in self.presets.items()}
        if key.casefold() in lowered:
            return lowered[key.casefold()]
        if key.isdigit():
            return int(key)
        raise LookupError(f"preset {preset!r} not in {list(self.presets)}")

    def resolve_patrol(self, patrol_id: int | str | None) -> int:
        if not self.patrols:
            raise LookupError("no enabled PTZ patrol on this camera")
        if patrol_id is None:
            return next(iter(self.patrols.values()))
        if isinstance(patrol_id, int):
            if patrol_id in self.patrols.values():
                return patrol_id
            return patrol_id
        key = str(patrol_id)
        if key in self.patrols:
            return self.patrols[key]
        lowered = {n.casefold(): i for n, i in self.patrols.items()}
        if key.casefold() in lowered:
            return lowered[key.casefold()]
        if key.isdigit():
            return int(key)
        raise LookupError(f"patrol {patrol_id!r} not in {list(self.patrols)}")


class ReolinkHttpClient:
    """One login session to api.cgi."""

    def __init__(
        self,
        host: str,
        username: str,
        password: str,
        *,
        port: int = DEFAULT_HTTP_PORT,
        session: aiohttp.ClientSession | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self._password = password
        self.timeout = timeout
        self._session = session
        self._owns_session = session is None
        self._token: str | None = None
        self._abilities: dict[str, Any] | None = None

    @property
    def _base(self) -> str:
        return f"http://{self.host}:{self.port}/api.cgi"

    async def __aenter__(self) -> ReolinkHttpClient:
        await self.login()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.timeout)
            )
            self._owns_session = True
        return self._session

    async def close(self) -> None:
        try:
            if self._token is not None:
                await self._post([{"cmd": "Logout", "param": {}}])
        except (BaichuanError, OSError, TimeoutError) as err:
            _LOGGER.debug("HTTP API logout on %s failed: %s", self.host, err)
        self._token = None
        if self._owns_session and self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None

    async def _post(self, body: list[dict[str, Any]]) -> list[dict[str, Any]]:
        session = await self._ensure_session()
        # The Reolink CGI routes on the ``cmd`` query parameter; without it the
        # NVR answers "please login first" even for a valid Login body.
        params: dict[str, str] = {}
        if body and body[0].get("cmd"):
            params["cmd"] = body[0]["cmd"]
        if self._token:
            params["token"] = self._token
        try:
            async with session.post(self._base, params=params or None, json=body) as resp:
                resp.raise_for_status()
                data = await resp.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError, OSError) as err:
            raise BaichuanError(f"HTTP API error on {self.host}: {err}") from err
        if not isinstance(data, list):
            raise BaichuanError(f"unexpected HTTP API response on {self.host}")
        return data

    async def login(self) -> None:
        body = [
            {
                "cmd": "Login",
                "action": 0,
                "param": {"User": {"userName": self.username, "password": self._password}},
            }
        ]
        # Login must be unauthenticated
        token = self._token
        self._token = None
        try:
            data = await self._post(body)
        finally:
            self._token = token
        item = data[0] if data else {}
        if item.get("code") != 0 or "value" not in item:
            raise BaichuanAuthError("HTTP API login rejected")
        self._token = item["value"]["Token"]["name"]
        _LOGGER.debug("HTTP API login ok on %s:%s", self.host, self.port)

    async def send(self, body: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self._token is None:
            await self.login()
        data = await self._post(body)
        # token expired?
        if data and data[0].get("code") in (1, -4):  # common auth-ish codes
            await self.login()
            data = await self._post(body)
        return data

    async def get_abilities(self) -> dict[str, Any]:
        if self._abilities is not None:
            return self._abilities
        data = await self.send(
            [{"cmd": "GetAbility", "action": 0, "param": {"User": {"userName": self.username}}}]
        )
        item = data[0] if data else {}
        if item.get("code") != 0:
            raise BaichuanError(f"GetAbility failed: {item.get('error') or item}")
        self._abilities = (item.get("value") or {}).get("Ability") or item.get("value") or {}
        return self._abilities

    def _ptz_type(self, abilities: dict[str, Any], channel: int) -> int:
        chans = abilities.get("abilityChn") or []
        if channel >= len(chans):
            return 0
        return int((chans[channel].get("ptzType") or {}).get("ver") or 0)

    async def get_ptz_info(self, channel: int) -> PtzInfo:
        """Read-only: ability + presets + patrols + guard for one channel."""
        abilities = await self.get_abilities()
        ptz_type = self._ptz_type(abilities, channel)
        body = [
            {"cmd": "GetPtzPreset", "action": 1, "param": {"channel": channel}},
            {"cmd": "GetPtzPatrol", "action": 1, "param": {"channel": channel}},
            {"cmd": "GetPtzGuard", "action": 1, "param": {"channel": channel}},
        ]
        data = await self.send(body)
        presets: dict[str, int] = {}
        patrols: dict[str, int] = {}
        guard: dict[str, Any] | None = None
        for item in data:
            cmd = item.get("cmd")
            if item.get("code") not in (0, None) and "value" not in item:
                continue
            value = item.get("value") or {}
            if cmd == "GetPtzPreset":
                for preset in value.get("PtzPreset") or []:
                    if preset.get("enable"):
                        name = str(preset.get("name") or preset.get("id"))
                        presets[name] = int(preset["id"])
            elif cmd == "GetPtzPatrol":
                for patrol in value.get("PtzPatrol") or []:
                    if patrol.get("enable"):
                        name = str(patrol.get("name") or patrol.get("id"))
                        patrols[name] = int(patrol["id"])
            elif cmd == "GetPtzGuard":
                guard = value.get("PtzGuard")
        return PtzInfo(
            channel=channel,
            ptz_supported=ptz_type != 0,
            presets=presets,
            patrols=patrols,
            guard=guard,
            ptz_type=ptz_type,
        )

    async def ptz_ctrl(
        self,
        channel: int,
        op: str,
        *,
        id: int | None = None,
        speed: int | None = None,
    ) -> None:
        """Send PtzCtrl (StartPatrol / StopPatrol / ToPos / …)."""
        param: dict[str, Any] = {"channel": channel, "op": op}
        if id is not None:
            param["id"] = id
        if speed is not None:
            param["speed"] = speed
        data = await self.send([{"cmd": "PtzCtrl", "action": 0, "param": param}])
        item = data[0] if data else {}
        if item.get("code") != 0:
            raise BaichuanError(f"PtzCtrl {op} failed on channel {channel}: {item.get('error') or item}")

    async def goto_guard(self, channel: int) -> None:
        """Return to the configured guard position (SetPtzGuard toPos)."""
        data = await self.send(
            [
                {
                    "cmd": "SetPtzGuard",
                    "action": 0,
                    "param": {"PtzGuard": {"channel": channel, "cmdStr": "toPos"}},
                }
            ]
        )
        item = data[0] if data else {}
        if item.get("code") != 0:
            raise BaichuanError(f"SetPtzGuard toPos failed on channel {channel}: {item.get('error') or item}")

    async def get_ai_cfg(self, channel: int) -> dict[str, Any]:
        """GetAiCfg (auto-tracking settings). Read-only."""
        data = await self.send([{"cmd": "GetAiCfg", "action": 0, "param": {"channel": channel}}])
        item = data[0] if data else {}
        if item.get("code") != 0:
            raise BaichuanError(f"GetAiCfg failed on channel {channel}: {item.get('error') or item}")
        return dict(item.get("value") or {})

    async def set_ai_cfg(self, channel: int, values: dict[str, Any]) -> None:
        """SetAiCfg with only the given keys (used to pause/restore auto-tracking)."""
        data = await self.send(
            [{"cmd": "SetAiCfg", "action": 0, "param": {"channel": channel, **values}}]
        )
        item = data[0] if data else {}
        if item.get("code") != 0:
            raise BaichuanError(f"SetAiCfg failed on channel {channel}: {item.get('error') or item}")
