"""Run paid Continue checks under the draft's shared, durable spending authority."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from ..billing import ProviderKeyVault, payload_uses_token_source
from ..billing.budgets import BudgetConflictError, BudgetError, BudgetService
from ..billing.model_gateway import ModelGateway
from ..billing.protected_credentials import (
    ProtectedCredentialVault,
    prepare_protected_credentials,
    protect_execution_credentials,
    resolve_execution_credentials,
)
from ..billing.protected_execution import bind_protected_sandbox, protected_vercel_unavailable_reason
from ..billing.runtime import BudgetRuntime, UsagePendingError
from ..config import settings
from ..constants import OPTIMIZATION_TYPE_BLACKBOX, TOKEN_SOURCE_MANAGED
from ..models import BlackboxRunRequest, GridSearchRequest, RunRequest
from ..models.common import SplitFractions
from ..service_gateway.optimization.data import split_examples
from ..storage.preflights import PreflightStore
from ..worker.vercel_dspy import run_vercel_dspy
from .model_billing import normalize_model_token_sources
from .preflight_progress import report_preflight_phase
from .routers.execution_budgets import ExecutionBudgetResponse, budget_http_error, budget_response


class WizardPreflightRequest(BaseModel):
    scope: Literal["evaluation", "execution"]
    workflow: Literal["anything", "dspy"]
    payload: dict[str, Any]
    execution_budget_id: str = Field(min_length=1, max_length=64)
    execution_budget_revision: int = Field(ge=1)

    @field_validator("payload")
    @classmethod
    def reject_runtime_controls(cls, payload: dict[str, Any]) -> dict[str, Any]:
        """Reject public inputs that attempt to supply trusted runtime control fields.

        Args:
            payload: Untrusted public stage inputs before canonicalization or fingerprinting.

        Returns:
            Public inputs containing no parent-owned execution descriptors.

        Raises:
            ValueError: When a top-level private execution key is supplied.
        """
        if any(key.startswith("_") for key in payload):
            raise ValueError("Runtime control fields cannot be supplied in setup inputs.")
        return payload


class WizardPreflightCheck(BaseModel):
    key: str
    status: Literal["succeeded", "failed", "pending", "skipped"]
    message: str | None = None
    field: str | None = None


class WizardPreflightPendingReason(BaseModel):
    category: Literal["later_stage_dependency", "usage_reconciliation", "setup_incomplete"]
    message: str
    field: str | None = None


class WizardPreflightResponse(BaseModel):
    id: str
    fingerprint: str
    status: Literal["succeeded", "failed", "pending"]
    may_advance: bool
    pending_reason: WizardPreflightPendingReason | None = None
    checks: list[WizardPreflightCheck]
    budget: ExecutionBudgetResponse
    scorer_result: dict[str, Any] | None = None
    workflow_result: dict[str, Any] | None = None


_GRID_REQUEST_FIELDS = frozenset(
    {
        "generation_models",
        "reflection_models",
        "use_all_available_generation_models",
        "use_all_available_reflection_models",
    }
)


def _canonical_execution_payload(request: WizardPreflightRequest, username: str) -> dict[str, Any]:
    """Apply the submission schema before hashing complete execution inputs.

    Args:
        request: Full execution preflight request.
        username: Authenticated owner replacing any client-supplied identity.

    Returns:
        The same canonical JSON shape the submission endpoint will attach.
    """
    payload = {**request.payload, "username": username}
    if request.workflow == "anything":
        typed = BlackboxRunRequest.model_validate(payload)
    elif _GRID_REQUEST_FIELDS.intersection(payload):
        typed = GridSearchRequest.model_validate(payload)
    else:
        typed = RunRequest.model_validate(payload)
    normalize_model_token_sources(typed)
    return typed.model_dump(mode="json", by_alias=True)


def _check(key: str, status: str, message: str | None = None, field: str | None = None) -> dict[str, Any]:
    """Build one scoped readiness result without inventing a score."""
    return {
        "key": key,
        "status": status,
        **({"message": message} if message else {}),
        **({"field": field} if field else {}),
    }


def _pending_reason(category: str, message: str, field: str | None = None) -> dict[str, Any]:
    """Describe why incomplete evidence cannot or may safely cross this stage."""
    return {
        "category": category,
        "message": message,
        **({"field": field} if field else {}),
    }


def _mark_usage_pending(result: dict[str, Any], message: str) -> dict[str, Any]:
    """Attach one blocking usage-reconciliation outcome without losing performed checks."""
    checks = list(result.get("checks", []))
    if not any(check.get("key") == "usage" and check.get("status") == "pending" for check in checks):
        checks.append(_check("usage", "pending", message))
    return {
        **result,
        "checks": checks,
        "pending_reason": _pending_reason("usage_reconciliation", message),
    }


def _sample(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Choose only training or validation data using the submitted deterministic split.

    Args:
        payload: Canonical scorer inputs and split configuration.

    Returns:
        One non-held-out case, or None for a task without cases.
    """
    cases = payload.get("cases") or []
    if not cases:
        return None
    splits = split_examples(
        cases,
        SplitFractions.model_validate(payload.get("split_fractions") or {}),
        shuffle=payload.get("shuffle", True),
        seed=payload.get("seed") or 0,
    )
    eligible = splits.train or splits.val
    if not eligible:
        raise ValueError("Setup needs at least one training or validation case; held-out data is never used.")
    return eligible[0]


