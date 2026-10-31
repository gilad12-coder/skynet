"""OAuth 2.1 pieces of the hosted remote MCP server (SKY-229).

An MCP client (Claude Code, Cursor, Codex, claude.ai) gets an opaque
``skym_at_`` access token and a rotating ``skym_rt_`` refresh token through the
authorization code flow with PKCE. Hosted stores only their SHA-256 hashes.

Every token is bound to the configured MCP resource URL
(:attr:`core.config.Settings.mcp_resource_url`). The issuer is the origin of
that URL. A token of another resource, or of an older resource URL, is refused.

A client is either registered with dynamic client registration (RFC 7591), or
names an ``https`` URL as its ``client_id``: a client ID metadata document
(CIMD), fetched here with SSRF checks.

``core.api.auth.get_authenticated_user`` never accepts a ``skym_`` token: it is
not a session JWT and has no PAT prefix. Only the remote MCP server reads it.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import secrets
import socket
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy import update
from sqlalchemy.orm import Session

from ..config import settings
from ..storage.models import McpGrantModel, McpOAuthClientModel, McpTokenModel, UserModel
from .auth import hash_api_token
from .desktop_auth import as_utc
from .errors import DomainError
from .monthly_active_users import enforce_monthly_active_user_limit

MCP_SCOPES: tuple[str, ...] = ("runs:read", "runs:write")
SCOPE_READ = "runs:read"
SCOPE_WRITE = "runs:write"

ACCESS_TOKEN_PREFIX = "skym_at_"
REFRESH_TOKEN_PREFIX = "skym_rt_"
TOKEN_KIND_ACCESS = "access"
TOKEN_KIND_REFRESH = "refresh"

ACCESS_TOKEN_TTL = timedelta(hours=1)
REFRESH_TOKEN_IDLE_TTL = timedelta(days=30)
GRANT_ABSOLUTE_TTL = timedelta(days=90)
AUTH_CODE_TTL = timedelta(minutes=5)

MAX_REDIRECT_URIS = 10
MAX_URI_LENGTH = 512
MAX_CLIENT_NAME_LENGTH = 128
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

_CIMD_MAX_BYTES = 16 * 1024
_CIMD_TIMEOUT_SECONDS = 5.0
_CIMD_CACHE_TTL_SECONDS = 300.0
_CIMD_CACHE_MAX = 256
_cimd_cache: dict[str, tuple[float, McpClient]] = {}
_cimd_lock = threading.Lock()


@dataclass(frozen=True)
class McpClient:
    """An MCP OAuth client: registered, or described by a CIMD document."""

    client_id: str
    client_name: str
    redirect_uris: tuple[str, ...]
    is_metadata_document: bool


@dataclass(frozen=True)
class McpPrincipal:
    """The account and grant behind a valid MCP access token."""

    username: str
    grant_id: str
    scopes: frozenset[str]


class McpTokenError(Exception):
    """A bearer token the MCP server refuses; maps to a 401 challenge."""


def resource_url() -> str:
    """Return the configured MCP resource URL, or ``""`` when the server is off."""
    return settings.mcp_resource_url.strip()


def require_resource_url() -> str:
    """Return the configured MCP resource URL.

    Returns:
        The resource URL.

    Raises:
        DomainError: 404 ``mcp.not_configured`` when the server is off.
    """
    url = resource_url()
    if not url:
        raise DomainError("mcp.not_configured", status=404)
    return url


def issuer_url() -> str:
    """Return the OAuth issuer: the origin of the MCP resource URL."""
    parts = urlsplit(require_resource_url())
    return f"{parts.scheme}://{parts.netloc}"


def resource_metadata_url() -> str:
    """Return the RFC 9728 protected resource metadata URL of the MCP server."""
    parts = urlsplit(require_resource_url())
    path = parts.path.rstrip("/")
    return f"{parts.scheme}://{parts.netloc}/.well-known/oauth-protected-resource{path}"


def challenge_headers() -> dict[str, str]:
    """Return the ``WWW-Authenticate`` header of a 401 from the MCP server."""
    return {"WWW-Authenticate": f'Bearer resource_metadata="{resource_metadata_url()}"'}


def s256(verifier: str) -> str:
    """Return the PKCE S256 challenge for ``verifier``."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def generate_token(kind: str) -> str:
    """Return a fresh MCP token of ``kind`` with 256 bits of entropy.

    Args:
        kind: ``"access"`` or ``"refresh"``.

    Returns:
        The plaintext token, prefixed ``skym_at_`` or ``skym_rt_``.
    """
    prefix = ACCESS_TOKEN_PREFIX if kind == TOKEN_KIND_ACCESS else REFRESH_TOKEN_PREFIX
    return f"{prefix}{secrets.token_urlsafe(32)}"


