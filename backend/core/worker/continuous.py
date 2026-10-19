"""Continuous optimization: scheduled checks that start fresh, linked runs.

A plan is enabled from one successful unified run. On each scheduled check the
plan resolves the inputs it is permitted to refresh (evaluation data from a
connected source, a staged model change, a staged optimizer change). When none
changed, the check is recorded as skipped and nothing is spent. When one
changed, the check starts one fresh run through the same admission, preflight
and protected budget path as ``/optimize``. That run starts from the incumbent
version, so its final run scores the incumbent and the candidate on the same
evaluation snapshot. A candidate that beats the incumbent waits for the
customer's approval; nothing is ever deployed automatically.

Each check spends against a monthly allowance and the existing wallet only.
A new month resets the allowance, keeps every recorded cycle and its spend,
leaves in-flight budgets untouched, never buys credit, and never lifts a
customer's own pause.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..api.auth import AuthenticatedUser
from ..api.errors import DomainError
from ..api.observability import advisory_lock
from ..api.routers.connectors import connector_secret
from ..api.routers.submissions import UNIFIED_WORKFLOW, rows_to_cases, submit_unified_payload
from ..api.submission_idempotency import resolve_submission_replay_keys
from ..billing.budget_amounts import budget_wallet_hold
from ..billing.budgets import BudgetError, BudgetService
from ..billing.operation_pricing import json_fingerprint
from ..billing.protected_credentials import scrub_execution_credentials
from ..billing.service import StripeBillingService
from ..connectors import huggingface as hf
from ..connectors import registry
from ..connectors.vault import ConnectorVault
from ..constants import PAYLOAD_OVERVIEW_NAME
from ..models import UnifiedRunRequest
from ..models.common import OptimizationStatus
from ..models.unified import UnifiedData
from ..storage.models import ContinuousCycleModel, ContinuousPlanModel, ExecutionBudgetModel
from .continuous_schedule import ScheduleRule, legacy_rule, next_runs

logger = logging.getLogger(__name__)

DIMENSIONS = ("data", "models", "optimizer")
CYCLE_LEASE = timedelta(minutes=30)
# A minute keeps a check within a minute of the time the owner picked.
SWEEP_INTERVAL_SECONDS = 60.0
# Distinct from every other sweeper's advisory lock key in core.api.observability.
CONTINUOUS_SWEEP_LOCK_KEY = 7_412_093_551

PLAN_ACTIVE = "active"
PLAN_PAUSED = "paused"
# A plan set up in the submit wizard waits for its first run, and starts once that run succeeds.
PLAN_WAITING = "waiting"
PAUSE_USER = "user"
PAUSE_ALLOWANCE = "allowance"
PAUSE_FUNDS = "funds"
# Checks kept failing; only the customer resumes, so a broken source stops costing checks.
PAUSE_FAILING = "failing"
SYSTEM_PAUSES = frozenset({PAUSE_ALLOWANCE, PAUSE_FUNDS})
# A waiting plan whose first run did not succeed; kept so the owner sees why it never started.
PLAN_ENDED = "ended"
# This many failed checks in a row pause the plan.
FAILURE_STREAK = 3
# A check that lost its worker this many times is closed as failed instead of retried again.
MAX_CHECK_ATTEMPTS = 3
# A candidate must beat the incumbent by this much on a 0..1 score, so scoring noise cannot win.
WIN_MARGIN = 0.01

CYCLE_CHECKING = "checking"
CYCLE_SKIPPED = "skipped"
CYCLE_FAILED = "failed"
CYCLE_PAUSED = "paused"
CYCLE_OPTIMIZING = "optimizing"
CYCLE_AWAITING_REVIEW = "awaiting_review"
CYCLE_REGRESSED = "regressed"
CYCLE_APPROVED = "approved"
CYCLE_REJECTED = "rejected"

_TERMINAL_JOB = {
    OptimizationStatus.success.value,
    OptimizationStatus.failed.value,
    OptimizationStatus.cancelled.value,
    OptimizationStatus.stopped.value,
}

RowFetcher = Callable[[Any, str, dict[str, Any]], list[dict[str, Any]]]


class SourceError(Exception):
    """Carry an actionable i18n code for a source that cannot supply valid cases."""

    def __init__(self, code: str, **params: Any) -> None:
        """Keep the code and its substitution params.

        Args:
            code: I18n key the cycle shows.
            **params: Substitution params for the key.
        """
        super().__init__(code)
        self.code = code
        self.params = params


def aware(moment: datetime | None) -> datetime | None:
    """Treat a naive database timestamp as UTC.

    Args:
        moment: A timestamp as read back from the database.

    Returns:
        The same instant with a UTC timezone, or ``None``.
    """
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def month_key(moment: datetime) -> str:
    """Name the monthly allowance a moment falls in.

    Args:
        moment: Any timestamp.

    Returns:
        ``YYYY-MM`` in UTC.
    """
    return moment.astimezone(UTC).strftime("%Y-%m")


def next_month_start(moment: datetime) -> datetime:
    """Return when the allowance after ``moment``'s month begins.

    Args:
        moment: Any timestamp.

    Returns:
        Midnight UTC on the first day of the next month.
    """
    moment = moment.astimezone(UTC)
    year, month = (moment.year + 1, 1) if moment.month == 12 else (moment.year, moment.month + 1)
    return datetime(year, month, 1, tzinfo=UTC)


def _cases_fingerprint(cases: list[dict[str, Any]]) -> str:
    """Identify an evaluation snapshot by its exact cases, in any order.

    Args:
        cases: Unified cases in their JSON form.

    Returns:
        A content digest that the order of the cases does not change.
    """
    return json_fingerprint(canonical_cases(cases))


def canonical_cases(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Put cases in an order that depends only on their content.

    Warehouse sources return rows in no fixed order, so without this the same
    rows would look like new data and start a paid run.

    Args:
        cases: Unified cases in their JSON form.

    Returns:
        The same cases, sorted by each case's content digest.
    """
    return sorted(cases, key=json_fingerprint)


