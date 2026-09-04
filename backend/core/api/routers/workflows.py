"""Run explicit workflow previews inside protected executors with reserved setup credits."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header
from starlette.responses import StreamingResponse

from ...models.submissions import WorkflowDryRunRequest, WorkflowDryRunResponse
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError
from ..protected_preview import run_protected_preview
from ..rate_limit import enforce_submission_rate
from ._helpers import sse_from_events

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]
IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)]


def _validate_inputs(request: WorkflowDryRunRequest) -> None:
    """Reject missing input values before starting any paid or authored execution."""
    names = request.workflow.input_field_names()
    missing = [name for name in names if name not in request.inputs]
    if missing:
        raise DomainError("serve.missing_inputs", status=400, missing=missing, input_fields=names)


async def _stream_preview(
    request: WorkflowDryRunRequest, user: AuthenticatedUser, job_store: Any, key: str | None
) -> AsyncIterator[dict[str, Any]]:
    """Forward isolated tokens and one final result while ensuring paid cleanup completes.

    Args:
        request: Validated explicit debug inputs and optional shared budget.
        user: Authenticated spending owner.
        job_store: Authoritative persistence.
        key: Optional transport replay key.

    Yields:
        Actual token chunks, a final preview response, or an admission error.
    """
    loop = asyncio.get_running_loop()
    events: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    def token(value: dict[str, str]) -> None:
        """Forward actual isolated output to the request's event loop."""
        loop.call_soon_threadsafe(events.put_nowait, {"event": "token", "data": value})

    def execute() -> None:
        """Finish the covered preview and its cleanup even if the client disconnects."""
        try:
            result = run_protected_preview(
                request.model_dump(mode="json", by_alias=True),
                kind="workflow",
                user=user,
                job_store=job_store,
                idempotency_key=key,
                on_token=token,
            )
            response = WorkflowDryRunResponse.model_validate(result)
            loop.call_soon_threadsafe(events.put_nowait, {"event": "final", "data": response.model_dump(mode="json")})
        except Exception as error:
            loop.call_soon_threadsafe(
                events.put_nowait,
                {"event": "error", "data": {"error": str(error), "code": getattr(error, "code", None)}},
            )
        finally:
            loop.call_soon_threadsafe(events.put_nowait, None)

    task = asyncio.create_task(asyncio.to_thread(execute))
    try:
        while (event := await events.get()) is not None:
            yield event
    finally:
        await asyncio.shield(task)


def create_workflows_router(*, job_store=None) -> APIRouter:
    """Build protected blocking and streaming workflow preview routes.

    Args:
        job_store: Store exposing the authoritative wallet and setup database.

    Returns:
        Workflow debug routes sharing the same protected execution path.
    """
    router = APIRouter()

    @router.post(
        "/workflows/dry-run",
        response_model=WorkflowDryRunResponse,
        summary="Execute an unoptimized workflow once on a sample input",
        tags=["Workflows"],
    )
    def workflow_dry_run(
        request: WorkflowDryRunRequest, user: AuthenticatedUserDep, idempotency_key: IdempotencyKey = None
    ) -> WorkflowDryRunResponse:
        """Return real workflow outputs and traces after reserved, isolated execution.

        Args:
            request: Explicit input values, workflow, and model configuration.
            user: Authenticated spending owner.
            idempotency_key: Optional paid-preview replay identity.

        Returns:
            Existing debug output fields with current setup budget and billing status.
        """
        enforce_submission_rate(user.username)
        _validate_inputs(request)
        return WorkflowDryRunResponse.model_validate(
            run_protected_preview(
                request.model_dump(mode="json", by_alias=True),
                kind="workflow",
                user=user,
                job_store=job_store,
                idempotency_key=idempotency_key,
            )
        )

    @router.post(
        "/workflows/dry-run/stream",
        summary="Execute an unoptimized workflow once and stream the answer as SSE",
        tags=["Workflows"],
    )
    async def workflow_dry_run_stream(
        request: WorkflowDryRunRequest, user: AuthenticatedUserDep, idempotency_key: IdempotencyKey = None
    ) -> StreamingResponse:
        """Stream actual isolated chunks and the final budget-aware preview result.

        Args:
            request: Explicit debug inputs and optional shared budget.
            user: Authenticated spending owner.
            idempotency_key: Optional paid-preview replay identity.

        Returns:
            SSE tokens followed by a final response, including node errors and usage.
        """
        enforce_submission_rate(user.username)
        _validate_inputs(request)
        return StreamingResponse(
            sse_from_events(_stream_preview(request, user, job_store, idempotency_key)),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
        )

    return router
