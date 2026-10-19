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
import math
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..api.auth import AuthenticatedUser
from ..api.errors import DomainError
from ..api.model_catalog import CatalogModel, _reasoning_match_key, get_catalog_cached
from ..api.observability import advisory_lock
from ..api.routers.billing import _byok_catalog_for_user
from ..api.routers.connectors import connector_secret
from ..api.routers.submissions import UNIFIED_WORKFLOW, rows_to_cases, submit_unified_payload
from ..api.submission_idempotency import resolve_submission_replay_keys
from ..billing import ProviderKeyVault
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
from ..models.common import OptimizationStatus, SplitFractions
from ..models.unified import MIN_PAIRS_FOR_HELD_OUT, PinnedSplit, UnifiedData
from ..service_gateway.optimization.unified.split import case_key, split_cases, split_seed
from ..storage.models import ContinuousCycleModel, ContinuousPlanModel, ExecutionBudgetModel
from .continuous_schedule import ScheduleRule, legacy_rule, next_runs

logger = logging.getLogger(__name__)

DIMENSIONS = ("data", "models", "optimizer", "new_model")
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
# An ended plan whose first run kept no test cases apart, so no check could ever replace it.
END_NO_TEST_SPLIT = "no_test_split"
SYSTEM_PAUSES = frozenset({PAUSE_ALLOWANCE, PAUSE_FUNDS})
# A waiting plan whose first run did not succeed; kept so the owner sees why it never started.
PLAN_ENDED = "ended"
# This many failed checks in a row pause the plan.
FAILURE_STREAK = 3
# A check that lost its worker this many times is closed as failed instead of retried again.
MAX_CHECK_ATTEMPTS = 3
# A candidate must beat the incumbent by this much on a 0..1 score, so scoring noise cannot win.
WIN_MARGIN = 0.01
# Without an owner-set minimum, new data starts a run once it adds this share of the incumbent's cases.
DEFAULT_NEW_CASES_SHARE = 0.1
# The plan flag that lets each model role move to a better model.
NEW_MODEL_FLAGS = {"task_model": "new_task_model", "reflection_model": "new_reflection_model"}
# The runs a check can start when new data and a better model are both waiting.
RUN_DATA = "data"
RUN_MODEL = "model"
RUN_BOTH = "both"
MATRIX_KINDS = (RUN_DATA, RUN_MODEL, RUN_BOTH)
# Scores the current version with its own models on a changed test set, without optimizing.
RUN_REFERENCE = "reference"

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
ModelPicker = Callable[[Any, str, dict[str, Any]], dict[str, Any] | None]


@dataclass(frozen=True)
class CycleRun:
    """One run a check starts, with the cases and split it uses.

    Every run of one check holds out the same test cases, so their scores
    compare. ``new_models`` maps a model role to the better model this run
    tries. ``own_models`` keeps the incumbent's models as they are, which only
    the reference run does.
    """

    kind: str
    cases: list[dict[str, Any]]
    pinned: PinnedSplit
    task_model_changed: bool
    new_models: dict[str, dict[str, Any]] = field(default_factory=dict)
    own_models: bool = False
    score_only: bool = False


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
    if snapshot.get("new_models"):
        changed.append("new_model")
    return changed


def _comparable(model: CatalogModel) -> bool:
    """Say whether a catalog model has the rating and both prices a comparison needs.

    Args:
        model: A catalog model.

    Returns:
        ``True`` when it is rated and priced for input and output.
    """
    return (
        model.intelligence_index is not None
        and model.input_cost_per_token is not None
        and model.output_cost_per_token is not None
    )


