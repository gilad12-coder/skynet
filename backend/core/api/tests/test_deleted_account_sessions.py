"""A session JWT for a deleted account must stop working on every route (SKY-150).

Session JWTs are stateless, so a second browser that signed in before an
account deletion keeps getting valid tokens from the frontend. These tests
run the real ``get_authenticated_user`` dependency (no auth override) over a
shared in-memory SQLite engine: they register an account, delete it through
``POST /account/delete``, and then replay the old JWT on several routes.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...config import settings
from ...storage.models import ApiTokenModel, Base, UserModel
from ..errors import DomainError
from ..routers.account_data import create_account_data_router
from ..routers.accounts import create_accounts_router
from ..routers.api_tokens import create_api_tokens_router
from ..routers.model_privacy import create_model_privacy_router
from ..routers.notification_preferences import create_notification_preferences_router

_SECRET = "test-shared-secret"
_EMAIL = "owner@example.com"
_PASSWORD = "correct horse battery"

# Routes that only need an authenticated caller; each must refuse a deleted account.
_SESSION_ROUTES = [
    ("POST", "/settings/api-token"),
    ("GET", "/settings/api-token"),
    ("DELETE", "/settings/api-token"),
    ("GET", "/account/export"),
    ("GET", "/account/model-privacy"),
    ("GET", "/account/notification-preferences"),
]


def _b64url(raw: bytes) -> str:
    """Encode bytes as unpadded base64url.

    Args:
        raw: Bytes to encode.

    Returns:
        The encoded string.
    """
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _session_jwt(email: str = _EMAIL) -> str:
    """Mint a backend session JWT shaped like the frontend's.

    Args:
        email: Identity the token carries.

    Returns:
        A compact HS256 JWT signed with the shared secret.
    """
    now = int(time.time())
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode("utf-8"))
    payload = _b64url(
        json.dumps(
            {
                "aud": "skynet-backend",
                "iss": "skynet-frontend",
                "sub": email,
                "name": email,
                "email": email,
                "role": "user",
                "groups": [],
                "iat": now,
                "exp": now + 900,
            }
        ).encode("utf-8")
    )
    signature = _b64url(
        hmac.new(_SECRET.encode("utf-8"), f"{header}.{payload}".encode("ascii"), hashlib.sha256).digest()
    )
    return f"{header}.{payload}.{signature}"


def _bearer(token: str) -> dict[str, str]:
    """Return an Authorization header for ``token``.

    Args:
        token: Bearer credential.

    Returns:
        The header mapping.
    """
    return {"Authorization": f"Bearer {token}"}


def _call(client: TestClient, method: str, path: str, token: str) -> Any:
    """Send ``method path`` with ``token``.

    Args:
        client: Test client.
        method: HTTP method.
        path: Route path.
        token: Bearer credential.

    Returns:
        The HTTP response.
    """
    return client.request(method, path, headers=_bearer(token))


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Serve the account, token, and preference routers with real JWT auth.

    Args:
        monkeypatch: Pytest fixture used to set the shared secret and turn
            off the monthly-active-user cap.

    Returns:
        A namespace exposing ``client`` and ``engine``.
    """
    monkeypatch.setattr(settings, "backend_auth_secret", SecretStr(_SECRET))
    monkeypatch.setattr(settings, "max_monthly_active_users", 0)
    monkeypatch.setattr(settings, "smtp_host", None)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    store = SimpleNamespace(engine=engine)
    app = FastAPI()
    app.state.job_store = store

    @app.exception_handler(DomainError)
    async def _domain_error(request: Request, exc: DomainError) -> JSONResponse:
        """Render a DomainError with its code, like the app's handler.

        Args:
            request: Incoming request.
            exc: Raised error.

        Returns:
            JSON error body.
        """
        return JSONResponse(status_code=exc.status_code, content={"code": exc.code})

    app.include_router(create_accounts_router(job_store=store))
    app.include_router(create_account_data_router(job_store=store))
    app.include_router(create_api_tokens_router(job_store=store))
    app.include_router(create_model_privacy_router(job_store=store))
    app.include_router(create_notification_preferences_router(job_store=store))
    client = TestClient(app)
    registered = client.post(
        "/auth/register",
        json={"email": _EMAIL, "password": _PASSWORD},
        headers={"X-Internal-Auth": _SECRET},
    )
    assert registered.status_code == 201
    return SimpleNamespace(client=client, engine=engine)


