"""OAuth 2.1 authorization server of the hosted remote MCP server (SKY-229).

The protocol endpoints follow RFC 9728 (protected resource metadata), RFC 8414
(authorization server metadata), RFC 7591 (dynamic client registration),
RFC 7009 (revocation) and RFC 9207 (``iss`` on the authorization response).
They are left out of the OpenAPI schema; their shapes are fixed by the RFCs.

``/oauth/authorize`` validates the request, then sends the browser to the
hosted consent page ``/mcp/authorize``. The page calls ``/oauth/consent`` with
the session JWT, like the Mac link consent page, and follows the returned
redirect back to the client. ``/oauth/authorize`` shows an invalid request as
an error and never redirects it: anyone can register a client, so its redirect
is not trusted before the user sees consent (RFC 9700 section 4.11.2).
"""

from __future__ import annotations

import json
import re
import secrets
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ...config import settings
from ...storage.models import McpAuthCodeModel, McpGrantModel, McpOAuthClientModel, McpTokenModel, UserModel
from ..auth import AuthenticatedUser, get_authenticated_user, hash_api_token
from ..desktop_auth import as_utc
from ..errors import DomainError
from ..mcp_oauth import (
    ACCESS_TOKEN_TTL,
    AUTH_CODE_TTL,
    GRANT_ABSOLUTE_TTL,
    MAX_REDIRECT_URIS,
    MCP_SCOPES,
    REFRESH_TOKEN_IDLE_TTL,
    TOKEN_KIND_ACCESS,
    TOKEN_KIND_REFRESH,
    McpClient,
    canonical_scopes,
    clean_client_name,
    generate_token,
    grant_is_live,
    issuer_url,
    redirect_uri_is_valid,
    redirect_uri_matches,
    require_resource_url,
    resolve_client,
    revoke_grant,
    s256,
)
from ..rate_limit import RateLimiter, shared_redis_client
from .desktop_link import _client_address

_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_VERIFIER = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
_NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]
FormField = Annotated[str, Form()]


# Consent-page request to show who asks for access; sent with the session JWT.
class McpConsentDescribeRequest(BaseModel):
    client_id: str = Field(max_length=512)
    redirect_uri: str = Field(max_length=512)
    scope: str = Field(default="", max_length=255)


class McpConsentDescription(BaseModel):
    client_name: str
    client_host: str | None = Field(description="Host of a metadata-document client ID, else null.")
    redirect_host: str
    scopes: list[str]


# Consent-page decision; sent with the session JWT.
class McpConsentRequest(BaseModel):
    client_id: str = Field(max_length=512)
    redirect_uri: str = Field(max_length=512)
    code_challenge: str = Field(max_length=64)
    code_challenge_method: Literal["S256"]
    scope: str = Field(default="", max_length=255)
    state: str | None = Field(default=None, max_length=1024)
    resource: str | None = Field(default=None, max_length=512)
    decision: Literal["approve", "deny"]


class McpConsentResponse(BaseModel):
    redirect_url: str


def _limit(key: str, *, limit: int, window_seconds: int) -> None:
    """Apply the shared Redis rate limiter to ``key``.

    Args:
        key: Caller-scoped limiter key.
        limit: Maximum hits in the window.
        window_seconds: Window length in seconds.

    Raises:
        DomainError: 429 ``rate_limit.exceeded`` over the limit.
    """
    RateLimiter(shared_redis_client()).enforce(key, limit=limit, window_seconds=window_seconds)


def _oauth_error(error: str, status: int = 400, description: str | None = None) -> JSONResponse:
    """Return an RFC 6749 error response.

    Args:
        error: OAuth error code.
        status: HTTP status.
        description: Optional human-readable detail.

    Returns:
        The JSON error response, never cached.
    """
    content: dict[str, str] = {"error": error}
    if description:
        content["error_description"] = description
    return JSONResponse(status_code=status, content=content, headers=_NO_STORE)