def better_model(job_store: Any, username: str, current: dict[str, Any]) -> dict[str, Any] | None:
    """Find the model a plan should try next for one role: rated higher and priced no higher.

    A higher rating at an equal or lower price for both input and output has
    no downside, so a plan may try it on its own. Only models the run can pay
    for the way it pays now are considered: the hosted catalog for a managed
    run, the owner's verified connections for a BYOK run. A model on a custom
    endpoint is never switched.

    Args:
        job_store: Store whose engine holds the provider connections.
        username: Plan owner.
        current: The model block the run uses now for this role.

    Returns:
        ``{"name", "byok_provider"}`` for the highest-rated such model, or ``None``.
    """
    if current.get("base_url"):
        return None
    if current.get("token_source") == "byok":
        # The BYOK registry carries no ratings, so each model borrows the
        # rating of its hosted twin (same id, or the same model under another
        # provider's spelling).
        ratings: dict[str, float] = {}
        for hosted in get_catalog_cached().models:
            if hosted.intelligence_index is not None:
                ratings.setdefault(hosted.value, hosted.intelligence_index)
                ratings.setdefault(_reasoning_match_key(hosted.value), hosted.intelligence_index)
        models = [
            model
            if model.intelligence_index is not None
            else model.model_copy(
                update={"intelligence_index": ratings.get(model.value, ratings.get(_reasoning_match_key(model.value)))}
            )
            for model in _byok_catalog_for_user(ProviderKeyVault(engine=job_store.engine), username).models
        ]
    else:
        models = [model for model in get_catalog_cached().models if model.available]
    now = next((model for model in models if model.value == current.get("name")), None)
    if now is None or not _comparable(now):
        # Without a rating and both prices there is nothing to compare, so nothing counts as better.
        return None
    better = [
        model
        for model in models
        if _comparable(model)
        and (model.intelligence_index or 0.0) > (now.intelligence_index or 0.0)
        and (model.input_cost_per_token or 0.0) <= (now.input_cost_per_token or 0.0)
        and (model.output_cost_per_token or 0.0) <= (now.output_cost_per_token or 0.0)
    ]
    if not better:
        return None
    best = max(better, key=lambda model: (model.intelligence_index or 0.0, -(model.input_cost_per_token or 0.0)))
    return {"name": best.value, "byok_provider": best.byok_provider}


def new_cases_needed(plan: ContinuousPlanModel, incumbent_cases: int) -> int:
    """Return how many new or changed cases start a data run.

    Args:
        plan: The plan.
        incumbent_cases: How many cases the incumbent run used.

    Returns:
        The owner's minimum, else a share of the incumbent's cases, at least one.
    """
    explicit = (plan.permitted or {}).get("min_new_cases")
    return int(explicit) if explicit else max(1, math.ceil(incumbent_cases * DEFAULT_NEW_CASES_SHARE))


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


