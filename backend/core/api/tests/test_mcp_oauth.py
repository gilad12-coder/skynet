"""Tests for the OAuth server of the hosted remote MCP server (SKY-229).

The app runs over a shared in-memory SQLite engine (StaticPool). Only the
browser session JWT is bypassed, with a dependency override that acts as a
signed-in user. Metadata documents are served by an ``httpx.MockTransport``
and DNS answers are stubbed, so no test touches the network.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import socket
import ssl
import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import fakeredis
import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...config import settings
from ...storage.models import Base, McpAuthCodeModel, McpGrantModel, McpTokenModel, UserModel
from .. import mcp_oauth
from ..account_data_service import delete_account
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError
from ..mcp_oauth import McpTokenError, resolve_principal
from ..routers import mcp_oauth as mcp_oauth_router
from ..routers.mcp_oauth import create_mcp_oauth_router

RESOURCE = "https://mcp.example.test/mcp"
ISSUER = "https://mcp.example.test"
APP_URL = "https://app.example.test"
REDIRECT = "https://claude.ai/api/mcp/auth_callback"
CIMD_URL = "https://client.example.test/oauth/client.json"
USER = "alice@example.test"


class _Store:
    """Minimal store exposing the engine and the MAU admission hook."""

    def __init__(self, engine: Any) -> None:
        """Hold the engine the routes open sessions on.

        Args:
            engine: SQLAlchemy engine with the schema created.
        """
        self.engine = engine

    def admit_monthly_active_user(self, username: str, month_start: Any, cap: int) -> bool:
        """Admit every identity; the MAU cap is not under test here.

        Args:
            username: Identity to admit.
            month_start: First day of the month.
            cap: Configured cap.

        Returns:
            Always True.
        """
        return True


async def _domain_error_json(request: Request, exc: Exception) -> JSONResponse:
    """Render a DomainError with its semantic code, like the app's handler.

    Args:
        request: Incoming request.
        exc: The raised DomainError.

    Returns:
        A JSON body with ``code``.
    """
    assert isinstance(exc, DomainError)
    return JSONResponse(status_code=exc.status_code, content={"code": exc.code})


def _pkce() -> tuple[str, str]:
    """Return a fresh PKCE ``(verifier, S256 challenge)`` pair."""
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Build an app with the MCP OAuth router over in-memory SQLite.

    Args:
        monkeypatch: Pytest monkeypatch fixture.

    Returns:
        A ``(client, store)`` tuple.
    """
    monkeypatch.setattr(settings, "mcp_resource_url", RESOURCE)
    monkeypatch.setattr(settings, "app_public_url", APP_URL)
    mcp_oauth._cimd_cache.clear()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(UserModel(email=USER, name="Alice Example", password_hash="x"))
        session.commit()
    store = _Store(engine)
    app = FastAPI()
    app.add_exception_handler(DomainError, _domain_error_json)
    app.include_router(create_mcp_oauth_router(job_store=store))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(username=USER, role="user", groups=())
    return TestClient(app), store


def _register(client: TestClient, redirect_uris: list[str] | None = None) -> str:
    """Register a DCR client and return its ID.

    Args:
        client: Test client.
        redirect_uris: Redirects to register.

    Returns:
        The new client ID.
    """
    resp = client.post("/oauth/register", json={"client_name": "Claude", "redirect_uris": redirect_uris or [REDIRECT]})
    assert resp.status_code == 201, resp.text
    return resp.json()["client_id"]


def _approve(client: TestClient, client_id: str, challenge: str, scope: str = "", redirect: str = REDIRECT) -> str:
    """Approve consent and return the authorization code.

    Args:
        client: Test client.
        client_id: Client that asks.
        challenge: PKCE challenge.
        scope: Requested scopes.
        redirect: Redirect URI.

    Returns:
        The code from the redirect.
    """
    resp = client.post(
        "/oauth/consent",
        json={
            "client_id": client_id,
            "redirect_uri": redirect,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": scope,
            "state": "st-1",
            "resource": RESOURCE,
            "decision": "approve",
        },
    )
    assert resp.status_code == 200, resp.text
    query = parse_qs(urlsplit(resp.json()["redirect_url"]).query)
    assert query["state"] == ["st-1"]
    assert query["iss"] == [ISSUER]
    return query["code"][0]


