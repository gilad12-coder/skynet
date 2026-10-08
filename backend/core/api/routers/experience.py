"""Authenticated abstraction-level and onboarding-intake endpoints. [INTERNAL]"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from ...storage.models import UserModel
from ..auth import AuthenticatedUser, get_authenticated_user

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]

ExperienceLevel = Literal["guided", "standard", "expert"]
EXPERIENCE_LEVELS = frozenset({"guided", "standard", "expert"})
# The original sign-up form's vocabulary, still sent by older clients.
_LEGACY_EXPERIENCE_LEVELS = {"new": "guided", "familiar": "standard"}
INTAKE_MAX_BYTES = 16 * 1024


def normalize_experience_level(value: str | None) -> str | None:
    """Map a sign-up or abstraction-level choice onto the stored vocabulary.

    Args:
        value: Raw level from a client (``guided``/``standard``/``expert`` or
            the legacy ``new``/``familiar``).

    Returns:
        The stored level, or ``None`` for a blank or unknown value.
    """
    cleaned = (value or "").strip()
    cleaned = _LEGACY_EXPERIENCE_LEVELS.get(cleaned, cleaned)
    return cleaned if cleaned in EXPERIENCE_LEVELS else None


class ExperienceProfileResponse(BaseModel):
    level: ExperienceLevel | None = Field(description="How much of the product surface the UI shows.")
    intake_completed: bool = Field(description="Whether the caller finished the onboarding intake.")
    intake: dict[str, Any] | None = Field(description="Answers captured by the onboarding intake.")


class ExperienceProfileUpdate(BaseModel):
    level: ExperienceLevel | None = Field(default=None)
    intake: dict[str, Any] | None = Field(default=None)
    intake_completed: bool | None = Field(
        default=None,
        description="True stamps the intake as finished; false clears it so the intake runs again.",
    )

    @field_validator("intake")
    @classmethod
    def _cap_intake_size(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        """Reject intake answers larger than :data:`INTAKE_MAX_BYTES` once serialized.

        Args:
            value: Intake answers from the request.

        Returns:
            The unchanged answers.

        Raises:
            ValueError: When the serialized answers exceed the cap.
        """
        if value is not None and len(json.dumps(value, ensure_ascii=False).encode()) > INTAKE_MAX_BYTES:
            raise ValueError(f"intake must serialize to at most {INTAKE_MAX_BYTES} bytes")
        return value


def _response(row: UserModel | None) -> ExperienceProfileResponse:
    """Render the caller's stored profile, or the empty profile when no account row exists.

    Args:
        row: The caller's account row, if any.

    Returns:
        The experience profile response.
    """
    if row is None:
        return ExperienceProfileResponse(level=None, intake_completed=False, intake=None)
    return ExperienceProfileResponse(
        level=normalize_experience_level(row.experience_level),
        intake_completed=row.intake_completed_at is not None,
        intake=row.intake_profile,
    )


def create_experience_router(*, job_store) -> APIRouter:
    """Build the caller-scoped abstraction-level router.

    Args:
        job_store: Job-store instance whose ORM engine persists accounts.

    Returns:
        A router exposing get and patch operations for the authenticated caller.
    """
    router = APIRouter()

    @router.get(
        "/account/experience",
        response_model=ExperienceProfileResponse,
        summary="Read the caller's abstraction level and onboarding intake",
    )
    def get_experience(user: AuthenticatedUserDep) -> ExperienceProfileResponse:
        """Return the caller's abstraction level and intake state.

        Args:
            user: Authenticated caller.

        Returns:
            The stored profile, or an empty one for an identity with no account row.
        """
        with Session(job_store.engine) as session:
            return _response(session.get(UserModel, user.username))

    @router.patch(
        "/account/experience",
        response_model=ExperienceProfileResponse,
        summary="Update the caller's abstraction level and onboarding intake",
    )
    def update_experience(body: ExperienceProfileUpdate, user: AuthenticatedUserDep) -> ExperienceProfileResponse:
        """Persist the supplied level, intake answers and intake completion.

        Args:
            body: Partial profile changes.
            user: Authenticated caller.

        Returns:
            The profile after the update.
        """
        with Session(job_store.engine) as session:
            row = session.get(UserModel, user.username)
            if row is None:
                # Every OAuth/SSO sign-in already mirrors a row like this one;
                # only identities that never went through sign-in (API tokens,
                # dev auth) reach here, and an empty hash never verifies.
                row = UserModel(email=user.username, name=user.username, password_hash="", email_verified=True)
                session.add(row)
            if body.level is not None:
                row.experience_level = body.level
            if body.intake is not None:
                row.intake_profile = body.intake
            if body.intake_completed is True:
                row.intake_completed_at = datetime.now(UTC)
            elif body.intake_completed is False:
                row.intake_completed_at = None
            session.commit()
            session.refresh(row)
            return _response(row)

    return router