def has_held_out(job: dict[str, Any]) -> bool:
    """Say whether a run scores its versions on test cases that no optimizer saw.

    A plan can replace its current version only on such a run, so a run without
    them would spend money on checks that can never win. A finished run answers
    from the split it recorded; a run still in flight from its request.

    Args:
        job: A run with its payload and, once finished, its result.

    Returns:
        ``True`` when the run has held-out test cases.
    """
    split = (job.get("result") or {}).get("split_counts")
    if isinstance(split, dict):
        return bool(split.get("test")) and split.get("held_out") is True
    data = (job.get("payload") or {}).get("data") or {}
    if data.get("mode") != "pairs" or SplitFractions(**(data.get("split") or {})).test <= 0:
        return False
    cases = data.get("cases")
    return cases is None or len(cases) >= MIN_PAIRS_FOR_HELD_OUT


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
    plan: ContinuousPlanModel,
    incumbent_payload: dict[str, Any],
    *,
    job_store: Any,
    fetch_rows: RowFetcher,
    pick_model: ModelPicker = better_model,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Resolve the inputs this check would use, refreshing only what is permitted.

    Refreshed data counts only once it adds the plan's minimum of new or
    changed cases; until then the check keeps the incumbent's cases, so small
    changes do not pay for a run. Each better model is tried once per role.

    Args:
        plan: The plan being checked.
        incumbent_payload: The incumbent run's stored request.
        job_store: Job store handed to the row fetcher.
        fetch_rows: Reads a source's rows.
        pick_model: Finds a better model for one role.

    Returns:
        The snapshot and the cases it describes.

    Raises:
        SourceError: When a permitted data refresh cannot supply valid cases.
    """
    permitted = plan.permitted or {}
    data = incumbent_payload.get("data") or {}
    stored = list(data.get("cases") or [])
    cases = stored
    baseline = plan.baseline_snapshot or {}
    prior = baseline.get("data") or {"fingerprint": _cases_fingerprint(stored), "cases": len(stored)}
    data_snapshot: dict[str, Any] = prior
    if permitted.get("data") and plan.source:
        fresh = canonical_cases(prepare_source_cases(fetch_rows(job_store, plan.username, plan.source), data))
        known = {case_key(case) for case in stored}
        # New cases an earlier run already tried against this incumbent do not count again.
        same_incumbent = prior.get("incumbent") == plan.incumbent_optimization_id
        tried = set(prior.get("tried_cases") or []) if same_incumbent else set()
        new_keys = [key for key in (case_key(case) for case in fresh) if key not in known]
        untried = sum(1 for key in new_keys if key not in tried)
        fingerprint = _cases_fingerprint(fresh)
        if fingerprint != prior.get("fingerprint") and untried >= new_cases_needed(plan, len(stored)):
            cases = fresh
            data_snapshot = {
                "fingerprint": fingerprint,
                "cases": len(fresh),
                "source": plan.source,
                "new_cases": len(new_keys),
                "incumbent": plan.incumbent_optimization_id,
                "tried_cases": sorted(tried | set(new_keys)),
            }
    models = _model_names(incumbent_payload.get("models") or {})
    optimizer = (incumbent_payload.get("optimizer") or {}).get("choice", "auto")
    pending = plan.pending_inputs or {}
    if permitted.get("models"):
        for role in ("task_model", "reflection_model"):
            if pending.get(role):
                models[role] = pending[role]
    if permitted.get("optimizers") and pending.get("optimizer"):
        optimizer = pending["optimizer"]
    tried = list(baseline.get("tried_models") or [])
    found: dict[str, dict[str, Any]] = {}
    blocks = incumbent_payload.get("models") or {}
    for role, flag in NEW_MODEL_FLAGS.items():
        block = blocks.get(role)
        if not (permitted.get(flag) and block and models.get(role)):
            continue
        better = pick_model(job_store, plan.username, {**block, "name": models[role]})
        if better is not None and f"{role}:{better['name']}" not in tried:
            found[role] = better
            tried.append(f"{role}:{better['name']}")
    snapshot: dict[str, Any] = {"data": data_snapshot, "models": models, "optimizer": optimizer, "tried_models": tried}
    if found:
        snapshot["new_models"] = found
    return snapshot, cases


def _request_copy(stored: dict[str, Any]) -> dict[str, Any]:
    """Drop the fields of a stored request that belong to that run's funding alone.

    Args:
        stored: A stored unified request, with credentials scrubbed.

    Returns:
        The fields a new run may reuse.
    """
    return {
        key: value
        for key, value in stored.items()
        if not key.startswith("_budget")
        and not key.startswith("execution_budget_")
        and key not in {"preflight_id", "preflight_fingerprint", "estimated_cents_low", "estimated_cents_high"}
    }


def _split_keys(request: UnifiedRunRequest, cases: list[Any], pinned: PinnedSplit | None) -> PinnedSplit:
    """Split cases the way the run engine would, and name each case's role.

    Args:
        request: The incumbent's request, which fixes the fractions, shuffle and seed.
        cases: The cases to split.
        pinned: Roles earlier runs already gave some cases.

    Returns:
        The keys of the test cases and of the search cases.
    """
    data = request.data
    splits = split_cases(cases, data.mode, data.split, shuffle=data.shuffle, seed=split_seed(request), pinned=pinned)
    return PinnedSplit(
        test=[case_key(case) for case in splits.test], fit=[case_key(case) for case in splits.train + splits.val]
    )


def plan_runs(
    plan: ContinuousPlanModel,
    incumbent_payload: dict[str, Any],
    snapshot: dict[str, Any],
    cases: list[dict[str, Any]],
    changes: list[str],
) -> list[CycleRun]:
    """Decide which runs a check starts and which cases each one uses.

    New data alone starts a data run and a better model alone a model run.
    When both wait, the plan's matrix picks among data only, model only and
    both. Every run holds out the same test cases: the incumbent's, plus some
    of the new cases. A model-only run searches only on the incumbent's
    search cases. When every run changes the task model on a changed test
    set, no run's own baseline is the incumbent, so a reference run scores the
    incumbent on the new test cases without optimizing.

    Args:
        plan: The plan.
        incumbent_payload: The incumbent run's stored request.
        snapshot: This check's resolved inputs.
        cases: This check's cases.
        changes: The inputs that changed since the last reviewed check.

    Returns:
        The runs, in matrix order, the reference run last.
    """
    stored = list((incumbent_payload.get("data") or {}).get("cases") or [])
    request = UnifiedRunRequest.model_validate(_request_copy(scrub_execution_credentials(incumbent_payload)))
    earlier = _split_keys(request, stored, request.data.pinned_split)
    new_models = snapshot.get("new_models") or {}
    data_changed = "data" in changes
    if data_changed and new_models:
        matrix = (plan.permitted or {}).get("matrix") or [RUN_BOTH]
        kinds = [kind for kind in MATRIX_KINDS if kind in matrix]
    elif new_models:
        kinds = [RUN_MODEL]
    else:
        kinds = [RUN_DATA]
    if data_changed:
        full = _split_keys(request, cases, earlier)
        searched_before = set(earlier.fit)
        model_pinned = PinnedSplit(test=full.test, fit=[key for key in full.fit if key in searched_before])
        allowed = set(model_pinned.test) | searched_before
        model_cases = [case for case in cases if case_key(case) in allowed]
    else:
        full, model_pinned, model_cases = earlier, earlier, stored
    incumbent_task = _model_names(incumbent_payload.get("models") or {})["task_model"]
    base_task_changed = snapshot["models"].get("task_model") != incumbent_task
    runs = []
    for kind in kinds:
        tried = new_models if kind in (RUN_MODEL, RUN_BOTH) else {}
        runs.append(
            CycleRun(
                kind=kind,
                cases=model_cases if kind == RUN_MODEL else cases,
                pinned=model_pinned if kind == RUN_MODEL else full,
                task_model_changed=base_task_changed or "task_model" in tried,
                new_models=tried,
            )
        )
    if data_changed and all(run.task_model_changed for run in runs):
        runs.append(
            CycleRun(
                kind=RUN_REFERENCE,
                cases=cases,
                pinned=full,
                task_model_changed=False,
                own_models=True,
                score_only=True,
            )
        )
    return runs


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
    budget_ids = [budget_id for cycle in cycles for budget_id in cycle_budget_ids(cycle)]
    budgets = {
        budget.id: budget
        for budget in session.scalars(select(ExecutionBudgetModel).where(ExecutionBudgetModel.id.in_(budget_ids)))
    }
    total = 0
    for cycle in cycles:
        found = [budgets[budget_id] for budget_id in cycle_budget_ids(cycle) if budget_id in budgets]
        if cycle.status == CYCLE_OPTIMIZING:
            total += plan.cycle_budget_cents * max(1, len(cycle_runs(cycle)))
        elif found:
            # ``spent_cents`` is sampled once when the run ends; reconciliation can bill more later.
            total += sum(budget.billed_cents + budget_wallet_hold(budget) for budget in found)
        elif cycle.spent_cents:
            total += cycle.spent_cents
    return total


def cycle_runs(cycle: ContinuousCycleModel) -> list[dict[str, Any]]:
    """List the runs a check started, including a check from before checks started several.

    Args:
        cycle: The cycle.

    Returns:
        One entry per run, each with its ``optimization_id`` and ``execution_budget_id``.
    """
    runs = [run for run in (cycle.snapshot or {}).get("runs") or [] if run.get("optimization_id")]
    if not runs and cycle.optimization_id:
        return [{"kind": RUN_DATA, "optimization_id": cycle.optimization_id, "budget": cycle.execution_budget_id}]
    return runs


def cycle_budget_ids(cycle: ContinuousCycleModel) -> list[str]:
    """List the protected budgets a check's runs draw on.

    Args:
        cycle: The cycle.

    Returns:
        Budget ids, without repeats.
    """
    ids = [run.get("budget") for run in cycle_runs(cycle)] + [cycle.execution_budget_id]
    return list(dict.fromkeys(budget_id for budget_id in ids if budget_id))


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
    run: CycleRun,
    snapshot: dict[str, Any],
    sequence: int,
) -> UnifiedRunRequest:
    """Derive a fresh run request from the incumbent and one of this check's runs.

    The objective, metric, workspace, constraints and split fractions stay
    those of the incumbent; only the permitted inputs change. The run starts
    from the incumbent's best version, so its final run scores incumbent and
    candidate on the same cases, and its split is pinned, so it holds out the
    same test cases as every other run of the check.

    Args:
        plan: The plan.
        incumbent: The incumbent run record.
        run: The run to derive.
        snapshot: This check's resolved inputs.
        sequence: Cycle number shown in the run name.

    Returns:
        A new, unfunded unified request.
    """
    copy = _request_copy(scrub_execution_credentials(incumbent["payload"]))
    copy["data"] = {
        **copy["data"],
        "cases": run.cases,
        "staged_dataset_id": None,
        "pinned_split": run.pinned.model_dump(),
    }
    best = (incumbent.get("result") or {}).get("best_candidate")
    if best is not None:
        copy["task"] = {**copy["task"], "artifact": {**copy["task"]["artifact"], "starting_version": best}}
    models = dict(copy["models"])
    if not run.own_models:
        for role in ("task_model", "reflection_model"):
            name = snapshot["models"].get(role)
            if name and (models.get(role) or {}).get("name") != name:
                models[role] = {**(models.get(role) or {}), "name": name}
        if not run.score_only:
            copy["optimizer"] = {**copy.get("optimizer", {}), "choice": snapshot["optimizer"]}
    for role, better in run.new_models.items():
        block = {**models[role], "name": better["name"]}
        if block.get("token_source") == "byok":
            block["byok_provider"] = better.get("byok_provider")
        models[role] = block
    copy["models"] = models
    if run.score_only:
        copy["optimizer"] = {**copy.get("optimizer", {}), "score_only": True}
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
    pick_model: ModelPicker = better_model,
) -> None:
    """Run one claimed check to its outcome: skip, pause, fail or start its runs.

    Safe to repeat. Each run is submitted under an idempotency key derived from
    the cycle and the run's kind, so a retried check replays the same runs and
    the same budgets instead of creating new ones.

    Args:
        job_store: Job store.
        service: Optimization service handed to the in-process worker.
        cycle_id: The claimed cycle.
        now: Clock override for tests.
        fetch_rows: Reads a source's rows.
        pick_model: Finds a better model for one role.
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
        if _link_accepted(job_store, session, plan.username, cycle):
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
            snapshot, cases = resolve_snapshot(
                plan, incumbent["payload"], job_store=job_store, fetch_rows=fetch_rows, pick_model=pick_model
            )
        except SourceError as error:
            _fail_cycle(session, plan, cycle, error.code, **error.params)
            return
        # A retry after ``budget.pending`` already holds this check's budgets.
        retrying = bool((cycle.snapshot or {}).get("runs"))
        cycle.snapshot = snapshot
        changes = changed_dimensions(plan.baseline_snapshot or {}, snapshot)
        cycle.changes = changes
        if not changes:
            if plan.status == PLAN_PAUSED and plan.pause_reason in SYSTEM_PAUSES:
                plan.status, plan.pause_reason = PLAN_ACTIVE, None
            _finish_cycle(session, cycle, CYCLE_SKIPPED, "continuous.skip_unchanged")
            return
        try:
            runs = plan_runs(plan, incumbent["payload"], snapshot, cases, changes)
            started = session.scalars(
                select(ContinuousCycleModel.id).where(
                    ContinuousCycleModel.plan_id == plan.id, ContinuousCycleModel.optimization_id.is_not(None)
                )
            ).all()
            payloads = [_cycle_payload(plan, incumbent, run, snapshot, len(started) + 1) for run in runs]
        except ValidationError as error:
            # A staged model or optimizer the run contract rejects fails this cycle instead of wedging the plan.
            reason = "; ".join(str(item.get("msg")) for item in error.errors())
            _fail_cycle(session, plan, cycle, "continuous.run_rejected", reason=reason)
            return
        need = plan.cycle_budget_cents * len(runs)
        gate = None
        # Gating a retry again would demand a second set of check budgets of headroom
        # and pause a check that is covered.
        if not retrying:
            if (
                plan.monthly_limit_cents is not None
                and plan.monthly_limit_cents - month_committed(session, plan, cycle.month) < need
            ):
                gate = PAUSE_ALLOWANCE
            elif StripeBillingService(engine=engine).spendable_cents(plan.username) < need:
                gate = PAUSE_FUNDS
        if gate is None and plan.status == PLAN_PAUSED and plan.pause_reason in SYSTEM_PAUSES:
            plan.status, plan.pause_reason = PLAN_ACTIVE, None
        if gate is not None:
            _pause(plan, gate)
            _finish_cycle(session, cycle, CYCLE_PAUSED, f"continuous.paused_{gate}", runs=len(runs))
            return
        plan_username = plan.username
        cycle.snapshot = {
            **snapshot,
            "config": json_fingerprint(payloads[0].task.model_dump(mode="json", exclude={"artifact"})),
            "seed": payloads[0].seed,
            "compared_against": plan.incumbent_optimization_id,
            "runs": [
                {
                    "kind": run.kind,
                    "new_models": run.new_models,
                    "task_model_changed": run.task_model_changed,
                    "test_cases": len(run.pinned.test),
                }
                for run in runs
            ],
        }
    _submit_runs(job_store, service, cycle_id, plan_username, payloads)