def _with_query(uri: str, params: dict[str, str | None]) -> str:
    """Append query parameters to ``uri``, keeping any query it has.

    Args:
        uri: Base URI.
        params: Parameters; ``None`` values are left out.

    Returns:
        The URI with the parameters appended.
    """
    query = urlencode({key: value for key, value in params.items() if value is not None})
    return f"{uri}{'&' if urlsplit(uri).query else '?'}{query}"


def _display_host(url: str) -> str:
    """Return the host and port of ``url``.

    Validation accepts only ASCII hosts, so the text is the host the browser
    opens.

    Args:
        url: A validated client ID or redirect URI.

    Returns:
        The ``host[:port]`` text to show.
    """
    return urlsplit(url).netloc


def _require_session(request: Request) -> None:
    """Refuse a personal access token on a browser-session route.

    Args:
        request: Incoming request, after ``get_authenticated_user`` ran.

    Raises:
        DomainError: 403 ``mcp.session_required`` for a ``skyd_`` caller.
    """
    if getattr(request.state, "auth_channel", None) == "api_token":
        raise DomainError("mcp.session_required", status=403)


def _check_resource(resource: str | None) -> bool:
    """Return whether an RFC 8707 ``resource`` parameter names this server.

    Args:
        resource: The parameter, or ``None`` when the client sent none.

    Returns:
        Whether the value is missing or equals the configured resource URL.
    """
    return resource is None or resource.rstrip("/") == require_resource_url().rstrip("/")


def _client_and_redirect(session: Session, client_id: str, redirect_uri: str) -> McpClient:
    """Resolve a client and check that ``redirect_uri`` is one of its redirects.

    Args:
        session: Open ORM session.
        client_id: Client from the request.
        redirect_uri: Redirect URI from the request.

    Returns:
        The client.

    Raises:
        DomainError: 400 ``mcp.invalid_client`` or ``mcp.invalid_redirect``.
    """
    client = resolve_client(session, client_id)
    if client is None:
        raise DomainError("mcp.invalid_client", status=400)
    if not redirect_uri_matches(client.redirect_uris, redirect_uri):
        raise DomainError("mcp.invalid_redirect", status=400)
    return client


def _mint_pair(session: Session, grant: McpGrantModel, now: datetime) -> dict[str, Any]:
    """Create an access and a refresh token for ``grant``.

    Args:
        session: Open ORM session; the caller commits.
        grant: Live grant that owns the tokens.
        now: Current UTC time.

    Returns:
        The RFC 6749 token response with the plaintext tokens.
    """
    access = generate_token(TOKEN_KIND_ACCESS)
    refresh = generate_token(TOKEN_KIND_REFRESH)
    for token, kind, ttl in (
        (access, TOKEN_KIND_ACCESS, ACCESS_TOKEN_TTL),
        (refresh, TOKEN_KIND_REFRESH, REFRESH_TOKEN_IDLE_TTL),
    ):
        session.add(
            McpTokenModel(
                token_hash=hash_api_token(token),
                grant_id=grant.id,
                kind=kind,
                created_at=now,
                expires_at=now + ttl,
            )
        )
    return {
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": int(ACCESS_TOKEN_TTL.total_seconds()),
        "refresh_token": refresh,
        "scope": grant.scopes,
    }