def _tokens(client: TestClient, scope: str = "") -> tuple[str, dict[str, Any]]:
    """Run the full DCR, consent and code exchange flow.

    Args:
        client: Test client.
        scope: Requested scopes.

    Returns:
        The client ID and the token response.
    """
    client_id = _register(client)
    verifier, challenge = _pkce()
    code = _approve(client, client_id, challenge, scope)
    resp = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": REDIRECT,
            "client_id": client_id,
            "resource": RESOURCE,
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["cache-control"] == "no-store"
    return client_id, resp.json()


def test_protected_resource_metadata_names_the_issuer(harness: Any) -> None:
    """Serve RFC 9728 metadata at the root and under the resource path."""
    client, _store = harness
    for path in ("/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"):
        body = client.get(path).json()
        assert body["resource"] == RESOURCE
        assert body["authorization_servers"] == [ISSUER]
        assert body["scopes_supported"] == ["runs:read", "runs:write"]


def test_authorization_server_metadata(harness: Any) -> None:
    """Advertise S256 only, public clients, CIMD, DCR and the RFC 9207 iss."""
    client, _store = harness
    body = client.get("/.well-known/oauth-authorization-server").json()
    assert body["issuer"] == ISSUER
    assert body["token_endpoint"] == f"{ISSUER}/oauth/token"
    assert body["registration_endpoint"] == f"{ISSUER}/oauth/register"
    assert body["code_challenge_methods_supported"] == ["S256"]
    assert body["token_endpoint_auth_methods_supported"] == ["none"]
    assert body["client_id_metadata_document_supported"] is True
    assert body["authorization_response_iss_parameter_supported"] is True


