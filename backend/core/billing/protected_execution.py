"""Configure trusted spending and sandbox boundaries for setup and optimization."""

from __future__ import annotations

import math
import re
from typing import Any

from ..config import Settings
from ..service_gateway.optimization.blackbox.sandbox import (
    JOB_TAG,
    VercelCredentials,
    VercelSandboxRuntime,
    sandbox_unavailable_reason,
)
from ..service_gateway.optimization.blackbox.sandbox_broker import SandboxBroker
from .model_gateway import ModelGateway
from .model_mailbox import ModelMailbox
from .operation_pricing import UnpricedOperationError
from .vercel_usage import vercel_sandbox_credit_range

_IMMUTABLE_IMAGE = re.compile(r"^\S+@sha256:[0-9a-f]{64}$")


def protected_image(settings: Settings, workflow: str) -> str | None:
    """Return the deployment-owned immutable profile for a workflow.

    Args:
        settings: Trusted backend configuration.
        workflow: DSPy or Anything execution family.

    Returns:
        The pinned image reference when configured, otherwise None.
    """
    image = settings.dspy_sandbox_image if workflow == "dspy" else settings.vercel_sandbox_image
    return image if image and _IMMUTABLE_IMAGE.fullmatch(image) else None


def protected_vercel_unavailable_reason(settings: Settings, workflow: str) -> str | None:
    """Check required provider access and an immutable offline workload image.

    Args:
        settings: Trusted deployment configuration.
        workflow: Execution family selecting its dependency profile.

    Returns:
        A configuration reason, or None when real setup verification may proceed.
    """
    reason = sandbox_unavailable_reason(settings)
    if reason:
        return reason
    if protected_image(settings, workflow) is None:
        return "This deployment needs a pinned sandbox image with the optimizer dependencies installed."
    return None


def runtime_cost_profile(settings: Settings, workflow: str, runtime: str) -> dict[str, Any]:
    """Describe the selected sandbox's incremental user-funded cost category.

    Args:
        settings: Trusted deployment configuration.
        workflow: DSPy or Anything execution family.
        runtime: Managed sandbox identity.

    Returns:
        Machine-readable at-cost session bounds.
    """
    image = protected_image(settings, workflow)
    if runtime != "vercel" or image is None:
        return {
            "billing_basis": "at_cost",
            "minimum_session_credits": None,
            "maximum_session_credits": None,
            "maximum_lifetime_seconds": None,
            "vcpus": 2,
        }
    lifetime = min(settings.vercel_sandbox_max_lifetime_seconds, 86_400)
    request = {
        "image": image,
        "lifetime_ms": max(1, math.ceil(lifetime * 1000)),
        "vcpus": 2,
        "network_disabled": True,
        "ports": [],
        "persistent": False,
    }
    minimum, maximum = vercel_sandbox_credit_range(request)
    return {
        "billing_basis": "at_cost",
        "minimum_session_credits": str(minimum),
        "maximum_session_credits": str(maximum),
        "maximum_lifetime_seconds": lifetime,
        "vcpus": 2,
    }


def bind_protected_sandbox(
    gateway: ModelGateway,
    settings: Settings,
    *,
    workflow: str,
    owner_id: str,
    lifetime_seconds: int | None = None,
) -> dict[str, Any]:
    """Keep provider credentials, fixed resource profiles, and metering in the parent.

    Args:
        gateway: Existing generation-fenced model and credit authority.
        settings: Trusted Vercel account and deployment image configuration.
        workflow: Execution family selecting its immutable prebuilt image.
        owner_id: Stable job or setup identity used for cleanup after interruption.
        lifetime_seconds: Optional shorter ceiling for one bounded interaction.

    Returns:
        Non-secret deployment identity usable in setup evidence.

    Raises:
        UnpricedOperationError: When the protected runtime cannot be configured.
    """
    reason = protected_vercel_unavailable_reason(settings, workflow)
    if reason:
        raise UnpricedOperationError(reason)
    image = protected_image(settings, workflow)
    assert image is not None
    assert settings.vercel_token is not None
    configured_lifetime = settings.vercel_sandbox_max_lifetime_seconds
    lifetime = min(lifetime_seconds or configured_lifetime, configured_lifetime, 86_400)
    runtime = VercelSandboxRuntime(
        VercelCredentials(
            token=settings.vercel_token.get_secret_value(),
            team_id=str(settings.vercel_team_id),
            project_id=str(settings.vercel_project_id),
        ),
        image=image,
        budget=gateway.runtime,
    )
    mailbox = ModelMailbox(gateway.dispatch_guest)
    broker = SandboxBroker(
        runtime,
        image=image,
        max_lifetime_seconds=lifetime,
        tags={JOB_TAG: owner_id},
        command_runner=mailbox.run,
    )
    gateway.bind_sandbox(broker, image=image, lifetime_seconds=lifetime)
    return {"image": image, "lifetime_seconds": lifetime}
