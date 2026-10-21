"""A fake of the hosted desktop-link routes, for local link-client tests.

It follows the SKY-124 addendum contract (section 2.3): the link code with
PKCE S256, the token pair with ``skyl_`` prefixes, refresh rotation, revoke,
``whoami`` and ``balance``, and the RFC 9457 error bodies with a ``code``.
The hosted server (SKY-124 PR 1) is built in parallel, so these tests prove
the client against the contract, not against the real hosted routes.
"""

from __future__ import annotations

import base64
import json
import secrets
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx

API_ORIGIN = "https://api.hosted.test"
APP_ORIGIN = "https://app.hosted.test"


@dataclass
class _Code:
    """One issued link code and what it is bound to."""

    challenge: str
    redirect_uri: str
    scope: str
    used: bool = False


@dataclass
class FakeHosted:
    """In-memory hosted link server reached through an ``httpx.MockTransport``."""

    email: str = "dana@example.test"
    scopes: str = "identity balance:read sync models connectors web"
    access_ttl: int = 3600
    balance_cents: int = 1234
    reachable: bool = True
    revoked: bool = False
    codes: dict[str, _Code] = field(default_factory=dict)
    access: set[str] = field(default_factory=set)
    refresh: set[str] = field(default_factory=set)
    expired_access: set[str] = field(default_factory=set)
    calls: list[tuple[str, str]] = field(default_factory=list)
    refresh_count: int = 0
    revoke_bodies: list[dict[str, Any]] = field(default_factory=list)

    def transport(self) -> httpx.MockTransport:
        """Return a transport that routes requests to this fake.

        Returns:
            The mock transport.
        """
        return httpx.MockTransport(self._handle)

    def authorize(self, authorize_url: str) -> tuple[str, str, str]:
        """Do what the hosted consent page does after the user clicks Allow.

        Args:
            authorize_url: The URL the Mac opened in the system browser.

        Returns:
            ``(redirect_uri, code, state)``, the values the browser sends back.
        """
        query = {k: v[0] for k, v in parse_qs(urlsplit(authorize_url).query).items()}
        assert query["code_challenge_method"] == "S256"
        assert query["client_id"] == "skynet-desktop"
        code = secrets.token_urlsafe(32)
        self.codes[code] = _Code(query["code_challenge"], query["redirect_uri"], query["scope"])
        return query["redirect_uri"], code, query["state"]

    def _pair(self) -> dict[str, Any]:
        """Issue a new token pair.

        Returns:
            The token response body.
        """
        access = "skyl_at_" + secrets.token_urlsafe(32)
        refresh = "skyl_rt_" + secrets.token_urlsafe(32)
        self.access.add(access)
        self.refresh.add(refresh)
        return {
            "token_type": "Bearer",
            "access_token": access,
            "expires_in": self.access_ttl,
            "refresh_token": refresh,
            "refresh_expires_in": 2592000,
            "scope": self.scopes,
            "link_id": "dl_00000000-0000-0000-0000-000000000001",
            "account": {"email": self.email, "name": "Dana"},
        }

    @staticmethod
    def _problem(status: int, code: str) -> httpx.Response:
        """Build an RFC 9457 error like the hosted API sends.

        Args:
            status: HTTP status.
            code: Domain error code.

        Returns:
            The response.
        """
        return httpx.Response(status, json={"status": status, "code": code, "detail": code, "params": {}})

    def _token(self, body: dict[str, Any]) -> httpx.Response:
        """Answer ``POST /desktop/link/token``.

        Args:
            body: The JSON request body.

        Returns:
            The response.
        """
        if body.get("grant_type") == "authorization_code":
            entry = self.codes.get(body.get("code", ""))
            verifier = body.get("code_verifier", "")
            challenge = base64.urlsafe_b64encode(sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            if (
                entry is None
                or entry.used
                or entry.challenge != challenge
                or entry.redirect_uri != body.get("redirect_uri")
                or body.get("client_id") != "skynet-desktop"
            ):
                return self._problem(400, "desktop.invalid_grant")
            entry.used = True
            return httpx.Response(200, json=self._pair())
        if body.get("grant_type") == "refresh_token":
            if self.revoked:
                return self._problem(401, "desktop.link_revoked")
            token = body.get("refresh_token", "")
            if token not in self.refresh:
                return self._problem(400, "desktop.invalid_grant")
            self.refresh.discard(token)
            self.refresh_count += 1
            return httpx.Response(200, json=self._pair())
        return self._problem(400, "desktop.invalid_grant")

    def _bearer(self, request: httpx.Request) -> httpx.Response | None:
        """Check the desktop access token on a ``/desktop/v1`` call.

        Args:
            request: The incoming request.

        Returns:
            An error response, or ``None`` when the token is good.
        """
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        if self.revoked:
            return self._problem(401, "desktop.link_revoked")
        if token in self.expired_access:
            return self._problem(401, "desktop.token_expired")
        if token not in self.access:
            return self._problem(401, "desktop.invalid_token")
        return None

    def _handle(self, request: httpx.Request) -> httpx.Response:
        """Route one request.

        Args:
            request: The incoming request.

        Returns:
            The response.

        Raises:
            httpx.ConnectError: When the fake is set unreachable.
        """
        if not self.reachable:
            raise httpx.ConnectError("offline", request=request)
        path = request.url.path
        self.calls.append((request.method, path))
        if request.method == "POST" and path == "/desktop/link/token":
            return self._token(json.loads(request.content))
        if request.method == "POST" and path == "/desktop/link/revoke":
            self.revoke_bodies.append(json.loads(request.content))
            self.revoked = True
            return httpx.Response(200, json={})
        if request.method == "GET" and path == "/desktop/v1/whoami":
            return self._bearer(request) or httpx.Response(
                200,
                json={
                    "email": self.email,
                    "name": "Dana",
                    "link_id": "dl_00000000-0000-0000-0000-000000000001",
                    "scopes": self.scopes.split(),
                    "device_name": "Test Mac",
                },
            )
        if request.method == "GET" and path == "/desktop/v1/balance":
            return self._bearer(request) or httpx.Response(
                200, json={"available_cents": self.balance_cents, "currency": "usd", "low_balance": False}
            )
        return httpx.Response(404, json={"code": "not_found"})