def test_metadata_is_404_when_not_configured(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Hide the server when no resource URL is configured."""
    client, _store = harness
    monkeypatch.setattr(settings, "mcp_resource_url", "")
    assert client.get("/.well-known/oauth-protected-resource").status_code == 404


def test_authorize_redirects_to_consent_page(harness: Any) -> None:
    """Send a valid request to the frontend consent page with every parameter."""
    client, _store = harness
    client_id = _register(client)
    _verifier, challenge = _pkce()
    resp = client.get(
        "/oauth/authorize",
        params={
            "client_id": client_id,
            "redirect_uri": REDIRECT,
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "xyz",
            "resource": RESOURCE,
        },
        follow_redirects=False,
    )
    assert resp.status_code == 302
    target = urlsplit(resp.headers["location"])
    assert f"{target.scheme}://{target.netloc}{target.path}" == f"{APP_URL}/mcp/authorize"
    query = parse_qs(target.query)
    assert query["scope"] == ["runs:read runs:write"]
    assert query["state"] == ["xyz"]


@pytest.mark.parametrize(
    ("override", "error"),
    [
        ({"code_challenge_method": "plain"}, "invalid_request"),
        ({"response_type": "token"}, "unsupported_response_type"),
        ({"scope": "admin"}, "invalid_scope"),
        ({"resource": "https://evil.example.test/mcp"}, "invalid_target"),
    ],
)
def test_authorize_shows_errors_instead_of_redirecting(harness: Any, override: dict[str, str], error: str) -> None:
    """Show PKCE, scope and audience errors here; never send the browser to an unseen client (RFC 9700 4.11.2)."""
    client, _store = harness
    client_id = _register(client)
    _verifier, challenge = _pkce()
    params = {
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": "s",
        **override,
    }
    resp = client.get("/oauth/authorize", params=params, follow_redirects=False)
    assert resp.status_code == 400
    assert "location" not in resp.headers
    assert resp.json()["error"] == error


def test_authorize_is_not_an_open_redirect(harness: Any) -> None:
    """Refuse to bounce an anonymous caller to a redirect that anyone can register."""
    client, _store = harness
    client.app.dependency_overrides.clear()
    client_id = _register(client, ["https://evil.example.test/landing"])
    resp = client.get(
        "/oauth/authorize",
        params={"client_id": client_id, "redirect_uri": "https://evil.example.test/landing", "response_type": "x"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    assert "location" not in resp.headers


def test_authorize_is_rate_limited_per_address(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Limit anonymous authorization requests, which can start metadata document fetches."""
    client, _store = harness
    redis = fakeredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(mcp_oauth_router, "shared_redis_client", lambda: redis)
    params = {"client_id": "mcpc_unknown", "redirect_uri": REDIRECT, "response_type": "code"}
    statuses = [client.get("/oauth/authorize", params=params).status_code for _ in range(31)]
    assert statuses[:30] == [400] * 30
    assert statuses[30] == 429


def test_authorize_refuses_an_unregistered_redirect(harness: Any) -> None:
    """Never redirect to a URI the client did not register."""
    client, _store = harness
    client_id = _register(client)
    _verifier, challenge = _pkce()
    resp = client.get(
        "/oauth/authorize",
        params={
            "client_id": client_id,
            "redirect_uri": "https://evil.example.test/cb",
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
        follow_redirects=False,
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_request"


@pytest.mark.parametrize(
    "uris",
    [
        ["http://evil.example.test/cb"],
        ["https://ok.example.test/cb#frag"],
        ["https://user:pw@ok.example.test/cb"],
        [],
        ["javascript:alert(1)"],
    ],
)
def test_dcr_refuses_bad_redirects(harness: Any, uris: list[str]) -> None:
    """Accept only https and loopback http redirects in registration."""
    client, _store = harness
    resp = client.post("/oauth/register", json={"redirect_uris": uris})
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_redirect_uri"


def test_dcr_refuses_confidential_clients(harness: Any) -> None:
    """Register public clients only."""
    client, _store = harness
    resp = client.post(
        "/oauth/register",
        json={"redirect_uris": [REDIRECT], "token_endpoint_auth_method": "client_secret_basic"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_client_metadata"


def test_loopback_redirect_matches_any_port(harness: Any) -> None:
    """Let a native client pick its loopback port at run time (RFC 8252)."""
    client, _store = harness
    client_id = _register(client, ["http://127.0.0.1/callback"])
    _verifier, challenge = _pkce()
    code = _approve(client, client_id, challenge, redirect="http://127.0.0.1:53111/callback")
    assert code


def test_full_flow_issues_resource_bound_tokens(harness: Any) -> None:
    """Exchange a code for tokens bound to the resource URL and the user."""
    client, store = harness
    _client_id, tokens = _tokens(client)
    assert tokens["access_token"].startswith("skym_at_")
    assert tokens["refresh_token"].startswith("skym_rt_")
    assert tokens["scope"] == "runs:read runs:write"
    principal = resolve_principal(store, tokens["access_token"])
    assert principal.username == USER
    assert principal.scopes == frozenset({"runs:read", "runs:write"})
    with Session(store.engine) as session:
        grant = session.scalars(select(McpGrantModel)).one()
        assert grant.resource == RESOURCE


def test_wrong_verifier_spends_the_code(harness: Any) -> None:
    """Refuse a wrong verifier, and refuse the right one after it."""
    client, _store = harness
    client_id = _register(client)
    verifier, challenge = _pkce()
    code = _approve(client, client_id, challenge)
    base = {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT, "client_id": client_id}
    wrong = client.post("/oauth/token", data={**base, "code_verifier": _pkce()[0]})
    assert wrong.json()["error"] == "invalid_grant"
    right = client.post("/oauth/token", data={**base, "code_verifier": verifier})
    assert right.json()["error"] == "invalid_grant"


def test_code_replay_revokes_the_grant(harness: Any) -> None:
    """End the tokens of a code that someone uses twice."""
    client, store = harness
    client_id = _register(client)
    verifier, challenge = _pkce()
    code = _approve(client, client_id, challenge)
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": REDIRECT,
        "client_id": client_id,
    }
    access = client.post("/oauth/token", data=data).json()["access_token"]
    assert client.post("/oauth/token", data=data).json()["error"] == "invalid_grant"
    with pytest.raises(McpTokenError):
        resolve_principal(store, access)


def test_code_for_another_client_is_refused(harness: Any) -> None:
    """Bind a code to the client that got it."""
    client, _store = harness
    client_id = _register(client)
    other = _register(client)
    verifier, challenge = _pkce()
    code = _approve(client, client_id, challenge)
    resp = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": REDIRECT,
            "client_id": other,
        },
    )
    assert resp.json()["error"] == "invalid_grant"


def test_expired_code_is_refused(harness: Any) -> None:
    """Refuse a code after its five minutes."""
    client, store = harness
    client_id = _register(client)
    verifier, challenge = _pkce()
    code = _approve(client, client_id, challenge)
    with Session(store.engine) as session:
        row = session.scalars(select(McpAuthCodeModel)).one()
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        session.commit()
    resp = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": REDIRECT,
            "client_id": client_id,
        },
    )
    assert resp.json()["error"] == "invalid_grant"


