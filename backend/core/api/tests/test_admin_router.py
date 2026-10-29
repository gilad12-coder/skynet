"""Tests for admin quota and account-flag routes."""

from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import time
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest
import sqlalchemy as sa
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...config import settings
from ...storage.models import UserIdentityModel, UserModel
from .. import auth as auth_mod
from ..routers.accounts import create_accounts_router
from ..routers.admin import create_admin_router

_MIGRATION_PATH = Path(__file__).resolve().parents[3] / "alembic" / "versions" / "b7c8d9e0f1a2_add_users_is_internal.py"
_INTERNAL_SECRET = "test-internal-secret"


class _FakeQuotaStore:
    """In-memory quota store for admin route tests."""

    def __init__(self, engine: Engine | None = None) -> None:
        """Initialize empty override and audit state.

        Args:
            engine: Optional SQLAlchemy engine holding the ``users`` table.
        """
        self.engine = engine
        self.overrides: dict[str, int | None] = {}
        self.audit_events: list[dict[str, Any]] = []

    def list_user_quota_overrides(self) -> list[dict[str, Any]]:
        """Return all saved quota overrides."""
        return [
            {
                "username": username,
                "quota": quota,
                "updated_at": None,
                "updated_by": "admin@example.com",
            }
            for username, quota in sorted(self.overrides.items())
        ]

    def list_user_quota_audit_events(self) -> list[dict[str, Any]]:
        """Return saved audit events newest-first."""
        return list(reversed(self.audit_events))

    def get_effective_user_quota(self, username: str) -> int | None:
        """Return the override or the default test quota."""
        return self.overrides.get(username, 100)

    def count_jobs(self, *, username: str | None = None, **_: Any) -> int:
        """Return a stable fake job count."""
        return 7 if username else 0

    def get_user_quota_override(self, username: str) -> tuple[bool, int | None]:
        """Return whether an override exists and its value."""
        if username not in self.overrides:
            return False, None
        return True, self.overrides[username]

    def set_user_quota_override(self, username: str, quota: int | None, updated_by: str | None = None) -> None:
        """Store an override."""
        self.overrides[username] = quota

    def delete_user_quota_override(self, username: str) -> bool:
        """Delete an override if present."""
        return self.overrides.pop(username, None) is not None

    def record_user_quota_audit(
        self,
        *,
        actor: str,
        target_username: str,
        action: str,
        old_quota: int | None,
        new_quota: int | None,
    ) -> None:
        """Record an audit event."""
        self.audit_events.append(
            {
                "id": len(self.audit_events) + 1,
                "actor": actor,
                "target_username": target_username,
                "action": action,
                "old_quota": old_quota,
                "new_quota": new_quota,
                "created_at": None,
            }
        )


def _base64url(value: bytes) -> str:
    """Encode bytes as unpadded base64url."""
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _users_engine() -> Engine:
    """Return a shared in-memory SQLite engine with the account tables created."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    UserModel.__table__.create(engine)
    UserIdentityModel.__table__.create(engine)
    return engine


def _token(*, groups: list[str] | None = None, secret: str = "test-secret") -> str:
    """Return a signed backend token for route tests."""
    now = int(time.time())
    header = _base64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode("utf-8"))
    payload = _base64url(
        json.dumps(
            {
                "aud": "skynet-backend",
                "iss": "skynet-frontend",
                "sub": "admin@example.com",
                "name": "admin@example.com",
                "role": "user",
                "groups": groups or ["skynet-admins"],
                "iat": now,
                "exp": now + 300,
            }
        ).encode("utf-8")
    )
    signature = _base64url(
        hmac.new(secret.encode("utf-8"), f"{header}.{payload}".encode("ascii"), hashlib.sha256).digest()
    )
    return f"{header}.{payload}.{signature}"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Build a test client with signed-token admin authorization enabled."""
    monkeypatch.setattr(auth_mod.settings, "backend_auth_secret", SecretStr("test-secret"))
    monkeypatch.setattr(auth_mod.settings, "admin_usernames", "")
    monkeypatch.setattr(auth_mod.settings, "admin_groups", "skynet-admins")
    engine = _users_engine()
    with Session(engine) as session:
        session.add(UserModel(email="admin@example.com", name="Admin", password_hash="x"))
        session.commit()
    store = _FakeQuotaStore(engine)
    app = FastAPI()
    app.state.users_engine = engine
    app.state.job_store = store
    app.include_router(create_admin_router(job_store=store))
    return TestClient(app)


def _engine_of(client: TestClient) -> Engine:
    """Return the users engine behind an admin test client."""
    return client.app.state.users_engine


def test_admin_quota_routes_reject_missing_bearer(client: TestClient) -> None:
    """Admin quota routes reject unauthenticated requests."""
    response = client.get("/admin/quotas")

    assert response.status_code == 401


def test_admin_quota_routes_reject_non_admin_group(client: TestClient) -> None:
    """Signed users without an admin group cannot manage quotas."""
    response = client.get("/admin/quotas", headers={"Authorization": f"Bearer {_token(groups=['other'])}"})

    assert response.status_code == 403


def test_admin_can_set_list_and_delete_quota(client: TestClient) -> None:
    """Admin quota route writes live overrides and audit events."""
    headers = {"Authorization": f"Bearer {_token()}"}

    set_response = client.put("/admin/quotas", headers=headers, json={"username": "Power@Example.com", "quota": 500})
    list_response = client.get("/admin/quotas", headers=headers)
    delete_response = client.delete("/admin/quotas/power@example.com", headers=headers)

    assert set_response.status_code == 200
    assert set_response.json()["username"] == "power@example.com"
    assert set_response.json()["quota"] == 500
    assert list_response.status_code == 200
    assert list_response.json()["overrides"][0]["username"] == "power@example.com"
    assert list_response.json()["audit_events"][0]["action"] == "set"
    assert list_response.json()["audit_events"][0]["old_quota"] == 100
    assert delete_response.status_code == 200
    assert delete_response.json()["effective_quota"] == 100


