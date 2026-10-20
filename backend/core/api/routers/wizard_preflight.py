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

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ValidationError

from ...i18n import request_locale, t, t_locale
from ...models import BlackboxRunRequest
from ...models.unified import (
    ContractCheckItem,
    ContractCheckRequest,
    ContractCheckResponse,
    UnifiedRunRequest,
    resolve_optimizer,
)
from ...service_gateway.optimization.blackbox.check_terminal import CheckTerminalRecorder, recording
from ...service_gateway.optimization.unified.contract import (
    contract_fingerprint,
    in_locale,
    static_contract_check,
    with_message_codes,
)
from ...storage.preflights import setup_seed
from ..auth import AuthenticatedUser, get_authenticated_user
from ..preflight_execution import (
    BUDGET_CHECK_KEY,
    WizardPreflightCheck,
    WizardPreflightRequest,
    WizardPreflightResponse,
    run_preflight,
)
from ..preflight_progress import progress_observer
from ..rate_limit import enforce_submission_rate
from .submissions import _default_unified_seed, _materialize_unified_cases

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]
AcceptLanguageDep = Annotated[str | None, Header(include_in_schema=False)]
CONTRACT_CHECK_KEY = "metric.contract"


def _contract_failure(contract: dict[str, Any], spec: UnifiedRunRequest | None) -> ContractCheckItem | None:
    """Find the coded item behind a failed ``metric.contract`` check.

    Args:
        contract: The contract outcome under the setup check's ``workflow_result``.
        spec: The canonical unified spec, used to recover codes an older
            sandbox image left out; None when it is not known.

    Returns:
        The first failed item carrying a message code, or None.
    """
    try:
        parsed = ContractCheckResponse.model_validate(contract)
    except ValidationError:
        return None
    if spec is not None and any(item.message_code is None for item in parsed.checks):
        parsed = with_message_codes(parsed, static_contract_check(spec))
    return next((item for item in parsed.checks if item.status == "failed" and item.message_code), None)


def _localized_check(
    check: WizardPreflightCheck, code: str, failure: ContractCheckItem, locale: str
) -> WizardPreflightCheck:
    """Word a failed contract check in ``locale`` and attach its message code.

    Args:
        check: The ``metric.contract`` check as the setup check stored it.
        code: The failure's message code.
        failure: The coded contract item the check reports.
        locale: The caller's locale tag.

    Returns:
        The check with its message in ``locale``, keeping the exact error detail.
    """
    message = t_locale(locale, code, **failure.message_params)
    if failure.detail:
        message = f"{message}\n{failure.detail}"
    return check.model_copy(
        update={
            "message": message,
            "message_code": code,
            "message_params": dict(failure.message_params),
        }
    )


def localize_preflight(
    response: WizardPreflightResponse, spec: UnifiedRunRequest | None, locale: str
) -> WizardPreflightResponse:
    """Render a setup check's catalog messages in the caller's locale.

    The contract check words its failure in the Hebrew base wherever it runs
    (often a sandbox with no request locale), and the stored evidence is
    replayed to later callers in any language, so the wording happens here
    at response time.

    Args:
        response: The setup check result.
        spec: The canonical unified spec the check ran, if known.
        locale: The caller's locale tag.

    Returns:
        The result with its failed contract check worded in ``locale``.
    """
    contract = (response.workflow_result or {}).get("contract")
    if not isinstance(contract, dict):
        return response
    if not any(check.key == CONTRACT_CHECK_KEY and check.status == "failed" for check in response.checks):
        return response
    failure = _contract_failure(contract, spec)
    if failure is None or failure.message_code is None:
        return response
    checks = [
        _localized_check(check, failure.message_code, failure, locale)
        if check.key == CONTRACT_CHECK_KEY and check.status == "failed"
        else check
        for check in response.checks
    ]
    return response.model_copy(update={"checks": checks})