def test_deny_returns_access_denied(harness: Any) -> None:
    """Send ``access_denied`` back to the client when the user denies."""
    client, _store = harness
    client_id = _register(client)
    _verifier, challenge = _pkce()
    resp = client.post(
        "/oauth/consent",
        json={
            "client_id": client_id,
            "redirect_uri": REDIRECT,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "s",
            "decision": "deny",
        },
    )
    query = parse_qs(urlsplit(resp.json()["redirect_url"]).query)
    assert query["error"] == ["access_denied"]
    assert "code" not in query


def test_consent_refuses_a_personal_access_token(harness: Any) -> None:
    """Accept consent only from a browser session, never from a PAT."""
    client, _store = harness
    client.app.dependency_overrides.clear()

    def pat_user(request: Request) -> AuthenticatedUser:
        """Act as a caller that signed in with a personal access token."""
        request.state.auth_channel = "api_token"
        return AuthenticatedUser(username=USER, role="user", groups=())

    client.app.dependency_overrides[get_authenticated_user] = pat_user
    client_id = _register(client)
    resp = client.post("/oauth/consent/describe", json={"client_id": client_id, "redirect_uri": REDIRECT, "scope": ""})
    assert resp.status_code == 403
    assert resp.json()["code"] == "mcp.session_required"


def test_describe_shows_the_client_and_redirect_host(harness: Any) -> None:
    """Tell the user who asks and where the code goes."""
    client, _store = harness
    client_id = _register(client)
    body = client.post(
        "/oauth/consent/describe", json={"client_id": client_id, "redirect_uri": REDIRECT, "scope": "runs:read"}
    ).json()
    assert body == {"client_name": "Claude", "client_host": None, "redirect_host": "claude.ai", "scopes": ["runs:read"]}


def test_describe_shows_a_unicode_redirect_host_as_punycode(harness: Any) -> None:
    """Show the ASCII host the browser goes to, so a look-alike letter cannot pass as claude.ai."""
    client, _store = harness
    redirect = "https://cl\u0430ude.ai:8443/cb"
    client_id = _register(client, [redirect])
    body = client.post(
        "/oauth/consent/describe", json={"client_id": client_id, "redirect_uri": redirect, "scope": "runs:read"}
    ).json()
    assert body["redirect_host"] == "xn--clude-5ve.ai:8443"


