"""Validate wizard inputs before sharing the same paid setup path as API submissions."""

from __future__ import annotations

import copy
import json
from collections.abc import Iterator
from queue import Empty, Queue
from threading import Thread
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from ...models import BlackboxRunRequest, GridSearchRequest, RunRequest
from ...storage.preflights import setup_seed
from ..auth import AuthenticatedUser, get_authenticated_user
from ..preflight_execution import WizardPreflightRequest, WizardPreflightResponse, run_preflight
from ..preflight_progress import progress_observer
from ..rate_limit import enforce_submission_rate
from .submissions import _expand_catalog_grid_payload, _materialize_library_dataset, _materialize_staged_dataset

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]


def create_wizard_preflight_router(*, job_store: Any) -> APIRouter:
    """Build paid Continue validation using the same ledger as the eventual run."""
    router = APIRouter(prefix="/wizard")

    @router.post("/preflight", response_model=WizardPreflightResponse, response_model_exclude_none=True)
    def preflight(request: WizardPreflightRequest, user: AuthenticatedUserDep) -> WizardPreflightResponse:
        """Validate the current wizard stage once and return durable budget-aware evidence.

        Args:
            request: Current authored inputs and the user's shared budget revision.
            user: Authenticated owner used for data, credentials, and spending.

        Returns:
            Scoped checks, reusable evidence identity, and authoritative setup spend.
        """
        enforce_submission_rate(user.username)
        payload = copy.deepcopy(request.payload)
        payload["username"] = user.username
        payload["execution_budget_id"] = request.execution_budget_id
        payload["execution_budget_revision"] = request.execution_budget_revision
        if payload.get("seed") is None:
            payload["seed"] = setup_seed(request.execution_budget_id)
        if request.scope == "execution":
            model = (
                BlackboxRunRequest
                if request.workflow == "anything"
                else (GridSearchRequest if "generation_models" in payload else RunRequest)
            )
            try:
                typed = model.model_validate(payload)
            except ValidationError as error:
                raise RequestValidationError(error.errors()) from error
            if isinstance(typed, GridSearchRequest):
                _expand_catalog_grid_payload(typed)
            if request.workflow == "dspy":
                _materialize_staged_dataset(typed, job_store=job_store, username=user.username)
                _materialize_library_dataset(typed, job_store=job_store, user=user)
            payload = typed.model_dump(mode="json", by_alias=True)
        return run_preflight(request.model_copy(update={"payload": payload}), user, job_store)

    @router.post("/preflight/stream", include_in_schema=False)
    def stream_preflight(request: WizardPreflightRequest, user: AuthenticatedUserDep) -> StreamingResponse:
        """Stream actual setup phases followed by the existing authoritative result.

        Args:
            request: Current wizard inputs and budget revision.
            user: Authenticated owner of the setup request.

        Returns:
            An event stream that never dispatches a second validation attempt.
        """
        events: Queue[dict[str, Any] | None] = Queue()

        def phase(value: str) -> None:
            """Queue a public execution phase for this request."""
            events.put({"event": "phase", "data": {"phase": value}})

        def execute() -> None:
            """Finish admitted work even if the viewer disconnects, preserving its billing evidence."""
            token = progress_observer.set(phase)
            try:
                result = preflight(request, user)
                events.put({"event": "result", "data": result.model_dump(mode="json", exclude_none=True)})
            except HTTPException as error:
                events.put({"event": "error", "data": {"detail": error.detail}})
            except RequestValidationError:
                events.put({"event": "error", "data": {"detail": "The setup configuration is invalid."}})
            except Exception:
                events.put(
                    {
                        "event": "error",
                        "data": {"detail": "Setup validation could not finish. Return to setup and try again."},
                    }
                )
            finally:
                progress_observer.reset(token)
                events.put(None)

        def stream() -> Iterator[str]:
            """Yield phase events and keep the connection alive during long provider calls."""
            Thread(target=execute, daemon=True, name="wizard-preflight").start()
            while True:
                try:
                    event = events.get(timeout=10)
                except Empty:
                    yield ": waiting\n\n"
                    continue
                if event is None:
                    break
                yield f"event: {event['event']}\ndata: {json.dumps(event['data'])}\n\n"

        return StreamingResponse(
            stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
        )

    return router
