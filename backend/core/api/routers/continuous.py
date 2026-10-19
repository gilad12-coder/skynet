"""Continuous optimization plans on a successful unified run.

* ``GET  /optimizations/{id}/continuous`` — the plan this run belongs to, its
  checks, this month's usage and the next scheduled check.
* ``POST /optimizations/{id}/continuous`` — enable a plan from a successful run.
* ``POST /continuous/{plan_id}/pause`` and ``/resume`` — the customer's pause.
* ``PUT  /continuous/{plan_id}/schedule`` — change when the plan checks.
* ``POST /continuous/{plan_id}/check-now`` — run the next check now instead of
  waiting for its time. It is still a check: unchanged inputs are skipped.
* ``POST /continuous/schedule-preview`` — the next check times a rule gives.
* ``POST /continuous/{plan_id}/inputs`` — stage a permitted model or optimizer
  change for the next check.
* ``POST /continuous/{plan_id}/cycles/{cycle_id}/approve`` and ``/reject`` —
  review a validated candidate. Approval makes it the incumbent later checks
  start from; it deploys nothing.

There is deliberately no endpoint that reruns unchanged inputs.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...billing.budgets import BudgetError, BudgetService
from ...models.common import OptimizationStatus
from ...storage.models import ContinuousCycleModel, ContinuousPlanModel
from ...worker import continuous as engine_mod
from ...worker.continuous_schedule import ScheduleRule, next_runs
from ..auth import AuthenticatedUser, get_authenticated_user
from ..converters import job_owner
from ..errors import DomainError
from ._helpers import get_job_no_payload

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]

_HISTORY_LIMIT = 50
_UPCOMING_CHECKS = 3
_BUSY_CYCLES = (engine_mod.CYCLE_CHECKING, engine_mod.CYCLE_OPTIMIZING)


# Which inputs a plan may refresh on its own; anything else needs a setup change.
class ContinuousPermitted(BaseModel):
    data: bool = False
    models: bool = False
    optimizers: bool = False


# A connected source the existing connectors can read. A Hugging Face ref is
# ``repo_id/config/split``; other providers use their own import ref.
class ContinuousSource(BaseModel):
    provider: str = Field(min_length=1, max_length=64)
    ref: str = Field(min_length=1, max_length=1024)


# Enables continuous optimization on a successful run.
class ContinuousEnableRequest(BaseModel):
    schedule: ScheduleRule
    permitted: ContinuousPermitted
    source: ContinuousSource | None = None
    # Both are optional: a run reuses the source run's budget, and no monthly
    # limit means only the wallet balance gates a run (we never buy credit).
    monthly_limit_cents: int | None = Field(default=None, gt=0, le=10_000_000)
    cycle_budget_cents: int | None = Field(default=None, gt=0, le=10_000_000)

    @model_validator(mode="after")
    def _check(self) -> ContinuousEnableRequest:
        """Reject a plan that cannot refresh anything or cannot afford one cycle.

        Returns:
            The validated request.

        Raises:
            ValueError: On an inconsistent plan.
        """
        if not (self.permitted.data or self.permitted.models or self.permitted.optimizers):
            raise ValueError("permit at least one input to refresh")
        if self.permitted.data and self.source is None:
            raise ValueError("a data refresh needs a connected source")
        if (
            self.cycle_budget_cents is not None
            and self.monthly_limit_cents is not None
            and self.cycle_budget_cents > self.monthly_limit_cents
        ):
            raise ValueError("the cycle budget exceeds the monthly limit")
        return self


# A staged model or optimizer change; only permitted dimensions are accepted.
class ContinuousInputsRequest(BaseModel):
    task_model: str | None = Field(default=None, min_length=1, max_length=200)
    reflection_model: str | None = Field(default=None, min_length=1, max_length=200)
    optimizer: str | None = Field(default=None, min_length=1, max_length=64)


# One scheduled check and the run it started, if any.
class ContinuousCycleItem(BaseModel):
    id: str
    slot: str
    month: str
    status: str
    changes: list[str]
    detail_code: str | None = None
    detail_params: dict[str, Any] = Field(default_factory=dict)
    snapshot: dict[str, Any] | None = None
    optimization_id: str | None = None
    incumbent_score: float | None = None
    candidate_score: float | None = None
    spent_cents: int | None = None
    created_at: datetime


# This month's allowance as the plan sees it.
class ContinuousUsage(BaseModel):
    month: str
    limit_cents: int | None = None
    committed_cents: int
    resets_at: datetime


# A plan with its history.
class ContinuousPlanItem(BaseModel):
    id: str
    source_optimization_id: str
    incumbent_optimization_id: str
    status: str
    pause_reason: str | None = None
    schedule: ScheduleRule
    next_check_at: datetime | None = None
    upcoming_checks: list[datetime] = Field(default_factory=list)
    permitted: ContinuousPermitted
    source: ContinuousSource | None = None
    pending_inputs: dict[str, Any] = Field(default_factory=dict)
    cycle_budget_cents: int
    usage: ContinuousUsage
    cycles: list[ContinuousCycleItem]


# The next check times a schedule rule gives, earliest first.
class SchedulePreviewResponse(BaseModel):
    next_checks: list[datetime]


# ``plan`` is null when the run has none; ``eligible`` says whether one can start here.
class ContinuousStateResponse(BaseModel):
    plan: ContinuousPlanItem | None = None
    eligible: bool


def _is_unified(job: dict[str, Any]) -> bool:
    """Say whether a job row is a unified run with a stored request.

    Args:
        job: A job row with its payload.

    Returns:
        ``True`` for a unified run.
    """
    payload = job.get("payload") or {}
    return isinstance(payload.get("task"), dict) and isinstance(payload.get("data"), dict) and "workspace" in payload


def _source_budget_cents(job_store, job: dict[str, Any], username: str) -> int | None:
    """Read the spending budget the source run started with.

    Args:
        job_store: Store whose engine holds the budgets.
        job: The source run, with its payload.
        username: Budget owner.

    Returns:
        The run's budget in cents, or ``None`` when it had none.
    """
    stated = (job.get("payload") or {}).get("max_cost_cents")
    if stated:
        return int(stated)
    budget_id = job.get("execution_budget_id") or (job.get("payload") or {}).get("execution_budget_id")
    if not budget_id:
        return None
    try:
        return BudgetService(engine=job_store.engine).get(budget_id, username).total_cents
    except BudgetError:
        return None


def _owned_job(job_store, optimization_id: str, user: AuthenticatedUser, *, payload: bool) -> dict[str, Any]:
    """Load a run the caller owns.

    Args:
        job_store: Job store.
        optimization_id: The run.
        user: The caller.
        payload: Whether to read the stored request.

    Returns:
        The job row.

    Raises:
        DomainError: 404 when the run is missing or not the caller's.
    """
    try:
        job = (
            job_store.get_job(optimization_id, include_payload=True)
            if payload
            else get_job_no_payload(job_store, optimization_id)
        )
    except KeyError as error:
        raise DomainError("optimization.not_found", status=404, optimization_id=optimization_id) from error
    if job_owner(job) != user.username.lower():
        raise DomainError("optimization.not_found", status=404, optimization_id=optimization_id)
    return job


def _owned_plan(session: Session, plan_id: str, user: AuthenticatedUser) -> ContinuousPlanModel:
    """Load a plan the caller owns.

    Args:
        session: Open session.
        plan_id: The plan.
        user: The caller.

    Returns:
        The plan row.

    Raises:
        DomainError: 404 when the plan is missing or not the caller's.
    """
    plan = session.get(ContinuousPlanModel, plan_id)
    if plan is None or plan.username.lower() != user.username.lower():
        raise DomainError("continuous.not_found", status=404)
    return plan


def _plan_item(session: Session, plan: ContinuousPlanModel) -> ContinuousPlanItem:
    """Serialize a plan with its recent checks and this month's usage.

    Args:
        session: Open session.
        plan: The plan.

    Returns:
        The response item.
    """
    now = datetime.now(UTC)
    month = engine_mod.month_key(now)
    cycles = session.scalars(
        select(ContinuousCycleModel)
        .where(ContinuousCycleModel.plan_id == plan.id)
        .order_by(ContinuousCycleModel.created_at.desc())
        .limit(_HISTORY_LIMIT)
    ).all()
    return ContinuousPlanItem(
        id=plan.id,
        source_optimization_id=plan.source_optimization_id,
        incumbent_optimization_id=plan.incumbent_optimization_id,
        status=plan.status,
        pause_reason=plan.pause_reason,
        schedule=engine_mod.plan_rule(plan),
        next_check_at=engine_mod.aware(plan.next_check_at),
        upcoming_checks=_upcoming(plan),
        permitted=ContinuousPermitted.model_validate(plan.permitted or {}),
        source=ContinuousSource.model_validate(plan.source) if plan.source else None,
        pending_inputs=plan.pending_inputs or {},
        cycle_budget_cents=plan.cycle_budget_cents,
        usage=ContinuousUsage(
            month=month,
            limit_cents=plan.monthly_limit_cents,
            committed_cents=engine_mod.month_committed(session, plan, month),
            resets_at=engine_mod.next_month_start(now),
        ),
        cycles=[
            ContinuousCycleItem(
                id=cycle.id,
                slot=cycle.slot,
                month=cycle.month,
                status=cycle.status,
                changes=list(cycle.changes or []),
                detail_code=cycle.detail_code,
                detail_params=cycle.detail_params or {},
                snapshot=cycle.snapshot,
                optimization_id=cycle.optimization_id,
                incumbent_score=cycle.incumbent_score,
                candidate_score=cycle.candidate_score,
                spent_cents=cycle.spent_cents,
                created_at=engine_mod.aware(cycle.created_at),
            )
            for cycle in cycles
        ],
    )


def _upcoming(plan: ContinuousPlanModel) -> list[datetime]:
    """List the plan's next few check times; none while it is paused.

    Args:
        plan: The plan.

    Returns:
        Up to three check times, earliest first.
    """
    first = engine_mod.aware(plan.next_check_at)
    if first is None:
        return []
    later = next_runs(
        engine_mod.plan_rule(plan), first, anchor=engine_mod.plan_anchor(plan), count=_UPCOMING_CHECKS - 1
    )
    return [first, *later]


def _set_schedule(plan: ContinuousPlanModel, rule: ScheduleRule, now: datetime) -> None:
    """Store a rule and, for an active plan, its first check after now.

    The rule's intervals count from now, so "every 2 weeks" starts this week.

    Args:
        plan: The plan.
        rule: The new rule.
        now: Current time.
    """
    plan.schedule = rule.frequency
    plan.schedule_rule = {**rule.model_dump(), "anchor": now.isoformat()}
    if plan.status == engine_mod.PLAN_ACTIVE:
        plan.next_check_at = engine_mod.next_check_after(plan, now)
    plan.updated_at = now


def _plan_for_run(session: Session, optimization_id: str) -> ContinuousPlanModel | None:
    """Find the plan a run started, is the incumbent of, or was started by.

    Args:
        session: Open session.
        optimization_id: Any run.

    Returns:
        The plan, or ``None``.
    """
    plan = session.scalar(
        select(ContinuousPlanModel).where(
            or_(
                ContinuousPlanModel.source_optimization_id == optimization_id,
                ContinuousPlanModel.incumbent_optimization_id == optimization_id,
            )
        )
    )
    if plan is not None:
        return plan
    plan_id = session.scalar(
        select(ContinuousCycleModel.plan_id).where(ContinuousCycleModel.optimization_id == optimization_id)
    )
    return session.get(ContinuousPlanModel, plan_id) if plan_id else None


def create_continuous_router(
    *, job_store, service, fetch_rows: engine_mod.RowFetcher = engine_mod.fetch_source_rows
) -> APIRouter:
    """Build the continuous-optimization router.

    Args:
        job_store: Job store whose engine holds the plans.
        service: Optimization service a "check now" hands its run to.
        fetch_rows: Reads a source's rows for a "check now".

    Returns:
        The router.
    """
    router = APIRouter()

    def _session() -> Session:
        """Open a session on the store's engine.

        Returns:
            A new session.

        Raises:
            DomainError: 503 for a store without a database.
        """
        engine = getattr(job_store, "engine", None)
        if engine is None:
            raise DomainError("continuous.unavailable", status=503)
        return Session(engine)

    @router.get(
        "/optimizations/{optimization_id}/continuous",
        response_model=ContinuousStateResponse,
        summary="Read a run's continuous optimization plan",
    )
    def get_continuous(optimization_id: str, current_user: AuthenticatedUserDep) -> ContinuousStateResponse:
        """Return the plan a run belongs to, or whether one can start from it.

        Args:
            optimization_id: Any run the caller owns.
            current_user: The caller.

        Returns:
            The plan state.
        """
        job = _owned_job(job_store, optimization_id, current_user, payload=True)
        with _session() as session:
            plan = _plan_for_run(session, optimization_id)
            eligible = plan is None and job["status"] == OptimizationStatus.success.value and _is_unified(job)
            return ContinuousStateResponse(plan=_plan_item(session, plan) if plan else None, eligible=eligible)

    @router.post(
        "/optimizations/{optimization_id}/continuous",
        response_model=ContinuousPlanItem,
        status_code=201,
        summary="Enable continuous optimization from a successful run",
    )
    def enable_continuous(
        optimization_id: str, body: ContinuousEnableRequest, current_user: AuthenticatedUserDep
    ) -> ContinuousPlanItem:
        """Create a plan that reuses this run's setup on a schedule.

        Args:
            optimization_id: A successful unified run the caller owns.
            body: Schedule, permitted inputs, source and limits.
            current_user: The caller.

        Returns:
            The new plan.

        Raises:
            DomainError: 409 when the run did not succeed, is not a unified
                run, or already has a plan.
        """
        job = _owned_job(job_store, optimization_id, current_user, payload=True)
        if job["status"] != OptimizationStatus.success.value or not _is_unified(job):
            raise DomainError("continuous.not_eligible", status=409)
        cycle_budget = body.cycle_budget_cents or _source_budget_cents(job_store, job, current_user.username)
        if cycle_budget is None:
            raise DomainError("continuous.not_eligible", status=409)
        now = datetime.now(UTC)
        plan = ContinuousPlanModel(
            username=current_user.username,
            source_optimization_id=optimization_id,
            incumbent_optimization_id=optimization_id,
            status=engine_mod.PLAN_ACTIVE,
            permitted=body.permitted.model_dump(),
            source=body.source.model_dump() if body.source else None,
            pending_inputs={},
            baseline_snapshot=engine_mod.snapshot_of_payload(job["payload"]),
            monthly_limit_cents=body.monthly_limit_cents,
            cycle_budget_cents=cycle_budget,
            created_at=now,
        )
        _set_schedule(plan, body.schedule, now)
        with _session() as session:
            if _plan_for_run(session, optimization_id) is not None:
                raise DomainError("continuous.already_enabled", status=409)
            session.add(plan)
            try:
                session.commit()
            except IntegrityError as error:
                raise DomainError("continuous.already_enabled", status=409) from error
            return _plan_item(session, plan)

    @router.post(
        "/continuous/{plan_id}/pause",
        response_model=ContinuousPlanItem,
        summary="Pause a continuous plan",
    )
    def pause_continuous(plan_id: str, current_user: AuthenticatedUserDep) -> ContinuousPlanItem:
        """Stop scheduled checks until the customer resumes them.

        Args:
            plan_id: The plan.
            current_user: The caller.

        Returns:
            The paused plan.
        """
        with _session() as session:
            plan = _owned_plan(session, plan_id, current_user)
            plan.status = engine_mod.PLAN_PAUSED
            plan.pause_reason = engine_mod.PAUSE_USER
            plan.next_check_at = None
            plan.updated_at = datetime.now(UTC)
            session.commit()
            return _plan_item(session, plan)

    @router.post(
        "/continuous/{plan_id}/resume",
        response_model=ContinuousPlanItem,
        summary="Resume a paused continuous plan",
    )
    def resume_continuous(plan_id: str, current_user: AuthenticatedUserDep) -> ContinuousPlanItem:
        """Resume checks; the next one is the schedule's first time after now.

        An allowance or funds limit still applies at that check.

        Args:
            plan_id: The plan.
            current_user: The caller.

        Returns:
            The resumed plan.
        """
        with _session() as session:
            plan = _owned_plan(session, plan_id, current_user)
            now = datetime.now(UTC)
            plan.status = engine_mod.PLAN_ACTIVE
            plan.pause_reason = None
            plan.next_check_at = engine_mod.next_check_after(plan, now)
            plan.updated_at = now
            session.commit()
            return _plan_item(session, plan)

    @router.put(
        "/continuous/{plan_id}/schedule",
        response_model=ContinuousPlanItem,
        summary="Change when a continuous plan checks",
    )
    def update_schedule(plan_id: str, body: ScheduleRule, current_user: AuthenticatedUserDep) -> ContinuousPlanItem:
        """Replace the plan's repeat rule; a paused plan stays paused.

        Args:
            plan_id: The plan.
            body: The new rule.
            current_user: The caller.

        Returns:
            The updated plan.
        """
        with _session() as session:
            plan = _owned_plan(session, plan_id, current_user)
            _set_schedule(plan, body, datetime.now(UTC))
            session.commit()
            return _plan_item(session, plan)

    @router.post(
        "/continuous/{plan_id}/check-now",
        response_model=ContinuousPlanItem,
        summary="Run the next continuous check now",
    )
    def check_now(
        plan_id: str, background_tasks: BackgroundTasks, current_user: AuthenticatedUserDep
    ) -> ContinuousPlanItem:
        """Make the next check due now and run it after responding; the schedule continues after it.

        The check follows the usual rules, so unchanged inputs are recorded as
        skipped and start no run.

        Args:
            plan_id: The plan.
            background_tasks: Runs the check once the response is sent.
            current_user: The caller.

        Returns:
            The plan with its check due now.

        Raises:
            DomainError: 409 while the plan is paused or a check or run is still in progress.
        """
        with _session() as session:
            plan = _owned_plan(session, plan_id, current_user)
            if plan.status != engine_mod.PLAN_ACTIVE:
                raise DomainError("continuous.check_paused", status=409)
            busy = session.scalar(
                select(ContinuousCycleModel.id).where(
                    ContinuousCycleModel.plan_id == plan.id, ContinuousCycleModel.status.in_(_BUSY_CYCLES)
                )
            )
            if busy is not None:
                raise DomainError("continuous.check_busy", status=409)
            now = datetime.now(UTC)
            plan.next_check_at = now
            plan.updated_at = now
            session.commit()
            item = _plan_item(session, plan)
        background_tasks.add_task(engine_mod.check_plan_now, job_store, service, plan_id, fetch_rows=fetch_rows)
        return item

    @router.post(
        "/continuous/schedule-preview",
        response_model=SchedulePreviewResponse,
        summary="Preview the next check times of a schedule rule",
    )
    def preview_schedule(body: ScheduleRule, current_user: AuthenticatedUserDep) -> SchedulePreviewResponse:
        """Return the next three times a rule would check, counting from now.

        Args:
            body: The rule.
            current_user: The caller; only signed-in users may preview.

        Returns:
            The next check times.
        """
        now = datetime.now(UTC)
        return SchedulePreviewResponse(next_checks=next_runs(body, now, anchor=now, count=_UPCOMING_CHECKS))

    @router.post(
        "/continuous/{plan_id}/inputs",
        response_model=ContinuousPlanItem,
        summary="Stage a permitted model or optimizer change",
    )
    def stage_inputs(
        plan_id: str, body: ContinuousInputsRequest, current_user: AuthenticatedUserDep
    ) -> ContinuousPlanItem:
        """Record a model or optimizer change the next check may use.

        Args:
            plan_id: The plan.
            body: The staged names.
            current_user: The caller.

        Returns:
            The updated plan.

        Raises:
            DomainError: 409 for a change the plan does not permit.
        """
        with _session() as session:
            plan = _owned_plan(session, plan_id, current_user)
            permitted = plan.permitted or {}
            changes = body.model_dump(exclude_none=True)
            if (("task_model" in changes or "reflection_model" in changes) and not permitted.get("models")) or (
                "optimizer" in changes and not permitted.get("optimizers")
            ):
                raise DomainError("continuous.not_permitted", status=409)
            plan.pending_inputs = {**(plan.pending_inputs or {}), **changes}
            plan.updated_at = datetime.now(UTC)
            session.commit()
            return _plan_item(session, plan)

    def _review(plan_id: str, cycle_id: str, user: AuthenticatedUser, *, approve: bool) -> ContinuousPlanItem:
        """Approve or reject a candidate that waits for review.

        Args:
            plan_id: The plan.
            cycle_id: The cycle with the candidate.
            user: The caller.
            approve: ``True`` to make the candidate the incumbent.

        Returns:
            The updated plan.

        Raises:
            DomainError: 409 when the cycle has no candidate awaiting review.
        """
        with _session() as session:
            plan = _owned_plan(session, plan_id, user)
            cycle = session.get(ContinuousCycleModel, cycle_id)
            if cycle is None or cycle.plan_id != plan.id or cycle.status != engine_mod.CYCLE_AWAITING_REVIEW:
                raise DomainError("continuous.not_reviewable", status=409)
            now = datetime.now(UTC)
            if approve:
                plan.incumbent_optimization_id = cycle.optimization_id
                cycle.status = engine_mod.CYCLE_APPROVED
                cycle.detail_code = "continuous.review_approved"
            else:
                cycle.status = engine_mod.CYCLE_REJECTED
                cycle.detail_code = "continuous.review_rejected"
            cycle.updated_at = now
            plan.updated_at = now
            session.commit()
            return _plan_item(session, plan)

    @router.post(
        "/continuous/{plan_id}/cycles/{cycle_id}/approve",
        response_model=ContinuousPlanItem,
        summary="Approve a validated candidate as the new incumbent",
    )
    def approve_cycle(plan_id: str, cycle_id: str, current_user: AuthenticatedUserDep) -> ContinuousPlanItem:
        """Make a validated candidate the version later checks start from.

        Args:
            plan_id: The plan.
            cycle_id: The cycle awaiting review.
            current_user: The caller.

        Returns:
            The updated plan.
        """
        return _review(plan_id, cycle_id, current_user, approve=True)

    @router.post(
        "/continuous/{plan_id}/cycles/{cycle_id}/reject",
        response_model=ContinuousPlanItem,
        summary="Reject a candidate and keep the incumbent",
    )
    def reject_cycle(plan_id: str, cycle_id: str, current_user: AuthenticatedUserDep) -> ContinuousPlanItem:
        """Keep the incumbent and close the candidate's review.

        Args:
            plan_id: The plan.
            cycle_id: The cycle awaiting review.
            current_user: The caller.

        Returns:
            The updated plan.
        """
        return _review(plan_id, cycle_id, current_user, approve=False)

    return router
