"""Verify persisted registry defaults, validation, and account isolation."""

from __future__ import annotations

import runpy
from pathlib import Path
from types import SimpleNamespace

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...storage.models import Base, PackageRegistryPreferenceModel
from ..account_data_service import delete_account, export_account
from ..auth import AuthenticatedUser, get_authenticated_user
from ..routers.package_registry import DEFAULT_PACKAGE_INDEX, create_package_registry_router


def _client() -> tuple[TestClient, object, FastAPI]:
    """Create isolated registry routes with an authenticated OAuth identity.

    Returns:
        Test client, database engine, and app for swapping authenticated owners.
    """
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    app = FastAPI()
    app.include_router(create_package_registry_router(job_store=SimpleNamespace(engine=engine)))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(
        username="first@example.com", role="user", groups=()
    )
    return TestClient(app), engine, app


def test_default_save_reload_reset_and_account_isolation() -> None:
    """Persist one account's choice without affecting another account or requiring a password row."""
    client, engine, app = _client()
    path = "/account/package-registry"
    assert client.get(path).json() == {"index_url": DEFAULT_PACKAGE_INDEX}
    with Session(engine) as session:
        assert session.get(PackageRegistryPreferenceModel, "first@example.com") is None
    response = client.put(path, json={"index_url": " https://Packages.Example.com/team/simple/ "})
    assert response.status_code == 200
    assert response.json() == {"index_url": "https://packages.example.com/team/simple"}
    assert client.get(path).json() == response.json()
    assert client.put(path, json={"index_url": ""}).json() == {"index_url": DEFAULT_PACKAGE_INDEX}
    assert client.get(path).json() == {"index_url": DEFAULT_PACKAGE_INDEX}
    client.put(path, json=response.json())
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(
        username="second@example.com", role="user", groups=()
    )
    assert client.get(path).json() == {"index_url": DEFAULT_PACKAGE_INDEX}
    assert client.put(path, json={"index_url": ""}).json() == {"index_url": DEFAULT_PACKAGE_INDEX}
    with Session(engine) as session:
        assert (
            session.get(PackageRegistryPreferenceModel, "first@example.com").index_url == response.json()["index_url"]
        )


@pytest.mark.parametrize(
    "url",
    [
        "http://packages.example.com/simple",
        "file:///tmp/wheels",
        "not a url",
        "https://user:secret@packages.example.com/simple",
        "https://packages.example.com/simple?token=secret",
        "https://packages.example.com/simple#fragment",
        "https://packages.example.com:bad/simple",
        "https://packages.example.com/with space",
        "https://packages.example.com\\@elsewhere.invalid",
    ],
)
def test_invalid_index_is_not_saved(url: str) -> None:
    """Reject malformed URLs and credential-bearing settings.

    Args:
        url: Invalid index URL supplied by the user.
    """
    client, engine, _app = _client()
    assert client.put("/account/package-registry", json={"index_url": url}).status_code == 422
    with Session(engine) as session:
        assert session.get(PackageRegistryPreferenceModel, "first@example.com") is None


def test_registry_requires_authentication() -> None:
    """Deny unauthenticated reads and writes."""
    client, _engine, app = _client()
    app.dependency_overrides.clear()
    assert client.get("/account/package-registry").status_code == 401
    assert client.put("/account/package-registry", json={"index_url": DEFAULT_PACKAGE_INDEX}).status_code == 401


def test_account_export_and_delete_include_only_owned_registry() -> None:
    """Export and delete the owner's preference while preserving another account."""
    _test_client, engine, _app = _client()
    with Session(engine) as session:
        session.add_all(
            [
                PackageRegistryPreferenceModel(username="first@example.com", index_url="https://first.example/simple"),
                PackageRegistryPreferenceModel(
                    username="second@example.com", index_url="https://second.example/simple"
                ),
            ]
        )
        session.commit()
        assert export_account(session, "first@example.com")["package_registry"] == {
            "index_url": "https://first.example/simple"
        }
        delete_account(session, "first@example.com")
        session.commit()
        assert session.get(PackageRegistryPreferenceModel, "first@example.com") is None
        assert (
            session.get(PackageRegistryPreferenceModel, "second@example.com").index_url
            == "https://second.example/simple"
        )


def test_migration_accepts_startup_created_table() -> None:
    """Allow both standalone migration and startup's create-all-before-migrate path."""
    migration = runpy.run_path(
        str(Path(__file__).resolve().parents[3] / "alembic/versions/b95ea4618c02_package_registry_preferences.py")
    )
    engine = create_engine("sqlite://")
    with engine.begin() as connection, Operations.context(MigrationContext.configure(connection)):
        migration["upgrade"]()
        migration["upgrade"]()
        assert inspect(connection).has_table("package_registry_preferences")