def _run_key(cycle_id: str, kind: str) -> str:
    """Return the idempotency key of one of a check's runs.

    Args:
        cycle_id: The check.
        kind: The run's kind.

    Returns:
        The key.
    """
    return f"continuous:{cycle_id}:{kind}"


def _link_accepted(job_store: Any, session: Session, username: str, cycle: ContinuousCycleModel) -> bool:
    """Link the runs a check already submitted before its worker died.

    The runs are already paid for and ran on the inputs recorded then, so they
    are linked as they are instead of re-reading inputs or re-checking funds.
    A run the dead worker never submitted is dropped from the check.

    Args:
        job_store: Job store.
        session: Open session that owns ``cycle``.
        username: Plan owner.
        cycle: The cycle.

    Returns:
        ``True`` when the check had submitted runs and is now optimizing.
    """
    planned = (cycle.snapshot or {}).get("runs") or []
    linked = []
    for run in planned:
        accepted = job_store.find_job_by_idempotency_key(username, _run_key(cycle.id, run["kind"]))
        if accepted is not None:
            job = job_store.get_job(accepted, include_payload=False)
            linked.append({**run, "optimization_id": accepted, "budget": job.get("execution_budget_id")})
    # A check claimed before checks started several runs used one key for its one run.
    legacy = None if planned else job_store.find_job_by_idempotency_key(username, f"continuous:{cycle.id}")
    if legacy is not None:
        job = job_store.get_job(legacy, include_payload=False)
        linked.append({"kind": RUN_DATA, "optimization_id": legacy, "budget": job.get("execution_budget_id")})
    if not linked:
        return False
    _record_started(session, cycle, linked)
    return True


