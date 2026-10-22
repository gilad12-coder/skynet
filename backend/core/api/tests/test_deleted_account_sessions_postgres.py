"""Check the SKY-150 account and PAT-age checks against a disposable PostgreSQL database.

Skipped unless ``APP_BUDGET_TEST_DB_URL`` points at Postgres, like
``test_metric_views_postgres.py``. Each test runs in its own schema with only
the ``users`` and ``api_tokens`` tables, so PostgreSQL's timezone-aware
``created_at`` values and its case-sensitive text comparison are exercised.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import SecretStr
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session

from core.api import auth as auth_mod
from core.api.auth import generate_api_token, get_authenticated_user, hash_api_token
from core.config import app_env
from core.storage.models import ApiTokenModel, Base, UserModel

TEST_DB_URL = app_env("APP_BUDGET_TEST_DB_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DB_URL or not TEST_DB_URL.startswith("postgresql"),
    reason="Set APP_BUDGET_TEST_DB_URL to an explicitly disposable PostgreSQL database.",
)

_SECRET = "pg-test-secret"
_EMAIL = "owner@example.com"
_ACCOUNT_CREATED_AT = datetime(2020, 1, 1, tzinfo=UTC)


@pytest.fixture
def database() -> Iterator[Engine]:
    """Isolate each test in its own schema without touching pre-existing data."""
    schema = f"sky150_test_{uuid4().hex}"
    admin = create_engine(TEST_DB_URL)
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(TEST_DB_URL, connect_args={"options": f"-csearch_path={schema}"})
    try:
        Base.metadata.create_all(engine, tables=[UserModel.__table__, ApiTokenModel.__table__])
        with Session(engine) as session:
            # Older than any aged token below: a PAT that predates its account is refused.
            session.add(UserModel(email=_EMAIL, name="Owner", password_hash="x", created_at=_ACCOUNT_CREATED_AT))
            session.commit()
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


@pytest.fixture(autouse=True)
def _auth_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set the shared secret and turn off the monthly-active-user cap."""
    monkeypatch.setattr(auth_mod.settings, "backend_auth_secret", SecretStr(_SECRET))
    monkeypatch.setattr(auth_mod.settings, "max_monthly_active_users", 0)


def _request(engine: Engine) -> Any:
    """Build a request stand-in whose store uses ``engine``.

    Args:
        engine: Schema-scoped PostgreSQL engine.

    Returns:
        The request stand-in.
    """
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(job_store=SimpleNamespace(engine=engine))),
        state=SimpleNamespace(),
    )


def _jwt(email: str) -> str:
    """Mint a session JWT shaped like the frontend's.

    Args:
        email: Identity the token carries.

    Returns:
        A compact HS256 JWT.
    """
    now = int(time.time())

    def encode(value: dict[str, Any]) -> str:
        """Encode one JWT segment.

        Args:
            value: Segment content.

        Returns:
            Unpadded base64url JSON.
        """
        return base64.urlsafe_b64encode(json.dumps(value).encode("utf-8")).decode("ascii").rstrip("=")

    header = encode({"alg": "HS256", "typ": "JWT"})
    payload = encode(
        {
            "aud": "skynet-backend",
            "iss": "skynet-frontend",
            "sub": email,
            "name": email,
            "email": email,
            "iat": now,
            "exp": now + 900,
        }
    )
    digest = hmac.new(_SECRET.encode("utf-8"), f"{header}.{payload}".encode("ascii"), hashlib.sha256).digest()
    return f"{header}.{payload}.{base64.urlsafe_b64encode(digest).decode('ascii').rstrip('=')}"


def _add_pat(engine: Engine, age: timedelta) -> str:
    """Store a PAT for the owner that is ``age`` old.

    Args:
        engine: Schema-scoped PostgreSQL engine.
        age: How long ago the token was generated.

    Returns:
        The raw token.
    """
    token = generate_api_token()
    with Session(engine) as session:
        session.add(
            ApiTokenModel(
                username=_EMAIL,
                token_hash=hash_api_token(token),
                last4=token[-4:],
                created_at=datetime.now(UTC) - age,
            )
        )
        session.commit()
    return token


def test_jwt_for_existing_account_is_accepted(database: Engine) -> None:
    """A JWT whose account row exists authenticates."""
    assert get_authenticated_user(_request(database), f"Bearer {_jwt(_EMAIL)}").username == _EMAIL


def test_jwt_for_deleted_account_is_refused(database: Engine) -> None:
    """After the account row is deleted, the same still-valid JWT gets 401."""
    token = _jwt(_EMAIL)
    with Session(database) as session:
        session.delete(session.get(UserModel, _EMAIL))
        session.commit()

    with pytest.raises(HTTPException) as exc:
        get_authenticated_user(_request(database), f"Bearer {token}")

    assert exc.value.status_code == 401


def test_pat_age_check_uses_aware_postgres_timestamps(database: Engine) -> None:
    """A young PAT works and a PAT past one year gets 401 on PostgreSQL."""
    young = _add_pat(database, timedelta(days=30))
    assert get_authenticated_user(_request(database), f"Bearer {young}").username == _EMAIL

    with Session(database) as session:
        session.query(ApiTokenModel).delete()
        session.commit()
    old = _add_pat(database, timedelta(days=366))

    with pytest.raises(HTTPException) as exc:
        get_authenticated_user(_request(database), f"Bearer {old}")

    assert exc.value.status_code == 401


def test_pat_older_than_its_account_is_refused_on_postgres(database: Engine) -> None:
    """A PAT created before the current account row (a re-signup) gets 401."""
    with Session(database) as session:
        account = session.get(UserModel, _EMAIL)
        assert account is not None
        account.created_at = datetime.now(UTC)
        session.commit()
    orphan = _add_pat(database, timedelta(days=1))

    with pytest.raises(HTTPException) as exc:
        get_authenticated_user(_request(database), f"Bearer {orphan}")

    assert exc.value.status_code == 401
