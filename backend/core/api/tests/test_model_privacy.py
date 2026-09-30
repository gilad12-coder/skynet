"""Tests for the caller-scoped model data-privacy preference endpoints."""

from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...storage.models import Base, ModelPrivacyPreferenceModel
from ..auth import AuthenticatedUser, get_authenticated_user
from ..routers.model_privacy import create_model_privacy_router

_USER = "oauth-user@example.com"


def _harness() -> tuple[TestClient, object]:
    """Build an authenticated preference client over an in-memory database.

    Returns:
        Client and shared SQLAlchemy engine.
    """
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    app = FastAPI()
    app.include_router(create_model_privacy_router(job_store=SimpleNamespace(engine=engine)))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(username=_USER, role="user", groups=())
    return TestClient(app), engine


def test_new_identity_reads_deny_without_creating_data() -> None:
    """Default to the privacy-preserving setting before the caller chooses one."""
    client, engine = _harness()
    response = client.get("/account/model-privacy")
    assert response.status_code == 200
    assert response.json() == {"data_policy": "deny"}
    with Session(engine) as session:
        assert session.get(ModelPrivacyPreferenceModel, _USER) is None


def test_put_persists_and_rejects_unknown_values() -> None:
    """Store a known setting and refuse anything outside the three OpenRouter modes."""
    client, engine = _harness()
    assert client.put("/account/model-privacy", json={"data_policy": "zdr"}).json() == {"data_policy": "zdr"}
    assert client.get("/account/model-privacy").json() == {"data_policy": "zdr"}
    assert client.put("/account/model-privacy", json={"data_policy": "train"}).status_code == 422
    with Session(engine) as session:
        assert session.get(ModelPrivacyPreferenceModel, _USER).data_policy == "zdr"