def _record_started(session: Session, cycle: ContinuousCycleModel, started: list[dict[str, Any]]) -> None:
    """Mark a check as optimizing on the runs it started.

    Args:
        session: Open session that owns ``cycle``.
        cycle: The cycle.
        started: The started runs, each with its ``optimization_id`` and ``budget``.
    """
    cycle.snapshot = {**(cycle.snapshot or {}), "runs": started}
    cycle.optimization_id = started[0]["optimization_id"]
    cycle.execution_budget_id = started[0]["budget"]
    _finish_cycle(
        session,
        cycle,
        CYCLE_OPTIMIZING,
        "continuous.run_started",
        changes=",".join(cycle.changes or []),
        runs=",".join(run["kind"] for run in started),
    )


def _submit_runs(job_store: Any, service: Any, cycle_id: str, username: str, payloads: list[UnifiedRunRequest]) -> None:
    """Submit a check's runs, then record which started.

    When no run started, a run refused for a pending budget leaves the check
    claimed, so a later sweep replays the same keys and budgets. Once one run
    started, a refusal only drops the refused run, because the started ones
    are already paid for.

    Args:
        job_store: Job store.
        service: Optimization service handed to the in-process worker.
        cycle_id: The check.
        username: Plan owner.
        payloads: One request per planned run, in the snapshot's order.
    """
    engine = job_store.engine
    user = AuthenticatedUser(username, "user", ())
    with Session(engine) as session:
        cycle = session.get(ContinuousCycleModel, cycle_id)
        if cycle is None:
            # The owner deleted the plan before this check submitted anything.
            return
        planned = list((cycle.snapshot or {}).get("runs") or [])
    started: list[dict[str, Any]] = []
    refused: DomainError | None = None
    budget_keys: list[str] = []
    for run, payload in zip(planned, payloads, strict=True):
        key = _run_key(cycle_id, run["kind"])
        budget_key = resolve_submission_replay_keys(
            payload, username=username, workflow=UNIFIED_WORKFLOW, supplied_key=key
        ).budget
        if budget_key:
            budget_keys.append(budget_key)
        try:
            response = submit_unified_payload(
                payload, service=service, job_store=job_store, current_user=user, idempotency_key=key
            )
        except DomainError as error:
            logger.warning("Continuous cycle %s could not start its %s run: %s", cycle_id, run["kind"], error.code)
            refused = refused or error
            if error.code == "budget.pending":
                break
            continue
        job = job_store.get_job(response.optimization_id, include_payload=False)
        started.append({**run, "optimization_id": response.optimization_id, "budget": job.get("execution_budget_id")})
    with Session(engine) as session, session.begin():
        cycle = session.get(ContinuousCycleModel, cycle_id)
        if cycle is None:
            # The owner deleted the plan while this check was submitting; its runs stay ordinary runs.
            return
        plan = session.get(ContinuousPlanModel, cycle.plan_id, with_for_update=True)
        if started:
            _record_started(session, cycle, started)
            logger.info("Continuous cycle %s started %d runs", cycle_id, len(started))
            return
        budgets = [BudgetService(engine=engine).find_by_creation_key(username, key) for key in budget_keys]
        budget_ids = [budget.id for budget in budgets if budget is not None]
        cycle.execution_budget_id = budget_ids[0] if budget_ids else None
        cycle.spent_cents = sum(_billed_cents(job_store, budget_id, username) or 0 for budget_id in budget_ids) or None
        if refused is None:
            return
        if refused.code == "budget.pending":
            # Setup usage is still being confirmed. The cycle keeps its lease, so a
            # later sweep replays these same keys and budgets instead of a new check
            # paying for setup again. This wait is not a crash, so it does
            # not count toward MAX_CHECK_ATTEMPTS.
            cycle.detail_params = {**(cycle.detail_params or {}), "attempts": 0}
            return
        if refused.code in {"billing.insufficient_funds", "budget.insufficient"}:
            _pause(plan, PAUSE_FUNDS)
            _finish_cycle(session, cycle, CYCLE_PAUSED, "continuous.paused_funds")
        else:
            _fail_cycle(session, plan, cycle, "continuous.run_rejected", reason=str(refused.detail))


