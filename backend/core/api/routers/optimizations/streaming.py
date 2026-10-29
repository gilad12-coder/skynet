"""Server-sent-event streams for the optimizations dashboard and per-job view. [MIXED]

Public dev surface (in ``_SCALAR_PUBLIC_PATHS``):
- ``GET /optimizations/{id}/stream`` — live progress for a single job.

Internal (dashboard plumbing, hidden from public docs):
- ``GET /optimizations/stream`` — fan-out stream for the dashboard.
- ``GET /optimizations/{id}/logs/stream`` — live tail of a job's run log.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from starlette.responses import StreamingResponse

from ...auth import AuthenticatedUser, get_authenticated_user, is_admin
from ...sharing_access import ShareRole
from .._helpers import require_role_at_least, sse_from_events
from ._local import stream_dashboard_snapshots, stream_job_updates
from .log_stream import stream_job_logs

logger = logging.getLogger(__name__)

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]

_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def register_dashboard_stream(router: APIRouter, *, job_store) -> None:
    """Register the ``GET /optimizations/stream`` dashboard SSE route.

    Must be registered before any ``/optimizations/{optimization_id}`` route
    so FastAPI's literal-first matcher does not shadow it.

    Args:
        router: The router to attach the dashboard stream route to.
        job_store: Job-store the underlying generator reads from.
    """

    @router.get(
        "/optimizations/stream",
        summary="Stream live dashboard updates (all active optimizations) as SSE",
    )
    async def stream_dashboard(current_user: AuthenticatedUserDep):
        """Stream live dashboard snapshots of all active optimizations as SSE.

        Polls pending/validating/running rows every 3 seconds and yields a JSON
        snapshot per tick. Non-admins see only their own active jobs; admins
        see everyone. When no jobs in scope are active the generator emits
        ``event: idle`` and closes the stream.

        Args:
            current_user: Authenticated caller resolved from the bearer token.

        Returns:
            A streaming ``StreamingResponse`` with ``text/event-stream`` body.
        """
        owner_filter = None if is_admin(current_user) else current_user.username
        return StreamingResponse(
            sse_from_events(stream_dashboard_snapshots(job_store, owner_filter=owner_filter)),
            media_type="text/event-stream",
            headers=_SSE_HEADERS,
        )


def register_job_stream(router: APIRouter, *, job_store) -> None:
    """Register the ``GET /optimizations/{id}/stream`` per-job SSE route.

    Args:
        router: The router to attach the per-job stream route to.
        job_store: Job-store the underlying generator reads from.
    """

    @router.get(
        "/optimizations/{optimization_id}/stream",
        summary="Stream one optimization's live status updates as SSE",
    )
    async def stream_job(optimization_id: str, current_user: AuthenticatedUserDep):
        """Stream one optimization's live status updates as SSE.

        Emits a status + metrics snapshot every 2 seconds and terminates with
        ``event: done`` once the optimization reaches a terminal state. Open to
        anyone the run is shared with (viewer tier or above) — owner, admin, and
        invited members alike — mirroring the access check on the rest of the
        optimization surface.

        Args:
            optimization_id: Optimization id to follow.
            current_user: Authenticated caller resolved from the bearer token.

        Returns:
            A streaming ``StreamingResponse`` with ``text/event-stream`` body.

        Raises:
            DomainError: 404 when the optimization id is unknown or the caller
                has no share access to it.
        """
        loop = asyncio.get_running_loop()
        # Run the sync DB role check off the event loop (the job read did the
        # same). viewer-minimum admits any grant tier; a non-member 404s.
        await loop.run_in_executor(
            None, require_role_at_least, job_store, optimization_id, current_user, ShareRole.viewer
        )

        return StreamingResponse(
            sse_from_events(stream_job_updates(job_store, optimization_id)),
            media_type="text/event-stream",
            headers=_SSE_HEADERS,
        )


def register_log_stream(router: APIRouter, *, job_store) -> None:
    """Register the ``GET /optimizations/{id}/logs/stream`` live run-log route.

    Args:
        router: The router to attach the route to.
        job_store: Job-store the rows are read from.
    """

    @router.get(
        "/optimizations/{optimization_id}/logs/stream",
        summary="Stream an optimization's run log live as SSE",
        include_in_schema=False,
    )
    async def stream_logs(
        optimization_id: str,
        current_user: AuthenticatedUserDep,
        after_id: int | None = Query(
            default=None, ge=0, description="Last log row id already held; the stream resumes after it."
        ),
    ):
        """Stream an optimization's run-log rows as they are written.

        Each ``logs`` event carries a batch of rows and an SSE ``id`` equal to
        the batch's last row id; reconnect with ``after_id`` set to it to
        resume without gaps or repeats. Ends with ``event: done`` once the run
        is over and every row has been sent. Open to anyone the run is shared
        with, like the job stream.

        Args:
            optimization_id: Optimization id to tail.
            current_user: Authenticated caller resolved from the bearer token.
            after_id: Last row id the client already holds.

        Returns:
            A streaming ``StreamingResponse`` with ``text/event-stream`` body.

        Raises:
            DomainError: 404 when the optimization id is unknown or the caller
                has no share access to it.
        """
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None, require_role_at_least, job_store, optimization_id, current_user, ShareRole.viewer
        )
        return StreamingResponse(
            sse_from_events(stream_job_logs(job_store, optimization_id, after_id)),
            media_type="text/event-stream",
            headers=_SSE_HEADERS,
        )
