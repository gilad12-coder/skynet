"""Persist the authenticated caller's Python package index preference."""

from __future__ import annotations

from typing import Annotated, Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy.orm import Session

from ...storage.models import PackageRegistryPreferenceModel
from ..auth import AuthenticatedUser, get_authenticated_user

DEFAULT_PACKAGE_INDEX = "https://pypi.org/simple"
AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]

# A reachability probe fetches this project's simple-index page. pip ships with
# every Python and is present on any mirror worth pointing at, so its page is a
# stable sentinel for "this index is alive and serves the simple API."
_SENTINEL_PROJECT = "pip"
_SIMPLE_INDEX_ACCEPT = "application/vnd.pypi.simple.v1+json, text/html;q=0.9"
# The probe sends no credentials, so following redirects (as pip itself does)
# leaks nothing and correctly reads a mirror that canonicalizes its URLs.
_PROBE_TIMEOUT_SECONDS = 6.0


class PackageRegistryPreference(BaseModel):
    index_url: str = Field(default=DEFAULT_PACKAGE_INDEX, max_length=2048)

    @field_validator("index_url")
    @classmethod
    def validate_index(cls, value: str) -> str:
        """Normalize a package index without storing credentials in a URL.

        Args:
            value: User-supplied simple-index URL, or blank to restore PyPI.

        Returns:
            HTTPS URL with a normalized host and no trailing slash.
        """
        value = value.strip()
        if not value:
            return DEFAULT_PACKAGE_INDEX
        parts = urlsplit(value)
        if (
            parts.scheme != "https"
            or not parts.hostname
            or parts.username is not None
            or parts.password is not None
            or parts.query
            or parts.fragment
            or any(char.isspace() or ord(char) < 32 for char in value)
            or "\\" in value
        ):
            raise ValueError("Use an HTTPS package index URL without credentials, query parameters, or fragments.")
        # Parsing the port rejects malformed values before this setting reaches a resolver.
        if parts.port is not None and not 1 <= parts.port <= 65535:
            raise ValueError("Use a valid HTTPS port.")
        return urlunsplit(("https", parts.netloc.lower(), parts.path.rstrip("/"), "", ""))


def package_registry_for(session: Session, username: str) -> PackageRegistryPreference:
    """Read the effective index for one account without creating default rows.

    Args:
        session: Caller-owned database session.
        username: Authenticated account identity.

    Returns:
        Stored package index or the public PyPI default.
    """
    row = session.get(PackageRegistryPreferenceModel, username)
    return PackageRegistryPreference(index_url=row.index_url) if row else PackageRegistryPreference()


# The verdict a reachability probe returns to the settings UI. ``reason`` is a
# stable slug the client maps to a message; ``status_code`` carries the exact
# HTTP status so a failure can name the precise cause (e.g. "HTTP 404").
class PackageRegistryCheck(BaseModel):
    ok: bool = Field(description="Whether the index is reachable and serves the simple API.")
    reason: str = Field(description="Stable outcome slug the client maps to a message.")
    status_code: int | None = Field(default=None, description="HTTP status of the probe, when a response arrived.")


# The URL to probe. Validation runs inside the handler so a malformed URL comes
# back as a structured reason the result card can show, not a 422 it can't read.
class PackageRegistryCheckRequest(BaseModel):
    index_url: str = Field(default=DEFAULT_PACKAGE_INDEX, max_length=2048)


def _looks_like_simple_index(response: httpx.Response) -> bool:
    """Judge whether a probe response is a PEP 503/691 simple-index page.

    Args:
        response: The sentinel project's fetched page.

    Returns:
        True when the body carries the JSON ``files`` array or the HTML
        distribution anchors a simple index is required to list.
    """
    if "json" in response.headers.get("content-type", "").lower():
        try:
            payload = response.json()
        except ValueError:
            return False
        return isinstance(payload, dict) and "files" in payload
    return "<a " in response.text.lower()


def probe_package_index(index_url: str) -> PackageRegistryCheck:
    """Fetch the sentinel project's page and classify the index's health.

    Args:
        index_url: Normalized HTTPS simple-index root.

    Returns:
        A verdict separating a healthy index from an auth wall, a non-index URL,
        a timeout, and an unreachable host, carrying the HTTP status whenever a
        response arrived so the caller can name the exact failure.
    """
    sentinel = f"{index_url}/{_SENTINEL_PROJECT}/"
    try:
        response = httpx.get(
            sentinel,
            headers={"Accept": _SIMPLE_INDEX_ACCEPT},
            timeout=_PROBE_TIMEOUT_SECONDS,
            follow_redirects=True,
        )
    except httpx.TimeoutException:
        return PackageRegistryCheck(ok=False, reason="timeout")
    except httpx.HTTPError:
        return PackageRegistryCheck(ok=False, reason="unreachable")
    status = response.status_code
    if status in (401, 403):
        return PackageRegistryCheck(ok=False, reason="auth_required", status_code=status)
    if status == 404:
        return PackageRegistryCheck(ok=False, reason="not_an_index", status_code=status)
    if status >= 400:
        return PackageRegistryCheck(ok=False, reason="bad_status", status_code=status)
    if not _looks_like_simple_index(response):
        return PackageRegistryCheck(ok=False, reason="not_an_index", status_code=status)
    return PackageRegistryCheck(ok=True, reason="healthy", status_code=status)


def create_package_registry_router(*, job_store: Any) -> APIRouter:
    """Build account-scoped package registry settings routes.

    Args:
        job_store: Store whose database persists account preferences.

    Returns:
        Authenticated read and update routes.
    """
    router = APIRouter()

    @router.get("/account/package-registry", response_model=PackageRegistryPreference)
    def get_registry(user: AuthenticatedUserDep) -> PackageRegistryPreference:
        """Read the caller's package index.

        Args:
            user: Authenticated preference owner.

        Returns:
            Effective registry configuration.
        """
        with Session(job_store.engine) as session:
            return package_registry_for(session, user.username)

    @router.put("/account/package-registry", response_model=PackageRegistryPreference)
    def put_registry(body: PackageRegistryPreference, user: AuthenticatedUserDep) -> PackageRegistryPreference:
        """Save the caller's package index or reset it to PyPI.

        Args:
            body: Validated registry configuration.
            user: Authenticated preference owner.

        Returns:
            Persisted registry configuration.
        """
        with Session(job_store.engine) as session:
            session.merge(PackageRegistryPreferenceModel(username=user.username, index_url=body.index_url))
            session.commit()
        return body

    @router.post("/account/package-registry/check", response_model=PackageRegistryCheck)
    def check_registry(body: PackageRegistryCheckRequest, user: AuthenticatedUserDep) -> PackageRegistryCheck:
        """Probe a candidate index for reachability before the caller commits it.

        Args:
            body: Candidate index URL, validated here so a bad URL returns a
                structured reason rather than a request-validation error.
            user: Authenticated caller; gates the probe behind a session.

        Returns:
            A pass/fail verdict that names the exact cause when unhealthy.
        """
        try:
            preference = PackageRegistryPreference(index_url=body.index_url)
        except ValidationError:
            return PackageRegistryCheck(ok=False, reason="invalid_url")
        return probe_package_index(preference.index_url)

    return router
