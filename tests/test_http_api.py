"""HTTP api.cgi client tests (fake aiohttp session, no network)."""

from __future__ import annotations

from typing import Any

from custom_components.advanced_reolink_card.http_api import ReolinkHttpClient


class _Resp:
    def __init__(self, data: Any) -> None:
        self._data = data

    async def __aenter__(self) -> _Resp:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    async def json(self, content_type: str | None = None) -> Any:
        return self._data


class FakeSession:
    closed = False

    def __init__(self) -> None:
        self.posts: list[tuple[str, dict[str, str] | None, list[dict[str, Any]]]] = []

    def post(self, url: str, *, params: dict[str, str] | None = None, json: Any = None) -> _Resp:
        self.posts.append((url, params, json))
        cmd = json[0]["cmd"]
        if cmd == "Login":
            return _Resp([{"cmd": "Login", "code": 0, "value": {"Token": {"name": "tok123"}}}])
        if cmd == "GetAbility":
            return _Resp(
                [
                    {
                        "cmd": "GetAbility",
                        "code": 0,
                        "value": {
                            "Ability": {
                                "abilityChn": [
                                    {"ptzType": {"ver": 0}},
                                    {"ptzType": {"ver": 3}},
                                    {"ptzType": {"ver": 0}},
                                ]
                            }
                        },
                    }
                ]
            )
        return _Resp([{"cmd": cmd, "code": 0, "value": {}}])


async def test_cmd_query_param_is_sent() -> None:
    """Regression: the CGI routes on ?cmd=<Cmd>; without it the NVR rejects Login."""
    session = FakeSession()
    client = ReolinkHttpClient("198.51.100.10", "admin", "pw", session=session)
    await client.login()
    await client.send([{"cmd": "GetPtzPreset", "action": 0, "param": {"channel": 3}}])
    await client.close()

    url, params, body = session.posts[0]
    assert url == "http://198.51.100.10:80/api.cgi"
    # Login: cmd only, never a token, password only in the JSON body.
    assert params == {"cmd": "Login"}
    assert body[0]["cmd"] == "Login"
    assert all("pw" not in v for v in params.values())

    _, params, body = session.posts[1]
    assert params == {"cmd": "GetPtzPreset", "token": "tok123"}
    assert body[0]["cmd"] == "GetPtzPreset"

    _, params, _ = session.posts[2]
    assert params == {"cmd": "Logout", "token": "tok123"}


async def test_relogin_sends_login_without_stale_token() -> None:
    session = FakeSession()
    client = ReolinkHttpClient("198.51.100.10", "admin", "pw", session=session)
    await client.login()
    await client.login()
    assert session.posts[1][1] == {"cmd": "Login"}


async def test_set_guard_payload() -> None:
    session = FakeSession()
    client = ReolinkHttpClient("198.51.100.10", "admin", "pw", session=session)
    await client.login()
    await client.set_guard(3)
    _url, params, body = session.posts[1]
    assert params == {"cmd": "SetPtzGuard", "token": "tok123"}
    assert body == [
        {
            "cmd": "SetPtzGuard",
            "action": 0,
            "param": {
                "PtzGuard": {
                    "channel": 3,
                    "cmdStr": "setPos",
                    "benable": 1,
                    "bSaveCurrentPos": 1,
                }
            },
        }
    ]
    await client.close()


async def test_set_guard_keeps_auto_return_off() -> None:
    session = FakeSession()
    client = ReolinkHttpClient("198.51.100.10", "admin", "pw", session=session)
    await client.login()
    await client.set_guard(2, enable=False)
    guard = session.posts[1][2][0]["param"]["PtzGuard"]
    assert guard["benable"] == 0
    assert guard["bSaveCurrentPos"] == 1
    await client.close()


async def test_ptz_channels_from_ability() -> None:
    session = FakeSession()
    client = ReolinkHttpClient("198.51.100.10", "admin", "pw", session=session)
    assert await client.ptz_channels() == [1]
    assert session.posts[-1][1]["cmd"] == "GetAbility"
