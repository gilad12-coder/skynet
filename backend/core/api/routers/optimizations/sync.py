"""Desktop run sync routes. [INTERNAL]

Internal (Mac app plumbing, hidden from public docs):
- ``GET /optimizations/{optimization_id}/export`` — local mode only; bundle one finished run.
- ``POST /optimizations/import`` — hosted only; store a bundle as a read-only run of the caller.
"""

from __future__ import annotations

import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ....config import settings
from ....service_gateway.run_sync import MAX_BUNDLE_BYTES, RunSyncError, export_run, import_run
from ...auth import AuthenticatedUser, get_authenticated_user
from ...errors import DomainError
from .._helpers import enforce_job_quota, enforce_storage_quota
from ..local_runtime import require_local_mode

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]
_MAX_BUNDLE_MB = MAX_BUNDLE_BYTES // (1024 * 1024)


def _domain_error(exc: RunSyncError) -> DomainError:
    """Turn a sync error into the API's localized error.

    Args:
        exc: The error raised by the sync service.

    Returns:
        The matching ``DomainError``.
    """
    return DomainError(exc.code, status=exc.http_status, params=exc.params)


async def _read_capped_body(request: Request) -> bytes:
    """Read the request body, stopping as soon as it passes the bundle cap.

    The declared length is checked first and the stream is counted as it
    arrives, so an oversized or lying upload is refused before it is buffered
    whole or parsed.

    Args:
        request: The incoming import request.

    Returns:
        The raw body bytes.

    Raises:
        DomainError: 413 ``sync.bundle_too_large`` above ``MAX_BUNDLE_BYTES``.
    """
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > MAX_BUNDLE_BYTES:
        raise DomainError("sync.bundle_too_large", status=413, max_mb=_MAX_BUNDLE_MB)
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_BUNDLE_BYTES:
            raise DomainError("sync.bundle_too_large", status=413, max_mb=_MAX_BUNDLE_MB)
        chunks.append(chunk)
    return b"".join(chunks)


def register_sync_routes(router: APIRouter, *, job_store) -> None:
    """Register the run export and import routes on ``router``.

    Args:
        router: The router to attach the routes to.
        job_store: Job store the routes read from and write to.
    """

    @router.post(
        "/optimizations/import",
        status_code=201,
        include_in_schema=False,
        summary="Import a run exported from the Mac app",
    )
    async def import_optimization(request: Request, current_user: AuthenticatedUserDep) -> JSONResponse:
        """Store an exported bundle as a new read-only run owned by the caller.

        Args:
            request: The request whose body is the export bundle JSON.
            current_user: The authenticated hosted caller.

        Returns:
            ``{"optimization_id": ...}`` for the new run, with HTTP 201.

        Raises:
            DomainError: 422 in local mode or for a bad bundle, 413 above the
                size cap, 409 when the caller's quota is full.
        """
        if settings.local_mode:
            raise DomainError("sync.import_local_only_disabled", status=422)
        raw = await _read_capped_body(request)
        try:
            bundle: Any = json.loads(raw)
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise DomainError("sync.invalid_bundle", status=422) from None
        enforce_job_quota(job_store, current_user.username)
        enforce_storage_quota(job_store, current_user.username, len(raw))
        try:
            optimization_id = import_run(job_store, current_user.username, bundle)
        except RunSyncError as exc:
            raise _domain_error(exc) from None
        return JSONResponse(status_code=201, content={"optimization_id": optimization_id})

    @router.get(
        "/optimizations/{optimization_id}/export",
        include_in_schema=False,
        dependencies=[Depends(require_local_mode)],
        summary="Export a finished local run as a sync bundle",
    )
    def export_optimization(optimization_id: str, current_user: AuthenticatedUserDep) -> dict:
        """Return the export bundle for one of the caller's finished runs.

        Args:
            optimization_id: The run to export.
            current_user: The signed-in local user.

        Returns:
            The ``skynet.run-export/v1`` bundle.

        Raises:
            DomainError: 404 outside local mode or for another user's run, 409
                for a run that is still active or of an unsupported type.
        """
        try:
            return export_run(job_store, current_user.username, optimization_id)
        except RunSyncError as exc:
            raise _domain_error(exc) from None