def _incumbent_score(job_store: Any, optimization_id: str | None, split: dict[str, Any]) -> float | None:
    """Read the incumbent run's own best score, when it was scored on the same test split.

    Args:
        job_store: Job store.
        optimization_id: The incumbent run the cycle started from.
        split: The cycle run's ``split_counts``.

    Returns:
        The incumbent's score, or ``None`` when it is gone or used other test cases.
    """
    if optimization_id is None:
        return None
    try:
        result = job_store.get_job(optimization_id, include_payload=False).get("result") or {}
    except KeyError:
        return None
    prior = result.get("split_counts") or {}
    if any(prior.get(key) != split.get(key) for key in ("test", "held_out", "report_split")):
        return None
    return result.get("best_score")


def _incumbent_on_test(
    job_store: Any, cycle: ContinuousCycleModel, finished: list[tuple[dict[str, Any], dict[str, Any]]]
) -> float | None:
    """Score the incumbent on this check's test cases with its own models.

    A run that keeps the incumbent's task model scores the incumbent as its
    own baseline. When every run moves the task model, the reference run
    scored it, or, on unchanged test cases, the incumbent run's own score
    still holds.

    Args:
        job_store: Job store.
        cycle: The cycle.
        finished: Each successful run with its result.

    Returns:
        The incumbent's score, or ``None`` when no run could score it.
    """
    for run, result in finished:
        if run["kind"] == RUN_REFERENCE:
            return result.get("best_score")
    for run, result in finished:
        if not run.get("task_model_changed"):
            return result.get("baseline_score")
    if not finished:
        return None
    split = finished[0][1].get("split_counts") or {}
    return _incumbent_score(job_store, (cycle.snapshot or {}).get("compared_against"), split)