def create_mcp_oauth_router(*, job_store) -> APIRouter:
    """Build the OAuth router of the remote MCP server.

    Args:
        job_store: Job-store instance whose ORM engine backs the routes.

    Returns:
        A FastAPI ``APIRouter`` with the metadata, authorize, consent, token,
        registration and revocation routes.
    """
    router = APIRouter()

    def protected_resource_metadata() -> dict[str, Any]:
        """Return the RFC 9728 metadata of the MCP server.

        Returns:
            The metadata document.
        """
        return {
            "resource": require_resource_url(),
            "authorization_servers": [issuer_url()],
            "scopes_supported": list(MCP_SCOPES),
            "bearer_methods_supported": ["header"],
            "resource_name": "Skynet",
        }

    @router.get("/.well-known/oauth-protected-resource", include_in_schema=False)
    def resource_metadata_root() -> dict[str, Any]:
        """Serve the protected resource metadata at the host root."""
        return protected_resource_metadata()

    @router.get("/.well-known/oauth-protected-resource/{path:path}", include_in_schema=False)
    def resource_metadata_path(path: str) -> dict[str, Any]:
        """Serve the protected resource metadata under the resource path (RFC 9728 section 3.1).

        Args:
            path: Path of the resource URL.

        Returns:
            The metadata document.
        """
        return protected_resource_metadata()

    @router.get("/.well-known/oauth-authorization-server", include_in_schema=False)
    def authorization_server_metadata() -> dict[str, Any]:
        """Return the RFC 8414 authorization server metadata.

        Returns:
            The metadata document.
        """
        issuer = issuer_url()
        return {
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/oauth/authorize",
            "token_endpoint": f"{issuer}/oauth/token",
            "registration_endpoint": f"{issuer}/oauth/register",
            "revocation_endpoint": f"{issuer}/oauth/revoke",
            "scopes_supported": list(MCP_SCOPES),
            "response_types_supported": ["code"],
            "response_modes_supported": ["query"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "revocation_endpoint_auth_methods_supported": ["none"],
            "authorization_response_iss_parameter_supported": True,
            "client_id_metadata_document_supported": True,
            "protected_resources": [require_resource_url()],
        }

    @router.get("/oauth/authorize", include_in_schema=False)
    def authorize(
        request: Request,
        client_id: str = "",
        redirect_uri: str = "",
        response_type: str = "",
        code_challenge: str = "",
        code_challenge_method: str = "",
        scope: str | None = None,
        state: str | None = None,
        resource: str | None = None,
    ) -> Any:
        """Check an authorization request and send the browser to the consent page.

        Every error is a 400 here. Anyone can register a client or host a
        metadata document, so an error redirect would make an open redirect.

        Args:
            request: Incoming request, for the per-address limit.
            client_id: Registered client ID or metadata document URL.
            redirect_uri: Where the code goes.
            response_type: Must be ``code``.
            code_challenge: PKCE S256 challenge.
            code_challenge_method: Must be ``S256``.
            scope: Space-separated MCP scopes; missing asks for all.
            state: Opaque client state, returned unchanged.
            resource: RFC 8707 resource; must name this server when sent.

        Returns:
            A 302 to the consent page, or a 400 JSON error.

        Raises:
            DomainError: 404 ``mcp.not_configured``, or 429 ``rate_limit.exceeded``
                over the per-address limit.
        """
        require_resource_url()
        # Anonymous, and a metadata document client ID starts an outbound fetch.
        _limit(f"mcp-authorize:{_client_address(request)}", limit=30, window_seconds=60)
        with Session(job_store.engine) as session:
            client = resolve_client(session, client_id)
        if client is None:
            return _oauth_error("invalid_client", description="Unknown client.")
        if not redirect_uri_matches(client.redirect_uris, redirect_uri):
            return _oauth_error("invalid_request", description="The redirect_uri is not registered for this client.")
        if response_type != "code":
            return _oauth_error("unsupported_response_type")
        if code_challenge_method != "S256" or not _CHALLENGE.match(code_challenge):
            return _oauth_error("invalid_request", description="Send an S256 code_challenge.")
        scopes = canonical_scopes(scope)
        if scopes is None:
            return _oauth_error("invalid_scope")
        if not _check_resource(resource):
            return _oauth_error("invalid_target")
        query = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "scope": scopes,
            "state": state,
            "resource": resource,
        }
        return RedirectResponse(
            _with_query(f"{settings.app_public_url.rstrip('/')}/mcp/authorize", query), status_code=302
        )

    @router.post(
        "/oauth/consent/describe",
        response_model=McpConsentDescription,
        summary="Describe the client that asks for MCP access",
    )
    def describe_consent(
        body: McpConsentDescribeRequest, request: Request, user: AuthenticatedUserDep
    ) -> McpConsentDescription:
        """Return what the consent page shows: client, redirect host and scopes.

        Args:
            body: Client and redirect from the authorization request.
            request: Incoming request; tells a session JWT from a PAT.
            user: Signed-in user who sees the page.

        Returns:
            The client name, its host, the redirect host and the scopes.

        Raises:
            DomainError: 403 ``mcp.session_required``, 404 ``mcp.not_configured``,
                400 ``mcp.invalid_client``, ``mcp.invalid_redirect`` or
                ``mcp.invalid_scope``, or 429.
        """
        _require_session(request)
        require_resource_url()
        _limit(f"mcp-consent-describe:{user.username}", limit=60, window_seconds=3600)
        with Session(job_store.engine) as session:
            client = _client_and_redirect(session, body.client_id, body.redirect_uri)
        scopes = canonical_scopes(body.scope)
        if scopes is None:
            raise DomainError("mcp.invalid_scope", status=400)
        return McpConsentDescription(
            client_name=client.client_name,
            client_host=_display_host(client.client_id) if client.is_metadata_document else None,
            redirect_host=_display_host(body.redirect_uri),
            scopes=scopes.split(),
        )

    @router.post(
        "/oauth/consent",
        response_model=McpConsentResponse,
        summary="Approve or deny MCP access and return the client redirect",
    )
    def consent(body: McpConsentRequest, request: Request, user: AuthenticatedUserDep) -> McpConsentResponse:
        """Record the user's decision and return the redirect back to the client.

        Args:
            body: The authorization request and the decision.
            request: Incoming request; tells a session JWT from a PAT.
            user: Signed-in user who decides.

        Returns:
            The client redirect, with a code or with ``error=access_denied``.

        Raises:
            DomainError: 403 ``mcp.session_required``, 404 ``mcp.not_configured``,
                400 ``mcp.invalid_client``, ``mcp.invalid_redirect``,
                ``mcp.invalid_scope`` or ``mcp.invalid_request``, 401
                ``auth.invalid_token`` when the account is gone, or 429.
        """
        _require_session(request)
        resource = require_resource_url()
        issuer = issuer_url()
        _limit(f"mcp-consent:{user.username}", limit=30, window_seconds=3600)
        scopes = canonical_scopes(body.scope)
        if scopes is None:
            raise DomainError("mcp.invalid_scope", status=400)
        if not _CHALLENGE.match(body.code_challenge) or not _check_resource(body.resource):
            raise DomainError("mcp.invalid_request", status=400)
        now = datetime.now(UTC)
        with Session(job_store.engine) as session:
            client = _client_and_redirect(session, body.client_id, body.redirect_uri)
            if body.decision == "deny":
                return McpConsentResponse(
                    redirect_url=_with_query(
                        body.redirect_uri, {"error": "access_denied", "state": body.state, "iss": issuer}
                    )
                )
            # A session JWT outlives an account deletion until it expires. The
            # lock waits for an open deletion, so no code outlives it.
            if session.get(UserModel, user.username, with_for_update=True) is None:
                raise DomainError("auth.invalid_token", status=401)
            code = secrets.token_urlsafe(32)
            session.add(
                McpAuthCodeModel(
                    code_hash=hash_api_token(code),
                    username=user.username,
                    client_id=client.client_id,
                    client_name=client.client_name,
                    redirect_uri=body.redirect_uri,
                    code_challenge=body.code_challenge,
                    scopes=scopes,
                    resource=resource,
                    created_at=now,
                    expires_at=now + AUTH_CODE_TTL,
                )
            )
            session.commit()
        return McpConsentResponse(
            redirect_url=_with_query(body.redirect_uri, {"code": code, "state": body.state, "iss": issuer})
        )

    def exchange_code(
        request: Request, code: str, code_verifier: str, redirect_uri: str, client_id: str, resource: str | None
    ) -> JSONResponse:
        """Run the ``authorization_code`` grant.

        Args:
            request: Incoming request, for the per-address limit.
            code: Authorization code.
            code_verifier: PKCE verifier.
            redirect_uri: Redirect URI of the authorization request.
            client_id: Client that got the code.
            resource: Optional RFC 8707 resource.

        Returns:
            The token response, or an OAuth error.
        """
        _limit(f"mcp-token-code:{_client_address(request)}", limit=30, window_seconds=60)
        if not _check_resource(resource):
            return _oauth_error("invalid_target")
        now = datetime.now(UTC)
        code_hash = hash_api_token(code)
        with Session(job_store.engine) as session:
            row = session.get(McpAuthCodeModel, code_hash)
            if row is None:
                return _oauth_error("invalid_grant")
            # User row, then code: the account deletion takes the user lock
            # first, so the opposite order deadlocks.
            owner = session.get(UserModel, row.username, with_for_update=True)
            row = session.get(McpAuthCodeModel, code_hash, with_for_update=True, populate_existing=True)
            if row is None:
                return _oauth_error("invalid_grant")
            if row.used_at is not None:
                # A replayed code means someone else holds it: end what it made.
                if row.grant_id is not None:
                    revoke_grant(session, row.grant_id, now)
                    session.commit()
                return _oauth_error("invalid_grant")
            matches = (
                bool(_VERIFIER.match(code_verifier))
                and client_id == row.client_id
                and redirect_uri == row.redirect_uri
                and secrets.compare_digest(s256(code_verifier), row.code_challenge)
            )
            # Any wrong attempt spends the code, so a verifier cannot be guessed.
            row.used_at = now
            if not matches or as_utc(row.expires_at) <= now or owner is None or row.resource != require_resource_url():
                session.commit()
                return _oauth_error("invalid_grant")
            grant = McpGrantModel(
                id=f"mg_{uuid.uuid4()}",
                username=row.username,
                client_id=row.client_id,
                client_name=row.client_name,
                scopes=row.scopes,
                resource=row.resource,
                created_at=now,
                absolute_expires_at=now + GRANT_ABSOLUTE_TTL,
            )
            session.add(grant)
            row.grant_id = grant.id
            response = _mint_pair(session, grant, now)
            session.commit()
        return JSONResponse(response, headers=_NO_STORE)

    def refresh_pair(refresh_token: str, client_id: str, resource: str | None) -> JSONResponse:
        """Run the ``refresh_token`` grant with rotation and reuse detection.

        A second use of a rotated refresh token revokes the whole grant.

        Args:
            refresh_token: Refresh token.
            client_id: Client ID; must match the grant when sent.
            resource: Optional RFC 8707 resource.

        Returns:
            The new token pair, or an OAuth error.
        """
        if not _check_resource(resource):
            return _oauth_error("invalid_target")
        now = datetime.now(UTC)
        token_hash = hash_api_token(refresh_token)
        with Session(job_store.engine) as session:
            row = session.get(McpTokenModel, token_hash)
            if row is None or row.kind != TOKEN_KIND_REFRESH:
                return _oauth_error("invalid_grant")
            # Grant, then token, so every refresh of one grant runs in turn.
            grant = session.get(McpGrantModel, row.grant_id, with_for_update=True)
            row = session.get(McpTokenModel, token_hash, with_for_update=True, populate_existing=True)
            if not grant_is_live(grant, now) or row is None:
                return _oauth_error("invalid_grant")
            if client_id and client_id != grant.client_id:
                return _oauth_error("invalid_grant")
            _limit(f"mcp-token-refresh:{grant.id}", limit=60, window_seconds=3600)
            if row.used_at is not None:
                revoke_grant(session, grant.id, now)
                session.commit()
                return _oauth_error("invalid_grant")
            if as_utc(row.expires_at) <= now or grant.resource != require_resource_url():
                return _oauth_error("invalid_grant")
            row.used_at = now
            response = _mint_pair(session, grant, now)
            session.commit()
        return JSONResponse(response, headers=_NO_STORE)

    @router.post("/oauth/token", include_in_schema=False)
    def token(
        request: Request,
        grant_type: FormField = "",
        code: FormField = "",
        code_verifier: FormField = "",
        redirect_uri: FormField = "",
        client_id: FormField = "",
        refresh_token: FormField = "",
        resource: Annotated[str | None, Form()] = None,
    ) -> JSONResponse:
        """Run the token endpoint for public clients (form-urlencoded body).

        Args:
            request: Incoming request.
            grant_type: ``authorization_code`` or ``refresh_token``.
            code: Authorization code.
            code_verifier: PKCE verifier.
            redirect_uri: Redirect URI of the authorization request.
            client_id: Client ID.
            refresh_token: Refresh token.
            resource: Optional RFC 8707 resource.

        Returns:
            The token response, or an OAuth error.
        """
        require_resource_url()
        if grant_type == "authorization_code":
            if not code or not code_verifier or not redirect_uri or not client_id:
                return _oauth_error("invalid_request")
            return exchange_code(request, code, code_verifier, redirect_uri, client_id, resource)
        if grant_type == "refresh_token":
            if not refresh_token:
                return _oauth_error("invalid_request")
            return refresh_pair(refresh_token, client_id, resource)
        return _oauth_error("unsupported_grant_type")

    def register_client(metadata: dict[str, Any]) -> JSONResponse:
        """Validate RFC 7591 client metadata and store the new client.

        Args:
            metadata: The registration request.

        Returns:
            201 with the client information, or a 400 registration error.
        """
        uris = metadata.get("redirect_uris")
        if not isinstance(uris, list) or not 1 <= len(uris) <= MAX_REDIRECT_URIS:
            return _oauth_error("invalid_redirect_uri", description="Send 1 to 10 redirect_uris.")
        if not all(redirect_uri_is_valid(uri) for uri in uris):
            return _oauth_error("invalid_redirect_uri", description="Use https, or http on a loopback host.")
        if metadata.get("token_endpoint_auth_method", "none") != "none":
            return _oauth_error("invalid_client_metadata", description="Only public clients are supported.")
        grant_types = metadata.get("grant_types", ["authorization_code", "refresh_token"])
        if not isinstance(grant_types, list) or not set(grant_types) <= {"authorization_code", "refresh_token"}:
            return _oauth_error("invalid_client_metadata", description="Unsupported grant_types.")
        response_types = metadata.get("response_types", ["code"])
        if not isinstance(response_types, list) or not set(response_types) <= {"code"}:
            return _oauth_error("invalid_client_metadata", description="Unsupported response_types.")
        now = datetime.now(UTC)
        client_id = f"mcpc_{secrets.token_urlsafe(24)}"
        name = clean_client_name(metadata.get("client_name"), "MCP client")
        with Session(job_store.engine) as session:
            session.add(
                McpOAuthClientModel(
                    client_id=client_id, client_name=name, redirect_uris=json.dumps(uris), created_at=now
                )
            )
            session.commit()
        return JSONResponse(
            status_code=201,
            headers=_NO_STORE,
            content={
                "client_id": client_id,
                "client_id_issued_at": int(now.timestamp()),
                "client_name": name,
                "redirect_uris": uris,
                "grant_types": grant_types,
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            },
        )

    @router.post("/oauth/register", include_in_schema=False)
    async def register(request: Request) -> JSONResponse:
        """Register a public MCP client (RFC 7591).

        Args:
            request: Incoming request with a JSON body.

        Returns:
            201 with the client information, or a 400 registration error.
        """
        require_resource_url()
        _limit(f"mcp-register:{_client_address(request)}", limit=20, window_seconds=3600)
        try:
            metadata = await request.json()
        except ValueError:
            return _oauth_error("invalid_client_metadata", description="The body must be JSON.")
        if not isinstance(metadata, dict):
            return _oauth_error("invalid_client_metadata", description="The body must be a JSON object.")
        return await run_in_threadpool(register_client, metadata)

    @router.post("/oauth/revoke", include_in_schema=False)
    def revoke(token: FormField = "") -> JSONResponse:
        """Revoke the grant that owns an access or refresh token (RFC 7009).

        Args:
            token: The token to revoke.

        Returns:
            200 whether or not the token was known.
        """
        now = datetime.now(UTC)
        if token:
            with Session(job_store.engine) as session:
                row = session.get(McpTokenModel, hash_api_token(token))
                if row is not None:
                    revoke_grant(session, row.grant_id, now)
                    session.commit()
        return JSONResponse({}, headers=_NO_STORE)

    return router