def _model_names(models: dict[str, Any]) -> dict[str, str | None]:
    """Reduce a stored models block to the names a plan may refresh.

    Args:
        models: A unified request's ``models`` block.

    Returns:
        The task and reflection model names.
    """
    task = models.get("task_model") or {}
    reflection = models.get("reflection_model") or {}
    return {"task_model": task.get("name"), "reflection_model": reflection.get("name")}


def snapshot_of_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Record the refreshable inputs of a stored unified run.

    Args:
        payload: A stored unified request.

    Returns:
        The data, model and optimizer versions the run used.
    """
    cases = payload.get("data", {}).get("cases") or []
    return {
        "data": {"fingerprint": _cases_fingerprint(cases), "cases": len(cases)},
        "models": _model_names(payload.get("models") or {}),
        "optimizer": (payload.get("optimizer") or {}).get("choice", "auto"),
    }


def changed_dimensions(baseline: dict[str, Any], snapshot: dict[str, Any]) -> list[str]:
    """List the inputs whose versions differ between two snapshots.

    Args:
        baseline: The last reviewed snapshot.
        snapshot: The snapshot resolved by this check.

    Returns:
        The changed dimensions, in a fixed order.
    """
    changed = []
    if (baseline.get("data") or {}).get("fingerprint") != (snapshot.get("data") or {}).get("fingerprint"):
        changed.append("data")
    if baseline.get("models") != snapshot.get("models"):
        changed.append("models")
    if baseline.get("optimizer") != snapshot.get("optimizer"):
        changed.append("optimizer")
    return changed


def fetch_source_rows(job_store: Any, username: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    """Read the current rows of a plan's connected source with the existing connectors.

    Args:
        job_store: Store whose engine holds the connector vault.
        username: Owner of the linked account.
        source: ``{"provider", "ref"}``; a Hugging Face ref is ``repo_id/config/split``.

    Returns:
        The source's rows.

    Raises:
        SourceError: When the account is unlinked or the source cannot be read.
    """
    provider = source.get("provider") or ""
    ref = source.get("ref") or ""
    vault = ConnectorVault(job_store.engine)
    try:
        if provider == hf.PROVIDER:
            parts = ref.rsplit("/", 2)
            if len(parts) != 3:
                raise SourceError("continuous.source_unavailable", provider=provider, reason=ref)
            rows, _schema = hf.import_split(hf.current_token(vault, username), *parts)
        else:
            module = registry.get_provider(provider)
            rows, _schema, _name = module.import_ref(connector_secret(vault, username, provider), ref)
    except SourceError:
        raise
    except DomainError as error:
        raise SourceError("continuous.source_unavailable", provider=provider, reason=str(error.detail)) from error
    except Exception as error:
        logger.warning("Continuous source read failed for %s", provider, exc_info=True)
        raise SourceError("continuous.source_unavailable", provider=provider, reason=type(error).__name__) from error
    return rows


def prepare_source_cases(rows: list[dict[str, Any]], data: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn refreshed rows into cases with the incumbent's agreed case schema.

    Args:
        rows: Rows read from the source.
        data: The incumbent run's ``data`` block, which fixes the case schema.

    Returns:
        Cases in their JSON form, validated against the run's data mode.

    Raises:
        SourceError: When the rows are empty, miss an agreed column, or do not
            fit the data mode.
    """
    if not rows:
        raise SourceError("continuous.source_invalid_cases", reason="no rows")
    input_fields = list(data.get("input_fields") or [])
    expected_field = data.get("expected_field")
    required = [*input_fields, *([expected_field] if expected_field else [])]
    missing = sorted({field for row in rows for field in required if field not in row})
    if missing:
        raise SourceError("continuous.source_invalid_cases", reason="missing columns: " + ", ".join(missing))
    if expected_field and any(row.get(expected_field) in (None, "") for row in rows):
        raise SourceError("continuous.source_invalid_cases", reason=f"empty {expected_field}")
    cases = rows_to_cases(rows, input_fields=input_fields, expected_field=expected_field)
    try:
        UnifiedData.model_validate({**data, "cases": cases, "staged_dataset_id": None})
    except ValidationError as error:
        message = str(error.errors()[0].get("msg", "")) if error.errors() else str(error)
        raise SourceError("continuous.source_invalid_cases", reason=message.removeprefix("Value error, ")) from error
    return cases