def review_cycle(job_store: Any, cycle_id: str) -> None:
    """Judge a check's finished runs against the incumbent they started from.

    The check waits until every run ended. The incumbent is scored on the
    check's test cases with its own models, which every run held out. A run's
    candidate counts only when the run succeeded, its final run scored on
    held-out test cases, and, for a run that kept the incumbent's task model,
    no regression guard fired. The best such candidate is kept for review when
    it scored at least ``WIN_MARGIN`` above the incumbent; anything else leaves
    the incumbent in place. Only a check with a successful run marks its inputs
    as seen, so a check whose runs all failed (a provider outage) is retried on
    the next check instead of waiting for the data to change again.

    Args:
        job_store: Job store.
        cycle_id: A cycle in ``optimizing``.
    """
    with Session(job_store.engine) as session, session.begin():
        cycle = session.get(ContinuousCycleModel, cycle_id)
        if cycle is None or cycle.status != CYCLE_OPTIMIZING or cycle.optimization_id is None:
            return
        plan = session.get(ContinuousPlanModel, cycle.plan_id, with_for_update=True)
        runs = cycle_runs(cycle)
        jobs = []
        for run in runs:
            try:
                jobs.append(job_store.get_job(run["optimization_id"], include_payload=False))
            except KeyError:
                jobs.append({"status": "missing"})
        if any(job["status"] not in _TERMINAL_JOB and job["status"] != "missing" for job in jobs):
            return
        billed = [_billed_cents(job_store, budget_id, plan.username) for budget_id in cycle_budget_ids(cycle)]
        cycle.spent_cents = sum(cents or 0 for cents in billed) if any(c is not None for c in billed) else None
        plan.updated_at = datetime.now(UTC)
        recorded = []
        finished = []
        for run, job in zip(runs, jobs, strict=True):
            result = job.get("result") or {}
            recorded.append(
                {
                    **run,
                    "status": job["status"],
                    "baseline_score": result.get("baseline_score"),
                    "best_score": result.get("best_score"),
                }
            )
            if job["status"] == OptimizationStatus.success.value:
                finished.append((run, result))
        cycle.snapshot = {**(cycle.snapshot or {}), "runs": recorded}
        candidates = [(run, result) for run, result in finished if run["kind"] != RUN_REFERENCE]
        if not candidates:
            # The baseline stays put so the next check retries these inputs instead of skipping them as unchanged.
            reason = next((job["status"] for job in jobs if job["status"] != OptimizationStatus.success.value), "")
            _fail_cycle(session, plan, cycle, "continuous.run_failed", reason=reason)
            return
        plan.baseline_snapshot = {
            key: value for key, value in (cycle.snapshot or {}).items() if key not in {"runs", "winner"}
        } or plan.baseline_snapshot
        incumbent = _incumbent_on_test(job_store, cycle, finished)
        eligible = [
            (run, result)
            for run, result in candidates
            if result.get("best_score") is not None
            and (result.get("split_counts") or {}).get("test")
            and (result.get("split_counts") or {}).get("held_out")
            # With the same task model the guard means the search found nothing; on a new model it
            # only means optimizing did not help, and the model alone may still win.
            and not (result.get("regression_guard_applied") and not run.get("task_model_changed"))
        ]
        best_run, best_result = max(eligible or candidates, key=lambda item: item[1].get("best_score") or 0.0)
        best = best_result.get("best_score")
        cycle.optimization_id = best_run["optimization_id"]
        cycle.execution_budget_id = best_run.get("budget")
        cycle.incumbent_score, cycle.candidate_score = incumbent, best
        cycle.snapshot = {
            **cycle.snapshot,
            "winner": {"kind": best_run["kind"], "new_models": best_run.get("new_models") or {}},
        }
        split = best_result.get("split_counts") or {}
        if incumbent is None or best is None:
            _finish_cycle(session, cycle, CYCLE_REGRESSED, "continuous.review_unscored")
        elif not (split.get("test") and split.get("held_out")):
            # Without separate test cases the split that picked the candidate would also judge it.
            _finish_cycle(session, cycle, CYCLE_REGRESSED, "continuous.review_not_held_out")
        elif not eligible or best <= incumbent:
            _finish_cycle(session, cycle, CYCLE_REGRESSED, "continuous.review_regressed")
        elif best < incumbent + WIN_MARGIN:
            _finish_cycle(session, cycle, CYCLE_REGRESSED, "continuous.review_within_margin")
        else:
            _finish_cycle(session, cycle, CYCLE_AWAITING_REVIEW, "continuous.review_ready", run=best_run["kind"])


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


def settle_waiting(plan: ContinuousPlanModel, job_status: str | None, now: datetime, *, held_out: bool = True) -> None:
    """Start a waiting plan once its first run succeeded, or end it once that run ended otherwise.

    An ended plan is kept, with the run's outcome as its reason, so the owner
    sees why the schedule never started; they delete it from the run page.

    Args:
        plan: A plan, in any state.
        job_status: Status of the plan's source run, or ``None`` when the run is gone.
        now: Current time.
        held_out: Whether the source run kept test cases apart; without them the plan ends.
    """
    if plan.status != PLAN_WAITING:
        return
    if job_status == OptimizationStatus.success.value and not held_out:
        plan.status = PLAN_ENDED
        plan.pause_reason = END_NO_TEST_SPLIT
        plan.next_check_at = None
        plan.updated_at = now
    elif job_status == OptimizationStatus.success.value:
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
                job = job_store.get_job(plan.source_optimization_id, include_payload=True)
            except KeyError:
                settle_waiting(plan, None, now)
                continue
            settle_waiting(plan, job["status"], now, held_out=has_held_out(job))
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
