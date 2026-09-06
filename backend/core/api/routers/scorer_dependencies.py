"""Resolve scorer packages using the caller's registry and protected setup budget."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ...billing.operation_pricing import json_fingerprint
from ...config import settings
from ..auth import AuthenticatedUser, get_authenticated_user
from ..protected_preview import run_protected_preview
from ..rate_limit import enforce_submission_rate
from .package_registry import package_registry_for

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]


class ScorerDependenciesRequest(BaseModel):
    code: str = Field(max_length=200_000)
    requirements: list[str] = Field(default_factory=list, max_length=100)
    execution_budget_id: str
    execution_budget_revision: int


def create_scorer_dependencies_router(*, job_store: Any) -> APIRouter:
    """Build the caller-owned, idempotent dependency-resolution route.

    Args:
        job_store: Authoritative account and budget database.

    Returns:
        Authenticated paid package-resolution API.
    """
    router = APIRouter()

    @router.post("/wizard/scorer-dependencies")
    def resolve_dependencies(body: ScorerDependenciesRequest, user: AuthenticatedUserDep) -> dict[str, Any]:
        """Resolve imports without running scorer code on the API process.

        Args:
            body: Scorer source, optional overrides, and authorized shared budget.
            user: Authenticated owner of the registry and spending limit.

        Returns:
            Signed exact package lock and authoritative setup spending state.
        """
        enforce_submission_rate(user.username)
        with Session(job_store.engine) as session:
            registry = package_registry_for(session, user.username).index_url
        payload = {
            "scorer": {"kind": "python", "metric_code": body.code},
            "requirements": body.requirements,
            "runtime_image": settings.vercel_sandbox_image,
            "registry_url": registry,
            "dependency_registry": registry,
            "execution_budget_id": body.execution_budget_id,
            "execution_budget_revision": body.execution_budget_revision,
        }
        return run_protected_preview(
            payload,
            kind="dependencies",
            user=user,
            job_store=job_store,
            idempotency_key="dependencies:" + json_fingerprint(payload),
        )

    return router
