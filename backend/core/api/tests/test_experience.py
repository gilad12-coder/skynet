"""Tests for the caller-scoped abstraction-level and onboarding-intake endpoints."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...storage.models import Base, UserModel
from ..auth import AuthenticatedUser, get_authenticated_user
from ..routers.experience import INTAKE_MAX_BYTES, create_experience_router, normalize_experience_level

_USER = "level-user@example.com"


def _harness(*, with_row: bool = True, level: str | None = None) -> tuple[TestClient, object]:
    """Build an authenticated experience client over an in-memory database.

    Args:
        with_row: Whether the caller already has an account row.
        level: Stored ``experience_level`` for that row.

    Returns:
        Client and shared SQLAlchemy engine.
    """
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    if with_row:
        with Session(engine) as session:
            session.add(UserModel(email=_USER, name="Level", password_hash="x", experience_level=level))
            session.commit()
    app = FastAPI()
    app.include_router(create_experience_router(job_store=SimpleNamespace(engine=engine)))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(
        username=_USER,
        role="user",
        groups=(),
    )
    return TestClient(app), engine


def test_get_returns_empty_profile_for_new_account() -> None:
    """An account that never chose a level or did the intake gets the empty profile."""
    client, _ = _harness()

    response = client.get("/account/experience")

    assert response.status_code == 200
    assert response.json() == {"level": None, "intake_completed": False, "intake": None}


def test_get_without_account_row_does_not_create_one() -> None:
    """A read for an identity without a row returns the empty profile and writes nothing."""
    client, engine = _harness(with_row=False)

    assert client.get("/account/experience").json() == {"level": None, "intake_completed": False, "intake": None}
    with Session(engine) as session:
        assert session.get(UserModel, _USER) is None


def test_get_maps_a_legacy_stored_level() -> None:
    """A row written before the migration still reads in the new vocabulary."""
    client, _ = _harness(level="familiar")

    assert client.get("/account/experience").json()["level"] == "standard"


def test_patch_level_persists_and_leaves_intake_alone() -> None:
    """Setting only the level stores it and keeps the intake untouched."""
    client, engine = _harness()

    response = client.patch("/account/experience", json={"level": "expert"})

    assert response.status_code == 200
    assert response.json() == {"level": "expert", "intake_completed": False, "intake": None}
    with Session(engine) as session:
        row = session.get(UserModel, _USER)
        assert row is not None
        assert row.experience_level == "expert"


def test_intake_completed_stamps_and_clears() -> None:
    """``true`` stamps completion with the answers; ``false`` clears it so the intake reruns."""
    client, engine = _harness()
    answers = {"goal": "classify tickets", "experience": "some"}

    done = client.patch(
        "/account/experience",
        json={"level": "guided", "intake": answers, "intake_completed": True},
    )

    assert done.status_code == 200
    assert done.json() == {"level": "guided", "intake_completed": True, "intake": answers}
    with Session(engine) as session:
        row = session.get(UserModel, _USER)
        assert row is not None
        assert row.intake_completed_at is not None

    rerun = client.patch("/account/experience", json={"intake_completed": False})

    assert rerun.json() == {"level": "guided", "intake_completed": False, "intake": answers}
    with Session(engine) as session:
        row = session.get(UserModel, _USER)
        assert row is not None
        assert row.intake_completed_at is None


def test_patch_creates_a_row_for_an_identity_without_one() -> None:
    """An identity with no mirrored account row can still save its profile."""
    client, engine = _harness(with_row=False)

    response = client.patch("/account/experience", json={"level": "standard", "intake_completed": True})

    assert response.json() == {"level": "standard", "intake_completed": True, "intake": None}
    with Session(engine) as session:
        row = session.get(UserModel, _USER)
        assert row is not None
        assert row.experience_level == "standard"


@pytest.mark.parametrize("level", ["new", "familiar", "wizard", ""])
def test_patch_rejects_unknown_level(level: str) -> None:
    """Only the three abstraction levels are accepted on this endpoint."""
    client, engine = _harness()

    response = client.patch("/account/experience", json={"level": level})

    assert response.status_code == 422
    with Session(engine) as session:
        row = session.get(UserModel, _USER)
        assert row is not None
        assert row.experience_level is None


def test_patch_rejects_oversize_intake() -> None:
    """Intake answers over the size cap fail with 422 and are not stored."""
    client, engine = _harness()

    response = client.patch("/account/experience", json={"intake": {"notes": "x" * INTAKE_MAX_BYTES}})

    assert response.status_code == 422
    with Session(engine) as session:
        row = session.get(UserModel, _USER)
        assert row is not None
        assert row.intake_profile is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("new", "guided"), ("familiar", "standard"), (" expert ", "expert"), ("bogus", None), (None, None)],
)
def test_normalize_experience_level(raw: str | None, expected: str | None) -> None:
    """Legacy values map onto the new vocabulary; unknown ones become NULL."""
    assert normalize_experience_level(raw) == expected