def create_wizard_preflight_router(*, job_store: Any) -> APIRouter:
    """Build paid Continue validation using the same ledger as the eventual run."""
    router = APIRouter()

    @router.post("/wizard/preflight", response_model=WizardPreflightResponse, response_model_exclude_none=True)
    def preflight(
        request: WizardPreflightRequest, user: AuthenticatedUserDep, accept_language: AcceptLanguageDep = None
    ) -> WizardPreflightResponse:
        """Validate the current wizard stage once and return durable budget-aware evidence.

        Args:
            request: Current authored inputs and the user's shared budget revision.
            user: Authenticated owner used for data, credentials, and spending.
            accept_language: The browser's languages, used when the body names no locale.

        Returns:
            Scoped checks, reusable evidence identity, and authoritative setup spend,
            worded in the caller's locale.
        """
        response, spec = _checked_preflight(request, user)
        return localize_preflight(response, spec, request_locale(request.locale, accept_language))

    def _checked_preflight(
        request: WizardPreflightRequest, user: AuthenticatedUser
    ) -> tuple[WizardPreflightResponse, UnifiedRunRequest | None]:
        """Run one setup check, with its messages still in the Hebrew base.

        Args:
            request: Current authored inputs and the user's shared budget revision.
            user: Authenticated owner used for data, credentials, and spending.

        Returns:
            The check result, and the canonical unified spec it ran (None for other workflows).
        """
        enforce_submission_rate(user.username)
        spec: UnifiedRunRequest | None = None
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
                spec = typed
            payload = typed.model_dump(mode="json", by_alias=True)
        return run_preflight(request.model_copy(update={"payload": payload}), user, job_store), spec

    @router.post("/wizard/preflight/stream", include_in_schema=False)
    def stream_preflight(
        request: WizardPreflightRequest, user: AuthenticatedUserDep, accept_language: AcceptLanguageDep = None
    ) -> StreamingResponse:
        """Stream actual setup phases followed by the existing authoritative result.

        Args:
            request: Current wizard inputs and budget revision.
            user: Authenticated owner of the setup request.
            accept_language: The browser's languages, used when the body names no locale.

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
                result = preflight(request, user, accept_language)
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
        return in_locale(static_contract_check(request.spec), request.locale)

    def _run_contract_check(request: ContractCheckRequest, user: AuthenticatedUser) -> ContractCheckResponse:
        """Run the sandboxed contract check shared by the plain and streaming routes.

        Args:
            request: The unified spec and how many samples to score.
            user: Authenticated owner whose budget pays for the check.

        Returns:
            Every check item and the scored samples, worded in the request's locale.

        Raises:
            HTTPException: 402 when the spec names no execution budget, or the
                budget errors ``run_preflight`` raises.
        """
        enforce_submission_rate(user.username)
        return in_locale(_sandboxed_check(request, user), request.locale)

    def _sandboxed_check(request: ContractCheckRequest, user: AuthenticatedUser) -> ContractCheckResponse:
        """Run the static check, then the sampled one under the spec's budget.

        Args:
            request: The unified spec and how many samples to score.
            user: Authenticated owner whose budget pays for the check.

        Returns:
            Every check item and the scored samples, in the Hebrew base.

        Raises:
            HTTPException: 402 when the spec names no execution budget.
        """
        spec = request.spec
        static = static_contract_check(spec)
        if not static.ok:
            return static
        if spec.execution_budget_id is None or spec.execution_budget_revision is None:
            raise HTTPException(status_code=402, detail="Choose a spending budget before running the contract check.")
        result, _ = _checked_preflight(
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
            checked = with_message_codes(ContractCheckResponse.model_validate(contract), static)
            return checked.model_copy(update={"terminal": result.terminal})
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
            terminal=result.terminal,
        )

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
        """
        return _run_contract_check(request, user)

    @router.post("/optimizations/contract-check/stream", include_in_schema=False)
    def contract_check_stream(request: ContractCheckRequest, user: AuthenticatedUserDep) -> StreamingResponse:
        """Stream the check's real phases, then the same result the plain route returns.

        Args:
            request: The unified spec and how many samples to score.
            user: Authenticated owner whose budget pays for the check.

        Returns:
            An event stream of ``phase`` and ``terminal`` events, then one
            ``result`` or ``error``.
        """
        events: Queue[dict[str, Any] | None] = Queue()

        def phase(value: str) -> None:
            """Queue a public execution phase for this request."""
            events.put({"event": "phase", "data": {"phase": value}})

        def terminal(event: dict[str, Any]) -> None:
            """Queue one live, already-redacted line of the check's sandbox transcript."""
            events.put({"event": "terminal", "data": event})

        def execute() -> None:
            """Finish admitted work even if the viewer disconnects, preserving its billing evidence."""
            token = progress_observer.set(phase)
            try:
                with recording(CheckTerminalRecorder(emit=terminal)):
                    result = _run_contract_check(request, user)
                events.put({"event": "result", "data": result.model_dump(mode="json")})
            except HTTPException as error:
                events.put({"event": "error", "data": {"detail": error.detail}})
            except RequestValidationError:
                events.put({"event": "error", "data": {"detail": "The setup configuration is invalid."}})
            except Exception:
                events.put(
                    {
                        "event": "error",
                        "data": {"detail": "The workspace check could not finish. Try again."},
                    }
                )
            finally:
                progress_observer.reset(token)
                events.put(None)

        def stream() -> Iterator[str]:
            """Yield phase events and keep the connection alive during long provider calls."""
            Thread(target=execute, daemon=True, name="contract-check").start()
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