def test_describe_shows_the_host_by_browser_rules(harness: Any) -> None:
    """Keep "\u00df" as its own letter, as browsers do, so the page cannot name glassdoor.de."""
    client, _store = harness
    redirect = "https://gla\u00dfdoor.de/cb"
    client_id = _register(client, [redirect])
    body = client.post(
        "/oauth/consent/describe", json={"client_id": client_id, "redirect_uri": redirect, "scope": "runs:read"}
    ).json()
    assert body["redirect_host"] == "xn--gladoor-2va.de"


def test_describe_shows_a_fullwidth_host_as_the_browser_opens_it(harness: Any) -> None:
    """Map a fullwidth letter like browsers, so the page names the domain the browser opens."""
    client, _store = harness
    redirect = "https://\uff45xample.com/cb"
    client_id = _register(client, [redirect])
    body = client.post(
        "/oauth/consent/describe", json={"client_id": client_id, "redirect_uri": redirect, "scope": "runs:read"}
    ).json()
    assert body["redirect_host"] == "example.com"


def test_refresh_rotates_and_reuse_revokes(harness: Any) -> None:
    """Rotate refresh tokens, and end the grant when an old one comes back."""
    client, store = harness
    client_id, first = _tokens(client)
    rotated = client.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": first["refresh_token"], "client_id": client_id},
    )
    assert rotated.status_code == 200, rotated.text
    second = rotated.json()
    assert second["refresh_token"] != first["refresh_token"]
    assert resolve_principal(store, second["access_token"]).username == USER
    reuse = client.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": first["refresh_token"], "client_id": client_id},
    )
    assert reuse.json()["error"] == "invalid_grant"
    with pytest.raises(McpTokenError):
        resolve_principal(store, second["access_token"])
    after = client.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": second["refresh_token"], "client_id": client_id},
    )
    assert after.json()["error"] == "invalid_grant"


def test_refresh_by_another_client_is_refused(harness: Any) -> None:
    """Bind a refresh token to its client."""
    client, _store = harness
    _client_id, tokens = _tokens(client)
    resp = client.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "client_id": "mcpc_other"},
    )
    assert resp.json()["error"] == "invalid_grant"


