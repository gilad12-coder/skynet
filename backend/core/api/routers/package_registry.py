"""Persist the authenticated caller's Python package index preference."""

from __future__ import annotations

from typing import Annotated, Any
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from ...storage.models import PackageRegistryPreferenceModel
from ..auth import AuthenticatedUser, get_authenticated_user

DEFAULT_PACKAGE_INDEX = "https://pypi.org/simple"
AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]


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

    return router
