"""Tests for the Slack connection endpoints of the notifications router."""

from __future__ import annotations

import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...config import settings
from ...notifications import slack
from ...storage.models import Base, SlackConnectionModel
from ..auth import AuthenticatedUser, get_authenticated_user
from ..routers import notifications as notifications_router
from ..routers.notifications import create_notifications_router

_USER = "oauth-user@example.com"
_APP = "https://app.example.com"


class FakeSlack:
    """An ``httpx`` transport answering Web API methods from a table."""

    def __init__(self, answers: dict[str, dict]) -> None:
        """Bind the canned answers.

        Args:
            answers: Method -> JSON answer.
        """
        self.answers = answers
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the call and answer it.

        Args:
            request: The outgoing request.

        Returns:
            The canned answer.
        """
        method = request.url.path.rsplit("/", 1)[-1]
        if request.method == "GET":
            body = dict(request.url.params)
        elif request.headers.get("content-type", "").startswith("application/json"):
            body = json.loads(request.content or b"{}")
        else:
            body = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
        self.calls.append((method, body))
        return httpx.Response(200, json=self.answers.get(method, {"ok": False, "error": "unknown_method"}))


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Build an authenticated client with Slack configured and Slack's API faked.

    Args:
        monkeypatch: pytest's ``MonkeyPatch`` fixture.

    Returns:
        ``client``, ``engine`` and ``slack(answers)`` to set Slack's answers.
    """
    monkeypatch.setattr(notifications_router, "ensure_news", lambda session, username: None)
    monkeypatch.setattr(settings, "slack_client_id", "123.456")
    monkeypatch.setattr(settings, "slack_client_secret", SecretStr("shh"))
    monkeypatch.setattr(settings, "slack_redirect_url", None)
    monkeypatch.setattr(settings, "byok_vault_key", SecretStr(Fernet.generate_key().decode()))
    monkeypatch.setattr(settings, "app_public_url", _APP)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    app = FastAPI()
    app.include_router(create_notifications_router(job_store=SimpleNamespace(engine=engine)))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(username=_USER, role="user", groups=())

    def answers(table: dict[str, dict]) -> FakeSlack:
        """Fake Slack with ``table``.

        Args:
            table: Method -> answer.

        Returns:
            The fake.
        """
        fake = FakeSlack(table)
        monkeypatch.setattr(slack, "_TRANSPORT", httpx.MockTransport(fake))
        return fake

    return SimpleNamespace(client=TestClient(app), engine=engine, slack=answers)


def _connect(engine, **over) -> None:
    """Store a working connection for ``_USER``.

    Args:
        engine: Database engine.
        **over: Column overrides.
    """
    fields = {
        "username": _USER,
        "team_id": "T1",
        "team_name": "Acme",
        "bot_user_id": "B1",
        "slack_user_id": "U1",
        "bot_token_encrypted": slack.encrypt_token("xoxb-old"),
    }
    fields.update(over)
    with Session(engine) as session:
        session.add(SlackConnectionModel(**fields))
        session.commit()


def _row(engine) -> SlackConnectionModel | None:
    """Load ``_USER``'s connection.

    Args:
        engine: Database engine.

    Returns:
        The row, detached, or ``None``.
    """
    with Session(engine, expire_on_commit=False) as session:
        return session.get(SlackConnectionModel, _USER)


def _state(harness: SimpleNamespace) -> str:
    """Start the flow and return the state Slack would echo back.

    Args:
        harness: The test harness.

    Returns:
        The state parameter.
    """
    url = harness.client.post("/notifications/slack/oauth/start").json()["authorize_url"]
    return parse_qs(urlparse(url).query)["state"][0]


_INSTALL = {
    "ok": True,
    "token_type": "bot",
    "access_token": "xoxb-new",
    "bot_user_id": "B9",
    "team": {"id": "T9", "name": "Acme"},
    "authed_user": {"id": "U9"},
}


