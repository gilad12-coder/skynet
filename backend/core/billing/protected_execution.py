"""Configure trusted spending and sandbox boundaries for setup and optimization."""

from __future__ import annotations

import math
import re
from typing import Any
from urllib.parse import urlsplit

from ..config import VERCEL_SANDBOX_LIFETIME_CEILING_SECONDS, Settings
from ..service_gateway.optimization.blackbox.harness_bridge import ANTHROPIC_HOST
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
from .vercel_usage import vercel_sandbox_cost_range

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
        Machine-readable session bounds, including the usage markup.
    """
    image = protected_image(settings, workflow)
    if runtime != "vercel" or image is None:
        return {
            "billing_basis": "at_cost",
            "minimum_session_cents": None,
            "maximum_session_cents": None,
            "maximum_lifetime_seconds": None,
            "vcpus": 2,
        }
    lifetime = min(settings.vercel_sandbox_max_lifetime_seconds, VERCEL_SANDBOX_LIFETIME_CEILING_SECONDS)
    request = {
        "image": image,
        "lifetime_ms": max(1, math.ceil(lifetime * 1000)),
        "vcpus": 2,
        "network_disabled": True,
        "ports": [],
        "persistent": False,
    }
    minimum, maximum = vercel_sandbox_cost_range(request)
    return {
        "billing_basis": "at_cost",
        "minimum_session_cents": str(minimum),
        "maximum_session_cents": str(maximum),
        "maximum_lifetime_seconds": lifetime,
        "vcpus": 2,
    }


def claude_code_anthropic_key(vault: Any, username: str) -> str:
    """Resolve the run owner's verified Anthropic key for Claude Code's network edge.

    Args:
        vault: The BYOK vault holding the owner's provider connections.
        username: The run owner.

    Returns:
        The decrypted key, handed only to the parent's sandbox broker.

    Raises:
        ValueError: When the owner has no verified Anthropic key, or the key
            targets an endpoint other than Anthropic's own API.
    """
    connection = vault.resolve_connection(username, "anthropic", verified_only=True)
    if connection is None:
        raise ValueError("Claude Code needs a verified Anthropic key. Add one in Settings, then run again.")
    if connection.api_base and urlsplit(connection.api_base).hostname != ANTHROPIC_HOST:
        raise ValueError(f"Claude Code reaches only {ANTHROPIC_HOST}; this Anthropic key uses a custom endpoint.")
    return connection.secret


def bind_protected_sandbox(
    gateway: ModelGateway,
    settings: Settings,
    *,
    workflow: str,
    owner_id: str,
    lifetime_seconds: int | None = None,
    anthropic_api_key: str | None = None,
    parent_hosts: tuple[str, ...] = (),
    image: str | None = None,
) -> dict[str, Any]:
    """Keep provider credentials, fixed resource profiles, and metering in the parent.

    Args:
        gateway: Existing generation-fenced model and spend authority.
        settings: Trusted Vercel account and deployment image configuration.
        workflow: Execution family selecting its immutable prebuilt image.
        owner_id: Stable job or setup identity used for cleanup after interruption.
        lifetime_seconds: Optional shorter ceiling for one bounded interaction.
        anthropic_api_key: The owner's Anthropic key when Claude Code proposes;
            the network edge adds it to the box's Anthropic requests.
        parent_hosts: Package registries the parent's own repository scoring
            box may reach during setup; empty when the run opens no such box.
        image: The immutable image the run is pinned to; the deployment's
            current image when None.

    Returns:
        Non-secret deployment identity usable in setup evidence.

    Raises:
        UnpricedOperationError: When the protected runtime cannot be configured.
    """
    reason = protected_vercel_unavailable_reason(settings, workflow)
    if reason:
        raise UnpricedOperationError(reason)
    if image is None:
        image = protected_image(settings, workflow)
    elif not _IMMUTABLE_IMAGE.fullmatch(image):
        raise UnpricedOperationError("The run's pinned sandbox image is not an immutable reference.")
    assert image is not None
    assert settings.vercel_token is not None
    configured_lifetime = settings.vercel_sandbox_max_lifetime_seconds
    lifetime = min(
        lifetime_seconds or configured_lifetime, configured_lifetime, VERCEL_SANDBOX_LIFETIME_CEILING_SECONDS
    )
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
        anthropic_api_key=anthropic_api_key,
    )
    gateway.bind_sandbox(
        broker,
        image=image,
        lifetime_seconds=lifetime,
        allowed_hosts=(ANTHROPIC_HOST,) if anthropic_api_key is not None else (),
    )
    if parent_hosts:
        gateway.fund_parent_sandbox(parent_hosts)
    return {"image": image, "lifetime_seconds": lifetime}
