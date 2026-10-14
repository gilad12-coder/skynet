"""Validate wizard inputs before sharing the same paid setup path as API submissions.

Also serves the unified workspace contract check: a static one that reads
the code without running it, and a sandboxed one that runs the starting
version through the code and metric on a few non-held-out samples under
the same budget, evidence and protected sandbox as a setup check.
"""

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
from pydantic import BaseModel, ValidationError

from ...i18n import t
from ...models import BlackboxRunRequest
from ...models.unified import (
    ContractCheckItem,
    ContractCheckRequest,
    ContractCheckResponse,
    UnifiedRunRequest,
    resolve_optimizer,
)
from ...service_gateway.optimization.unified.contract import (
    contract_fingerprint,
    static_contract_check,
    with_message_codes,
)
from ...storage.preflights import setup_seed
from ..auth import AuthenticatedUser, get_authenticated_user
from ..preflight_execution import BUDGET_CHECK_KEY, WizardPreflightRequest, WizardPreflightResponse, run_preflight
from ..preflight_progress import progress_observer
from ..rate_limit import enforce_submission_rate
from .submissions import _default_unified_seed, _materialize_unified_cases

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]


def create_wizard_preflight_router(*, job_store: Any) -> APIRouter:
    """Build paid Continue validation using the same ledger as the eventual run."""
    router = APIRouter()

    @router.post("/wizard/preflight", response_model=WizardPreflightResponse, response_model_exclude_none=True)
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
        # A unified run is seeded from its task, not its budget, so the
        # evidence fingerprint matches what POST /optimize later recomputes.
        if payload.get("seed") is None and request.workflow != "unified":
            payload["seed"] = setup_seed(request.execution_budget_id)
        if request.scope == "execution" or request.workflow == "unified":
            model: type[BaseModel] = BlackboxRunRequest if request.workflow == "anything" else UnifiedRunRequest
            try:
                typed = model.model_validate(payload)
            except ValidationError as error:
                raise RequestValidationError(error.errors()) from error
            if isinstance(typed, UnifiedRunRequest):
                _materialize_unified_cases(typed, job_store=job_store, username=user.username)
                _default_unified_seed(typed)
            payload = typed.model_dump(mode="json", by_alias=True)
        return run_preflight(request.model_copy(update={"payload": payload}), user, job_store)

    @router.post("/wizard/preflight/stream", include_in_schema=False)
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

    @router.post("/optimizations/contract-check/static", response_model=ContractCheckResponse)
    def contract_check_static(request: ContractCheckRequest, user: AuthenticatedUserDep) -> ContractCheckResponse:
        """Check the workspace code's signatures and metric model without running it.

        Args:
            request: The unified spec to check.
            user: Authenticated caller.

        Returns:
            The static checks; ``samples`` is always empty.
        """
        enforce_submission_rate(user.username)
        return static_contract_check(request.spec)

    @router.post("/optimizations/contract-check", response_model=ContractCheckResponse)
    def contract_check(request: ContractCheckRequest, user: AuthenticatedUserDep) -> ContractCheckResponse:
        """Run the starting version through the code and metric on a few samples, in the sandbox.

        The check runs as an evaluation-scope setup check under the spec's
        execution budget, so it is billed, deduplicated and sandboxed exactly
        like ``/wizard/preflight``. A contract mismatch is a 200 with
        ``ok=false``; only auth, billing and quota failures are 4xx.

        Args:
            request: The unified spec and how many samples to score.
            user: Authenticated owner whose budget pays for the check.

        Returns:
            Every check item and the scored samples.

        Raises:
            HTTPException: 402 when the spec names no execution budget, or the
                budget errors ``run_preflight`` raises.
        """
        enforce_submission_rate(user.username)
        spec = request.spec
        static = static_contract_check(spec)
        if not static.ok:
            return static
        if spec.execution_budget_id is None or spec.execution_budget_revision is None:
            raise HTTPException(status_code=402, detail="Choose a spending budget before running the contract check.")
        result = preflight(
            WizardPreflightRequest(
                scope="evaluation",
                workflow="unified",
                payload=spec.model_dump(mode="json", exclude_none=True),
                execution_budget_id=spec.execution_budget_id,
                execution_budget_revision=spec.execution_budget_revision,
                contract_sample_count=request.sample_count,
            ),
            user,
        )
        contract = (result.workflow_result or {}).get("contract")
        if isinstance(contract, dict):
            return with_message_codes(ContractCheckResponse.model_validate(contract), static)
        failure = next((check for check in result.checks if check.status != "succeeded"), None)
        error = failure.message if failure is not None and failure.message else result.status
        # A spent budget is not a code mismatch; it is fixed by raising the limit.
        code = (
            "submit.unified.contract_budget"
            if failure is not None and failure.key == BUDGET_CHECK_KEY
            else "submit.unified.contract_failed"
        )
        return ContractCheckResponse(
            ok=False,
            optimizer_resolved=resolve_optimizer(spec.optimizer.choice, spec.task.artifact.kind),
            uses_llm=static.uses_llm,
            checks=[
                *static.checks,
                ContractCheckItem(
                    key="workspace.run",
                    status="pending" if result.status == "pending" else "failed",
                    message=t(code, error=error),
                    message_code=code,
                    message_params={"error": error},
                    # The message already carries the error; a detail repeating it
                    # printed the sentence twice under the editor.
                    detail=None,
                ),
            ],
            fingerprint=contract_fingerprint(spec),
        )

    return router
