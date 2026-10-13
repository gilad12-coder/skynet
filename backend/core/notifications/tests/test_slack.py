"""Tests for the Slack app helpers and the Slack notification channel."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...api.errors import DomainError
from ...config import settings
from ...connectors.vault import vault_cipher
from ...storage.models import Base, SlackConnectionModel
from .. import email_render, slack
from ..channels import Delivery, SlackChannel
from ..preferences import configure_notification_preferences

_USER = "alice@example.com"
_REDIRECT = "https://api.example.com/notifications/slack/oauth/callback"

Handler = Callable[[str, dict], dict]


class FakeSlack:
    """An ``httpx`` transport answering Web API methods from a handler table."""

    def __init__(self, answers: dict[str, dict | list[dict]]) -> None:
        """Bind the canned answers.

        Args:
            answers: Method -> JSON answer, or a list consumed one per call.
        """
        self.answers = answers
        self.calls: list[tuple[str, dict, httpx.Request]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the call and answer it.

        Args:
            request: The outgoing request.

        Returns:
            Slack's canned JSON answer.
        """
        method = request.url.path.rsplit("/", 1)[-1]
        if request.method == "GET":
            body = dict(request.url.params)
        elif request.headers.get("content-type", "").startswith("application/json"):
            body = json.loads(request.content or b"{}")
        else:
            body = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
        self.calls.append((method, body, request))
        answer = self.answers.get(method, {"ok": False, "error": "unknown_method"})
        if isinstance(answer, list):
            answer = answer.pop(0)
        return httpx.Response(200, json=answer)

    def methods(self) -> list[str]:
        """Return the called method names in order."""
        return [method for method, _, _ in self.calls]


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure the Slack app and the vault key.

    Args:
        monkeypatch: pytest's ``MonkeyPatch`` fixture.
    """
    monkeypatch.setattr(settings, "slack_client_id", "123.456")
    monkeypatch.setattr(settings, "slack_client_secret", SecretStr("shh"))
    monkeypatch.setattr(settings, "byok_vault_key", SecretStr(Fernet.generate_key().decode()))


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> Callable[[dict], FakeSlack]:
    """Return a factory that routes Slack calls to a :class:`FakeSlack`.

    Args:
        monkeypatch: pytest's ``MonkeyPatch`` fixture.

    Returns:
        ``answers -> FakeSlack``.
    """

    def install(answers: dict) -> FakeSlack:
        """Swap in the fake transport.

        Args:
            answers: Method -> canned answer.

        Returns:
            The fake.
        """
        fake_slack = FakeSlack(answers)
        monkeypatch.setattr(slack, "_TRANSPORT", httpx.MockTransport(fake_slack))
        return fake_slack

    return install


@pytest.fixture
def engine():
    """Return an in-memory engine wired as the notification store.

    Returns:
        The engine.
    """
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    configure_notification_preferences(engine)
    return engine


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
        "bot_token_encrypted": slack.encrypt_token("xoxb-secret"),
    }
    fields.update(over)
    with Session(engine) as session:
        session.add(SlackConnectionModel(**fields))
        session.commit()


def _row(engine) -> SlackConnectionModel:
    """Load ``_USER``'s connection.

    Args:
        engine: Database engine.

    Returns:
        The row, detached.
    """
    with Session(engine, expire_on_commit=False) as session:
        return session.get(SlackConnectionModel, _USER)


def _delivery(**over) -> Delivery:
    """Build a finished-run delivery.

    Args:
        **over: Field overrides.

    Returns:
        The delivery.
    """
    fields = {
        "notification_id": "n1",
        "username": _USER,
        "event_type": "finished",
        "optimization_id": "run1",
        "title": "Bot",
        "link": "/optimizations/run1",
        "facts": {"score": 0.91, "delta": 0.12, "spent": 1.5, "duration": 125},
    }
    fields.update(over)
    return Delivery(**fields)


def test_authorize_url_carries_scopes_and_a_state_bound_to_the_user(configured) -> None:
    """The URL asks for the bot scopes, and its state decrypts to the caller."""
    url = urlparse(slack.build_authorize_url(_USER, _REDIRECT))
    query = {key: values[0] for key, values in parse_qs(url.query).items()}

    assert f"{url.scheme}://{url.netloc}{url.path}" == slack.AUTHORIZE_URL
    assert query["client_id"] == "123.456"
    assert query["scope"] == "chat:write,im:write,channels:read,groups:read"
    assert query["redirect_uri"] == _REDIRECT
    payload = slack.parse_state(query["state"])
    assert (payload["u"], payload["r"]) == (_USER, _REDIRECT)


def test_state_rejects_forged_tampered_foreign_and_expired_values(configured) -> None:
    """Only a fresh, untampered Slack state minted by this server is accepted."""
    good = parse_qs(urlparse(slack.build_authorize_url(_USER, _REDIRECT)).query)["state"][0]
    foreign = vault_cipher().encrypt(json.dumps({"p": "hf", "u": _USER, "r": _REDIRECT}).encode()).decode()
    expired = (
        vault_cipher()
        .encrypt_at_time(
            json.dumps({"p": "slack", "u": _USER, "r": _REDIRECT, "n": "x"}).encode(),
            int(time.time()) - slack.STATE_TTL_SECONDS - 5,
        )
        .decode()
    )
    other_key = Fernet(Fernet.generate_key()).encrypt(b'{"p":"slack","u":"x","r":"y"}').decode()

    for bad in ("not-a-token", good[:-4] + "AAAA", foreign, expired, other_key):
        with pytest.raises(DomainError) as caught:
            slack.parse_state(bad)
        assert (caught.value.status_code, caught.value.code) == (400, "notifications.slack_state_invalid")


def test_token_encryption_round_trip(configured) -> None:
    """A stored token is unreadable as text and decrypts back exactly."""
    stored = slack.encrypt_token("xoxb-123-abc")

    assert "xoxb" not in stored
    assert slack.decrypt_token(stored) == "xoxb-123-abc"


def test_exchange_code_reads_the_bot_install(configured, fake) -> None:
    """oauth.v2.access is called with client credentials and its answer is unpacked."""
    fake_slack = fake(
        {
            "oauth.v2.access": {
                "ok": True,
                "token_type": "bot",
                "access_token": "xoxb-new",
                "bot_user_id": "B9",
                "team": {"id": "T9", "name": "Acme"},
                "authed_user": {"id": "U9"},
            }
        }
    )

    install = slack.exchange_code("the-code", _REDIRECT)

    assert install == slack.SlackInstall("T9", "Acme", "B9", "U9", "xoxb-new")
    _, body, request = fake_slack.calls[0]
    assert body == {"code": "the-code", "redirect_uri": _REDIRECT}
    assert request.headers["authorization"].startswith("Basic ")


def test_exchange_code_surfaces_slack_refusals(configured, fake) -> None:
    """A refused code raises with Slack's error code."""
    fake({"oauth.v2.access": {"ok": False, "error": "invalid_code"}})

    with pytest.raises(slack.SlackApiError) as caught:
        slack.exchange_code("bad", _REDIRECT)
    assert caught.value.code == "invalid_code"


