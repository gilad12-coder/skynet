"""Expose the deployment's managed optimization runtime capability."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from ...billing.protected_execution import protected_vercel_unavailable_reason, runtime_cost_profile
from ...config import settings
from ..auth import AuthenticatedUser, get_authenticated_user

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]


def execution_runtime_catalog(*, has_image_inputs: bool = False) -> dict[str, Any]:
    """Report the DSPy sandbox without launching billable validation.

    Args:
        has_image_inputs: Whether the current task needs metered image input support.

    Returns:
        The managed sandbox with its deployment availability and cost profile.
        Local mode reports the local Docker sandbox instead.
    """
    runtime = "docker" if settings.local_mode else "vercel"
    reason = protected_vercel_unavailable_reason(settings, "dspy")
    # Local mode calls models through the user's CLI subscriptions, not OpenRouter.
    if settings.openrouter_api_key is None and not settings.local_mode:
        reason = reason or "Managed model routing is not configured."
    return {
        "runtimes": [
            {
                "id": runtime,
                "available": reason is None,
                "unavailable_reason": reason,
                "cost": runtime_cost_profile(settings, "dspy", runtime),
                "checkpoint_restore_supported": reason is None,
                "checkpoint_restore_reason": reason,
            }
        ],
        "default_runtime": runtime,
        "run_recovery_eligibility": "Requires a supported optimizer, a compatible saved checkpoint, and funded headroom.",
    }


def create_execution_runtimes_router() -> APIRouter:
    """Build the authenticated runtime capability endpoint."""
    router = APIRouter()

    @router.get("/execution-runtimes")
    def execution_runtimes(user: AuthenticatedUserDep, has_image_inputs: bool = False) -> dict[str, Any]:
        """Return the managed runtime supported by the current deployment.

        Args:
            user: Authenticated user authorized to configure a run.
            has_image_inputs: Whether input media requires an additional pricing adapter.

        Returns:
            Managed sandbox capability and its unavailability reason, if any.
        """
        return execution_runtime_catalog(has_image_inputs=has_image_inputs)

    return router