def canonical_scopes(raw: str | None) -> str | None:
    """Validate a space-separated scope string and return it in canonical order.

    Args:
        raw: The ``scope`` parameter; empty or missing asks for every scope.

    Returns:
        The scopes in :data:`MCP_SCOPES` order, or ``None`` for an unknown scope.
    """
    requested = (raw or "").split()
    if not requested:
        return " ".join(MCP_SCOPES)
    if any(scope not in MCP_SCOPES for scope in requested):
        return None
    return " ".join(scope for scope in MCP_SCOPES if scope in requested)


def _is_loopback(host: str | None) -> bool:
    """Return whether ``host`` names this machine."""
    return (host or "").lower() in _LOOPBACK_HOSTS


def redirect_uri_is_valid(uri: str) -> bool:
    """Accept an ``https`` redirect, or an ``http`` loopback one (RFC 8252).

    Args:
        uri: Redirect URI a client registers or sends.

    Returns:
        Whether the URI has an allowed form.
    """
    if not isinstance(uri, str) or len(uri) > MAX_URI_LENGTH:
        return False
    try:
        parts = urlsplit(uri)
        parts.port  # noqa: B018 - raises ValueError for a bad port.
    except ValueError:
        return False
    if parts.fragment or parts.username or parts.password or not parts.hostname:
        return False
    if parts.scheme == "https":
        return True
    return parts.scheme == "http" and _is_loopback(parts.hostname)


def redirect_uri_matches(registered: tuple[str, ...], uri: str) -> bool:
    """Return whether ``uri`` is one of the client's registered redirects.

    The match is exact, except that a loopback redirect may use any port
    (RFC 8252 section 7.3).

    Args:
        registered: The client's redirect URIs.
        uri: Redirect URI from the request.

    Returns:
        Whether the redirect is allowed for this client.
    """
    if not redirect_uri_is_valid(uri):
        return False
    if uri in registered:
        return True
    parts = urlsplit(uri)
    if parts.scheme != "http" or not _is_loopback(parts.hostname):
        return False
    for candidate in registered:
        other = urlsplit(candidate)
        if (
            other.scheme == "http"
            and other.hostname == parts.hostname
            and other.path == parts.path
            and other.query == parts.query
        ):
            return True
    return False


def clean_client_name(raw: Any, fallback: str) -> str:
    """Return a printable client name of at most 128 characters.

    Args:
        raw: Name from the registration or the metadata document.
        fallback: Name to use when ``raw`` is not a usable string.

    Returns:
        The cleaned name.
    """
    if not isinstance(raw, str):
        return fallback
    name = "".join(char for char in raw if char.isprintable()).strip()[:MAX_CLIENT_NAME_LENGTH]
    return name or fallback


def _resolve_host(host: str, port: int) -> list[str]:
    """Return every address ``host`` resolves to.

    Args:
        host: Host name of the metadata document URL.
        port: TCP port.

    Returns:
        The resolved IP addresses.
    """
    return [info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]


def _http_client() -> httpx.Client:
    """Return the HTTP client for metadata document fetches; tests replace it."""
    return httpx.Client(timeout=_CIMD_TIMEOUT_SECONDS, follow_redirects=False)


def _fetch_metadata_document(url: str) -> dict[str, Any] | None:
    """Fetch a client ID metadata document with SSRF checks.

    Only ``https`` URLs with a path are fetched. Every resolved address must be
    public, redirects are not followed, and the body is capped at 16 KiB.

    Args:
        url: The ``client_id`` URL.

    Returns:
        The parsed JSON object, or ``None`` when the URL or the fetch is refused.
    """
    try:
        parts = urlsplit(url)
        port = parts.port or 443
    except ValueError:
        return None
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.fragment
        or parts.path in ("", "/")
        or len(url) > MAX_URI_LENGTH
    ):
        return None
    try:
        addresses = _resolve_host(parts.hostname, port)
    except OSError:
        return None
    if not addresses or any(not ipaddress.ip_address(address.split("%")[0]).is_global for address in addresses):
        return None
    body = bytearray()
    try:
        with _http_client() as client, client.stream("GET", url, headers={"Accept": "application/json"}) as response:
            if response.status_code != 200:
                return None
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > _CIMD_MAX_BYTES:
                    return None
    except httpx.HTTPError:
        return None
    try:
        document = json.loads(bytes(body))
    except ValueError:
        return None
    return document if isinstance(document, dict) else None


