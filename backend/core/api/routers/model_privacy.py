"""Authenticated model data-privacy preference endpoints. [INTERNAL]"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ...billing.data_policy import DATA_POLICIES, DEFAULT_DATA_POLICY, DataPolicy
from ...storage.models import ModelPrivacyPreferenceModel
from ..auth import AuthenticatedUser, get_authenticated_user

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]


class ModelPrivacyPreference(BaseModel):
    data_policy: DataPolicy = Field(
        description=(
            "Which providers may receive prompts on platform-paid model calls: 'allow' (any provider), "
            "'deny' (only providers that neither train on nor retain prompts), or 'zdr' "
            "(zero-data-retention endpoints only). BYOK calls follow your own OpenRouter account settings."
        )
    )


def create_model_privacy_router(*, job_store) -> APIRouter:
    """Build the caller-scoped model privacy preference router.

    Args:
        job_store: Job-store instance whose ORM engine persists preferences.

    Returns:
        A router exposing get and put operations for the authenticated caller.
    """
    router = APIRouter()

    @router.get(
        "/account/model-privacy",
        response_model=ModelPrivacyPreference,
        summary="Read which model providers may receive the caller's prompts",
    )
    def get_model_privacy(user: AuthenticatedUserDep) -> ModelPrivacyPreference:
        """Return the caller's effective setting, ``deny`` when never set.

        Args:
            user: Authenticated caller whose setting is requested.

        Returns:
            The effective model data policy.
        """
        with Session(job_store.engine) as session:
            row = session.get(ModelPrivacyPreferenceModel, user.username)
        stored = row.data_policy if row is not None else DEFAULT_DATA_POLICY
        return ModelPrivacyPreference(data_policy=stored if stored in DATA_POLICIES else DEFAULT_DATA_POLICY)

    @router.put(
        "/account/model-privacy",
        response_model=ModelPrivacyPreference,
        summary="Set which model providers may receive the caller's prompts",
    )
    def put_model_privacy(body: ModelPrivacyPreference, user: AuthenticatedUserDep) -> ModelPrivacyPreference:
        """Persist the caller's setting; it applies to model calls started afterwards.

        Args:
            body: The new data policy.
            user: Authenticated caller whose setting is updated.

        Returns:
            The stored data policy.
        """
        with Session(job_store.engine) as session:
            row = session.get(ModelPrivacyPreferenceModel, user.username)
            if row is None:
                row = ModelPrivacyPreferenceModel(username=user.username)
                session.add(row)
            row.data_policy = body.data_policy
            row.updated_at = datetime.now(UTC)
            session.commit()
        return ModelPrivacyPreference(data_policy=body.data_policy)

    return router
