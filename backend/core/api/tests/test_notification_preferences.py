"""Tests for caller-scoped email-notification preference endpoints."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...storage.models import Base, NotificationPreferenceModel
from ..auth import AuthenticatedUser, get_authenticated_user
from ..routers.notification_preferences import create_notification_preferences_router

_USER = "oauth-user@example.com"
_CADENCE_DEFAULTS = {
    "cadence": "done",
    "live_mode": "per_stage",
    "live_count": 3,
    "digest_minutes": 60,
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


def test_missing_row_returns_enabled_defaults_without_creating_data() -> None:
    """A new identity starts enabled without requiring a local account row."""
    client, engine = _harness()

    response = client.get("/account/notification-preferences")

    assert response.status_code == 200
    assert response.json() == {
        "job_updates_enabled": True,
        "sharing_updates_enabled": True,
        **_CADENCE_DEFAULTS,
    }
    with Session(engine) as session:
        assert session.get(NotificationPreferenceModel, _USER) is None


def test_patch_persists_one_category_and_preserves_the_other() -> None:
    """A partial update stores the changed switch and keeps defaults intact."""
    client, engine = _harness()

    response = client.patch(
        "/account/notification-preferences",
        json={"job_updates_enabled": False},
    )

    assert response.status_code == 200
    assert response.json() == {
        "job_updates_enabled": False,
        "sharing_updates_enabled": True,
        **_CADENCE_DEFAULTS,
    }
    assert client.get("/account/notification-preferences").json() == response.json()
    with Session(engine) as session:
        row = session.get(NotificationPreferenceModel, _USER)
        assert row is not None
        assert row.job_updates_enabled is False
        assert row.sharing_updates_enabled is True


def test_patch_persists_cadence_settings_and_keeps_unsent_defaults() -> None:
    """Cadence fields round-trip and fields the patch omits keep their defaults."""
    client, engine = _harness()

    response = client.patch(
        "/account/notification-preferences",
        json={"cadence": "live", "live_mode": "per_run_count", "live_count": 5, "stuck_fraction": 0.5},
    )

    assert response.status_code == 200
    assert response.json() == {
        "job_updates_enabled": True,
        "sharing_updates_enabled": True,
        **_CADENCE_DEFAULTS,
        "cadence": "live",
        "live_mode": "per_run_count",
        "live_count": 5,
        "stuck_fraction": 0.5,
    }
    assert client.get("/account/notification-preferences").json() == response.json()
    with Session(engine) as session:
        row = session.get(NotificationPreferenceModel, _USER)
        assert row is not None
        assert (row.cadence, row.live_count, row.digest_minutes) == ("live", 5, 60)


@pytest.mark.parametrize(
    "body",
    [
        {"cadence": "hourly"},
        {"live_mode": "sometimes"},
        {"live_count": 0},
        {"live_count": 21},
        {"digest_minutes": 14},
        {"digest_minutes": 1441},
        {"stuck_fraction": 0.01},
        {"stuck_fraction": 1.5},
        {"budget_alert_fraction": 0.05},
    ],
)
def test_patch_rejects_out_of_range_cadence_settings(body: dict) -> None:
    """Unknown cadence values and out-of-range limits fail validation without writing."""
    client, engine = _harness()

    response = client.patch("/account/notification-preferences", json=body)

    assert response.status_code == 422
    with Session(engine) as session:
        assert session.get(NotificationPreferenceModel, _USER) is None
