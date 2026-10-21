"""Tests for the Mac app's notification routes and the local-mode preference grid."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...config import settings
from ...notifications.catalog import DEFAULT_GRID
from ...notifications.dispatch import notify
from ...notifications.preferences import configure_notification_preferences
from ...storage.models import Base, NotificationModel
from ..auth import AuthenticatedUser, get_authenticated_user
from ..routers.local_notifications import create_local_notifications_router
from ..routers.notification_preferences import create_notification_preferences_router

_USER = "local@skynet.local"
_PATHS = (
    ("get", "/local/notifications/channels"),
    ("patch", "/local/notifications/macos"),
    ("post", "/local/notifications/native/claim"),
)


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch):
    """Build a client over both notification routers and an in-memory database.

    Args:
        monkeypatch: pytest's ``MonkeyPatch`` fixture, used to clear the transports.

    Yields:
        ``(client, engine)``. Local mode stays off until a test turns it on.
    """
    for name in ("smtp_host", "vapid_public_key", "vapid_private_key", "slack_client_id"):
        monkeypatch.setattr(settings, name, None)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    configure_notification_preferences(engine)
    store = SimpleNamespace(engine=engine)
    app = FastAPI()
    app.include_router(create_notification_preferences_router(job_store=store))
    app.include_router(create_local_notifications_router(job_store=store))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(username=_USER, role="user", groups=())
    yield TestClient(app), engine
    configure_notification_preferences(None)


@pytest.fixture
def local_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Turn local mode on for one test.

    Args:
        monkeypatch: pytest's ``MonkeyPatch`` fixture.
    """
    monkeypatch.setattr(settings, "local_mode", True)


def test_local_routes_are_404_and_hidden_outside_local_mode(harness) -> None:
    """Hosted deployments answer 404 and keep the routes out of the schema."""
    client, _ = harness
    for method, path in _PATHS:
        assert getattr(client, method)(path, **({"json": {}} if method == "patch" else {})).status_code == 404
    schema_paths = client.app.openapi()["paths"]
    assert not any(path.startswith("/local/") for path in schema_paths)


def test_hosted_preferences_are_unchanged(harness) -> None:
    """Without local mode the preference grid is the hosted grid."""
    client, _ = harness
    assert client.get("/account/notification-preferences").json()["grid"] == DEFAULT_GRID


def test_local_preferences_keep_the_hosted_shape(harness, local_mode: None) -> None:
    """The shared preference API never returns the macOS column, so its contract stays the same."""
    client, _ = harness
    response = client.get("/account/notification-preferences")
    assert response.status_code == 200
    assert response.json()["grid"] == DEFAULT_GRID


def test_channels_report_an_unset_hosted_channel_as_off(harness, local_mode: None) -> None:
    """Without the transports, email, push and Slack stay listed and report off."""
    client, _ = harness
    body = client.get("/local/notifications/channels").json()
    assert body["channels"] == {
        "email": False,
        "chrome": False,
        "slack": False,
        "macos": True,
    }
    assert body["macos"] == {event: row["chrome"] for event, row in DEFAULT_GRID.items()}


def test_channels_report_a_configured_mail_relay_as_available(
    harness, local_mode: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A Mac with its own SMTP relay keeps hosted-style email."""
    monkeypatch.setattr(settings, "smtp_host", "127.0.0.1")
    monkeypatch.setattr(settings, "vapid_public_key", "pub")
    monkeypatch.setattr(settings, "vapid_private_key", SecretStr("priv"))
    client, _ = harness
    channels = client.get("/local/notifications/channels").json()["channels"]
    assert channels["email"] is True
    assert channels["chrome"] is True


def test_patch_macos_cells_saves_and_keeps_news_inbox_only(harness, local_mode: None) -> None:
    """Switching macOS cells saves them; product news cannot leave the inbox."""
    client, _ = harness
    response = client.patch(
        "/local/notifications/macos", json={"grid": {"finished": False, "stuck": True, "product_news": True}}
    )
    assert response.status_code == 200
    macos = response.json()["macos"]
    assert macos["finished"] is False
    assert macos["stuck"] is True
    assert macos["product_news"] is False
    assert client.get("/local/notifications/channels").json()["macos"] == macos
    assert client.get("/account/notification-preferences").json()["grid"]["finished"] == DEFAULT_GRID["finished"]


def test_patch_rejects_an_unknown_event(harness, local_mode: None) -> None:
    """Unknown event names are a validation error."""
    client, _ = harness
    assert client.patch("/local/notifications/macos", json={"grid": {"bogus": True}}).status_code == 422


def test_claim_returns_display_payloads_once(harness, local_mode: None) -> None:
    """The Mac app claims each queued notification once, with display text only."""
    client, engine = harness
    notify(_USER, "finished", "opt-1", {"score": 0.91}, title="Ticket triage")

    first = client.post("/local/notifications/native/claim").json()
    second = client.post("/local/notifications/native/claim").json()

    assert len(first["items"]) == 1
    item = first["items"][0]
    assert set(item) == {"id", "title", "body", "url", "tag"}
    assert item["url"] == "/optimizations/opt-1"
    assert second == {"items": []}
    with Session(engine) as session:
        row = session.get(NotificationModel, item["id"])
        assert row is not None
        assert row.deliveries["macos"]["state"] == "sent"