def test_list_channels_pages_and_sorts(configured, fake) -> None:
    """Pages are followed by cursor and merged sorted by name."""
    fake_slack = fake(
        {
            "conversations.list": [
                {
                    "ok": True,
                    "channels": [{"id": "C2", "name": "zeta", "is_member": True}],
                    "response_metadata": {"next_cursor": "p2"},
                },
                {
                    "ok": True,
                    "channels": [{"id": "C1", "name": "Alpha", "is_private": True}],
                    "response_metadata": {"next_cursor": ""},
                },
            ]
        }
    )

    channels, truncated = slack.list_channels("xoxb")

    assert [channel.name for channel in channels] == ["Alpha", "zeta"]
    assert channels[0].is_private
    assert not channels[0].is_member
    assert truncated is False
    assert fake_slack.calls[1][1]["cursor"] == "p2"


def test_message_blocks_show_the_email_facts_and_a_run_button(configured, monkeypatch) -> None:
    """The layout is a bold headline, the facts as context and a button to the run."""
    monkeypatch.setattr(email_render, "FRONTEND_URL", "https://app.example.com")

    text, blocks = slack.message_blocks(
        "finished", "<Bot>", {"score": 0.91, "delta": 0.12, "spent": 1.5, "duration": 125}, "/optimizations/run1"
    )

    assert "Bot" in text
    assert blocks[0]["text"]["text"].startswith("*")
    assert "&lt;Bot&gt;" in blocks[0]["text"]["text"]
    context = blocks[1]["elements"][0]["text"]
    assert "$1.50" in context
    assert blocks[2]["elements"][0]["url"] == "https://app.example.com/optimizations/run1"