def _verify_model_routes(gateway: ModelGateway, *, native: bool) -> list[dict[str, Any]]:
    """Verify each configured role through its real metered provider path.

    Args:
        gateway: Trusted setup authority retaining provider credentials.
        native: Whether the optimization model uses the native Anthropic protocol.

    Returns:
        Actual successful or failed connection checks for each distinct role route.
    """
    report_preflight_phase("models")
    checks = []
    for route in gateway.model_routes():
        anthropic = native and route["role"] == "optimization"
        body = {"model": route["model"], "messages": [{"role": "user", "content": "Reply with OK."}], "max_tokens": 16}
        response = gateway.dispatch_guest(
            route["token"],
            "/v1/messages" if anthropic else "/v1/chat/completions",
            body,
            {"anthropic-version": "2023-06-01"} if anthropic else {},
        )
        checks.append(
            _check(
                f"model.{route['role']}",
                "succeeded" if 200 <= response.status < 300 else "failed",
                None
                if 200 <= response.status < 300
                else f"The selected {route['role']} model rejected its setup request.",
                route["role"],
            )
        )
    return checks


def _verify_anything(gateway: ModelGateway, payload: dict[str, Any], *, scope: str, identity: str) -> dict[str, Any]:
    """Run complete Anything readiness in its selected outer sandbox.

    Args:
        gateway: Shared setup model and sandbox authority.
        payload: Canonical partial or full Anything request.
        scope: Evaluation or complete execution readiness.
        identity: Stable preflight evidence identity.

    Returns:
        Real checks and, when a seed exists, its actual scorer preview.
    """
    report_preflight_phase("sandbox")
    events = _Events()
    protected = {
        **payload,
        "_optimization_type": OPTIMIZATION_TYPE_BLACKBOX,
        "_preflight": {"scope": scope, "identity": identity},
    }
    run_vercel_dspy(protected, f"preflight-{identity}", events, "spawn")
    if events.error or events.result is None:
        raise ValueError(events.error or "The runtime did not return setup evidence.")
    result = events.result
    optimizer_ready = any(check.get("key") == "optimizer" for check in result["checks"])
    if scope == "execution" and optimizer_ready:
        public = {key: value for key, value in payload.items() if not key.startswith("_")}
        typed = BlackboxRunRequest.model_validate(public)
        native = typed.strategy.mode != "single" or typed.strategy.engine in {"meta_harness", "autoresearch"}
        optimizer_index = next(index for index, check in enumerate(result["checks"]) if check.get("key") == "optimizer")
        result["checks"][optimizer_index:optimizer_index] = _verify_model_routes(gateway, native=native)
    return result