def _incumbent(job_store: Any, optimization_id: str) -> dict[str, Any]:
    """Load the incumbent run with its payload and result.

    Args:
        job_store: Job store.
        optimization_id: The incumbent run.

    Returns:
        The job record.
    """
    return job_store.get_job(optimization_id, include_payload=True)


def resolve_snapshot(
    plan: ContinuousPlanModel, incumbent_payload: dict[str, Any], *, job_store: Any, fetch_rows: RowFetcher
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Resolve the inputs this check would use, refreshing only what is permitted.

    Args:
        plan: The plan being checked.
        incumbent_payload: The incumbent run's stored request.
        job_store: Job store handed to the row fetcher.
        fetch_rows: Reads a source's rows.

    Returns:
        The snapshot and the cases it describes.

    Raises:
        SourceError: When a permitted data refresh cannot supply valid cases.
    """
    permitted = plan.permitted or {}
    data = incumbent_payload.get("data") or {}
    cases = list(data.get("cases") or [])
    data_snapshot: dict[str, Any] = {"fingerprint": _cases_fingerprint(cases), "cases": len(cases)}
    if permitted.get("data") and plan.source:
        cases = canonical_cases(prepare_source_cases(fetch_rows(job_store, plan.username, plan.source), data))
        data_snapshot = {"fingerprint": _cases_fingerprint(cases), "cases": len(cases), "source": plan.source}
    models = _model_names(incumbent_payload.get("models") or {})
    optimizer = (incumbent_payload.get("optimizer") or {}).get("choice", "auto")
    pending = plan.pending_inputs or {}
    if permitted.get("models"):
        for role in ("task_model", "reflection_model"):
            if pending.get(role):
                models[role] = pending[role]
    if permitted.get("optimizers") and pending.get("optimizer"):
        optimizer = pending["optimizer"]
    return {"data": data_snapshot, "models": models, "optimizer": optimizer}, cases


def month_committed(session: Session, plan: ContinuousPlanModel, month: str) -> int:
    """Sum what a plan's cycles spent or hold in one monthly allowance.

    A cycle still optimizing counts at its full budget total, because its
    reservation can still be drawn on. A finished cycle counts what its budget
    billed plus any hold it still keeps for usage awaiting reconciliation.

    Args:
        session: Open database session.
        plan: The plan.
        month: ``YYYY-MM`` allowance.

    Returns:
        Committed cents.
    """
    cycles = session.scalars(
        select(ContinuousCycleModel).where(ContinuousCycleModel.plan_id == plan.id, ContinuousCycleModel.month == month)
    ).all()
    budget_ids = [cycle.execution_budget_id for cycle in cycles if cycle.execution_budget_id]
    budgets = {
        budget.id: budget
        for budget in session.scalars(select(ExecutionBudgetModel).where(ExecutionBudgetModel.id.in_(budget_ids)))
    }
    total = 0
    for cycle in cycles:
        budget = budgets.get(cycle.execution_budget_id)
        if cycle.status == CYCLE_OPTIMIZING:
            total += plan.cycle_budget_cents
        elif budget is not None:
            # ``spent_cents`` is sampled once when the run ends; reconciliation can bill more later.
            total += budget.billed_cents + budget_wallet_hold(budget)
        elif cycle.spent_cents:
            total += cycle.spent_cents
    return total


def _billed_cents(job_store: Any, budget_id: str | None, username: str) -> int | None:
    """Read what a cycle's protected budget billed the wallet.

    Args:
        job_store: Store whose engine holds the budgets.
        budget_id: The cycle's budget, if one was created.
        username: Budget owner.

    Returns:
        Billed cents, or ``None`` without a budget.
    """
    if budget_id is None:
        return None
    try:
        return BudgetService(engine=job_store.engine).get(budget_id, username).billed_cents
    except BudgetError:
        return None


def _cycle_payload(
    plan: ContinuousPlanModel,
    incumbent: dict[str, Any],
    cases: list[dict[str, Any]],
    snapshot: dict[str, Any],
    sequence: int,
) -> UnifiedRunRequest:
    """Derive a fresh run request from the incumbent and this check's inputs.

    The objective, metric, workspace, constraints and split stay those of the
    incumbent; only the permitted inputs change. The run starts from the
    incumbent's best version, so its final run scores incumbent and candidate
    on the same cases.

    Args:
        plan: The plan.
        incumbent: The incumbent run record.
        cases: This check's evaluation cases.
        snapshot: This check's resolved inputs.
        sequence: Cycle number shown in the run name.

    Returns:
        A new, unfunded unified request.
    """
    stored = scrub_execution_credentials(incumbent["payload"])
    copy = {
        key: value
        for key, value in stored.items()
        if not key.startswith("_budget")
        and not key.startswith("execution_budget_")
        and key not in {"preflight_id", "preflight_fingerprint", "estimated_cents_low", "estimated_cents_high"}
    }
    copy["data"] = {**copy["data"], "cases": cases, "staged_dataset_id": None}
    best = (incumbent.get("result") or {}).get("best_candidate")
    if best is not None:
        copy["task"] = {**copy["task"], "artifact": {**copy["task"]["artifact"], "starting_version": best}}
    models = dict(copy["models"])
    for role in ("task_model", "reflection_model"):
        name = snapshot["models"].get(role)
        if name and (models.get(role) or {}).get("name") != name:
            models[role] = {**(models.get(role) or {}), "name": name}
    copy["models"] = models
    copy["optimizer"] = {**copy.get("optimizer", {}), "choice": snapshot["optimizer"]}
    base_name = (incumbent.get("payload_overview") or {}).get(PAYLOAD_OVERVIEW_NAME) or copy.get("name") or ""
    copy["name"] = f"{base_name} · #{sequence}".strip(" ·")
    copy["max_cost_cents"] = plan.cycle_budget_cents
    return UnifiedRunRequest.model_validate(copy)


def _finish_cycle(session: Session, cycle: ContinuousCycleModel, status: str, code: str | None, **params: Any) -> None:
    """Record a cycle's outcome and release its lease.

    Args:
        session: Open session that owns ``cycle``.
        cycle: The cycle.
        status: New cycle status.
        code: I18n key explaining the outcome.
        **params: Substitution params for ``code``.
    """
    cycle.status = status
    cycle.detail_code = code
    cycle.detail_params = params
    cycle.lease_until = None
    cycle.updated_at = datetime.now(UTC)


def _pause(plan: ContinuousPlanModel, reason: str) -> None:
    """Pause a plan for a recorded reason.

    Args:
        plan: The plan.
        reason: ``user``, ``allowance``, ``funds`` or ``failing``.
    """
    if plan.pause_reason == PAUSE_USER and reason != PAUSE_USER:
        # Only the customer lifts their own pause, so a funds or allowance pause never replaces it.
        return
    plan.status = PLAN_PAUSED
    plan.pause_reason = reason
    if reason == PAUSE_FAILING:
        # Unlike a funds or allowance pause, nothing a later check sees can lift this one.
        plan.next_check_at = None
    plan.updated_at = datetime.now(UTC)


_STREAK_NEUTRAL = frozenset({"continuous.skip_busy", "continuous.skip_review_pending", "continuous.skip_paused"})


def _fail_cycle(
    session: Session, plan: ContinuousPlanModel, cycle: ContinuousCycleModel, code: str, **params: Any
) -> None:
    """Record a failed cycle and pause the plan after a streak of failures.

    Checks skipped only because another check, a run or a review was in the
    way say nothing about the source, so they neither count nor break a streak.

    Args:
        session: Open session that owns ``plan`` and ``cycle``.
        plan: The cycle's plan.
        cycle: The cycle.
        code: I18n key explaining the failure.
        **params: Substitution params for ``code``.
    """
    _finish_cycle(session, cycle, CYCLE_FAILED, code, **params)
    session.flush()
    recent = session.scalars(
        select(ContinuousCycleModel)
        .where(ContinuousCycleModel.plan_id == plan.id, ContinuousCycleModel.status != CYCLE_CHECKING)
        .order_by(ContinuousCycleModel.created_at.desc(), ContinuousCycleModel.slot.desc())
        .limit(FAILURE_STREAK * 4)
    ).all()
    counted = [item for item in recent if item.detail_code not in _STREAK_NEUTRAL][:FAILURE_STREAK]
    if len(counted) == FAILURE_STREAK and all(item.status == CYCLE_FAILED for item in counted):
        _pause(plan, PAUSE_FAILING)


def process_cycle(
    job_store: Any,
    service: Any,
    cycle_id: str,
    *,
    now: datetime | None = None,
    fetch_rows: RowFetcher = fetch_source_rows,
) -> None:
    """Run one claimed check to its outcome: skip, pause, fail or start a run.

    Safe to repeat. The run is submitted under an idempotency key derived from
    the cycle, so a retried check replays the same run and the same budget
    instead of creating new ones.

    Args:
        job_store: Job store.
        service: Optimization service handed to the in-process worker.
        cycle_id: The claimed cycle.
        now: Clock override for tests.
        fetch_rows: Reads a source's rows.
    """
    now = now or datetime.now(UTC)
    engine = job_store.engine
    with Session(engine) as session, session.begin():
        cycle = session.get(ContinuousCycleModel, cycle_id)
        if cycle is None or cycle.status != CYCLE_CHECKING:
            return
        # Locked so a customer's pause committed meanwhile is not overwritten by this check's outcome.
        plan = session.get(ContinuousPlanModel, cycle.plan_id, with_for_update=True)
        if plan is None:
            return
        accepted = job_store.find_job_by_idempotency_key(plan.username, f"continuous:{cycle.id}")
        if accepted is not None:
            # A worker died between submitting and linking. The run is already paid for and ran on the
            # inputs recorded then, so link it as is instead of re-reading inputs or re-checking funds.
            job = job_store.get_job(accepted, include_payload=False)
            cycle.optimization_id = accepted
            cycle.execution_budget_id = job.get("execution_budget_id")
            _finish_cycle(
                session, cycle, CYCLE_OPTIMIZING, "continuous.run_started", changes=",".join(cycle.changes or [])
            )
            return
        if plan.status == PLAN_PAUSED and plan.pause_reason in (PAUSE_USER, PAUSE_FAILING):
            _finish_cycle(session, cycle, CYCLE_SKIPPED, "continuous.skip_paused")
            return
        busy = session.scalar(
            select(ContinuousCycleModel.status).where(
                ContinuousCycleModel.plan_id == plan.id,
                ContinuousCycleModel.id != cycle.id,
                ContinuousCycleModel.status.in_((CYCLE_OPTIMIZING, CYCLE_AWAITING_REVIEW))
                | ((ContinuousCycleModel.status == CYCLE_CHECKING) & (ContinuousCycleModel.slot < cycle.slot)),
            )
        )
        if busy is not None:
            code = "continuous.skip_review_pending" if busy == CYCLE_AWAITING_REVIEW else "continuous.skip_busy"
            _finish_cycle(session, cycle, CYCLE_SKIPPED, code)
            return
        try:
            incumbent = _incumbent(job_store, plan.incumbent_optimization_id)
        except KeyError:
            # Uncaught, the cycle would stay ``checking`` and hold back every later check.
            _fail_cycle(session, plan, cycle, "continuous.run_rejected", reason="the incumbent run was deleted")
            return
        try:
            snapshot, cases = resolve_snapshot(plan, incumbent["payload"], job_store=job_store, fetch_rows=fetch_rows)
        except SourceError as error:
            _fail_cycle(session, plan, cycle, error.code, **error.params)
            return
        cycle.snapshot = snapshot
        changes = changed_dimensions(plan.baseline_snapshot or {}, snapshot)
        cycle.changes = changes
        spendable = StripeBillingService(engine=engine).spendable_cents(plan.username)
        gate = None
        if (
            plan.monthly_limit_cents is not None
            and plan.monthly_limit_cents - month_committed(session, plan, cycle.month) < plan.cycle_budget_cents
        ):
            gate = PAUSE_ALLOWANCE
        elif spendable < plan.cycle_budget_cents:
            gate = PAUSE_FUNDS
        if gate is None and plan.status == PLAN_PAUSED and plan.pause_reason in SYSTEM_PAUSES:
            plan.status, plan.pause_reason = PLAN_ACTIVE, None
        if not changes:
            _finish_cycle(session, cycle, CYCLE_SKIPPED, "continuous.skip_unchanged")
            return
        if gate is not None:
            _pause(plan, gate)
            _finish_cycle(session, cycle, CYCLE_PAUSED, f"continuous.paused_{gate}")
            return
        started = session.scalars(
            select(ContinuousCycleModel.id).where(
                ContinuousCycleModel.plan_id == plan.id, ContinuousCycleModel.optimization_id.is_not(None)
            )
        ).all()
        try:
            payload = _cycle_payload(plan, incumbent, cases, snapshot, len(started) + 1)
        except ValidationError as error:
            # A staged model or optimizer the run contract rejects fails this cycle instead of wedging the plan.
            reason = "; ".join(str(item.get("msg")) for item in error.errors())
            _fail_cycle(session, plan, cycle, "continuous.run_rejected", reason=reason)
            return
        key = f"continuous:{cycle.id}"
        budget_key = resolve_submission_replay_keys(
            payload, username=plan.username, workflow=UNIFIED_WORKFLOW, supplied_key=key
        ).budget
        plan_username = plan.username
        cycle.snapshot = {
            **snapshot,
            "config": json_fingerprint(payload.task.model_dump(mode="json", exclude={"artifact"})),
            "seed": payload.seed,
            "compared_against": plan.incumbent_optimization_id,
        }
    user = AuthenticatedUser(plan_username, "user", ())
    try:
        response = submit_unified_payload(
            payload, service=service, job_store=job_store, current_user=user, idempotency_key=key
        )
    except DomainError as error:
        budget = BudgetService(engine=engine).find_by_creation_key(plan_username, budget_key) if budget_key else None
        with Session(engine) as session, session.begin():
            cycle = session.get(ContinuousCycleModel, cycle_id)
            plan = session.get(ContinuousPlanModel, cycle.plan_id, with_for_update=True)
            cycle.execution_budget_id = budget.id if budget else None
            cycle.spent_cents = _billed_cents(job_store, cycle.execution_budget_id, plan_username)
            if error.code == "budget.pending":
                # Setup usage is still being confirmed. The cycle keeps its lease, so a
                # later sweep replays this same key and budget instead of a new check
                # paying for setup again. This wait is not a crash, so it does
                # not count toward MAX_CHECK_ATTEMPTS.
                cycle.detail_params = {**(cycle.detail_params or {}), "attempts": 0}
                return
            if error.code in {"billing.insufficient_funds", "budget.insufficient"}:
                _pause(plan, PAUSE_FUNDS)
                _finish_cycle(session, cycle, CYCLE_PAUSED, "continuous.paused_funds")
            else:
                _fail_cycle(session, plan, cycle, "continuous.run_rejected", reason=str(error.detail))
        return
    job = job_store.get_job(response.optimization_id, include_payload=False)
    with Session(engine) as session, session.begin():
        cycle = session.get(ContinuousCycleModel, cycle_id)
        cycle.optimization_id = response.optimization_id
        cycle.execution_budget_id = job.get("execution_budget_id")
        _finish_cycle(session, cycle, CYCLE_OPTIMIZING, "continuous.run_started", changes=",".join(cycle.changes))
    logger.info("Continuous cycle %s started run %s", cycle_id, response.optimization_id)


def review_cycle(job_store: Any, cycle_id: str) -> None:
    """Judge a finished cycle run against the incumbent it started from.

    A candidate is kept for review only when its run succeeded, the final run
    scored both versions on the same held-out test cases, no regression guard
    fired, and the candidate scored at least ``WIN_MARGIN`` higher. Anything
    else leaves the incumbent in place. Only a successful run marks its inputs
    as seen, so a run that failed (a provider outage) is retried on the next
    check instead of waiting for the data to change again.

    Args:
        job_store: Job store.
        cycle_id: A cycle in ``optimizing``.
    """
    with Session(job_store.engine) as session, session.begin():
        cycle = session.get(ContinuousCycleModel, cycle_id)
        if cycle is None or cycle.status != CYCLE_OPTIMIZING or cycle.optimization_id is None:
            return
        plan = session.get(ContinuousPlanModel, cycle.plan_id, with_for_update=True)
        try:
            job = job_store.get_job(cycle.optimization_id, include_payload=False)
        except KeyError:
            _fail_cycle(session, plan, cycle, "continuous.run_failed", reason="missing")
            return
        if job["status"] not in _TERMINAL_JOB:
            return
        cycle.spent_cents = _billed_cents(job_store, cycle.execution_budget_id, plan.username)
        plan.updated_at = datetime.now(UTC)
        if job["status"] != OptimizationStatus.success.value:
            # The baseline stays put so the next check retries these inputs instead of skipping them as unchanged.
            _fail_cycle(session, plan, cycle, "continuous.run_failed", reason=job["status"])
            return
        plan.baseline_snapshot = cycle.snapshot or plan.baseline_snapshot
        result = job.get("result") or {}
        baseline = result.get("baseline_score")
        best = result.get("best_score")
        split = result.get("split_counts") or {}
        cycle.incumbent_score, cycle.candidate_score = baseline, best
        if baseline is None or best is None:
            _finish_cycle(session, cycle, CYCLE_REGRESSED, "continuous.review_unscored")
        elif not (split.get("test") and split.get("held_out")):
            # Without separate test cases the split that picked the candidate would also judge it.
            _finish_cycle(session, cycle, CYCLE_REGRESSED, "continuous.review_not_held_out")
        elif result.get("regression_guard_applied") or best <= baseline:
            _finish_cycle(session, cycle, CYCLE_REGRESSED, "continuous.review_regressed")
        elif best < baseline + WIN_MARGIN:
            _finish_cycle(session, cycle, CYCLE_REGRESSED, "continuous.review_within_margin")
        else:
            _finish_cycle(session, cycle, CYCLE_AWAITING_REVIEW, "continuous.review_ready")


def plan_rule(plan: ContinuousPlanModel) -> ScheduleRule:
    """Read a plan's schedule rule, including plans saved as ``daily``/``weekly``.

    Args:
        plan: The plan.

    Returns:
        The plan's rule.
    """
    return ScheduleRule.model_validate(plan.schedule_rule) if plan.schedule_rule else legacy_rule(plan.schedule)


def plan_anchor(plan: ContinuousPlanModel) -> datetime | None:
    """Return when the plan's intervals start counting: its last schedule change, else its creation.

    Args:
        plan: The plan.

    Returns:
        The anchor time, or ``None`` for an unsaved plan with neither.
    """
    stored = (plan.schedule_rule or {}).get("anchor")
    if isinstance(stored, str):
        return aware(datetime.fromisoformat(stored))
    return aware(plan.created_at)


def next_check_after(plan: ContinuousPlanModel, after: datetime) -> datetime:
    """Return the plan's first scheduled check strictly after ``after``.

    Args:
        plan: The plan.
        after: Reference time.

    Returns:
        The next check time in UTC.
    """
    return next_runs(plan_rule(plan), after, anchor=plan_anchor(plan) or after)[0]


def settle_waiting(plan: ContinuousPlanModel, job_status: str | None, now: datetime) -> None:
    """Start a waiting plan once its first run succeeded, or end it once that run ended otherwise.

    An ended plan is kept, with the run's outcome as its reason, so the owner
    sees why the schedule never started; they delete it from the run page.

    Args:
        plan: A plan, in any state.
        job_status: Status of the plan's source run, or ``None`` when the run is gone.
        now: Current time.
    """
    if plan.status != PLAN_WAITING:
        return
    if job_status == OptimizationStatus.success.value:
        plan.status = PLAN_ACTIVE
        plan.next_check_at = next_check_after(plan, now)
        plan.updated_at = now
    elif job_status is None or job_status in _TERMINAL_JOB:
        plan.status = PLAN_ENDED
        plan.pause_reason = job_status or "missing"
        plan.next_check_at = None
        plan.updated_at = now


def _settle_waiting_plans(job_store: Any, now: datetime) -> None:
    """Start or end every waiting plan whose first run finished.

    Args:
        job_store: Job store.
        now: Current time.
    """
    with Session(job_store.engine) as session:
        for plan in session.scalars(select(ContinuousPlanModel).where(ContinuousPlanModel.status == PLAN_WAITING)):
            try:
                status = job_store.get_job(plan.source_optimization_id, include_payload=False)["status"]
            except KeyError:
                status = None
            settle_waiting(plan, status, now)
        session.commit()


def _claim_due(engine: Any, now: datetime, *, only_plan_id: str | None = None) -> list[str]:
    """Claim every due check exactly once and return the new cycle ids.

    The plan's ``next_check_at`` is advanced with a compare-and-set and the
    cycle is inserted under the unique ``(plan_id, slot)`` pair in the same
    transaction, so a second worker or an overlapping sweep claims nothing.
    The next check is the rule's first time after now, so checks missed while
    the service was down collapse into this one.

    Args:
        engine: Database engine.
        now: Current time.
        only_plan_id: Claim only this plan's check; every plan when omitted.

    Returns:
        Ids of the cycles this call claimed.
    """
    query = select(ContinuousPlanModel).where(
        ContinuousPlanModel.next_check_at.is_not(None),
        ContinuousPlanModel.next_check_at <= now,
    )
    if only_plan_id is not None:
        query = query.where(ContinuousPlanModel.id == only_plan_id)
    with Session(engine) as session:
        due = session.scalars(query).all()
        plans = [(plan.id, plan.next_check_at, next_check_after(plan, now)) for plan in due]
    claimed = []
    for plan_id, slot_at, following in plans:
        slot = aware(slot_at)
        try:
            with Session(engine) as session, session.begin():
                won = session.execute(
                    update(ContinuousPlanModel)
                    .where(ContinuousPlanModel.id == plan_id, ContinuousPlanModel.next_check_at == slot_at)
                    .values(next_check_at=following)
                ).rowcount
                if not won:
                    continue
                cycle = ContinuousCycleModel(
                    plan_id=plan_id,
                    slot=slot.isoformat(),
                    month=month_key(now),
                    status=CYCLE_CHECKING,
                    lease_until=now + CYCLE_LEASE,
                )
                session.add(cycle)
                session.flush()
                claimed.append(cycle.id)
        except IntegrityError:
            continue
    return claimed


def _reclaim_stale(engine: Any, now: datetime) -> list[str]:
    """Take over checks whose worker died before recording an outcome.

    A check that already lost its worker ``MAX_CHECK_ATTEMPTS`` times is
    closed as failed, so one check that always crashes cannot hold back the
    plan's later checks and "Check now" forever.

    Args:
        engine: Database engine.
        now: Current time.

    Returns:
        Ids of the cycles this call took over.
    """
    with Session(engine) as session:
        stale = session.execute(
            select(ContinuousCycleModel.id, ContinuousCycleModel.lease_until).where(
                ContinuousCycleModel.status == CYCLE_CHECKING,
                ContinuousCycleModel.lease_until <= now,
            )
        ).all()
    taken = []
    for cycle_id, lease in stale:
        with Session(engine) as session, session.begin():
            won = session.execute(
                update(ContinuousCycleModel)
                .where(ContinuousCycleModel.id == cycle_id, ContinuousCycleModel.lease_until == lease)
                .values(lease_until=now + CYCLE_LEASE)
            ).rowcount
            if not won:
                continue
            cycle = session.get(ContinuousCycleModel, cycle_id)
            attempts = int((cycle.detail_params or {}).get("attempts", 1)) + 1
            if attempts > MAX_CHECK_ATTEMPTS:
                plan = session.get(ContinuousPlanModel, cycle.plan_id, with_for_update=True)
                if plan is None:
                    _finish_cycle(session, cycle, CYCLE_FAILED, "continuous.check_stuck", attempts=MAX_CHECK_ATTEMPTS)
                else:
                    _fail_cycle(session, plan, cycle, "continuous.check_stuck", attempts=MAX_CHECK_ATTEMPTS)
                continue
            cycle.detail_params = {**(cycle.detail_params or {}), "attempts": attempts}
        taken.append(cycle_id)
    return taken


def run_due_checks(
    job_store: Any,
    service: Any,
    *,
    now: datetime | None = None,
    fetch_rows: RowFetcher = fetch_source_rows,
) -> list[str]:
    """Review finished cycle runs, then run every due or abandoned check once.

    Args:
        job_store: Job store.
        service: Optimization service handed to the in-process worker.
        now: Clock override for tests.
        fetch_rows: Reads a source's rows.

    Returns:
        Ids of the cycles this pass checked.
    """
    now = now or datetime.now(UTC)
    engine = job_store.engine
    with Session(engine) as session:
        optimizing = session.scalars(
            select(ContinuousCycleModel.id).where(ContinuousCycleModel.status == CYCLE_OPTIMIZING)
        ).all()
    for cycle_id in optimizing:
        review_cycle(job_store, cycle_id)
    _settle_waiting_plans(job_store, now)
    checked = _reclaim_stale(engine, now) + _claim_due(engine, now)
    for cycle_id in checked:
        try:
            process_cycle(job_store, service, cycle_id, now=now, fetch_rows=fetch_rows)
        except Exception:
            # The lease expires and a later sweep retries; the idempotency key
            # keeps that retry from starting or funding a second run.
            logger.exception("Continuous cycle %s failed", cycle_id)
    return checked


def check_plan_now(job_store: Any, service: Any, plan_id: str, *, fetch_rows: RowFetcher = fetch_source_rows) -> None:
    """Claim and run one plan's due check now, without waiting for a sweep.

    "Check now" calls this right after it makes the check due. Sweeps run on
    one replica at a time and can lag by minutes, so the click must not wait
    for one. The claim is the same compare-and-set as a sweep's, so a sweep
    that reaches the plan first leaves nothing to claim here, and the reverse.

    Args:
        job_store: Job store.
        service: Optimization service handed to the in-process worker.
        plan_id: The plan whose check is due.
        fetch_rows: Reads a source's rows.
    """
    for cycle_id in _claim_due(job_store.engine, datetime.now(UTC), only_plan_id=plan_id):
        try:
            process_cycle(job_store, service, cycle_id, fetch_rows=fetch_rows)
        except Exception:
            # The lease expires and a later sweep retries, as for a swept check.
            logger.exception("Continuous cycle %s failed", cycle_id)


class ContinuousSweeper:
    """Run :func:`run_due_checks` on a timer on one replica at a time."""

    def __init__(self, job_store: Any, service: Any, interval_seconds: float = SWEEP_INTERVAL_SECONDS) -> None:
        """Bind the sweeper to its store and service.

        Args:
            job_store: Job store.
            service: Optimization service handed to the in-process worker.
            interval_seconds: Seconds between sweeps.
        """
        self._job_store = job_store
        self._service = service
        self._interval_seconds = interval_seconds
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Start the background sweep loop."""
        self._thread = threading.Thread(target=self._run, name="continuous-sweeper", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop the background sweep loop."""
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def sweep_once(self) -> None:
        """Run one pass when this replica holds the sweep lock."""
        try:
            with advisory_lock(self._job_store.engine, CONTINUOUS_SWEEP_LOCK_KEY) as leader:
                if leader:
                    run_due_checks(self._job_store, self._service)
        except Exception:
            logger.warning("Continuous sweep failed", exc_info=True)

    def _run(self) -> None:
        """Sweep until stopped."""
        while not self._stop_event.wait(self._interval_seconds):
            self.sweep_once()


def start_continuous_sweeper(job_store: Any, service: Any) -> ContinuousSweeper | None:
    """Start the continuous-optimization sweeper when the store has a database.

    Args:
        job_store: Job store.
        service: Optimization service handed to the in-process worker.

    Returns:
        The started sweeper, or ``None`` for a store without an engine.
    """
    if getattr(job_store, "engine", None) is None:
        return None
    sweeper = ContinuousSweeper(job_store, service)
    sweeper.start()
    return sweeper