def _add_user(engine: Engine, email: str) -> None:
    """Insert an ordinary account row."""
    with Session(engine) as session:
        session.add(UserModel(email=email, name=email, password_hash="x"))
        session.commit()


def _is_internal(engine: Engine, email: str) -> bool:
    """Read an account's stored internal flag."""
    with Session(engine) as session:
        row = session.get(UserModel, email)
        assert row is not None
        return bool(row.is_internal)


def test_admin_can_flag_and_unflag_an_account_as_internal(client: TestClient) -> None:
    """The admin route persists the flag, matching the email case-insensitively."""
    engine = _engine_of(client)
    _add_user(engine, "teammate@example.com")
    headers = {"Authorization": f"Bearer {_token()}"}

    flagged = client.put("/admin/users/Teammate@Example.com/internal", headers=headers, json={"is_internal": True})

    assert flagged.status_code == 200
    assert flagged.json() == {"email": "teammate@example.com", "is_internal": True}
    assert _is_internal(engine, "teammate@example.com") is True

    cleared = client.put("/admin/users/teammate@example.com/internal", headers=headers, json={"is_internal": False})

    assert cleared.status_code == 200
    assert _is_internal(engine, "teammate@example.com") is False


def test_internal_flag_route_rejects_non_admin(client: TestClient) -> None:
    """A signed non-admin cannot change the flag, and the row is untouched."""
    engine = _engine_of(client)
    _add_user(engine, "teammate@example.com")

    response = client.put(
        "/admin/users/teammate@example.com/internal",
        headers={"Authorization": f"Bearer {_token(groups=['other'])}"},
        json={"is_internal": True},
    )

    assert response.status_code == 403
    assert _is_internal(engine, "teammate@example.com") is False


def test_internal_flag_route_returns_404_for_unknown_email(client: TestClient) -> None:
    """Flagging an email with no account row is a 404, not an upsert."""
    response = client.put(
        "/admin/users/nobody@example.com/internal",
        headers={"Authorization": f"Bearer {_token()}"},
        json={"is_internal": True},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "No account found for 'nobody@example.com'."
    with Session(_engine_of(client)) as session:
        assert session.get(UserModel, "nobody@example.com") is None


def test_new_signups_are_not_internal(monkeypatch: pytest.MonkeyPatch) -> None:
    """Register and OAuth provisioning both create rows with ``is_internal`` false."""
    monkeypatch.setattr(settings, "backend_auth_secret", SecretStr(_INTERNAL_SECRET))
    monkeypatch.setattr(settings, "smtp_host", None)
    engine = _users_engine()
    store = SimpleNamespace(engine=engine)
    app = FastAPI()
    app.state.job_store = store
    app.include_router(create_accounts_router(job_store=store))
    accounts = TestClient(app)
    headers = {"X-Internal-Auth": _INTERNAL_SECRET}

    registered = accounts.post(
        "/auth/register",
        json={"email": "new@example.com", "password": "hunter2hunter", "name": "New"},
        headers=headers,
    )
    provisioned = accounts.post(
        "/auth/oauth/provision", json={"email": "oauth@example.com", "name": "O"}, headers=headers
    )

    assert registered.status_code == 201
    assert provisioned.status_code == 200
    assert _is_internal(engine, "new@example.com") is False
    assert _is_internal(engine, "oauth@example.com") is False


def _load_migration() -> ModuleType:
    """Load the ``add_users_is_internal`` revision module from its file."""
    spec = importlib.util.spec_from_file_location("add_users_is_internal", _MIGRATION_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_migration(engine: Engine, step: str) -> None:
    """Run the revision's ``upgrade`` or ``downgrade`` against ``engine``."""
    migration = _load_migration()
    with engine.begin() as connection, Operations.context(MigrationContext.configure(connection)):
        getattr(migration, step)()


def test_migration_backfills_synthetic_and_admin_accounts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Upgrade marks ``.local`` fixtures and configured admins internal; downgrade drops the column."""
    monkeypatch.setattr(settings, "admin_usernames", "Boss@Example.com")
    engine = create_engine("sqlite://", poolclass=StaticPool)
    with engine.begin() as connection:
        connection.execute(sa.text("CREATE TABLE users (email VARCHAR(255) PRIMARY KEY, name VARCHAR(255) NOT NULL)"))
        connection.execute(
            sa.text("INSERT INTO users (email, name) VALUES (:a, 'a'), (:b, 'b'), (:c, 'c'), (:d, 'd')"),
            {"a": "x@sampler.local", "b": "analytics-1-1@s.local", "c": "boss@example.com", "d": "real@example.com"},
        )

    _run_migration(engine, "upgrade")

    with engine.connect() as connection:
        flags = dict(connection.execute(sa.text("SELECT email, is_internal FROM users")).all())
    assert {email: bool(flag) for email, flag in flags.items()} == {
        "x@sampler.local": True,
        "analytics-1-1@s.local": True,
        "boss@example.com": True,
        "real@example.com": False,
    }

    _run_migration(engine, "downgrade")

    assert "is_internal" not in {column["name"] for column in sa.inspect(engine).get_columns("users")}