def test_send_opens_and_caches_the_dm(configured, fake, engine) -> None:
    """With no channel chosen the app DMs the installer, opening the DM only once."""
    _connect(engine)
    fake_slack = fake(
        {
            "conversations.open": {"ok": True, "channel": {"id": "D1"}},
            "chat.postMessage": {"ok": True},
        }
    )

    assert SlackChannel().send(_delivery()) == "sent"
    assert SlackChannel().send(_delivery(notification_id="n2")) == "sent"

    assert fake_slack.methods() == ["conversations.open", "chat.postMessage", "chat.postMessage"]
    assert fake_slack.calls[0][1] == {"users": "U1"}
    post = fake_slack.calls[1]
    assert post[1]["channel"] == "D1"
    assert post[2].headers["authorization"] == "Bearer xoxb-secret"
    assert post[1]["blocks"][-1]["type"] == "actions"
    assert _row(engine).dm_channel_id == "D1"


def test_send_posts_to_the_chosen_channel(configured, fake, engine) -> None:
    """A chosen channel gets the post directly."""
    _connect(engine, channel_id="C7", channel_name="runs")
    fake_slack = fake({"chat.postMessage": {"ok": True}})

    assert SlackChannel().send(_delivery()) == "sent"

    assert fake_slack.methods() == ["chat.postMessage"]
    assert fake_slack.calls[0][1]["channel"] == "C7"


@pytest.mark.parametrize("code", ["not_in_channel", "channel_not_found", "token_revoked", "invalid_auth"])
def test_a_lasting_slack_error_breaks_the_connection_and_stops_sending(configured, fake, engine, code) -> None:
    """After a lasting refusal the connection is broken and later sends don't call Slack."""
    _connect(engine, channel_id="C7", channel_name="runs")
    fake_slack = fake({"chat.postMessage": {"ok": False, "error": code}})

    assert SlackChannel().send(_delivery()) == "failed"
    row = _row(engine)
    assert (row.status, row.broken_reason) == (slack.STATUS_BROKEN, code)

    assert SlackChannel().send(_delivery(notification_id="n2")) == "unavailable"
    assert len(fake_slack.calls) == 1


def test_a_transient_slack_error_keeps_the_connection(configured, fake, engine) -> None:
    """Rate limiting fails the one send but keeps sending later."""
    _connect(engine, channel_id="C7")
    fake({"chat.postMessage": {"ok": False, "error": "ratelimited"}})

    assert SlackChannel().send(_delivery()) == "failed"
    assert _row(engine).status == slack.STATUS_CONNECTED


def test_send_is_unavailable_without_config_or_connection(configured, fake, engine, monkeypatch) -> None:
    """No connection, or no Slack app on the server, means nothing is attempted."""
    fake_slack = fake({})
    assert SlackChannel().send(_delivery()) == "unavailable"

    _connect(engine)
    monkeypatch.setattr(settings, "slack_client_id", None)
    assert SlackChannel().send(_delivery()) == "unavailable"
    assert fake_slack.calls == []


def test_an_unreadable_token_breaks_the_connection(configured, fake, engine) -> None:
    """A token the vault key no longer opens is treated like a revoked one."""
    _connect(engine, bot_token_encrypted="garbage")
    fake({})

    assert SlackChannel().send(_delivery()) == "unavailable"
    assert _row(engine).broken_reason == "invalid_auth"
