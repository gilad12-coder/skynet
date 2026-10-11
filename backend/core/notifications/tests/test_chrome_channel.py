"""Tests for the Chrome (Web Push) notification channel."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from pydantic import SecretStr
from pywebpush import WebPushException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

import core.notifications.channels as channels_module
from core.notifications.channels import ChromeChannel, Delivery, push_payload
from core.notifications.preferences import configure_notification_preferences

from ...storage.models import Base, PushSubscriptionModel

_USER = "alice@example.com"


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


@pytest.fixture
def vapid(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure a VAPID key pair on the settings the channel reads.

    Args:
        monkeypatch: pytest's ``MonkeyPatch`` fixture.
    """
    monkeypatch.setattr(channels_module.settings, "vapid_public_key", "public-key")
    monkeypatch.setattr(channels_module.settings, "vapid_private_key", SecretStr("private-key"))
    monkeypatch.setattr(channels_module.settings, "vapid_subject", "mailto:ops@example.com")


class _FakePush:
    """Stand-in for ``pywebpush.webpush`` answering per endpoint."""

    def __init__(self, statuses: dict[str, int] | None = None) -> None:
        """Bind the failing endpoints.

        Args:
            statuses: Endpoint -> HTTP status the push service answers with;
                endpoints left out succeed.
        """
        self.statuses = statuses or {}
        self.calls: list[dict] = []

    def __call__(self, **kwargs) -> None:
        """Record the push, or raise like pywebpush for a failing endpoint.

        Args:
            **kwargs: The ``webpush`` keyword arguments.

        Raises:
            WebPushException: For an endpoint mapped to a status.
        """
        self.calls.append(kwargs)
        status = self.statuses.get(kwargs["subscription_info"]["endpoint"])
        if status is not None:
            raise WebPushException("push failed", response=SimpleNamespace(status_code=status, text=""))


def _subscribe(engine, endpoint: str, user: str = _USER) -> None:
    """Store one subscription.

    Args:
        engine: Database engine.
        endpoint: Push service URL.
        user: Owner.
    """
    with Session(engine) as session:
        session.add(PushSubscriptionModel(username=user, endpoint=endpoint, p256dh="key", auth="secret"))
        session.commit()


def _endpoints(engine) -> list[str]:
    """Return the stored endpoints.

    Args:
        engine: Database engine.

    Returns:
        Every saved endpoint, sorted.
    """
    with Session(engine) as session:
        return sorted(session.scalars(select(PushSubscriptionModel.endpoint)))


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
    }
    fields.update(over)
    return Delivery(**fields)


def test_sends_to_every_subscription(monkeypatch: pytest.MonkeyPatch, engine, vapid) -> None:
    """Each of the user's browsers gets the payload, signed with the configured key."""
    _subscribe(engine, "https://push.example/a")
    _subscribe(engine, "https://push.example/b")
    _subscribe(engine, "https://push.example/other", user="bob@example.com")
    fake = _FakePush()
    monkeypatch.setattr(channels_module, "webpush", fake)

    assert ChromeChannel().send(_delivery()) == "sent"

    assert sorted(call["subscription_info"]["endpoint"] for call in fake.calls) == [
        "https://push.example/a",
        "https://push.example/b",
    ]
    call = fake.calls[0]
    assert call["vapid_private_key"] == "private-key"
    assert call["vapid_claims"] == {"sub": "mailto:ops@example.com"}
    payload = json.loads(call["data"])
    assert set(payload) == {"title", "body", "url", "tag"}
    assert "Bot" in payload["title"]
    assert payload["url"] == "/optimizations/run1"
    assert payload["tag"] == "finished:run1"
    with Session(engine) as session:
        used = session.scalars(
            select(PushSubscriptionModel.last_used_at).where(PushSubscriptionModel.username == _USER)
        )
        assert all(value is not None for value in used)


def test_gone_subscriptions_are_deleted(monkeypatch: pytest.MonkeyPatch, engine, vapid) -> None:
    """A 404 or 410 drops that subscription; the others still get the push."""
    _subscribe(engine, "https://push.example/gone")
    _subscribe(engine, "https://push.example/expired")
    _subscribe(engine, "https://push.example/live")
    monkeypatch.setattr(
        channels_module,
        "webpush",
        _FakePush({"https://push.example/gone": 410, "https://push.example/expired": 404}),
    )

    assert ChromeChannel().send(_delivery()) == "sent"
    assert _endpoints(engine) == ["https://push.example/live"]


def test_only_gone_subscriptions_is_unavailable(monkeypatch: pytest.MonkeyPatch, engine, vapid) -> None:
    """When every browser has unsubscribed the user has no destination left."""
    _subscribe(engine, "https://push.example/gone")
    monkeypatch.setattr(channels_module, "webpush", _FakePush({"https://push.example/gone": 410}))

    assert ChromeChannel().send(_delivery()) == "unavailable"
    assert _endpoints(engine) == []


def test_other_errors_fail_and_keep_the_subscription(monkeypatch: pytest.MonkeyPatch, engine, vapid) -> None:
    """A transient push-service error is ``failed`` and the subscription stays."""
    _subscribe(engine, "https://push.example/busy")
    monkeypatch.setattr(channels_module, "webpush", _FakePush({"https://push.example/busy": 503}))

    assert ChromeChannel().send(_delivery()) == "failed"
    assert _endpoints(engine) == ["https://push.example/busy"]


def test_no_subscription_is_unavailable(monkeypatch: pytest.MonkeyPatch, engine, vapid) -> None:
    """A user who never subscribed a browser is ``unavailable`` and nothing is pushed."""
    fake = _FakePush()
    monkeypatch.setattr(channels_module, "webpush", fake)

    assert ChromeChannel().send(_delivery()) == "unavailable"
    assert fake.calls == []


def test_unconfigured_vapid_is_unavailable(monkeypatch: pytest.MonkeyPatch, engine) -> None:
    """Without VAPID keys web push is off, even for a subscribed user."""
    _subscribe(engine, "https://push.example/a")
    monkeypatch.setattr(channels_module.settings, "vapid_public_key", None)
    monkeypatch.setattr(channels_module.settings, "vapid_private_key", None)
    fake = _FakePush()
    monkeypatch.setattr(channels_module, "webpush", fake)

    assert ChromeChannel().send(_delivery()) == "unavailable"
    assert fake.calls == []


def test_payload_falls_back_to_the_title_and_carries_the_detail() -> None:
    """An event without an email headline uses its title; the detail is the body."""
    payload = push_payload(
        _delivery(event_type="product_news", optimization_id=None, title="News", link=None, facts={"detail": "Hi"})
    )

    assert payload == {"title": "News", "body": "Hi", "url": "/", "tag": "product_news:n1"}