def _client_from_document(url: str, document: dict[str, Any]) -> McpClient | None:
    """Validate a client ID metadata document.

    Args:
        url: The ``client_id`` URL the document came from.
        document: The parsed document.

    Returns:
        The client, or ``None`` when the document is not valid for ``url``.
    """
    if document.get("client_id") != url:
        return None
    if document.get("token_endpoint_auth_method", "none") != "none":
        return None
    uris = document.get("redirect_uris")
    if (
        not isinstance(uris, list)
        or not 1 <= len(uris) <= MAX_REDIRECT_URIS
        or not all(redirect_uri_is_valid(uri) for uri in uris)
    ):
        return None
    host = urlsplit(url).hostname or url
    return McpClient(
        client_id=url,
        client_name=clean_client_name(document.get("client_name"), host),
        redirect_uris=tuple(uris),
        is_metadata_document=True,
    )


def _metadata_document_client(url: str) -> McpClient | None:
    """Return the client a metadata document describes, from a short cache.

    Args:
        url: The ``client_id`` URL.

    Returns:
        The client, or ``None`` when the document cannot be used.
    """
    now = time.monotonic()
    with _cimd_lock:
        cached = _cimd_cache.get(url)
        if cached is not None and cached[0] > now:
            return cached[1]
    document = _fetch_metadata_document(url)
    client = _client_from_document(url, document) if document is not None else None
    if client is not None:
        with _cimd_lock:
            if len(_cimd_cache) >= _CIMD_CACHE_MAX:
                _cimd_cache.clear()
            _cimd_cache[url] = (now + _CIMD_CACHE_TTL_SECONDS, client)
    return client


def resolve_client(session: Session, client_id: str | None) -> McpClient | None:
    """Return the client behind ``client_id``.

    Args:
        session: Open ORM session.
        client_id: A registered client ID, or a metadata document URL.

    Returns:
        The client, or ``None`` when it is unknown or its document is refused.
    """
    if not client_id or len(client_id) > MAX_URI_LENGTH:
        return None
    if client_id.startswith("https://"):
        return _metadata_document_client(client_id)
    row = session.get(McpOAuthClientModel, client_id)
    if row is None:
        return None
    return McpClient(
        client_id=row.client_id,
        client_name=row.client_name,
        redirect_uris=tuple(json.loads(row.redirect_uris)),
        is_metadata_document=False,
    )


def grant_is_live(grant: McpGrantModel | None, now: datetime) -> bool:
    """Return whether ``grant`` exists, is not revoked, and is not expired."""
    return grant is not None and grant.revoked_at is None and as_utc(grant.absolute_expires_at) > now


def revoke_grant(session: Session, grant_id: str, now: datetime) -> None:
    """Mark a grant revoked so every token of it fails on the next call.

    Args:
        session: Open ORM session; the caller commits.
        grant_id: Grant to revoke.
        now: Current UTC time.
    """
    session.execute(
        update(McpGrantModel)
        .where(McpGrantModel.id == grant_id, McpGrantModel.revoked_at.is_(None))
        .values(revoked_at=now)
    )


def resolve_principal(job_store: Any, token: str) -> McpPrincipal:
    """Check an MCP access token and return its principal.

    The token must be a live access token of a live grant, and the grant must
    be bound to the MCP resource URL configured now (the audience check).

    Args:
        job_store: Store whose ORM engine holds the grants and tokens.
        token: Raw bearer token.

    Returns:
        The principal behind the token.

    Raises:
        McpTokenError: For any token the server refuses.
        DomainError: 503 from the monthly active user cap.
    """
    audience = resource_url()
    if not audience or not token.startswith(ACCESS_TOKEN_PREFIX):
        raise McpTokenError
    now = datetime.now(UTC)
    with Session(job_store.engine) as session:
        row = session.get(McpTokenModel, hash_api_token(token))
        if row is None or row.kind != TOKEN_KIND_ACCESS or as_utc(row.expires_at) <= now:
            raise McpTokenError
        grant = session.get(McpGrantModel, row.grant_id)
        if not grant_is_live(grant, now) or grant.resource != audience:
            raise McpTokenError
        if session.get(UserModel, grant.username) is None:
            raise McpTokenError
        principal = McpPrincipal(username=grant.username, grant_id=grant.id, scopes=frozenset(grant.scopes.split()))
        # A Core UPDATE, because account deletion can delete the grant while
        # this call runs; the ORM would raise StaleDataError.
        recorded = session.execute(
            update(McpGrantModel)
            .where(McpGrantModel.id == grant.id, McpGrantModel.revoked_at.is_(None))
            .values(last_used_at=now),
            execution_options={"synchronize_session": False},
        )
        if recorded.rowcount == 0:
            session.rollback()
            raise McpTokenError
        session.commit()
    enforce_monthly_active_user_limit(job_store, principal.username)
    return principal
