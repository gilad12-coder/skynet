"""Tests for caller-scoped notification routing preference endpoints."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...notifications.catalog import DEFAULT_GRID
from ...storage.models import Base, NotificationPreferenceModel
from ..auth import AuthenticatedUser, get_authenticated_user
from ..routers.notification_preferences import create_notification_preferences_router

_USER = "oauth-user@example.com"
_DEFAULTS = {
    "grid": DEFAULT_GRID,
    "hold_minutes": 10,
    "held_channels": ["email"],
    "stuck_fraction": 0.25,
    "budget_alert_fraction": 0.8,
}


def _harness() -> tuple[TestClient, object]:
    """Build an authenticated preference client over an in-memory database.

    Returns:
        Client and shared SQLAlchemy engine.
    """
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    app = FastAPI()
    app.include_router(create_notification_preferences_router(job_store=SimpleNamespace(engine=engine)))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(
        username=_USER,
        role="user",
        groups=(),
    )
    return TestClient(app), engine


def test_missing_row_returns_defaults_without_creating_data() -> None:
    """A new identity gets the default grid without a row being written."""
    client, engine = _harness()

    response = client.get("/account/notification-preferences")

    assert response.status_code == 200
    assert response.json() == _DEFAULTS
    with Session(engine) as session:
        assert session.get(NotificationPreferenceModel, _USER) is None


def test_patch_merges_grid_cells_and_hold_settings() -> None:
    """Changed cells persist, untouched cells keep their defaults."""
    client, engine = _harness()

    response = client.patch(
        "/account/notification-preferences",
        json={
            "grid": {"finished": {"email": False}, "stuck": {"slack": True}},
            "hold_minutes": 3,
            "held_channels": ["slack", "email"],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["grid"]["finished"] == {"inbox": True, "email": False, "chrome": False, "slack": False}
    assert body["grid"]["stuck"]["slack"] is True
    assert body["grid"]["failed"] == DEFAULT_GRID["failed"]
    assert (body["hold_minutes"], body["held_channels"]) == (3, ["email", "slack"])
    assert client.get("/account/notification-preferences").json() == body

    second = client.patch("/account/notification-preferences", json={"grid": {"failed": {"email": False}}})
    assert second.json()["grid"]["finished"]["email"] is False
    assert second.json()["grid"]["failed"]["email"] is False
    with Session(engine) as session:
        assert session.get(NotificationPreferenceModel, _USER).hold_minutes == 3


def test_patch_cannot_route_product_news_outside_the_inbox() -> None:
    """Product news stays inbox-only whatever the patch says."""
    client, _ = _harness()

    response = client.patch("/account/notification-preferences", json={"grid": {"product_news": {"email": True}}})

    assert response.json()["grid"]["product_news"] == DEFAULT_GRID["product_news"]


@pytest.mark.parametrize(
    "body",
    [
        {"grid": {"mystery": {"email": True}}},
        {"grid": {"finished": {"fax": True}}},
        {"held_channels": ["inbox"]},
        {"hold_minutes": -1},
        {"hold_minutes": 1441},
        {"stuck_fraction": 0.01},
        {"budget_alert_fraction": 0.05},
    ],
)
def test_patch_rejects_unknown_or_out_of_range_values(body: dict) -> None:
    """Unknown events, channels and out-of-range limits fail validation without writing."""
    client, engine = _harness()

    response = client.patch("/account/notification-preferences", json=body)

    assert response.status_code == 422
    with Session(engine) as session:
        assert session.get(NotificationPreferenceModel, _USER) is None