def test_token_for_another_resource_is_refused(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Refuse a token whose audience is not this server's resource URL."""
    client, store = harness
    _client_id, tokens = _tokens(client)
    monkeypatch.setattr(settings, "mcp_resource_url", "https://other.example.test/mcp")
    with pytest.raises(McpTokenError):
        resolve_principal(store, tokens["access_token"])


def test_refresh_token_is_not_an_access_token(harness: Any) -> None:
    """Refuse a refresh token as a bearer token."""
    client, store = harness
    _client_id, tokens = _tokens(client)
    with pytest.raises(McpTokenError):
        resolve_principal(store, tokens["refresh_token"])


def test_expired_access_token_is_refused(harness: Any) -> None:
    """Refuse an access token after its hour."""
    client, store = harness
    _client_id, tokens = _tokens(client)
    with Session(store.engine) as session:
        for row in session.scalars(select(McpTokenModel).where(McpTokenModel.kind == "access")):
            row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        session.commit()
    with pytest.raises(McpTokenError):
        resolve_principal(store, tokens["access_token"])


def test_revoke_ends_the_grant(harness: Any) -> None:
    """Revoke the whole grant from either token."""
    client, store = harness
    _client_id, tokens = _tokens(client)
    assert client.post("/oauth/revoke", data={"token": tokens["refresh_token"]}).status_code == 200
    with pytest.raises(McpTokenError):
        resolve_principal(store, tokens["access_token"])
    assert client.post("/oauth/revoke", data={"token": "unknown"}).status_code == 200


def test_account_deletion_removes_mcp_grants(harness: Any) -> None:
    """Delete MCP codes, grants and tokens with the account."""
    client, store = harness
    _client_id, tokens = _tokens(client)
    with Session(store.engine) as session:
        delete_account(session, USER)
        session.commit()
        assert session.scalars(select(McpGrantModel)).first() is None
        assert session.scalars(select(McpTokenModel)).first() is None
    with pytest.raises(McpTokenError):
        resolve_principal(store, tokens["access_token"])


def _cimd_transport(document: dict[str, Any] | None, status: int = 200) -> httpx.MockTransport:
    """Serve one metadata document, and count the requests.

    Args:
        document: The JSON document to serve.
        status: HTTP status to answer with.

    Returns:
        The mock transport; ``transport.calls`` counts requests.
    """
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """Answer one metadata document request."""
        calls.append(str(request.url))
        return httpx.Response(status, content=json.dumps(document).encode())

    transport = httpx.MockTransport(handler)
    transport.calls = calls  # type: ignore[attr-defined]
    return transport


def _use_cimd(monkeypatch: pytest.MonkeyPatch, transport: httpx.MockTransport, address: str = "93.184.216.34") -> None:
    """Route metadata document fetches to ``transport`` and stub DNS.

    Args:
        monkeypatch: Pytest monkeypatch fixture.
        transport: Mock transport that serves the documents.
        address: IP address the host resolves to.
    """
    monkeypatch.setattr(mcp_oauth, "_resolve_host", lambda host, port: [address])
    monkeypatch.setattr(mcp_oauth, "_http_client", lambda: httpx.Client(transport=transport))


def _cimd_document(**overrides: Any) -> dict[str, Any]:
    """Return a valid client ID metadata document.

    Args:
        **overrides: Fields to replace.

    Returns:
        The document.
    """
    return {
        "client_id": CIMD_URL,
        "client_name": "Example Agent",
        "redirect_uris": ["http://127.0.0.1/callback", REDIRECT],
        "token_endpoint_auth_method": "none",
        **overrides,
    }


def test_cimd_client_runs_the_full_flow(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Accept a client whose ID is its metadata document URL, and cache the fetch."""
    client, store = harness
    transport = _cimd_transport(_cimd_document())
    _use_cimd(monkeypatch, transport)
    described = client.post(
        "/oauth/consent/describe", json={"client_id": CIMD_URL, "redirect_uri": REDIRECT, "scope": ""}
    ).json()
    assert described["client_name"] == "Example Agent"
    assert described["client_host"] == "client.example.test"
    verifier, challenge = _pkce()
    code = _approve(client, CIMD_URL, challenge)
    resp = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": REDIRECT,
            "client_id": CIMD_URL,
        },
    )
    assert resp.status_code == 200, resp.text
    assert resolve_principal(store, resp.json()["access_token"]).username == USER
    assert transport.calls == [CIMD_URL]  # type: ignore[attr-defined]


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "fd00::1"])
def test_cimd_refuses_private_addresses(harness: Any, monkeypatch: pytest.MonkeyPatch, address: str) -> None:
    """Never fetch a metadata document from a private or link-local address."""
    client, _store = harness
    transport = _cimd_transport(_cimd_document())
    _use_cimd(monkeypatch, transport, address)
    resp = client.post("/oauth/consent/describe", json={"client_id": CIMD_URL, "redirect_uri": REDIRECT, "scope": ""})
    assert resp.status_code == 400
    assert resp.json()["code"] == "mcp.invalid_client"
    assert transport.calls == []  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    "client_id",
    ["http://client.example.test/oauth/client.json", "https://client.example.test/", "https://client.example.test"],
)
def test_cimd_refuses_non_https_or_pathless_ids(harness: Any, monkeypatch: pytest.MonkeyPatch, client_id: str) -> None:
    """Fetch metadata documents only from https URLs with a path."""
    client, _store = harness
    transport = _cimd_transport(_cimd_document(client_id=client_id))
    _use_cimd(monkeypatch, transport)
    resp = client.get(
        "/oauth/authorize",
        params={"client_id": client_id, "redirect_uri": REDIRECT, "response_type": "code"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    assert transport.calls == []  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    ("document", "status"),
    [
        (_cimd_document(client_id="https://other.example.test/client.json"), 200),
        (_cimd_document(token_endpoint_auth_method="private_key_jwt"), 200),
        (_cimd_document(redirect_uris=["http://evil.example.test/cb"]), 200),
        (_cimd_document(), 404),
    ],
)
def test_cimd_refuses_bad_documents(
    harness: Any, monkeypatch: pytest.MonkeyPatch, document: dict[str, Any], status: int
) -> None:
    """Refuse a document that names another ID, a secret, a bad redirect, or that fails."""
    client, _store = harness
    _use_cimd(monkeypatch, _cimd_transport(document, status))
    resp = client.post("/oauth/consent/describe", json={"client_id": CIMD_URL, "redirect_uri": REDIRECT, "scope": ""})
    assert resp.status_code == 400
    assert resp.json()["code"] == "mcp.invalid_client"


def test_cimd_refuses_large_documents(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Stop reading a metadata document after 16 KiB."""
    client, _store = harness
    _use_cimd(monkeypatch, _cimd_transport(_cimd_document(client_name="x" * 20_000)))
    resp = client.post("/oauth/consent/describe", json={"client_id": CIMD_URL, "redirect_uri": REDIRECT, "scope": ""})
    assert resp.status_code == 400


def test_cimd_failure_is_cached(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Remember a failed metadata document fetch for a short time, so a retry does not fetch again."""
    client, _store = harness
    transport = _cimd_transport(_cimd_document(), 404)
    _use_cimd(monkeypatch, transport)
    for _ in range(2):
        resp = client.post(
            "/oauth/consent/describe", json={"client_id": CIMD_URL, "redirect_uri": REDIRECT, "scope": ""}
        )
        assert resp.status_code == 400
    assert transport.calls == [CIMD_URL]  # type: ignore[attr-defined]


def test_describe_is_rate_limited_per_user(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Limit consent descriptions per account, because each one can start a metadata document fetch."""
    client, _store = harness
    redis = fakeredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(mcp_oauth_router, "shared_redis_client", lambda: redis)
    body = {"client_id": "mcpc_unknown", "redirect_uri": REDIRECT, "scope": ""}
    statuses = [client.post("/oauth/consent/describe", json=body).status_code for _ in range(61)]
    assert statuses[:60] == [400] * 60
    assert statuses[60] == 429


def test_cimd_fetches_are_capped(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Refuse a new fetch while the cap is full, and do not cache that refusal."""
    _client, _store = harness
    transport = _cimd_transport(_cimd_document())
    _use_cimd(monkeypatch, transport)
    monkeypatch.setattr(mcp_oauth, "_cimd_fetch_slots", threading.BoundedSemaphore(1))
    assert mcp_oauth._cimd_fetch_slots.acquire(blocking=False)
    assert mcp_oauth.resolve_client(None, CIMD_URL) is None  # type: ignore[arg-type]
    assert CIMD_URL not in mcp_oauth._cimd_cache
    mcp_oauth._cimd_fetch_slots.release()
    resolved = mcp_oauth.resolve_client(None, CIMD_URL)  # type: ignore[arg-type]
    assert resolved is not None
    assert resolved.client_name == "Example Agent"
    assert transport.calls == [CIMD_URL]  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    "client_id", ["https://" + "a" * 64 + ".example/client.json", "https://a..example/client.json"]
)
def test_cimd_refuses_bad_idna_hosts(harness: Any, client_id: str) -> None:
    """Answer a host name that IDNA cannot encode with invalid_client, not a server error."""
    client, _store = harness
    resp = client.post("/oauth/consent/describe", json={"client_id": client_id, "redirect_uri": REDIRECT, "scope": ""})
    assert resp.status_code == 400
    assert resp.json()["code"] == "mcp.invalid_client"


def test_cimd_refuses_hosts_that_only_idna_2003_accepts(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Answer invalid_client when DNS resolves a host that httpx refuses as a URL."""
    client, _store = harness
    client_id = "https://\u2603.example/client.json"
    transport = _cimd_transport(_cimd_document(client_id=client_id))
    _use_cimd(monkeypatch, transport)
    resp = client.post("/oauth/consent/describe", json={"client_id": client_id, "redirect_uri": REDIRECT, "scope": ""})
    assert resp.status_code == 400
    assert resp.json()["code"] == "mcp.invalid_client"
    assert transport.calls == []  # type: ignore[attr-defined]


def test_cimd_checks_the_host_that_httpx_connects_to(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Resolve the UTS 46 host, not the IDNA 2003 one that maps "\u00df" to "ss"."""
    client, _store = harness
    client_id = "https://gla\u00dfdoor.example/client.json"
    transport = _cimd_transport(_cimd_document(client_id=client_id))
    _use_cimd(monkeypatch, transport)
    resolved: list[str] = []
    monkeypatch.setattr(mcp_oauth, "_resolve_host", lambda host, port: resolved.append(host) or ["93.184.216.34"])
    client.post("/oauth/consent/describe", json={"client_id": client_id, "redirect_uri": REDIRECT, "scope": ""})
    assert resolved == ["xn--gladoor-2va.example"]


def test_cimd_fetch_refuses_a_private_peer(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """Close the connection when DNS changed to a private address after the check."""
    context = _self_signed_tls_context(tmp_path)
    listener = socket.create_server(("127.0.0.1", 0))
    received: list[bytes] = []

    def serve() -> None:
        """Record what one client sends after the TLS handshake."""
        conn, _ = listener.accept()
        try:
            with context.wrap_socket(conn, server_side=True) as tls:
                received.append(tls.recv(4096))
        except OSError:
            return

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    monkeypatch.setattr(mcp_oauth, "_resolve_host", lambda host, port: ["93.184.216.34"])
    monkeypatch.setattr(mcp_oauth, "_http_client", lambda: httpx.Client(timeout=5.0, verify=False))
    try:
        result = mcp_oauth._fetch_metadata_document(f"https://localhost:{listener.getsockname()[1]}/client.json")
        thread.join(5)
    finally:
        listener.close()
    assert result is None
    assert not any(received)


def _self_signed_tls_context(directory: Any) -> ssl.SSLContext:
    """Return a server TLS context with a fresh self-signed localhost certificate.

    Args:
        directory: Temporary directory for the key and certificate files.

    Returns:
        The server context.
    """
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(hours=1))
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = directory / "cert.pem", directory / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    return context


@pytest.mark.parametrize(
    "head",
    [b"HTTP/1.1 200 OK\r\n", b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n"],
    ids=["headers", "body"],
)
def test_cimd_fetch_has_a_total_deadline(monkeypatch: pytest.MonkeyPatch, tmp_path: Any, head: bytes) -> None:
    """Stop a metadata document fetch from a server that sends one byte at a time."""
    context = _self_signed_tls_context(tmp_path)
    listener = socket.create_server(("127.0.0.1", 0))
    done = threading.Event()

    def drip() -> None:
        """Answer one request, then send one byte every 0.2 s until the client goes."""
        conn, _ = listener.accept()
        with context.wrap_socket(conn, server_side=True) as tls:
            tls.recv(4096)
            tls.sendall(head)
            while not done.wait(0.2):
                try:
                    tls.sendall(b"X")
                except OSError:
                    return

    threading.Thread(target=drip, daemon=True).start()
    monkeypatch.setattr(mcp_oauth, "_CIMD_DEADLINE_SECONDS", 1.0)
    monkeypatch.setattr(mcp_oauth, "_resolve_host", lambda host, port: ["93.184.216.34"])
    monkeypatch.setattr(mcp_oauth, "_peer_is_public", lambda sock: True)
    monkeypatch.setattr(mcp_oauth, "_http_client", lambda: httpx.Client(timeout=5.0, verify=False))
    started = time.monotonic()
    try:
        result = mcp_oauth._fetch_metadata_document(f"https://localhost:{listener.getsockname()[1]}/client.json")
    finally:
        done.set()
        listener.close()
    assert result is None
    assert time.monotonic() - started < 3.0