def test_status_reports_unconfigured_server(harness: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    """Without the Slack app env the status says so and start refuses with 503."""
    monkeypatch.setattr(settings, "slack_client_id", None)

    assert harness.client.get("/notifications/slack").json()["configured"] is False
    response = harness.client.post("/notifications/slack/oauth/start")
    assert response.status_code == 503


def test_start_derives_the_callback_from_the_route(harness: SimpleNamespace) -> None:
    """The redirect URI is this router's callback when SLACK_REDIRECT_URL is unset."""
    url = harness.client.post("/notifications/slack/oauth/start").json()["authorize_url"]

    assert parse_qs(urlparse(url).query)["redirect_uri"] == ["http://testserver/notifications/slack/oauth/callback"]


def test_callback_stores_the_install_encrypted_and_redirects(harness: SimpleNamespace) -> None:
    """A good code is exchanged, the token stored encrypted, and the browser sent back."""
    fake = harness.slack({"oauth.v2.access": _INSTALL})
    state = _state(harness)

    response = harness.client.get(
        "/notifications/slack/oauth/callback", params={"code": "c", "state": state}, follow_redirects=False
    )

    assert response.status_code == 303
    assert response.headers["location"] == f"{_APP}/?settings=notifications&slack=connected"
    assert fake.calls[0][1]["redirect_uri"] == "http://testserver/notifications/slack/oauth/callback"
    row = _row(harness.engine)
    assert (row.team_id, row.slack_user_id, row.bot_user_id, row.status) == ("T9", "U9", "B9", "connected")
    assert "xoxb" not in row.bot_token_encrypted
    assert slack.decrypt_token(row.bot_token_encrypted) == "xoxb-new"
    status = harness.client.get("/notifications/slack").json()
    assert (status["connected"], status["team_name"], status["target"]) == (True, "Acme", "dm")


def test_reconnect_repairs_a_broken_connection(harness: SimpleNamespace) -> None:
    """Installing again into the same workspace keeps the channel and clears the broken state."""
    _connect(harness.engine, team_id="T9", channel_id="C1", channel_name="runs", status="broken", broken_reason="x")
    harness.slack({"oauth.v2.access": _INSTALL})

    harness.client.get("/notifications/slack/oauth/callback", params={"code": "c", "state": _state(harness)})

    row = _row(harness.engine)
    assert (row.status, row.broken_reason, row.channel_id) == ("connected", None, "C1")


@pytest.mark.parametrize(
    "params",
    [
        {"error": "access_denied"},
        {"code": "c"},
        {"code": "c", "state": "forged"},
    ],
)
def test_callback_rejects_cancelled_or_forged_flows(harness: SimpleNamespace, params: dict) -> None:
    """A cancelled install or a bad state stores nothing and reports slack=error."""
    fake = harness.slack({"oauth.v2.access": _INSTALL})

    response = harness.client.get("/notifications/slack/oauth/callback", params=params, follow_redirects=False)

    assert response.headers["location"].endswith("slack=error")
    assert fake.calls == []
    assert _row(harness.engine) is None


def test_callback_reports_a_refused_code(harness: SimpleNamespace) -> None:
    """Slack refusing the code reports slack=error."""
    harness.slack({"oauth.v2.access": {"ok": False, "error": "invalid_code"}})

    response = harness.client.get(
        "/notifications/slack/oauth/callback", params={"code": "c", "state": _state(harness)}, follow_redirects=False
    )

    assert response.headers["location"].endswith("slack=error")
    assert _row(harness.engine) is None


def test_channels_lists_what_the_app_sees(harness: SimpleNamespace) -> None:
    """Channels come back sorted with membership."""
    _connect(harness.engine)
    harness.slack(
        {
            "conversations.list": {
                "ok": True,
                "channels": [
                    {"id": "C2", "name": "runs", "is_member": True},
                    {"id": "C1", "name": "alerts", "is_private": True, "is_member": True},
                ],
            }
        }
    )

    body = harness.client.get("/notifications/slack/channels").json()

    assert [c["name"] for c in body["channels"]] == ["alerts", "runs"]
    assert body["truncated"] is False


def test_channels_without_a_connection_is_404(harness: SimpleNamespace) -> None:
    """Listing channels needs an install."""
    assert harness.client.get("/notifications/slack/channels").status_code == 404


def test_target_channel_requires_the_app_in_it(harness: SimpleNamespace) -> None:
    """A channel the app was not invited to is refused with the /invite hint."""
    _connect(harness.engine)
    harness.slack({"conversations.info": {"ok": True, "channel": {"id": "C1", "name": "secret", "is_member": False}}})

    response = harness.client.patch("/notifications/slack", json={"channel_id": "C1"})

    assert response.status_code == 409
    assert "/invite" in response.json()["detail"]
    assert _row(harness.engine).channel_id is None


def test_target_channel_and_back_to_dm(harness: SimpleNamespace) -> None:
    """Picking a channel the app is in saves it and clears a target-caused break; null goes back to DM."""
    _connect(harness.engine, status="broken", broken_reason="not_in_channel")
    harness.slack(
        {
            "conversations.info": {"ok": True, "channel": {"id": "C1", "name": "runs", "is_member": True}},
            "conversations.open": {"ok": True, "channel": {"id": "D1"}},
        }
    )

    chosen = harness.client.patch("/notifications/slack", json={"channel_id": "C1"}).json()
    assert (chosen["target"], chosen["channel_name"], chosen["status"]) == ("channel", "runs", "connected")

    back = harness.client.patch("/notifications/slack", json={"channel_id": None}).json()
    assert (back["target"], back["channel_id"]) == ("dm", None)
    assert _row(harness.engine).dm_channel_id == "D1"


def test_target_on_a_revoked_token_breaks_the_connection(harness: SimpleNamespace) -> None:
    """A dead token surfaces as reconnect and is remembered as broken."""
    _connect(harness.engine)
    harness.slack({"conversations.info": {"ok": False, "error": "token_revoked"}})

    response = harness.client.patch("/notifications/slack", json={"channel_id": "C1"})

    assert response.status_code == 409
    status = harness.client.get("/notifications/slack").json()
    assert (status["status"], status["broken_reason"]) == ("broken", "token_revoked")


def test_disconnect_revokes_and_forgets(harness: SimpleNamespace) -> None:
    """Disconnect revokes the token, deletes the row, and is harmless to repeat."""
    _connect(harness.engine)
    fake = harness.slack({"auth.revoke": {"ok": True, "revoked": True}})

    assert harness.client.delete("/notifications/slack").json()["connected"] is False
    assert [method for method, _ in fake.calls] == ["auth.revoke"]
    assert _row(harness.engine) is None
    assert harness.client.delete("/notifications/slack").status_code == 200


def test_disconnect_survives_slack_failing(harness: SimpleNamespace) -> None:
    """A revoke Slack refuses still deletes the row."""
    _connect(harness.engine)
    harness.slack({"auth.revoke": {"ok": False, "error": "invalid_auth"}})

    harness.client.delete("/notifications/slack")

    assert _row(harness.engine) is None
