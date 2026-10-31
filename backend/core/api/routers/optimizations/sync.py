"""Desktop run sync routes. [INTERNAL]

Internal (Mac app plumbing, hidden from public docs):
- ``GET /optimizations/{optimization_id}/export`` — local mode only; bundle one finished run.
- ``POST /optimizations/import`` — hosted only; store a bundle as a read-only run of the caller.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from ....config import settings
from ....models import OptimizationStatusResponse
from ....service_gateway.run_sync import MAX_BUNDLE_BYTES, RunSyncError, export_run, import_run
from ...auth import AuthenticatedUser, get_authenticated_user
from ...converters import (
    compute_elapsed,
    overview_to_base_fields,
    parse_overview,
    parse_timestamp,
    status_to_job_status,
)
from ...errors import DomainError
from ...rate_limit import enforce_submission_rate
from .._helpers import build_summary, enforce_job_quota, enforce_storage_quota
from ..local_runtime import require_local_mode
from ._local import execution_budget_view
from .listing import build_sidebar_item

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


def _check_readable(job: dict[str, Any], events: list[dict[str, Any]]) -> None:
    """Build the run list, sidebar, summary and detail shapes for an imported row.

    The bundle's overview and fields are caller-shaped. One value the read models
    cannot take would break the caller's whole run list, so the import is
    refused instead.

    Args:
        job: The new row as the job store returns it.
        events: The row's progress events.

    Raises:
        RunSyncError: 422 ``sync.invalid_bundle`` when any read shape fails.
    """
    try:
        build_summary(job)
        build_sidebar_item(job, set(), set())
        created_at = parse_timestamp(job.get("created_at")) or datetime.now(UTC)
        started_at = parse_timestamp(job.get("started_at"))
        completed_at = parse_timestamp(job.get("completed_at"))
        elapsed, elapsed_seconds = compute_elapsed(
            created_at, started_at, completed_at, job.get("accumulated_runtime_seconds") or 0.0
        )
        OptimizationStatusResponse(
            optimization_id=job["optimization_id"],
            status=status_to_job_status(job.get("status", "pending")),
            created_at=created_at,
            started_at=started_at,
            completed_at=completed_at,
            elapsed=elapsed,
            elapsed_seconds=elapsed_seconds,
            **overview_to_base_fields(parse_overview(job)),
            message=job.get("message"),
            stop_reason=job.get("stop_reason"),
            result_availability=job.get("result_availability"),
            terminal_evidence=job.get("terminal_evidence"),
            execution_budget=execution_budget_view(None, job),
            stored_bytes=job.get("stored_bytes", 0),
            latest_metrics=job.get("latest_metrics", {}),
            progress_events=events,
        ).model_dump_json()
    except (ValidationError, ValueError, TypeError, OverflowError, AttributeError):
        raise RunSyncError("sync.invalid_bundle", 422) from None


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


def _store_bundle(job_store, username: str, raw: bytes) -> str:
    """Parse an import body, check the caller's quotas and store the run.

    The parse of up to 50 MB and the database write are blocking, so the route
    runs this in a worker thread to keep the event loop serving other requests.

    Args:
        job_store: Job store the run is written to.
        username: The hosted caller who owns the new run.
        raw: The request body.

    Returns:
        The new optimization id.

    Raises:
        DomainError: 422 for a bad bundle, 409 when a quota is full.
    """
    try:
        bundle: Any = json.loads(raw)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise DomainError("sync.invalid_bundle", status=422) from None
    enforce_job_quota(job_store, username)
    enforce_storage_quota(job_store, username, len(raw))
    try:
        return import_run(job_store, username, bundle, check_row=_check_readable)
    except RunSyncError as exc:
        raise _domain_error(exc) from None


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
                size cap, 409 when the caller's quota is full, 429 above the
                submission rate.
        """
        if settings.local_mode:
            raise DomainError("sync.import_local_only_disabled", status=422)
        # A refused import writes no job, so the job quota cannot stop repeats; the rate cap does.
        await asyncio.to_thread(enforce_submission_rate, current_user.username)
        raw = await _read_capped_body(request)
        optimization_id = await asyncio.to_thread(_store_bundle, job_store, current_user.username, raw)
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