class _Events:
    """Collect only terminal preflight results from an isolated runtime."""

    def __init__(self) -> None:
        """Initialize a setup-only event collector."""
        self.result: dict[str, Any] | None = None
        self.error: str | None = None

    def put(self, event: dict[str, Any]) -> None:
        """Preserve a real result or error without interpreting optimizer logs as checks."""
        if event.get("type") == "preflight_phase":
            report_preflight_phase(str(event.get("phase")))
        elif event.get("type") == "preflight_result":
            self.result = event["result"]
        elif event.get("type") == "error":
            self.error = str(event.get("error") or "Setup execution failed.")


def _verify_dspy(payload: dict[str, Any], *, scope: str, identity: str) -> dict[str, Any]:
    """Run program readiness and a non-held-out sample through the selected isolated executor."""
    report_preflight_phase("sandbox")
    events = _Events()
    sample = _sample({**payload, "cases": payload.get("dataset") or []})
    payload = {**payload, "dataset": [sample] if sample is not None else [], "_preflight": {"scope": scope}}
    run_vercel_dspy(payload, f"preflight-{identity}", events, "spawn")
    if events.error or events.result is None:
        raise ValueError(events.error or "The runtime did not return setup evidence.")
    return events.result


def run_preflight(request: WizardPreflightRequest, user: Any, job_store: Any) -> WizardPreflightResponse:
    """Run canonical setup inputs under a shared authority for wizard and API callers.

    Args:
        request: Canonical current inputs with explicit budget and scope.
        user: Authenticated owner, resolved before dispatch.
        job_store: Authoritative ledger and evidence storage.

    Returns:
        Durable scoped checks and current budget state.
    """
    report_preflight_phase("budget")
    budgets = BudgetService(engine=job_store.engine)
    evidence = PreflightStore(job_store.engine)
    if request.scope == "execution":
        request = request.model_copy(update={"payload": _canonical_execution_payload(request, user.username)})
    try:
        snapshot = budgets.get(request.execution_budget_id, user.username)
        if snapshot.revision != request.execution_budget_revision:
            raise BudgetConflictError("The setup budget changed.")
        credential_vault = ProtectedCredentialVault(engine=job_store.engine)
        payload = protect_execution_credentials(
            request.payload,
            username=user.username,
            binding_id=request.execution_budget_id,
            vault=credential_vault,
        )
        request = request.model_copy(update={"payload": payload})
        claim = evidence.claim(
            username=user.username,
            budget_id=request.execution_budget_id,
            revision=request.execution_budget_revision,
            workflow=request.workflow,
            scope=request.scope,
            payload=payload,
        )
        snapshot = budgets.get(request.execution_budget_id, user.username)
        if snapshot.generation != claim.generation:
            raise BudgetConflictError("Another setup attempt replaced this execution generation.")
    except BudgetError as error:
        raise budget_http_error(error) from error
    if claim.token is None:
        return WizardPreflightResponse.model_validate({**claim.document, "budget": budget_response(snapshot)})
    try:
        with evidence.heartbeat(claim.document["id"], claim_token=claim.token):
            parent_payload = resolve_execution_credentials(
                request.payload,
                username=user.username,
                binding_id=request.execution_budget_id,
                vault=credential_vault,
            )
            parent_payload = prepare_protected_credentials(
                parent_payload,
                username=user.username,
                vault=ProviderKeyVault(engine=job_store.engine),
                default_token_source=str(parent_payload.get("token_source") or "managed"),
            )
            parent_request = request.model_copy(update={"payload": parent_payload})
            status, result = _perform_preflight(parent_request, user, budgets, snapshot, claim.document)
            snapshot = budgets.get(request.execution_budget_id, user.username)
            if snapshot.pending_operations:
                status = "pending"
                result = _mark_usage_pending(
                    result,
                    "Provider or sandbox usage is still awaiting final confirmation.",
                )
            document = evidence.finish(claim.document["id"], claim_token=claim.token, status=status, result=result)
    except BudgetError as error:
        raise budget_http_error(error) from error
    return WizardPreflightResponse.model_validate({**document, "budget": budget_response(snapshot)})