@pytest.mark.parametrize(("method", "path"), _SESSION_ROUTES)
def test_live_account_jwt_is_accepted(harness: SimpleNamespace, method: str, path: str) -> None:
    """Control: the same JWT works on every route while the account exists."""
    response = _call(harness.client, method, path, _session_jwt())

    assert response.status_code in {200, 201, 204}


@pytest.mark.parametrize(("method", "path"), _SESSION_ROUTES)
def test_deleted_account_jwt_is_refused(harness: SimpleNamespace, method: str, path: str) -> None:
    """After ``POST /account/delete``, the old still-valid JWT gets 401 on every route."""
    token = _session_jwt()
    deleted = harness.client.post("/account/delete", headers=_bearer(token), json={"password": _PASSWORD})
    assert deleted.status_code == 200

    response = _call(harness.client, method, path, token)

    assert response.status_code == 401
    assert response.json()["code"] == "auth.invalid_token"


def test_deleted_account_cannot_mint_a_permanent_api_token(harness: SimpleNamespace) -> None:
    """The issue's exact path: a second browser's JWT cannot create a PAT after deletion."""
    browser_a = _session_jwt()
    browser_b = _session_jwt()
    assert (
        harness.client.post("/account/delete", headers=_bearer(browser_a), json={"password": _PASSWORD}).status_code
        == 200
    )

    created = harness.client.post("/settings/api-token", headers=_bearer(browser_b))

    assert created.status_code == 401
    with Session(harness.engine) as session:
        assert session.get(ApiTokenModel, _EMAIL) is None


def test_api_token_made_before_deletion_stops_working(harness: SimpleNamespace) -> None:
    """A PAT minted before the deletion no longer authenticates afterwards."""
    token = _session_jwt()
    pat = harness.client.post("/settings/api-token", headers=_bearer(token)).json()["token"]
    assert _call(harness.client, "GET", "/account/model-privacy", pat).status_code == 200
    assert (
        harness.client.post("/account/delete", headers=_bearer(token), json={"password": _PASSWORD}).status_code == 200
    )

    assert _call(harness.client, "GET", "/account/model-privacy", pat).status_code == 401


def test_orphan_api_token_is_refused(harness: SimpleNamespace) -> None:
    """A PAT row that outlived its account (a create racing the deletion) is refused."""
    token = _session_jwt()
    pat = harness.client.post("/settings/api-token", headers=_bearer(token)).json()["token"]
    with Session(harness.engine) as session:
        session.delete(session.get(UserModel, _EMAIL))
        session.commit()

    response = _call(harness.client, "GET", "/account/model-privacy", pat)

    assert response.status_code == 401
    assert response.json()["code"] == "auth.invalid_token"


def test_new_account_under_the_same_email_gets_access_again(harness: SimpleNamespace) -> None:
    """The check follows the account row: signing up again restores access for a fresh JWT."""
    token = _session_jwt()
    assert (
        harness.client.post("/account/delete", headers=_bearer(token), json={"password": _PASSWORD}).status_code == 200
    )
    again = harness.client.post(
        "/auth/register",
        json={"email": _EMAIL, "password": _PASSWORD},
        headers={"X-Internal-Auth": _SECRET},
    )
    assert again.status_code == 201

    assert _call(harness.client, "GET", "/account/model-privacy", _session_jwt()).status_code == 200
