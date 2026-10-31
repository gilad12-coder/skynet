"""Report what the single-user Mac app needs on this machine. [INTERNAL]

``GET /local/status`` exists only in local mode. Hosted deployments answer 404
and leave it out of the OpenAPI schema, so the public API contract is the same
with or without local mode.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated, Any

from fastapi import APIRouter, Depends

from ...config import settings
from ...local.cli_probe import docker_status, probe_clis
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]


def require_local_mode() -> None:
    """Hide a local-only route outside local mode.

    Raises:
        DomainError: 404 ``local.not_available`` when local mode is off.
    """
    if not settings.local_mode:
        raise DomainError("local.not_available", status=404)


def create_local_runtime_router() -> APIRouter:
    """Build the local-mode status router.

    Returns:
        A FastAPI ``APIRouter`` exposing ``GET /local/status``.
    """
    router = APIRouter()

    @router.get("/local/status", include_in_schema=False, dependencies=[Depends(require_local_mode)])
    def local_status(user: AuthenticatedUserDep) -> dict[str, Any]:
        """Report Docker, the sandbox image, and each coding CLI.

        Args:
            user: The signed-in local user.

        Returns:
            ``{local_mode, version, docker: {available, error}, sandbox_image,
            clis: [CliStatus, ...]}``.
        """
        available, error = docker_status(settings)
        return {
            "local_mode": True,
            "version": settings.code_version,
            "docker": {"available": available, "error": error},
            "sandbox_image": settings.local_sandbox_image or None,
            "clis": [asdict(status) for status in probe_clis(settings)],
        }

    return router