def _perform_preflight(
    request: WizardPreflightRequest, user: Any, budgets: BudgetService, snapshot: Any, document: dict[str, Any]
) -> tuple[str, dict[str, Any]]:
    """Execute the owned attempt and finalize its transports before publishing evidence.

    Args:
        request: Canonical stage inputs.
        user: Authenticated spending owner.
        budgets: Shared operation ledger.
        snapshot: Generation read after the execution claim.
        document: Durable identity of this setup attempt.

    Returns:
        Actual readiness outcome and preserved results, including pending usage.
    """
    payload = request.payload
    gateway: ModelGateway | None = None
    status = "failed"
    result: dict[str, Any] = {}
    try:
        if (
            request.workflow == "dspy"
            and request.scope == "evaluation"
            and protected_vercel_unavailable_reason(settings, "dspy")
        ):
            return "pending", {
                "checks": [
                    _check(
                        "runtime",
                        "pending",
                        "The managed execution sandbox is not available on this deployment.",
                        "execution_runtime",
                    )
                ],
                "pending_reason": _pending_reason(
                    "later_stage_dependency",
                    "The managed execution sandbox is not available on this deployment.",
                    "execution_runtime",
                ),
            }
        remote_evaluation = (
            request.workflow == "anything"
            and request.scope == "evaluation"
            and payload.get("scorer", {}).get("kind") == "remote"
            and payload.get("target", {}).get("kind") != "agent"
        )
        uses_managed_models = payload_uses_token_source(
            payload,
            TOKEN_SOURCE_MANAGED,
            default_token_source=str(payload.get("token_source") or TOKEN_SOURCE_MANAGED),
        )
        if settings.openrouter_api_key is None and uses_managed_models and not remote_evaluation:
            raise ValueError("Managed model routing is not configured.")
        gateway = ModelGateway(
            BudgetRuntime(
                budgets,
                username=user.username,
                budget_id=snapshot.id,
                generation=snapshot.generation,
                phase="setup",
            )
        )
        bind_protected_sandbox(gateway, settings, workflow=request.workflow, owner_id=document["id"])
        protected = gateway.protect_payload(
            payload,
            managed_key=settings.openrouter_api_key.get_secret_value() if settings.openrouter_api_key else "",
            allow_private_tools=settings.discover_allow_private,
        )
        result = (
            _verify_anything(
                gateway,
                protected,
                scope=request.scope,
                identity=document["id"],
            )
            if request.workflow == "anything"
            else _verify_dspy(protected, scope=request.scope, identity=document["id"])
        )
        if request.workflow == "dspy" and request.scope == "execution":
            result["checks"].extend(_verify_model_routes(gateway, native=False))
        states = {check["status"] for check in result["checks"]}
        if not states or not states.issubset({"failed", "pending", "succeeded"}):
            raise ValueError("Setup did not return a complete set of readiness checks.")
        status = "failed" if "failed" in states else "pending" if "pending" in states else "succeeded"
        if status == "pending" and "pending_reason" not in result:
            pending_check = next(check for check in result["checks"] if check["status"] == "pending")
            category = "usage_reconciliation" if pending_check.get("key") == "usage" else "setup_incomplete"
            message = pending_check.get("message") or "Setup checks are incomplete."
            result["pending_reason"] = _pending_reason(category, message, pending_check.get("field"))
    except UsagePendingError:
        status, result = (
            "pending",
            _mark_usage_pending(
                {},
                "Previous provider or sandbox usage is awaiting final confirmation.",
            ),
        )
    except Exception as error:
        result = {"checks": [_check("setup", "failed", str(error))]}
    finally:
        if gateway is not None:
            report_preflight_phase("usage")
            try:
                gateway.close()
            except UsagePendingError:
                status = "pending"
                result = _mark_usage_pending(
                    result,
                    "Provider or sandbox usage is awaiting final confirmation.",
                )
            except Exception as error:
                status = "failed"
                result.setdefault("checks", []).append(_check("runtime", "failed", str(error)))
    return status, result
