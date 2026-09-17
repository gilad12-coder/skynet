"""Verify persisted registry defaults, validation, and account isolation."""

from __future__ import annotations

import runpy
from pathlib import Path
from types import SimpleNamespace

import httpx
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
from ..routers import package_registry
from ..routers.package_registry import DEFAULT_PACKAGE_INDEX, create_package_registry_router, probe_package_index


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


class _FakeResponse:
    """Minimal httpx.Response stand-in the probe reads for its verdict."""

    def __init__(
        self,
        status_code: int,
        *,
        content_type: str = "text/html",
        text: str = "",
        payload: object = None,
        payload_error: bool = False,
    ) -> None:
        self.status_code = status_code
        self.headers = {"content-type": content_type}
        self.text = text
        self._payload = payload
        self._payload_error = payload_error

    def json(self) -> object:
        """Return the parsed body, or raise as httpx does on a non-JSON body."""
        if self._payload_error:
            raise ValueError("no json")
        return self._payload


def _probe_returning(response_or_error: object):
    """Build an ``httpx.get`` replacement that yields one response or raises.

    Args:
        response_or_error: A fake response to return, or an exception to raise.

    Returns:
        A callable matching ``httpx.get``'s signature for monkeypatching.
    """

    def fake_get(url: str, **_kwargs: object) -> _FakeResponse:
        if isinstance(response_or_error, Exception):
            raise response_or_error
        return response_or_error

    return fake_get


@pytest.mark.parametrize(
    ("response_or_error", "ok", "reason", "status_code"),
    [
        (_FakeResponse(200, content_type="application/vnd.pypi.simple.v1+json", payload={"files": []}), True, "healthy", 200),
        (_FakeResponse(200, text="<html><body><a href='pip-1.whl'>pip</a></body></html>"), True, "healthy", 200),
        (_FakeResponse(403), False, "auth_required", 403),
        (_FakeResponse(401), False, "auth_required", 401),
        (_FakeResponse(404), False, "not_an_index", 404),
        (_FakeResponse(200, text="<html><body>Welcome</body></html>"), False, "not_an_index", 200),
        (_FakeResponse(200, content_type="application/json", payload={"detail": "nope"}), False, "not_an_index", 200),
        (_FakeResponse(503), False, "bad_status", 503),
        (httpx.TimeoutException("slow"), False, "timeout", None),
        (httpx.ConnectError("no route"), False, "unreachable", None),
    ],
)
def test_probe_classifies_index_health(
    monkeypatch: pytest.MonkeyPatch,
    response_or_error: object,
    ok: bool,
    reason: str,
    status_code: int | None,
) -> None:
    """Map each probe outcome to a pass/fail verdict with the exact reason.

    Args:
        monkeypatch: Fixture swapping the network call for a canned outcome.
        response_or_error: Fake response or exception the probe encounters.
        ok: Expected pass/fail flag.
        reason: Expected outcome slug.
        status_code: Expected HTTP status carried on the verdict, if any.
    """
    monkeypatch.setattr(package_registry.httpx, "get", _probe_returning(response_or_error))
    verdict = probe_package_index("https://packages.example.com/simple")
    assert (verdict.ok, verdict.reason, verdict.status_code) == (ok, reason, status_code)


def test_probe_targets_the_pip_sentinel_page(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fetch the pip project page under the given index root.

    Args:
        monkeypatch: Fixture capturing the URL the probe requests.
    """
    captured: dict[str, str] = {}

    def fake_get(url: str, **_kwargs: object) -> _FakeResponse:
        captured["url"] = url
        return _FakeResponse(200, text="<a href='pip.whl'>pip</a>")

    monkeypatch.setattr(package_registry.httpx, "get", fake_get)
    probe_package_index("https://packages.example.com/simple")
    assert captured["url"] == "https://packages.example.com/simple/pip/"


def test_check_endpoint_reports_invalid_url_without_probing() -> None:
    """Return a structured invalid-URL reason instead of a validation error."""
    client, _engine, _app = _client()
    response = client.post("/account/package-registry/check", json={"index_url": "http://insecure.example/simple"})
    assert response.status_code == 200
    assert response.json() == {"ok": False, "reason": "invalid_url", "status_code": None}


def test_check_endpoint_normalizes_then_probes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Validate and normalize the URL before probing the sentinel page.

    Args:
        monkeypatch: Fixture capturing the normalized URL the probe requests.
    """
    captured: dict[str, str] = {}

    def fake_get(url: str, **_kwargs: object) -> _FakeResponse:
        captured["url"] = url
        return _FakeResponse(200, content_type="application/vnd.pypi.simple.v1+json", payload={"files": []})

    monkeypatch.setattr(package_registry.httpx, "get", fake_get)
    client, _engine, _app = _client()
    response = client.post("/account/package-registry/check", json={"index_url": "https://Packages.Example.com/team/simple/"})
    assert response.json() == {"ok": True, "reason": "healthy", "status_code": 200}
    assert captured["url"] == "https://packages.example.com/team/simple/pip/"


def test_check_endpoint_requires_authentication() -> None:
    """Deny an unauthenticated probe request."""
    client, _engine, app = _client()
    app.dependency_overrides.clear()
    assert client.post("/account/package-registry/check", json={"index_url": DEFAULT_PACKAGE_INDEX}).status_code == 401


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
