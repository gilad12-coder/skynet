"""Desktop link tokens: the Mac app's scoped credential for hosted (SKY-124).

A linked Mac holds an opaque ``skyl_at_`` access token and a rotating
``skyl_rt_`` refresh token. Hosted stores only their SHA-256 hashes, like the
``skyd_`` personal access tokens, so a revoke takes effect on the next call.

A desktop token never opens a normal session route:
:func:`core.api.auth.get_authenticated_user` refuses every ``skyl_`` token.
Only routes that depend on :func:`get_desktop_principal` accept it, and each
of those routes names the one scope it needs.
"""

from __future__ import annotations

import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import Header, Request
from sqlalchemy.orm import Session

from ..storage.models import DesktopLinkModel, DesktopTokenModel
from .auth import DESKTOP_TOKEN_PREFIX, hash_api_token
from .errors import DomainError
from .monthly_active_users import enforce_monthly_active_user_limit

ACCESS_TOKEN_PREFIX = f"{DESKTOP_TOKEN_PREFIX}at_"
REFRESH_TOKEN_PREFIX = f"{DESKTOP_TOKEN_PREFIX}rt_"
TOKEN_KIND_ACCESS = "access"
TOKEN_KIND_REFRESH = "refresh"
_TOKEN_SECRET_BYTES = 32

DESKTOP_SCOPES: tuple[str, ...] = ("identity", "balance:read", "sync", "models", "connectors", "web")

ACCESS_TOKEN_TTL = timedelta(hours=1)
REFRESH_TOKEN_IDLE_TTL = timedelta(days=30)
LINK_ABSOLUTE_TTL = timedelta(days=365)


@dataclass(frozen=True)
class DesktopPrincipal:
    """The hosted account behind a valid desktop access token."""

    username: str
    link_id: str
    scopes: frozenset[str]
    device_name: str


def as_utc(value: datetime) -> datetime:
    """Return ``value`` as an aware UTC datetime.

    SQLite drops the zone of ``DateTime(timezone=True)`` columns, so the unit
    tests read naive values that are UTC by construction.

    Args:
        value: Datetime read from the database.

    Returns:
        The same instant, timezone-aware in UTC.
    """
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def generate_desktop_token(kind: str) -> str:
    """Return a fresh desktop token of ``kind`` with 256 bits of entropy.

    Args:
        kind: ``"access"`` or ``"refresh"``.

    Returns:
        The plaintext token, prefixed ``skyl_at_`` or ``skyl_rt_``.
    """
    prefix = ACCESS_TOKEN_PREFIX if kind == TOKEN_KIND_ACCESS else REFRESH_TOKEN_PREFIX
    return f"{prefix}{secrets.token_urlsafe(_TOKEN_SECRET_BYTES)}"


def link_is_live(link: DesktopLinkModel, now: datetime) -> bool:
    """Return whether ``link`` is neither revoked nor past its absolute expiry.

    Args:
        link: Link row to check.
        now: Current UTC time.

    Returns:
        True when the link may still authenticate calls.
    """
    return link.revoked_at is None and as_utc(link.absolute_expires_at) > now


def _resolve_principal(request: Request, token: str, scope: str) -> DesktopPrincipal:
    """Check a desktop access token and return its principal.

    Args:
        request: Incoming request, used to reach ``app.state.job_store``.
        token: Raw bearer token.
        scope: Scope the route needs.

    Returns:
        The principal behind the token.

    Raises:
        DomainError: 401 ``auth.invalid_token`` for an unknown or non-access
            token, 401 ``desktop.token_expired``, 401 ``desktop.link_revoked``,
            403 ``desktop.scope_missing``, or 500 when no store is configured.
    """
    job_store = getattr(request.app.state, "job_store", None)
    if job_store is None:
        raise DomainError("auth.not_configured", status=500)
    if not token.startswith(ACCESS_TOKEN_PREFIX):
        raise DomainError("auth.invalid_token", status=401)
    now = datetime.now(UTC)
    with Session(job_store.engine) as session:
        row = session.get(DesktopTokenModel, hash_api_token(token))
        if row is None or row.kind != TOKEN_KIND_ACCESS:
            raise DomainError("auth.invalid_token", status=401)
        link = session.get(DesktopLinkModel, row.link_id)
        if link is None or not link_is_live(link, now):
            raise DomainError("desktop.link_revoked", status=401)
        if as_utc(row.expires_at) <= now:
            raise DomainError("desktop.token_expired", status=401)
        scopes = frozenset(link.scopes.split())
        if scope not in scopes:
            raise DomainError("desktop.scope_missing", status=403, scope=scope)
        link.last_used_at = now
        session.commit()
        principal = DesktopPrincipal(
            username=link.username,
            link_id=link.id,
            scopes=scopes,
            device_name=link.device_name,
        )
    # Admin never applies to a desktop principal, so no MAU exemption either.
    enforce_monthly_active_user_limit(job_store, principal.username)
    return principal


def get_desktop_principal(scope: str) -> Callable[..., DesktopPrincipal]:
    """Build a FastAPI dependency that accepts only a desktop token with ``scope``.

    Args:
        scope: One of :data:`DESKTOP_SCOPES`.

    Returns:
        A dependency that returns the :class:`DesktopPrincipal` and sets
        ``request.state.auth_channel = "desktop"``.

    Raises:
        ValueError: When ``scope`` is not a desktop scope (a programming error).
    """
    if scope not in DESKTOP_SCOPES:
        raise ValueError(f"unknown desktop scope: {scope}")

    def dependency(request: Request, authorization: str | None = Header(default=None)) -> DesktopPrincipal:
        """Authenticate the desktop bearer token for this route.

        Args:
            request: Incoming request.
            authorization: HTTP Authorization header.

        Returns:
            The desktop principal.

        Raises:
            DomainError: 401 when the token is missing or invalid; 403 when it
                lacks the scope.
        """
        if not authorization or not authorization.startswith("Bearer "):
            raise DomainError("auth.missing_token", status=401)
        principal = _resolve_principal(request, authorization.removeprefix("Bearer ").strip(), scope)
        request.state.auth_channel = "desktop"
        return principal

    return dependency
