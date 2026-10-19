"""Verify continuous optimization against real jobs, preflight and protected budgets."""

from __future__ import annotations

import calendar
import logging
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from core.api import preflight_execution
from core.api.auth import AuthenticatedUser, get_authenticated_user
from core.api.errors import DomainError
from core.api.model_catalog import CatalogModel, ModelCatalogResponse
from core.api.routers import submissions
from core.api.routers._helpers import automated_run_ids
from core.api.routers.continuous import _HISTORY_LIMIT, create_continuous_router
from core.api.tests.test_protected_submissions import _Gateway, _Harness, _SQLiteJobStore
from core.billing.budget_amounts import CENT_SCALE, budget_wallet_hold
from core.billing.budgets import BudgetService
from core.models import UnifiedRunRequest
from core.service_gateway.optimization.unified.split import case_key, split_cases, split_seed
from core.storage.models import (
    BillingCustomerModel,
    ContinuousCycleModel,
    ContinuousPlanModel,
    ExecutionBudgetModel,
    JobModel,
)
from core.worker import continuous

BALANCE = 1000
WEEKLY = {"frequency": "weekly", "weekdays": [0], "time": "09:00", "timezone": "UTC"}
DAILY = {"frequency": "daily", "time": "09:00", "timezone": "UTC"}
CYCLE_BUDGET = 20


@dataclass
class _Env:
    """Hold the API client, the store and the scripted source rows."""

    harness: _Harness
    rows: list[dict[str, Any]] = field(default_factory=list)
    source_error: continuous.SourceError | None = None
    fetches: int = 0

    @property
    def store(self) -> _SQLiteJobStore:
        """Return the shared store."""
        return self.harness.store

    @property
    def client(self) -> TestClient:
        """Return the API client."""
        assert self.harness.client is not None
        return self.harness.client

    def fetch(self, job_store: Any, username: str, source: dict[str, Any]) -> list[dict[str, Any]]:
        """Return the scripted source rows, or raise the scripted source failure.

        Args:
            job_store: Unused store.
            username: Unused owner.
            source: Unused source.

        Returns:
            The current rows.

        Raises:
            continuous.SourceError: When a failure is scripted.
        """
        self.fetches += 1
        if self.source_error is not None:
            raise self.source_error
        return [dict(row) for row in self.rows]

    def sweep(self, now: datetime) -> list[str]:
        """Run one sweep with the scripted source.

        Args:
            now: Sweep time.

        Returns:
            Checked cycle ids.
        """
        return continuous.run_due_checks(self.store, object(), now=now, fetch_rows=self.fetch)

    def count(self, model: Any) -> int:
        """Count rows of one table.

        Args:
            model: ORM model.

        Returns:
            Row count.
        """
        with Session(self.store.engine) as session:
            return session.scalar(select(func.count()).select_from(model))

    def plan(self) -> ContinuousPlanModel:
        """Read the only plan.

        Returns:
            The plan row, detached.
        """
        with Session(self.store.engine, expire_on_commit=False) as session:
            return session.scalars(select(ContinuousPlanModel)).one()

    def cycles(self) -> list[ContinuousCycleModel]:
        """Read every cycle in claim order.

        Returns:
            Detached cycle rows.
        """
        with Session(self.store.engine, expire_on_commit=False) as session:
            return list(session.scalars(select(ContinuousCycleModel).order_by(ContinuousCycleModel.slot)).all())

    def edit_plan(self, **values: Any) -> None:
        """Overwrite plan columns.

        Args:
            **values: Column values.
        """
        with Session(self.store.engine) as session, session.begin():
            plan = session.scalars(select(ContinuousPlanModel)).one()
            for key, value in values.items():
                setattr(plan, key, value)

    def edit_cycle(self, cycle_id: str, **values: Any) -> None:
        """Overwrite cycle columns.

        Args:
            cycle_id: The cycle.
            **values: Column values.
        """
        with Session(self.store.engine) as session, session.begin():
            cycle = session.get(ContinuousCycleModel, cycle_id)
            for key, value in values.items():
                setattr(cycle, key, value)

    def set_balance(self, cents: int) -> None:
        """Set the wallet balance.

        Args:
            cents: New balance.
        """
        with Session(self.store.engine) as session, session.begin():
            session.get(BillingCustomerModel, "alice").balance_cents = cents

    def balance(self) -> int:
        """Read the wallet balance.

        Returns:
            Balance cents.
        """
        with Session(self.store.engine) as session:
            return session.get(BillingCustomerModel, "alice").balance_cents


def _cases(answers: list[str]) -> list[dict[str, Any]]:
    """Build source rows with the incumbent's case schema.

    Args:
        answers: One expected answer per row.

    Returns:
        Rows with ``question`` and ``answer`` columns.
    """
    return [{"question": f"Q{index}?", "answer": answer} for index, answer in enumerate(answers)]


def _incumbent_payload() -> dict[str, Any]:
    """Build a unified run request whose cases come from a dataset table.

    Returns:
        A request body without budget evidence.
    """
    rows = _cases(["A"] * 10)
    return {
        "name": "Support answers",
        "task": {
            "objective": "Answer the question in one word.",
            "artifact": {"kind": "prompt", "starting_version": "Answer briefly: "},
        },
        "data": {
            "mode": "pairs",
            "cases": submissions.rows_to_cases(rows, input_fields=["question"], expected_field="answer"),
            "input_fields": ["question"],
            "expected_field": "answer",
        },
        "optimizer": {"choice": "gepa"},
        "models": {"reflection_model": {"name": "fixture/text"}, "task_model": {"name": "fixture/task"}},
        "workspace": {
            "run_code": "def run(artifact, input):\n    return artifact + input['question']\n",
            "metric_code": (
                "def score(input, output, expected=None):\n    return float(output == expected), {'feedback': ''}\n"
            ),
        },
        "max_cost_cents": CYCLE_BUDGET,
    }


def _result(baseline: float, best: float, *, test: int = 2, held_out: bool = True, guard: bool = False) -> dict:
    """Build a finished unified run result.

    Args:
        baseline: Final-run score of the starting version.
        best: Final-run score of the winner.
        test: Held-out test cases in the split.
        held_out: Whether the report used unseen test cases.
        guard: Whether the regression guard kept the starting version.

    Returns:
        A stored result mapping.
    """
    return {
        "optimizer_name": "gepa",
        "strategy_mode": "single",
        "engine_used": "gepa",
        "baseline_score": baseline,
        "best_score": best,
        "best_candidate": "Answer in one word: ",
        "regression_guard_applied": guard,
        "runtime_seconds": 1.0,
        "split_counts": {
            "train": 6,
            "val": 2,
            "test": test,
            "held_out": held_out,
            "selection_split": "val",
            "report_split": "test" if held_out else "val",
        },
    }


def _finish(env: _Env, optimization_id: str, status: str = "success", result: dict | None = None) -> None:
    """Mark a run finished with a result.

    Args:
        env: Test environment.
        optimization_id: The run.
        status: Terminal status.
        result: Stored result.
    """
    env.store.update_job(optimization_id, status=status, result=result)


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[_Env]:
    """Serve submissions and continuous routes on a real SQLite store.

    Args:
        tmp_path: Disposable database directory.
        monkeypatch: Isolates provider adapters and deployment settings.

    Yields:
        The environment.
    """
    store = _SQLiteJobStore(tmp_path / "continuous.db")
    fixture = _Harness(store)
    with Session(store.engine) as session:
        session.add(
            BillingCustomerModel(
                username="alice", stripe_customer_id="fixture-alice", balance_cents=BALANCE, grant_remaining=0
            )
        )
        session.commit()

    def verify(gateway: _Gateway, payload: dict[str, Any], *, scope: str, identity: str) -> dict:
        """Run the measured fixture preflight instead of a sandbox."""
        return fixture.verify(gateway.runtime, payload, identity)

    monkeypatch.setattr(preflight_execution, "ModelGateway", _Gateway)
    monkeypatch.setattr(preflight_execution, "bind_protected_sandbox", lambda *args, **kwargs: None)
    monkeypatch.setattr(preflight_execution, "_verify_anything", verify)
    monkeypatch.setattr(preflight_execution, "_verify_unified", verify)
    monkeypatch.setattr(submissions.settings, "usage_markup", 1.0)
    monkeypatch.setattr(submissions.settings, "worker_enabled", False)
    monkeypatch.setattr(submissions.settings, "submissions_paused", False)
    monkeypatch.setattr(submissions.settings, "max_concurrent_jobs_per_user", 0)
    monkeypatch.setattr(submissions.settings, "global_daily_spend_ceiling_cents", 0)
    monkeypatch.setattr(submissions.settings, "rate_limit_submissions_per_minute", 0)
    monkeypatch.setattr(submissions.settings, "openrouter_api_key", SecretStr("fixture-only"))
    monkeypatch.setattr(submissions.settings, "byok_vault_key", SecretStr(Fernet.generate_key().decode()))
    app = FastAPI()

    @app.exception_handler(DomainError)
    async def _domain_error(request: Request, exc: DomainError) -> JSONResponse:
        """Render domain errors with their stable code."""
        return JSONResponse(status_code=exc.status_code, content={"code": exc.code, "params": exc.params})

    app.include_router(submissions.create_submissions_router(service=object(), job_store=store))
    environment = _Env(fixture, rows=_cases(["A"] * 10))
    app.include_router(create_continuous_router(job_store=store, service=object(), fetch_rows=environment.fetch))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(fixture.username, fixture.role, ())
    with TestClient(app) as client:
        fixture.client = client
        yield environment
    store.engine.dispose()


def _incumbent(env: _Env) -> str:
    """Submit and finish the run a plan is enabled from.

    Args:
        env: Test environment.

    Returns:
        The incumbent's optimization id.
    """
    response = env.client.post("/optimize", json=_incumbent_payload())
    assert response.status_code == 201, response.text
    optimization_id = response.json()["optimization_id"]
    _finish(env, optimization_id, result=_result(0.5, 0.7))
    return optimization_id


def _enable(env: _Env, optimization_id: str, **overrides: Any) -> dict[str, Any]:
    """Enable a weekly plan that may refresh data, models and optimizers.

    Args:
        env: Test environment.
        optimization_id: The incumbent.
        **overrides: Request field overrides.

    Returns:
        The plan response.
    """
    body = {
        "schedule": WEEKLY,
        "permitted": {"data": True, "models": True, "optimizers": True},
        "source": {"provider": "huggingface", "ref": "acme/support/default/train"},
        "monthly_limit_cents": 100,
        "cycle_budget_cents": CYCLE_BUDGET,
        **overrides,
    }
    response = env.client.post(f"/optimizations/{optimization_id}/continuous", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _due(env: _Env) -> datetime:
    """Return a moment just after the plan's next check.

    Args:
        env: Test environment.

    Returns:
        A sweep time at which the plan is due.
    """
    return continuous.aware(env.plan().next_check_at) + timedelta(seconds=1)


def test_enable_inspect_pause_resume_and_next_check(env: _Env) -> None:
    """A successful run enables one plan with a visible next check; pause and resume toggle it."""
    source_id = _incumbent(env)
    state = env.client.get(f"/optimizations/{source_id}/continuous").json()
    assert state == {
        "plan": None,
        "eligible": True,
        "held_out": True,
        # The setup names the models a better-model check compares against.
        "task_model": "fixture/task",
        "reflection_model": "fixture/text",
    }

    before = datetime.now(UTC)
    plan = _enable(env, source_id)
    next_check = datetime.fromisoformat(plan["next_check_at"])
    assert before < next_check <= datetime.now(UTC) + timedelta(days=7)
    assert (next_check.weekday(), next_check.hour, next_check.minute) == (0, 9, 0)
    assert plan["schedule"] == {**WEEKLY, "every": 1, "month_day": 1, "skip": [], "extra": []}
    assert len(plan["upcoming_checks"]) == 3
    assert plan["upcoming_checks"][0] == plan["next_check_at"]
    assert plan["status"] == "active"
    assert plan["usage"] == {
        "month": continuous.month_key(datetime.now(UTC)),
        "limit_cents": 100,
        "committed_cents": 0,
        "resets_at": plan["usage"]["resets_at"],
    }

    again = env.client.post(
        f"/optimizations/{source_id}/continuous",
        json={"schedule": DAILY, "permitted": {"models": True}, "monthly_limit_cents": 50, "cycle_budget_cents": 10},
    )
    assert again.status_code == 409
    assert again.json()["code"] == "continuous.already_enabled"

    paused = env.client.post(f"/continuous/{plan['id']}/pause").json()
    assert (paused["status"], paused["pause_reason"], paused["next_check_at"]) == ("paused", "user", None)
    assert env.sweep(datetime.now(UTC) + timedelta(days=30)) == []

    resumed = env.client.post(f"/continuous/{plan['id']}/resume").json()
    assert (resumed["status"], resumed["pause_reason"]) == ("active", None)
    resumed_at = datetime.fromisoformat(resumed["next_check_at"])
    assert datetime.now(UTC) < resumed_at <= datetime.now(UTC) + timedelta(days=7)
    assert resumed_at.weekday() == 0
    assert env.client.get(f"/optimizations/{source_id}/continuous").json()["plan"]["id"] == plan["id"]


def test_only_a_successful_unified_run_can_enable(env: _Env) -> None:
    """A failed run is not eligible and a plan needs a source to refresh data."""
    response = env.client.post("/optimize", json=_incumbent_payload())
    optimization_id = response.json()["optimization_id"]
    _finish(env, optimization_id, status="failed")
    assert env.client.get(f"/optimizations/{optimization_id}/continuous").json()["eligible"] is False
    refused = env.client.post(
        f"/optimizations/{optimization_id}/continuous",
        json={"schedule": WEEKLY, "permitted": {"models": True}, "monthly_limit_cents": 50, "cycle_budget_cents": 10},
    )
    assert refused.status_code == 409
    _finish(env, optimization_id, result=_result(0.5, 0.7))
    no_source = env.client.post(
        f"/optimizations/{optimization_id}/continuous",
        json={"schedule": WEEKLY, "permitted": {"data": True}, "monthly_limit_cents": 50, "cycle_budget_cents": 10},
    )
    assert no_source.status_code == 422


def test_permitted_data_change_starts_one_linked_fresh_run(env: _Env) -> None:
    """Changed source data starts one fresh, funded run from the incumbent with a recorded snapshot."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    jobs_before = env.count(JobModel)
    env.rows = _cases(["A"] * 9 + ["B", "C"])

    checked = env.sweep(_due(env))

    assert len(checked) == 1
    [cycle] = env.cycles()
    assert cycle.status == "optimizing"
    assert cycle.changes == ["data"]
    assert cycle.detail_code == "continuous.run_started"
    assert cycle.snapshot["data"]["cases"] == 11
    assert cycle.snapshot["data"]["source"] == {"provider": "huggingface", "ref": "acme/support/default/train"}
    assert cycle.snapshot["compared_against"] == source_id
    assert env.count(JobModel) == jobs_before + 1
    job = env.store.get_job(cycle.optimization_id, include_payload=True)
    payload = job["payload"]
    assert len(payload["data"]["cases"]) == 11
    assert {"input": {"question": "Q10?"}, "expected": {"answer": "C"}} in payload["data"]["cases"]
    assert payload["data"]["cases"] == continuous.canonical_cases(payload["data"]["cases"])
    assert payload["task"]["artifact"]["starting_version"] == "Answer in one word: "
    assert payload["task"]["objective"] == _incumbent_payload()["task"]["objective"]
    assert payload["workspace"]["metric_code"] == _incumbent_payload()["workspace"]["metric_code"]
    assert payload["preflight_id"]
    budget = BudgetService(engine=env.store.engine).get(job["execution_budget_id"], "alice")
    assert budget.total_cents == CYCLE_BUDGET
    assert cycle.execution_budget_id == job["execution_budget_id"]


def test_permitted_model_change_alone_justifies_a_cycle(env: _Env) -> None:
    """A staged model change starts a run with the new model and records why."""
    source_id = _incumbent(env)
    plan = _enable(env, source_id, permitted={"data": False, "models": True, "optimizers": False}, source=None)
    refused = env.client.post(f"/continuous/{plan['id']}/inputs", json={"optimizer": "mipro"})
    assert refused.status_code == 409
    assert refused.json()["code"] == "continuous.not_permitted"
    staged = env.client.post(f"/continuous/{plan['id']}/inputs", json={"task_model": "fixture/task-v2"})
    assert staged.status_code == 200, staged.text

    env.sweep(_due(env))

    [cycle] = env.cycles()
    assert cycle.changes == ["models"]
    assert env.fetches == 0
    payload = env.store.get_job(cycle.optimization_id, include_payload=True)["payload"]
    assert payload["models"]["task_model"]["name"] == "fixture/task-v2"


def test_unchanged_check_is_skipped_and_cannot_be_rerun(env: _Env) -> None:
    """Unchanged inputs record a visible skip, start nothing and offer no rerun."""
    source_id = _incumbent(env)
    plan = _enable(env, source_id)
    jobs_before = env.count(JobModel)
    budgets_before = env.count(ExecutionBudgetModel)

    env.sweep(_due(env))

    [cycle] = env.cycles()
    assert (cycle.status, cycle.detail_code, cycle.optimization_id) == ("skipped", "continuous.skip_unchanged", None)
    assert env.count(JobModel) == jobs_before
    assert env.count(ExecutionBudgetModel) == budgets_before
    state = env.client.get(f"/optimizations/{source_id}/continuous").json()["plan"]
    assert state["cycles"][0]["status"] == "skipped"
    assert env.client.post(f"/continuous/{plan['id']}/rerun").status_code in {404, 405}
    assert env.client.post(f"/continuous/{plan['id']}/cycles/{cycle.id}/rerun").status_code in {404, 405}


@pytest.mark.parametrize(
    ("rows", "error", "code"),
    [
        ([{"question": "Q?"}], None, "continuous.source_invalid_cases"),
        ([], None, "continuous.source_invalid_cases"),
        (None, continuous.SourceError("continuous.source_unavailable", provider="huggingface", reason="403"), None),
    ],
)
def test_invalid_or_unavailable_source_fails_without_a_run(
    env: _Env, rows: list | None, error: continuous.SourceError | None, code: str | None
) -> None:
    """A source that cannot supply agreed cases records an actionable failure and keeps the last setup."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    baseline = env.plan().baseline_snapshot
    jobs_before = env.count(JobModel)
    env.rows = rows or []
    env.source_error = error

    env.sweep(_due(env))

    [cycle] = env.cycles()
    assert cycle.status == "failed"
    assert cycle.detail_code == (code or error.code)
    assert cycle.detail_params.get("reason")
    assert env.count(JobModel) == jobs_before
    assert env.plan().baseline_snapshot == baseline


def test_missing_column_names_it(env: _Env) -> None:
    """The failure names the agreed column the source lost."""
    rows = [{"question": "Q?", "reply": "A"}]
    with pytest.raises(continuous.SourceError) as caught:
        continuous.prepare_source_cases(rows, _incumbent_payload()["data"])
    assert caught.value.params["reason"] == "missing columns: answer"


def test_overlapping_sweeps_and_retries_create_one_cycle_and_one_spend(env: _Env) -> None:
    """Parallel workers and a retried check produce one cycle, one run and one budget."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    jobs_before = env.count(JobModel)
    budgets_before = env.count(ExecutionBudgetModel)
    now = _due(env)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: env.sweep(now), range(4)))
    env.sweep(now)

    [cycle] = env.cycles()
    assert env.count(JobModel) == jobs_before + 1
    assert env.count(ExecutionBudgetModel) == budgets_before + 1

    # A worker that died after submitting leaves the check in ``checking``;
    # the takeover replays the same run and budget instead of a second one.
    # Its own reservation must not make the wallet look short and pause the plan,
    # and the source changing meanwhile must not relabel what that run evaluated.
    env.set_balance(0)
    env.rows = _cases(["C"] * 10)
    fetches = env.fetches
    env.edit_cycle(cycle.id, status="checking", optimization_id=None, lease_until=now - timedelta(seconds=1))
    env.sweep(now)
    [retried] = env.cycles()
    assert (retried.status, retried.optimization_id) == ("optimizing", cycle.optimization_id)
    assert retried.snapshot == cycle.snapshot
    assert env.fetches == fetches
    assert env.plan().status == "active"
    assert env.count(JobModel) == jobs_before + 1
    assert env.count(ExecutionBudgetModel) == budgets_before + 1


def test_check_waits_while_a_cycle_runs_or_awaits_review(env: _Env) -> None:
    """A new check does not start a second run while one is active or unreviewed."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    env.sweep(_due(env))
    env.rows = _cases(["C"] * 10)
    env.sweep(_due(env))
    first, second = env.cycles()
    assert (second.status, second.detail_code) == ("skipped", "continuous.skip_busy")
    _finish(env, first.optimization_id, result=_result(0.5, 0.8))
    env.sweep(_due(env))
    first, second, third = env.cycles()
    assert first.status == "awaiting_review"
    assert (third.status, third.detail_code) == ("skipped", "continuous.skip_review_pending")


def test_allowance_exhaustion_pauses_and_rollover_keeps_history(env: _Env) -> None:
    """A spent allowance pauses paid work; the next month resumes it and keeps every record."""
    source_id = _incumbent(env)
    _enable(env, source_id, monthly_limit_cents=CYCLE_BUDGET, cycle_budget_cents=CYCLE_BUDGET)
    env.rows = _cases(["B"] * 10)
    october = datetime(2026, 10, 20, tzinfo=UTC)
    env.edit_plan(next_check_at=october)
    env.sweep(october + timedelta(seconds=1))
    [first] = env.cycles()
    assert first.month == "2026-10"
    budget_before = BudgetService(engine=env.store.engine).get(first.execution_budget_id, "alice")
    _finish(env, first.optimization_id, status="failed")
    env.sweep(october + timedelta(seconds=2))
    env.edit_cycle(first.id, spent_cents=CYCLE_BUDGET)

    env.rows = _cases(["C"] * 10)
    env.edit_plan(next_check_at=october + timedelta(days=5))
    jobs_before = env.count(JobModel)
    env.sweep(october + timedelta(days=5, seconds=1))
    plan = env.plan()
    assert (plan.status, plan.pause_reason) == ("paused", "allowance")
    assert env.cycles()[-1].detail_code == "continuous.paused_allowance"
    assert env.count(JobModel) == jobs_before

    balance_before = env.balance()
    november = datetime(2026, 11, 3, tzinfo=UTC)
    env.edit_plan(next_check_at=november)
    env.sweep(november + timedelta(seconds=1))
    plan = env.plan()
    assert (plan.status, plan.pause_reason) == ("active", None)
    cycles = env.cycles()
    assert [c.month for c in cycles] == ["2026-10", "2026-10", "2026-11"]
    assert cycles[0].spent_cents == CYCLE_BUDGET
    assert cycles[-1].status == "optimizing"
    assert env.count(JobModel) == jobs_before + 1
    budget_after = BudgetService(engine=env.store.engine).get(first.execution_budget_id, "alice")
    assert budget_after.total_cents == budget_before.total_cents
    assert budget_after.billed_cents == budget_before.billed_cents
    assert env.balance() <= balance_before


def test_a_finished_cycle_counts_usage_still_awaiting_reconciliation(env: _Env) -> None:
    """A finished cycle's held coverage stays in the allowance until it settles, not just what it billed."""
    source_id = _incumbent(env)
    _enable(env, source_id, monthly_limit_cents=CYCLE_BUDGET + 1, cycle_budget_cents=CYCLE_BUDGET)
    env.rows = _cases(["B"] * 10)
    october = datetime(2026, 10, 20, tzinfo=UTC)
    env.edit_plan(next_check_at=october)
    env.sweep(october + timedelta(seconds=1))
    [first] = env.cycles()
    _finish(env, first.optimization_id, status="failed")
    continuous.review_cycle(env.store, first.id)
    # Usage the run reported but billing has not settled yet keeps its wallet hold after the run ends.
    with Session(env.store.engine) as session, session.begin():
        budget = session.get(ExecutionBudgetModel, first.execution_budget_id)
        budget.wallet_reserved_units += CYCLE_BUDGET * CENT_SCALE
        held = budget.billed_cents + budget_wallet_hold(budget)
    [first] = env.cycles()
    assert held > (first.spent_cents or 0)

    with Session(env.store.engine) as session:
        assert continuous.month_committed(session, env.plan(), first.month) == held

    env.edit_plan(next_check_at=october + timedelta(days=5))
    env.sweep(october + timedelta(days=5, seconds=1))
    assert env.cycles()[-1].detail_code == "continuous.paused_allowance"


def test_a_pending_review_stays_visible_past_the_history_window(env: _Env) -> None:
    """A candidate waiting for approval is returned even after many newer skipped checks."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    env.sweep(_due(env))
    [cycle] = env.cycles()
    _finish(env, cycle.optimization_id, result=_result(0.5, 0.9))
    continuous.review_cycle(env.store, cycle.id)
    plan_id = env.plan().id
    later = datetime.now(UTC) + timedelta(minutes=1)
    with Session(env.store.engine) as session, session.begin():
        session.add_all(
            ContinuousCycleModel(
                plan_id=plan_id,
                slot=f"later-{index}",
                month=cycle.month,
                status="skipped",
                detail_code="continuous.skip_review_pending",
                created_at=later + timedelta(minutes=index),
            )
            for index in range(_HISTORY_LIMIT)
        )

    cycles = env.client.get(f"/optimizations/{source_id}/continuous").json()["plan"]["cycles"]

    assert len(cycles) == _HISTORY_LIMIT + 1
    assert (cycles[-1]["id"], cycles[-1]["status"]) == (cycle.id, "awaiting_review")


def test_rollover_never_resumes_a_user_pause(env: _Env) -> None:
    """A new month leaves a customer's pause in place."""
    source_id = _incumbent(env)
    plan = _enable(env, source_id)
    env.client.post(f"/continuous/{plan['id']}/pause")
    env.rows = _cases(["B"] * 10)
    november = datetime(2026, 11, 3, tzinfo=UTC)
    env.edit_plan(next_check_at=november)
    jobs_before = env.count(JobModel)
    env.sweep(november + timedelta(seconds=1))
    current = env.plan()
    assert (current.status, current.pause_reason) == ("paused", "user")
    assert env.cycles()[-1].detail_code == "continuous.skip_paused"
    assert env.count(JobModel) == jobs_before


def test_wallet_exhaustion_pauses_without_buying_credit(env: _Env) -> None:
    """An empty wallet pauses paid work and the balance is never topped up."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    env.set_balance(5)
    env.rows = _cases(["B"] * 10)
    jobs_before = env.count(JobModel)
    env.sweep(_due(env))
    plan = env.plan()
    assert (plan.status, plan.pause_reason) == ("paused", "funds")
    assert env.cycles()[-1].detail_code == "continuous.paused_funds"
    assert env.count(JobModel) == jobs_before
    assert env.balance() == 5


@pytest.mark.parametrize(
    ("result", "status", "code"),
    [
        (_result(0.6, 0.5), "regressed", "continuous.review_regressed"),
        (_result(0.6, 0.6), "regressed", "continuous.review_regressed"),
        (_result(0.6, 0.9, guard=True), "regressed", "continuous.review_regressed"),
        (_result(0.6, 0.9, test=3, held_out=False), "regressed", "continuous.review_not_held_out"),
        (_result(0.6, 0.9, test=0, held_out=False), "regressed", "continuous.review_not_held_out"),
        (_result(0.6, 0.605), "regressed", "continuous.review_within_margin"),
        (_result(0.6, 0.61), "awaiting_review", "continuous.review_ready"),
        (_result(0.6, 0.9), "awaiting_review", "continuous.review_ready"),
    ],
)
def test_review_compares_on_the_same_snapshot(env: _Env, result: dict, status: str, code: str) -> None:
    """Only a candidate that beats the incumbent on the same held-out cases waits for review."""
    source_id = _incumbent(env)
    plan = _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    env.sweep(_due(env))
    [cycle] = env.cycles()
    _finish(env, cycle.optimization_id, result=result)

    continuous.review_cycle(env.store, cycle.id)

    [cycle] = env.cycles()
    assert (cycle.status, cycle.detail_code) == (status, code)
    assert (cycle.incumbent_score, cycle.candidate_score) == (result["baseline_score"], result["best_score"])
    assert env.plan().incumbent_optimization_id == source_id
    assert env.plan().baseline_snapshot["data"] == cycle.snapshot["data"]
    approve = env.client.post(f"/continuous/{plan['id']}/cycles/{cycle.id}/approve")
    if status == "regressed":
        assert approve.status_code == 409
        assert env.plan().incumbent_optimization_id == source_id
    else:
        assert approve.status_code == 200, approve.text
        assert env.plan().incumbent_optimization_id == cycle.optimization_id


def test_failed_cycle_run_keeps_the_incumbent(env: _Env) -> None:
    """A failed cycle run is recorded and never replaces the incumbent."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    env.sweep(_due(env))
    [cycle] = env.cycles()
    baseline = env.plan().baseline_snapshot
    _finish(env, cycle.optimization_id, status="failed")
    env.sweep(_due(env) - timedelta(days=1))
    [cycle] = env.cycles()
    assert (cycle.status, cycle.detail_code) == ("failed", "continuous.run_failed")
    assert env.plan().incumbent_optimization_id == source_id
    assert env.plan().baseline_snapshot == baseline


def test_a_rejected_staged_optimizer_fails_the_cycle_without_wedging_the_plan(env: _Env) -> None:
    """A staged optimizer the run contract refuses fails that check and leaves later checks free."""
    source_id = _incumbent(env)
    plan = _enable(env, source_id, permitted={"data": False, "models": False, "optimizers": True}, source=None)
    staged = env.client.post(f"/continuous/{plan['id']}/inputs", json={"optimizer": "mipro"})
    assert staged.status_code == 200, staged.text
    jobs_before = env.count(JobModel)

    env.sweep(_due(env))
    env.sweep(_due(env))

    cycles = env.cycles()
    assert [cycle.status for cycle in cycles] == ["failed", "failed"]
    assert all(cycle.detail_code == "continuous.run_rejected" and cycle.detail_params["reason"] for cycle in cycles)
    assert env.count(JobModel) == jobs_before


def test_pending_setup_usage_retries_the_same_check(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """A check whose setup usage awaits confirmation stays claimed and later replays the same budget."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    budgets_before = env.count(ExecutionBudgetModel)
    submit = continuous.submit_unified_payload

    def pending(*args: Any, **kwargs: Any) -> Any:
        """Refuse the submission as if setup usage were still being confirmed.

        Args:
            *args: Unused.
            **kwargs: Unused.

        Raises:
            DomainError: Always, as ``budget.pending``.
        """
        raise DomainError("budget.pending", status=409)

    monkeypatch.setattr(continuous, "submit_unified_payload", pending)
    now = _due(env)
    env.sweep(now)
    [cycle] = env.cycles()
    assert (cycle.status, cycle.optimization_id) == ("checking", None)
    assert cycle.lease_until is not None

    monkeypatch.setattr(continuous, "submit_unified_payload", submit)
    env.sweep(now + continuous.CYCLE_LEASE + timedelta(seconds=1))
    [retried] = env.cycles()
    assert retried.id == cycle.id
    assert retried.status == "optimizing"
    assert env.count(ExecutionBudgetModel) <= budgets_before + 1


def test_a_pending_retry_at_the_allowance_edge_is_not_paused(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """A retried check that already holds its budget does not need a second cycle budget of allowance."""
    source_id = _incumbent(env)
    _enable(env, source_id, monthly_limit_cents=CYCLE_BUDGET, cycle_budget_cents=CYCLE_BUDGET)
    env.rows = _cases(["B"] * 10)
    submit = continuous.submit_unified_payload

    def pending(payload: Any, **kwargs: Any) -> Any:
        """Create the cycle's budget with setup charges, then refuse as setup usage awaits confirmation.

        Args:
            payload: The cycle's run payload.
            **kwargs: Submission arguments, including the replay key.

        Raises:
            DomainError: Always, as ``budget.pending``.
        """
        budget_key = continuous.resolve_submission_replay_keys(
            payload, username="alice", workflow=continuous.UNIFIED_WORKFLOW, supplied_key=kwargs["idempotency_key"]
        ).budget
        budget = BudgetService(engine=env.store.engine).create("alice", CYCLE_BUDGET, idempotency_key=budget_key)
        with Session(env.store.engine) as session, session.begin():
            # The real preflight bills setup usage before it reports ``budget.pending``.
            session.get(ExecutionBudgetModel, budget.id).billed_cents = 2
        raise DomainError("budget.pending", status=409)

    monkeypatch.setattr(continuous, "submit_unified_payload", pending)
    now = _due(env)
    env.sweep(now)
    [cycle] = env.cycles()
    assert cycle.execution_budget_id is not None

    monkeypatch.setattr(continuous, "submit_unified_payload", submit)
    env.sweep(now + continuous.CYCLE_LEASE + timedelta(seconds=1))
    [retried] = env.cycles()
    assert (retried.id, retried.status) == (cycle.id, "optimizing")
    plan = env.plan()
    assert (plan.status, plan.pause_reason) == ("active", None)


def test_a_deleted_incumbent_fails_the_cycle_without_wedging_the_plan(env: _Env) -> None:
    """A check whose incumbent run is gone records why instead of staying in ``checking``."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    env.store.delete_job(source_id)

    env.sweep(_due(env))
    env.sweep(_due(env))

    cycles = env.cycles()
    assert [cycle.status for cycle in cycles] == ["failed", "failed"]
    assert cycles[0].detail_params["reason"] == "the incumbent run was deleted"


def test_candidate_waits_for_explicit_approval(env: _Env) -> None:
    """A validated candidate stays in review until the customer approves or rejects it."""
    source_id = _incumbent(env)
    plan = _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    env.sweep(_due(env))
    [cycle] = env.cycles()
    _finish(env, cycle.optimization_id, result=_result(0.5, 0.9))
    env.sweep(_due(env) - timedelta(days=1))
    assert env.cycles()[0].status == "awaiting_review"
    assert env.plan().incumbent_optimization_id == source_id

    rejected = env.client.post(f"/continuous/{plan['id']}/cycles/{cycle.id}/reject")
    assert rejected.status_code == 200
    assert env.cycles()[0].status == "rejected"
    assert env.plan().incumbent_optimization_id == source_id
    again = env.client.post(f"/continuous/{plan['id']}/cycles/{cycle.id}/approve")
    assert again.status_code == 409


def test_other_users_cannot_read_or_change_a_plan(env: _Env) -> None:
    """A plan and its run stay private to the owner."""
    source_id = _incumbent(env)
    plan = _enable(env, source_id)
    env.harness.username = "bob"
    assert env.client.get(f"/optimizations/{source_id}/continuous").status_code == 404
    assert env.client.post(f"/continuous/{plan['id']}/pause").status_code == 404
    assert env.client.put(f"/continuous/{plan['id']}/schedule", json=DAILY).status_code == 404
    assert env.client.post(f"/continuous/{plan['id']}/check-now").status_code == 404


def test_schedule_change_moves_the_next_check_and_keeps_a_pause(env: _Env) -> None:
    """A new rule sets the next check from now; a paused plan stays paused with no check."""
    plan = _enable(env, _incumbent(env))
    rule = {"frequency": "monthly", "month_day": 31, "time": "18:30", "timezone": "Asia/Jerusalem"}
    changed = env.client.put(f"/continuous/{plan['id']}/schedule", json=rule).json()
    first = datetime.fromisoformat(changed["next_check_at"]).astimezone(ZoneInfo("Asia/Jerusalem"))
    assert (first.hour, first.minute) == (18, 30)
    assert first.day == calendar.monthrange(first.year, first.month)[1]
    assert changed["schedule"]["frequency"] == "monthly"
    assert len(changed["upcoming_checks"]) == 3

    env.client.post(f"/continuous/{plan['id']}/pause")
    paused = env.client.put(f"/continuous/{plan['id']}/schedule", json=DAILY).json()
    assert (paused["status"], paused["next_check_at"], paused["upcoming_checks"]) == ("paused", None, [])
    assert paused["schedule"]["frequency"] == "daily"


@pytest.mark.parametrize(
    "rule",
    [
        {"frequency": "weekly", "weekdays": [], "time": "09:00"},
        {"frequency": "daily", "time": "25:00"},
        {"frequency": "hourly", "every": 13},
        {"frequency": "daily", "timezone": "Mars/Olympus"},
        {"frequency": "weekly", "weekdays": [7]},
    ],
)
def test_an_impossible_schedule_is_refused(env: _Env, rule: dict[str, Any]) -> None:
    """A rule that can't run, or names an unknown zone, is refused on enable, edit and preview."""
    source_id = _incumbent(env)
    assert env.client.post("/continuous/schedule-preview", json=rule).status_code == 422
    body = {"schedule": rule, "permitted": {"models": True}, "monthly_limit_cents": 50, "cycle_budget_cents": 10}
    assert env.client.post(f"/optimizations/{source_id}/continuous", json=body).status_code == 422
    plan = _enable(env, source_id)
    assert env.client.put(f"/continuous/{plan['id']}/schedule", json=rule).status_code == 422


def test_preview_lists_the_next_three_checks(env: _Env) -> None:
    """The preview gives the rule's next three times, at the chosen local time."""
    rule = {"frequency": "weekly", "weekdays": [0, 2, 4], "time": "07:15", "timezone": "America/New_York"}
    times = [
        datetime.fromisoformat(t)
        for t in env.client.post("/continuous/schedule-preview", json=rule).json()["next_checks"]
    ]
    local = [t.astimezone(ZoneInfo("America/New_York")) for t in times]
    assert len(local) == 3
    assert local == sorted(local)
    assert all(t.weekday() in {0, 2, 4} and (t.hour, t.minute) == (7, 15) for t in local)
    assert times[0] > datetime.now(UTC)


def test_check_now_runs_a_check_and_the_schedule_continues(env: _Env) -> None:
    """Check now runs a check at once; unchanged inputs still only record a skip."""
    plan = _enable(env, _incumbent(env))
    scheduled = env.plan().next_check_at
    jobs_before = env.count(JobModel)

    now_plan = env.client.post(f"/continuous/{plan['id']}/check-now").json()
    assert datetime.fromisoformat(now_plan["next_check_at"]) <= datetime.now(UTC)

    # The check ran with the request, not at a later sweep.
    [cycle] = env.cycles()
    assert (cycle.status, cycle.detail_code) == ("skipped", "continuous.skip_unchanged")
    assert env.count(JobModel) == jobs_before
    assert continuous.aware(env.plan().next_check_at) == continuous.aware(scheduled)


def test_check_now_waits_for_a_running_check_and_a_resume(env: _Env) -> None:
    """Check now is refused while a run is going or the plan is paused."""
    plan = _enable(env, _incumbent(env))
    env.rows = _cases(["B"] * 10)
    env.sweep(_due(env))
    assert env.cycles()[0].status == "optimizing"
    busy = env.client.post(f"/continuous/{plan['id']}/check-now")
    assert (busy.status_code, busy.json()["code"]) == (409, "continuous.check_busy")

    env.client.post(f"/continuous/{plan['id']}/pause")
    paused = env.client.post(f"/continuous/{plan['id']}/check-now")
    assert (paused.status_code, paused.json()["code"]) == (409, "continuous.check_paused")


def test_a_plan_saved_before_rules_reads_as_a_rule(env: _Env) -> None:
    """A stored ``daily`` plan with no rule shows and schedules as daily at 09:00 UTC."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    env.edit_plan(schedule="daily", schedule_rule=None)
    env.sweep(_due(env))
    following = continuous.aware(env.plan().next_check_at)
    assert (following.hour, following.minute) == (9, 0)
    plan = env.client.get(f"/optimizations/{source_id}/continuous").json()["plan"]
    assert (plan["schedule"]["frequency"], plan["schedule"]["time"]) == ("daily", "09:00")


def test_the_sidebar_flags_every_run_of_a_plan(env: _Env) -> None:
    """The source run and a run a check started are automated; an unrelated run is not."""
    source_id = _incumbent(env)
    other_id = env.client.post("/optimize", json=_incumbent_payload()).json()["optimization_id"]
    _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    env.sweep(_due(env))
    started = env.cycles()[0].optimization_id
    assert automated_run_ids(env.store, [source_id, started, other_id]) == {source_id, started}


def test_a_plan_without_amounts_reuses_the_run_budget_and_has_no_monthly_limit(env: _Env) -> None:
    """With no amounts, each run gets the source run's budget and only the wallet gates it."""
    source_id = _incumbent(env)
    source = env.store.get_job(source_id, include_payload=True)
    expected = source["payload"].get("max_cost_cents") or (
        BudgetService(engine=env.store.engine).get(source["execution_budget_id"], "alice").total_cents
    )
    plan = _enable(env, source_id, monthly_limit_cents=None, cycle_budget_cents=None)
    assert plan["cycle_budget_cents"] == expected
    assert plan["usage"]["limit_cents"] is None

    for answer in ("B", "C", "D"):
        env.rows = _cases([answer] * 10)
        env.sweep(_due(env))
        cycle = env.cycles()[-1]
        assert cycle.status == "optimizing", cycle.detail_code
        _finish(env, cycle.optimization_id, result=_result(0.7, 0.6))
        env.sweep(datetime.now(UTC))
    assert env.plan().status == "active"


def test_a_plan_set_up_while_the_run_works_waits_for_its_success(env: _Env) -> None:
    """A plan made from the submit wizard waits, then starts when the run succeeds."""
    optimization_id = env.client.post("/optimize", json=_incumbent_payload()).json()["optimization_id"]
    plan = _enable(env, optimization_id, monthly_limit_cents=None, cycle_budget_cents=None)
    assert (plan["status"], plan["next_check_at"]) == ("waiting", None)
    assert env.client.post(f"/continuous/{plan['id']}/pause").status_code == 409
    assert env.sweep(datetime.now(UTC) + timedelta(days=30)) == []

    _finish(env, optimization_id, result=_result(0.5, 0.7))
    started = env.client.get(f"/optimizations/{optimization_id}/continuous").json()["plan"]
    assert started["status"] == "active"
    assert started["next_check_at"] is not None


def test_a_waiting_plan_ends_with_a_failed_run(env: _Env) -> None:
    """A waiting plan ends, with the reason kept, when its run fails; the owner can then delete it."""
    optimization_id = env.client.post("/optimize", json=_incumbent_payload()).json()["optimization_id"]
    plan = _enable(env, optimization_id, permitted={"models": True}, source=None)
    _finish(env, optimization_id, status="failed")
    env.sweep(datetime.now(UTC))
    state = env.client.get(f"/optimizations/{optimization_id}/continuous").json()
    assert state["eligible"] is False
    assert (state["plan"]["status"], state["plan"]["pause_reason"], state["plan"]["next_check_at"]) == (
        "ended",
        "failed",
        None,
    )
    assert env.client.post(f"/continuous/{plan['id']}/resume").status_code == 409

    assert env.client.delete(f"/continuous/{plan['id']}").status_code == 204
    assert env.client.get(f"/optimizations/{optimization_id}/continuous").json() == {
        "plan": None,
        "eligible": False,
        "held_out": True,
        "task_model": "fixture/task",
        "reflection_model": "fixture/text",
    }
    assert env.client.delete(f"/continuous/{plan['id']}").status_code == 404


def test_a_run_without_test_cases_cannot_start_a_plan(env: _Env) -> None:
    """A plan could never replace a run that kept no test cases apart, so none starts from it."""
    optimization_id = env.client.post("/optimize", json=_incumbent_payload()).json()["optimization_id"]
    _finish(env, optimization_id, result=_result(0.5, 0.7, test=0, held_out=False))
    state = env.client.get(f"/optimizations/{optimization_id}/continuous").json()
    assert (state["eligible"], state["held_out"]) == (False, False)
    refused = env.client.post(
        f"/optimizations/{optimization_id}/continuous",
        json={"schedule": WEEKLY, "permitted": {"models": True}, "cycle_budget_cents": CYCLE_BUDGET},
    )
    assert (refused.status_code, refused.json()["code"]) == (409, "continuous.no_test_split")


def test_a_run_in_flight_without_a_test_split_cannot_start_a_plan(env: _Env) -> None:
    """The submit wizard cannot set up a plan for a run whose split keeps no test cases."""
    payload = _incumbent_payload()
    payload["data"]["split"] = {"train": 0.8, "val": 0.2, "test": 0.0}
    optimization_id = env.client.post("/optimize", json=payload).json()["optimization_id"]
    refused = env.client.post(
        f"/optimizations/{optimization_id}/continuous",
        json={"schedule": WEEKLY, "permitted": {"models": True}, "cycle_budget_cents": CYCLE_BUDGET},
    )
    assert (refused.status_code, refused.json()["code"]) == (409, "continuous.no_test_split")


def test_a_waiting_plan_ends_when_its_run_keeps_no_test_cases(env: _Env) -> None:
    """A run with too few cases for a test split succeeds, and its waiting plan ends with the reason."""
    optimization_id = env.client.post("/optimize", json=_incumbent_payload()).json()["optimization_id"]
    plan = _enable(env, optimization_id, monthly_limit_cents=None, cycle_budget_cents=None)
    assert plan["status"] == "waiting"
    _finish(env, optimization_id, result=_result(0.5, 0.7, test=0, held_out=False))
    env.sweep(datetime.now(UTC))
    ended = env.client.get(f"/optimizations/{optimization_id}/continuous").json()["plan"]
    assert (ended["status"], ended["pause_reason"], ended["next_check_at"]) == ("ended", "no_test_split", None)


def test_a_plan_deleted_while_its_check_submits_keeps_the_run(
    env: _Env, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A plan deleted mid-check leaves its run as an ordinary run and the check finishes quietly."""
    source_id = _incumbent(env)
    plan = _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    submit = continuous.submit_unified_payload
    submitted: list[str] = []

    def delete_then_submit(*args: Any, **kwargs: Any) -> Any:
        """Delete the plan, then submit as usual.

        Args:
            *args: Forwarded to the real submit.
            **kwargs: Forwarded to the real submit.

        Returns:
            The real submit's response.
        """
        assert env.client.delete(f"/continuous/{plan['id']}").status_code == 204
        response = submit(*args, **kwargs)
        submitted.append(response.optimization_id)
        return response

    monkeypatch.setattr(continuous, "submit_unified_payload", delete_then_submit)
    env.sweep(_due(env))

    assert not [record for record in caplog.records if record.levelno >= logging.ERROR]
    assert env.cycles() == []
    assert env.store.get_job(submitted[0], include_payload=False)["optimization_id"] == submitted[0]


def test_the_same_rows_in_another_order_start_no_run(env: _Env) -> None:
    """A warehouse that returns the same rows in a new order is not new data."""
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True})
    env.rows = _cases(["B"] * 5 + ["C"] * 5)
    env.sweep(_due(env))
    [first] = env.cycles()
    _finish(env, first.optimization_id, result=_result(0.5, 0.5))
    env.sweep(_due(env) - timedelta(days=1))
    jobs_before = env.count(JobModel)

    env.rows = list(reversed(env.rows))
    env.sweep(_due(env))

    assert (env.cycles()[-1].status, env.cycles()[-1].detail_code) == ("skipped", "continuous.skip_unchanged")
    assert env.count(JobModel) == jobs_before


def test_a_failed_run_leaves_its_new_data_for_the_next_check(env: _Env) -> None:
    """After an outage fails the run, the same new data starts a run on the next check."""
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True})
    baseline = env.plan().baseline_snapshot
    env.rows = _cases(["B"] * 10)
    env.sweep(_due(env))
    [first] = env.cycles()
    _finish(env, first.optimization_id, status="failed")
    env.sweep(_due(env) - timedelta(days=1))
    assert env.plan().baseline_snapshot == baseline

    env.sweep(_due(env))

    second = env.cycles()[-1]
    assert (second.status, second.changes) == ("optimizing", ["data"])


def test_a_check_that_keeps_crashing_is_closed_and_frees_the_plan(env: _Env) -> None:
    """A check that loses its worker three times is failed, so later checks and Check now run again."""
    source_id = _incumbent(env)
    plan = _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    now = _due(env)
    [claimed] = continuous._claim_due(env.store.engine, now)
    for attempt in range(continuous.MAX_CHECK_ATTEMPTS):
        now += continuous.CYCLE_LEASE + timedelta(seconds=1)
        reclaimed = continuous._reclaim_stale(env.store.engine, now)
        assert reclaimed == ([claimed] if attempt < continuous.MAX_CHECK_ATTEMPTS - 1 else [])

    [cycle] = env.cycles()
    assert (cycle.status, cycle.detail_code) == ("failed", "continuous.check_stuck")
    assert env.client.post(f"/continuous/{plan['id']}/check-now").status_code != 409


def test_failing_checks_in_a_row_pause_the_plan_until_resumed(env: _Env) -> None:
    """A source that keeps failing pauses the plan after a few checks instead of failing forever."""
    source_id = _incumbent(env)
    plan = _enable(env, source_id, schedule=DAILY)
    env.source_error = continuous.SourceError("continuous.source_unavailable", provider="huggingface", reason="gone")
    for _ in range(continuous.FAILURE_STREAK):
        env.sweep(_due(env))

    current = env.plan()
    assert (current.status, current.pause_reason, current.next_check_at) == ("paused", "failing", None)
    assert [c.status for c in env.cycles()] == ["failed"] * continuous.FAILURE_STREAK
    fetches = env.fetches
    env.sweep(datetime.now(UTC) + timedelta(days=30))
    assert env.fetches == fetches

    env.source_error = None
    resumed = env.client.post(f"/continuous/{plan['id']}/resume").json()
    assert (resumed["status"], resumed["pause_reason"]) == ("active", None)
    assert resumed["next_check_at"] is not None


def test_a_retry_keeps_the_snapshot_its_run_used(env: _Env) -> None:
    """A worker that died after submitting is replayed without reading the source again."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    now = _due(env)
    env.sweep(now)
    [cycle] = env.cycles()
    fetches = env.fetches
    env.edit_cycle(cycle.id, status="checking", optimization_id=None, lease_until=now - timedelta(seconds=1))
    env.rows = _cases(["C"] * 10)

    env.sweep(now)

    [retried] = env.cycles()
    assert (retried.status, retried.optimization_id) == ("optimizing", cycle.optimization_id)
    assert retried.snapshot == cycle.snapshot
    assert env.fetches == fetches


def test_a_waiting_check_is_reported_as_busy(env: _Env) -> None:
    """A check behind another check still running says it is busy, not waiting for a review."""
    source_id = _incumbent(env)
    _enable(env, source_id)
    env.rows = _cases(["B"] * 10)
    now = _due(env)
    continuous._claim_due(env.store.engine, now)
    env.edit_plan(next_check_at=now)
    [second] = continuous._claim_due(env.store.engine, now + timedelta(seconds=1))
    continuous.process_cycle(env.store, object(), second, now=now, fetch_rows=env.fetch)
    assert {c.id: c.detail_code for c in env.cycles()}[second] == "continuous.skip_busy"


def test_a_schedule_change_reaches_a_plan_paused_for_its_allowance(env: _Env) -> None:
    """A plan the system paused still checks, so a new rule moves its next check."""
    plan = _enable(env, _incumbent(env))
    env.edit_plan(status="paused", pause_reason="allowance")
    changed = env.client.put(f"/continuous/{plan['id']}/schedule", json=DAILY).json()
    first = datetime.fromisoformat(changed["next_check_at"])
    assert changed["status"] == "paused"
    assert (first.hour, first.minute) == (9, 0)
    assert first - datetime.now(UTC) <= timedelta(days=1)


def test_a_schedule_save_forgets_single_checks_that_passed(env: _Env) -> None:
    """Old single-date changes are dropped on save, so they never fill the slot limit."""
    plan = _enable(env, _incumbent(env))
    past, future = "2020-01-01T09:00", "2099-01-01T09:00"
    rule = {**DAILY, "skip": [past, future], "extra": [past]}
    saved = env.client.put(f"/continuous/{plan['id']}/schedule", json=rule).json()
    assert (saved["schedule"]["skip"], saved["schedule"]["extra"]) == ([future], [])


def _catalog(monkeypatch: pytest.MonkeyPatch, **models: tuple[float, float]) -> None:
    """Serve a hosted catalog whose models have the given rating and price.

    Args:
        monkeypatch: Replaces the cached catalog lookup.
        **models: ``(intelligence score, price per token)`` per model, keyed by the name after ``fixture/``.
    """
    entries = [
        CatalogModel(
            value=f"fixture/{name}",
            label=name,
            provider="fixture",
            available=True,
            intelligence_index=score,
            input_cost_per_token=price,
            output_cost_per_token=price,
        )
        for name, (score, price) in models.items()
    ]
    monkeypatch.setattr(continuous, "get_catalog_cached", lambda: ModelCatalogResponse(providers=[], models=entries))


def _new_models_plan(env: _Env, **permitted: Any) -> tuple[str, dict[str, Any]]:
    """Enable a plan that only tries better models.

    Args:
        env: Test environment.
        **permitted: Permission overrides; the task model by default.

    Returns:
        The incumbent's id and the plan.
    """
    source_id = _incumbent(env)
    plan = _enable(env, source_id, permitted=permitted or {"new_task_model": True}, source=None)
    return source_id, plan


def _payload(env: _Env, optimization_id: str) -> dict[str, Any]:
    """Read a run's stored request.

    Args:
        env: Test environment.
        optimization_id: The run.

    Returns:
        The request.
    """
    return env.store.get_job(optimization_id, include_payload=True)["payload"]


def _runs(cycle: Any) -> dict[str, str]:
    """Map each run a check started to its optimization id, by kind.

    Args:
        cycle: The cycle.

    Returns:
        Optimization id per run kind.
    """
    return {run["kind"]: run["optimization_id"] for run in cycle.snapshot["runs"]}


def test_a_better_model_at_the_same_price_runs_once_on_the_same_test_cases(
    env: _Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A model rated higher at the same price starts one run on the incumbent's cases, then waits for approval."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id, plan = _new_models_plan(env)
    incumbent = _payload(env, source_id)

    env.sweep(_due(env))

    [cycle] = env.cycles()
    assert (cycle.status, cycle.changes, list(_runs(cycle))) == ("optimizing", ["new_model"], ["model"])
    payload = _payload(env, cycle.optimization_id)
    assert payload["models"]["task_model"]["name"] == "fixture/strong"
    assert payload["models"]["reflection_model"]["name"] == "fixture/text"
    assert payload["data"]["cases"] == incumbent["data"]["cases"]
    request = UnifiedRunRequest.model_validate(incumbent)
    first = split_cases(request.data.cases, "pairs", request.data.split, shuffle=True, seed=split_seed(request))
    assert set(payload["data"]["pinned_split"]["test"]) == {case_key(case) for case in first.test}
    assert payload["task"]["artifact"]["starting_version"] == "Answer in one word: "

    # The new model scores the old version higher than the incumbent did, and optimizing adds nothing.
    _finish(env, cycle.optimization_id, result=_result(0.8, 0.8, guard=True))
    env.sweep(_due(env) - timedelta(days=1))
    [cycle] = env.cycles()
    assert (cycle.status, cycle.incumbent_score, cycle.candidate_score) == ("awaiting_review", 0.7, 0.8)

    approved = env.client.post(f"/continuous/{plan['id']}/cycles/{cycle.id}/approve")
    assert approved.status_code == 200, approved.text
    jobs = env.count(JobModel)
    env.sweep(_due(env))
    assert env.cycles()[-1].detail_code == "continuous.skip_unchanged"
    assert env.count(JobModel) == jobs


@pytest.mark.parametrize(
    "models",
    [
        {"task": (40.0, 1e-6), "pricier": (60.0, 2e-6)},
        {"task": (60.0, 1e-6), "weaker": (40.0, 5e-7)},
        {"strong": (60.0, 1e-6)},
    ],
)
def test_no_better_model_at_the_same_price_starts_no_run(
    env: _Env, monkeypatch: pytest.MonkeyPatch, models: dict
) -> None:
    """A model that costs more, rates lower, or has no current model to compare with is never tried."""
    _catalog(monkeypatch, **models)
    _new_models_plan(env)

    env.sweep(_due(env))

    [cycle] = env.cycles()
    assert (cycle.status, cycle.detail_code) == ("skipped", "continuous.skip_unchanged")


def test_a_cheaper_better_model_is_tried(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """Of the models that qualify, the highest-rated one is tried, even when a cheaper one also qualifies."""
    _catalog(monkeypatch, task=(40.0, 1e-6), cheap=(50.0, 5e-7), best=(55.0, 1e-6), pricey=(90.0, 3e-6))
    _new_models_plan(env)

    env.sweep(_due(env))

    [cycle] = env.cycles()
    assert _payload(env, cycle.optimization_id)["models"]["task_model"]["name"] == "fixture/best"


@pytest.mark.parametrize(
    ("result", "code"),
    [
        (_result(0.9, 0.705), "continuous.review_within_margin"),
        (
            {**_result(0.5, 0.9), "split_counts": {**_result(0.5, 0.9)["split_counts"], "test": 3}},
            "continuous.review_unscored",
        ),
    ],
)
def test_a_better_model_that_does_not_win_is_not_tried_again(
    env: _Env, monkeypatch: pytest.MonkeyPatch, result: dict, code: str
) -> None:
    """A model that loses, or ran on other test cases, keeps the incumbent and costs no second run."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    _new_models_plan(env)
    env.sweep(_due(env))
    [cycle] = env.cycles()
    _finish(env, cycle.optimization_id, result=result)

    jobs = env.count(JobModel)
    env.sweep(_due(env))

    first, second = env.cycles()
    assert (first.status, first.detail_code) == ("regressed", code)
    assert second.detail_code == "continuous.skip_unchanged"
    assert env.count(JobModel) == jobs


def test_a_better_reflection_model_keeps_the_task_model_and_its_own_baseline(
    env: _Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only the reflection model moves, so the run's own baseline is the incumbent's score."""
    # The task model rates highest but costs more, so the reflection role cannot move to it.
    _catalog(monkeypatch, task=(90.0, 5e-6), text=(40.0, 1e-6), sharper=(60.0, 1e-6))
    _new_models_plan(env, new_reflection_model=True)

    env.sweep(_due(env))

    [cycle] = env.cycles()
    payload = _payload(env, cycle.optimization_id)
    assert payload["models"]["task_model"]["name"] == "fixture/task"
    assert payload["models"]["reflection_model"]["name"] == "fixture/sharper"
    _finish(env, cycle.optimization_id, result=_result(0.6, 0.8))
    env.sweep(_due(env) - timedelta(days=1))
    [cycle] = env.cycles()
    assert (cycle.status, cycle.incumbent_score) == ("awaiting_review", 0.6)


def test_new_data_below_the_minimum_starts_no_run(env: _Env) -> None:
    """A few new cases wait until the plan's minimum of untried cases arrives."""
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True, "min_new_cases": 3})
    env.rows = _cases(["A"] * 10) + _cases(["B"] * 12)[10:12]

    env.sweep(_due(env))
    assert env.cycles()[-1].detail_code == "continuous.skip_unchanged"

    env.rows = _cases(["A"] * 10) + _cases(["B"] * 13)[10:13]
    env.sweep(_due(env))
    assert env.cycles()[-1].status == "optimizing"


def test_new_data_grows_the_test_set_and_never_moves_a_test_case_into_search(env: _Env) -> None:
    """The incumbent's test cases stay held out, and some new cases join them."""
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True})
    incumbent = _payload(env, source_id)
    env.rows = _cases(["A"] * 10) + _cases(["B"] * 20)[10:20]

    env.sweep(_due(env))

    [cycle] = env.cycles()
    pinned = _payload(env, cycle.optimization_id)["data"]["pinned_split"]
    request = UnifiedRunRequest.model_validate(incumbent)
    first = split_cases(request.data.cases, "pairs", request.data.split, shuffle=True, seed=split_seed(request))
    old_test = {case_key(case) for case in first.test}
    old_fit = {case_key(case) for case in first.train + first.val}
    assert old_test < set(pinned["test"])
    assert len(pinned["test"]) > len(old_test)
    assert not old_fit & set(pinned["test"])


def test_the_matrix_starts_each_ticked_run_on_one_test_set(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """With new data and a better model, every ticked run starts, all holding out the same test cases."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True, "new_task_model": True, "matrix": ["data", "model", "both"]})
    env.rows = _cases(["A"] * 10) + _cases(["B"] * 20)[10:20]

    env.sweep(_due(env))

    [cycle] = env.cycles()
    runs = _runs(cycle)
    assert list(runs) == ["data", "model", "both"]
    payloads = {kind: _payload(env, run_id) for kind, run_id in runs.items()}
    assert {kind: p["models"]["task_model"]["name"] for kind, p in payloads.items()} == {
        "data": "fixture/task",
        "model": "fixture/strong",
        "both": "fixture/strong",
    }
    tests = {tuple(sorted(p["data"]["pinned_split"]["test"])) for p in payloads.values()}
    assert len(tests) == 1
    # The model-only run searches only on cases the incumbent already searched.
    assert len(payloads["model"]["data"]["cases"]) < len(payloads["data"]["data"]["cases"])

    # The data run kept the incumbent's model, so its baseline scores the incumbent on the new test set.
    _finish(env, runs["data"], result=_result(0.6, 0.65))
    _finish(env, runs["model"], result=_result(0.7, 0.72))
    env.sweep(_due(env) - timedelta(days=1))
    assert env.cycles()[0].status == "optimizing"
    _finish(env, runs["both"], result=_result(0.7, 0.9))
    env.sweep(_due(env) - timedelta(days=1))
    [cycle] = env.cycles()
    assert (cycle.status, cycle.optimization_id) == ("awaiting_review", runs["both"])
    assert (cycle.incumbent_score, cycle.candidate_score) == (0.6, 0.9)
    assert cycle.snapshot["winner"]["kind"] == "both"


def test_new_data_the_matrix_left_without_a_run_waits_for_the_next_check(
    env: _Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A check that runs only the better model leaves its new data unseen, so the next check runs on it."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True, "new_task_model": True, "matrix": ["model"]})
    env.rows = _cases(["A"] * 10) + _cases(["B"] * 20)[10:20]

    env.sweep(_due(env))
    [cycle] = env.cycles()
    runs = _runs(cycle)
    assert not {"data", "both"} & set(runs)
    for run_id in runs.values():
        _finish(env, run_id, result=_result(0.6, 0.6))
    env.sweep(_due(env) - timedelta(days=1))
    assert env.cycles()[0].status != "optimizing"

    env.sweep(_due(env))
    latest = env.cycles()[-1]
    assert latest.status == "optimizing"
    assert list(_runs(latest)) == ["data"]


def test_runs_that_all_move_the_task_model_score_the_incumbent_once_without_optimizing(
    env: _Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without a run on the incumbent's own model, a reference run scores it on the grown test set."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True, "new_task_model": True})
    env.rows = _cases(["A"] * 10) + _cases(["B"] * 20)[10:20]

    env.sweep(_due(env))

    [cycle] = env.cycles()
    runs = _runs(cycle)
    assert list(runs) == ["both", "reference"]
    reference = _payload(env, runs["reference"])
    assert reference["optimizer"]["score_only"] is True
    assert reference["models"]["task_model"]["name"] == "fixture/task"

    _finish(env, runs["both"], result=_result(0.75, 0.8))
    _finish(env, runs["reference"], result=_result(0.62, 0.62))
    env.sweep(_due(env) - timedelta(days=1))
    [cycle] = env.cycles()
    assert (cycle.status, cycle.incumbent_score, cycle.candidate_score) == ("awaiting_review", 0.62, 0.8)


def test_the_allowance_gate_counts_every_run_of_a_check(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """A check whose runs together exceed what is left this month pauses before it starts any."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(
        env,
        source_id,
        permitted={"data": True, "new_task_model": True, "matrix": ["data", "model", "both"]},
        monthly_limit_cents=CYCLE_BUDGET * 2,
    )
    env.rows = _cases(["A"] * 10) + _cases(["B"] * 20)[10:20]

    env.sweep(_due(env))

    [cycle] = env.cycles()
    assert (cycle.status, cycle.detail_code) == ("paused", "continuous.paused_allowance")
    assert env.plan().pause_reason == "allowance"


def test_a_byok_run_rates_its_models_by_their_hosted_twins(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """BYOK registry entries carry no rating, so the hosted catalog's rating for the same model decides."""
    hosted = [
        CatalogModel(value="openrouter/acme/fast-1.5", label="fast", provider="openrouter", intelligence_index=40.0),
        CatalogModel(value="openrouter/acme/deep-2.0", label="deep", provider="openrouter", intelligence_index=60.0),
    ]
    byok = [
        CatalogModel(
            value=value,
            label=value,
            provider="acme",
            available=True,
            byok_provider="acme",
            input_cost_per_token=1e-6,
            output_cost_per_token=1e-6,
        )
        for value in ("acme/fast-1-5", "acme/deep-2-0-20260901", "acme/unrated")
    ]
    monkeypatch.setattr(continuous, "get_catalog_cached", lambda: ModelCatalogResponse(providers=[], models=hosted))
    monkeypatch.setattr(
        continuous, "_byok_catalog_for_user", lambda vault, username: ModelCatalogResponse(providers=[], models=byok)
    )

    better = continuous.better_model(env.store, "alice", {"name": "acme/fast-1-5", "token_source": "byok"})

    assert better == {"name": "acme/deep-2-0-20260901", "byok_provider": "acme"}


def test_approving_a_better_model_drops_an_older_staged_task_model(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """A task model staged before the switch must not undo the approved better model on the next check."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    _, plan = _new_models_plan(env, models=True, new_task_model=True)
    staged = env.client.post(f"/continuous/{plan['id']}/inputs", json={"task_model": "fixture/task"})
    assert staged.status_code == 200, staged.text

    env.sweep(_due(env))
    [cycle] = env.cycles()
    assert cycle.changes == ["new_model"]
    _finish(env, cycle.optimization_id, result=_result(0.8, 0.8))
    env.sweep(_due(env) - timedelta(days=1))
    [cycle] = env.cycles()
    assert cycle.status == "awaiting_review"
    approved = env.client.post(f"/continuous/{plan['id']}/cycles/{cycle.id}/approve")
    assert approved.status_code == 200, approved.text

    jobs = env.count(JobModel)
    env.sweep(_due(env))
    assert env.cycles()[-1].detail_code == "continuous.skip_unchanged"
    assert env.count(JobModel) == jobs


def test_after_the_top_model_loses_the_next_best_model_is_tried(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """A tried model is skipped when choosing, so a lower-rated model that also qualifies gets its run."""
    _catalog(monkeypatch, task=(40.0, 1e-6), mid=(50.0, 1e-6), strong=(60.0, 1e-6))
    _new_models_plan(env)
    env.sweep(_due(env))
    [cycle] = env.cycles()
    assert _payload(env, cycle.optimization_id)["models"]["task_model"]["name"] == "fixture/strong"
    _finish(env, cycle.optimization_id, result=_result(0.9, 0.705))
    env.sweep(_due(env) - timedelta(days=1))

    env.sweep(_due(env))

    latest = env.cycles()[-1]
    assert latest.status == "optimizing"
    assert _payload(env, latest.optimization_id)["models"]["task_model"]["name"] == "fixture/mid"


def test_a_failed_model_run_beside_a_successful_data_run_is_offered_again(
    env: _Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only a successful run marks its model as tried, so a model run lost to an outage runs on the next check."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True, "new_task_model": True, "matrix": ["data", "model"]})
    env.rows = _cases(["A"] * 10) + _cases(["B"] * 20)[10:20]
    env.sweep(_due(env))
    [cycle] = env.cycles()
    runs = _runs(cycle)
    _finish(env, runs["data"], result=_result(0.6, 0.6))
    _finish(env, runs["model"], status="failed")
    env.sweep(_due(env) - timedelta(days=1))
    assert env.cycles()[0].status != "optimizing"

    env.sweep(_due(env))

    latest = env.cycles()[-1]
    assert latest.status == "optimizing"
    assert "model" in _runs(latest)
    assert "data" not in _runs(latest)


def test_a_refused_run_keeps_its_budget_on_the_check(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """A run refused after its budget was created still counts against the check and the monthly allowance."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True, "new_task_model": True, "matrix": ["data", "model"]})
    env.rows = _cases(["A"] * 10) + _cases(["B"] * 20)[10:20]
    submit = continuous.submit_unified_payload
    refused: list[str] = []

    def refuse_the_model_run(payload: UnifiedRunRequest, **kwargs: Any) -> Any:
        """Fund the model run's budget, then refuse it as a failed setup check would.

        Args:
            payload: The run's request.
            **kwargs: Arguments for the real submit.

        Returns:
            The real submit's response for every other run.

        Raises:
            DomainError: For the model run, after its budget exists.
        """
        if payload.models.task_model.name != "fixture/strong":
            return submit(payload, **kwargs)
        key = continuous.resolve_submission_replay_keys(
            payload,
            username=kwargs["current_user"].username,
            workflow=continuous.UNIFIED_WORKFLOW,
            supplied_key=kwargs["idempotency_key"],
        ).budget
        refused.append(BudgetService(engine=env.store.engine).create("alice", 50, idempotency_key=key).id)
        raise DomainError("submission.validation_failed", status=422)

    monkeypatch.setattr(continuous, "submit_unified_payload", refuse_the_model_run)

    env.sweep(_due(env))

    [cycle] = env.cycles()
    assert list(_runs(cycle)) == ["data"]
    assert len(refused) == 1
    assert refused[0] in continuous.cycle_budget_ids(cycle)


def test_every_refused_run_keeps_its_budget_when_no_run_starts(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """When every run of a check is refused after funding, each budget still counts against the allowance."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True, "new_task_model": True, "matrix": ["data", "model"]})
    env.rows = _cases(["A"] * 10) + _cases(["B"] * 20)[10:20]
    refused: list[str] = []

    def refuse_every_run(payload: UnifiedRunRequest, **kwargs: Any) -> Any:
        """Fund each run's budget, then refuse it as a failed setup check would.

        Args:
            payload: The run's request.
            **kwargs: Arguments for the real submit.

        Raises:
            DomainError: Always, after the run's budget exists.
        """
        key = continuous.resolve_submission_replay_keys(
            payload,
            username=kwargs["current_user"].username,
            workflow=continuous.UNIFIED_WORKFLOW,
            supplied_key=kwargs["idempotency_key"],
        ).budget
        refused.append(BudgetService(engine=env.store.engine).create("alice", 7, idempotency_key=key).id)
        raise DomainError("submission.validation_failed", status=422)

    monkeypatch.setattr(continuous, "submit_unified_payload", refuse_every_run)

    env.sweep(_due(env))

    [cycle] = env.cycles()
    assert cycle.status == "failed"
    assert len(refused) == 2
    assert set(refused) <= set(continuous.cycle_budget_ids(cycle))
    with Session(env.store.engine) as session:
        budgets = [session.get(ExecutionBudgetModel, budget_id) for budget_id in refused]
        committed = continuous.month_committed(session, env.plan(), cycle.month)
    assert committed == sum(budget.billed_cents + budget_wallet_hold(budget) for budget in budgets)


def test_a_failed_reference_run_leaves_a_swapped_test_set_unscored(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """A test split of the same size made of other cases cannot reuse the incumbent's own score."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True, "new_task_model": True})
    env.rows = [{"question": f"New {index}?", "answer": "B"} for index in range(10)]

    env.sweep(_due(env))

    [cycle] = env.cycles()
    runs = _runs(cycle)
    assert list(runs) == ["both", "reference"]
    _finish(env, runs["both"], result=_result(0.75, 0.9))
    _finish(env, runs["reference"], status="failed")
    env.sweep(_due(env) - timedelta(days=1))
    [cycle] = env.cycles()
    assert (cycle.status, cycle.detail_code, cycle.incumbent_score) == ("regressed", "continuous.review_unscored", None)


def test_a_retry_that_new_data_grows_pays_for_its_extra_runs(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """Runs a ``budget.pending`` retry adds on new inputs pass the allowance gate; the funded run does not again."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(
        env,
        source_id,
        permitted={"data": True, "new_task_model": True},
        monthly_limit_cents=CYCLE_BUDGET,
        cycle_budget_cents=CYCLE_BUDGET,
    )
    pending_budgets: list[str] = []

    def pending(payload: Any, **kwargs: Any) -> Any:
        """Create the run's budget with setup charges, then refuse as setup usage awaits confirmation.

        Args:
            payload: The run's request.
            **kwargs: Submission arguments, including the replay key.

        Raises:
            DomainError: Always, as ``budget.pending``.
        """
        budget_key = continuous.resolve_submission_replay_keys(
            payload, username="alice", workflow=continuous.UNIFIED_WORKFLOW, supplied_key=kwargs["idempotency_key"]
        ).budget
        budget = BudgetService(engine=env.store.engine).create("alice", CYCLE_BUDGET, idempotency_key=budget_key)
        pending_budgets.append(budget.id)
        raise DomainError("budget.pending", status=409)

    monkeypatch.setattr(continuous, "submit_unified_payload", pending)
    now = _due(env)
    env.sweep(now)
    [cycle] = env.cycles()
    assert [run["kind"] for run in cycle.snapshot["runs"]] == ["model"]

    env.rows = _cases(["A"] * 10) + _cases(["B"] * 20)[10:20]
    env.sweep(now + continuous.CYCLE_LEASE + timedelta(seconds=1))

    [retried] = env.cycles()
    assert (retried.id, retried.status, retried.detail_code) == (cycle.id, "paused", "continuous.paused_allowance")
    assert pending_budgets[0] in continuous.cycle_budget_ids(retried)


def test_a_retry_gates_only_the_runs_it_has_no_budget_for(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """With headroom for one more budget, a retry that adds one run starts both, its funded run included."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(
        env,
        source_id,
        permitted={"data": True, "new_task_model": True, "matrix": ["data", "model"]},
        cycle_budget_cents=CYCLE_BUDGET,
    )
    submit = continuous.submit_unified_payload

    def pending(payload: Any, **kwargs: Any) -> Any:
        """Create the run's budget, then refuse as setup usage awaits confirmation.

        Args:
            payload: The run's request.
            **kwargs: Submission arguments, including the replay key.

        Raises:
            DomainError: Always, as ``budget.pending``.
        """
        budget_key = continuous.resolve_submission_replay_keys(
            payload, username="alice", workflow=continuous.UNIFIED_WORKFLOW, supplied_key=kwargs["idempotency_key"]
        ).budget
        BudgetService(engine=env.store.engine).create("alice", CYCLE_BUDGET, idempotency_key=budget_key)
        raise DomainError("budget.pending", status=409)

    monkeypatch.setattr(continuous, "submit_unified_payload", pending)
    now = _due(env)
    env.sweep(now)
    [cycle] = env.cycles()
    assert [run["kind"] for run in cycle.snapshot["runs"]] == ["model"]
    with Session(env.store.engine) as session:
        committed = continuous.month_committed(session, env.plan(), cycle.month)
    env.edit_plan(monthly_limit_cents=committed + CYCLE_BUDGET)

    monkeypatch.setattr(continuous, "submit_unified_payload", submit)
    env.rows = _cases(["A"] * 10) + _cases(["B"] * 20)[10:20]
    env.sweep(now + continuous.CYCLE_LEASE + timedelta(seconds=1))

    [retried] = env.cycles()
    assert (retried.id, retried.status) == (cycle.id, "optimizing")
    assert sorted(_runs(retried)) == ["data", "model"]


def test_duplicate_new_rows_hold_out_as_many_copies_in_every_run(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """The model-only run keeps only the held-out copies of a duplicated new row, as the data run does."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True, "new_task_model": True, "matrix": ["data", "model"]})
    env.rows = _cases(["A"] * 10) + [{"question": "Again?", "answer": "B"}] * 10

    env.sweep(_due(env))

    [cycle] = env.cycles()
    runs = _runs(cycle)
    assert list(runs) == ["data", "model"]
    held_out = {kind: continuous._test_keys(_payload(env, run_id)) for kind, run_id in runs.items()}
    assert held_out["model"] == held_out["data"]


def test_a_crashed_check_keeps_the_budget_of_a_run_refused_before_the_crash(
    env: _Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Recovery links the accepted run and still counts the budget a refused sibling was charged on."""
    _catalog(monkeypatch, task=(40.0, 1e-6), strong=(60.0, 1e-6))
    source_id = _incumbent(env)
    _enable(env, source_id, permitted={"data": True, "new_task_model": True, "matrix": ["data", "model"]})
    env.rows = _cases(["A"] * 10) + _cases(["B"] * 20)[10:20]
    submit = continuous.submit_unified_payload
    refused: list[str] = []

    def refuse_the_model_run(payload: UnifiedRunRequest, **kwargs: Any) -> Any:
        """Fund the model run's budget, then refuse it as a failed setup check would.

        Args:
            payload: The run's request.
            **kwargs: Arguments for the real submit.

        Returns:
            The real submit's response for every other run.

        Raises:
            DomainError: For the model run, after its budget exists.
        """
        if payload.models.task_model.name != "fixture/strong":
            return submit(payload, **kwargs)
        key = continuous.resolve_submission_replay_keys(
            payload,
            username=kwargs["current_user"].username,
            workflow=continuous.UNIFIED_WORKFLOW,
            supplied_key=kwargs["idempotency_key"],
        ).budget
        refused.append(BudgetService(engine=env.store.engine).create("alice", 50, idempotency_key=key).id)
        raise DomainError("submission.validation_failed", status=422)

    monkeypatch.setattr(continuous, "submit_unified_payload", refuse_the_model_run)
    now = _due(env)
    env.sweep(now)
    [cycle] = env.cycles()
    # The worker died after both submits but before recording them.
    snapshot = {key: value for key, value in cycle.snapshot.items() if key != "refused_budgets"}
    snapshot["runs"] = [{"kind": "data"}, {"kind": "model"}]
    env.edit_cycle(cycle.id, status="checking", optimization_id=None, snapshot=snapshot, lease_until=now)

    env.sweep(now + timedelta(seconds=1))

    [recovered] = env.cycles()
    assert (recovered.status, list(_runs(recovered))) == ("optimizing", ["data"])
    assert refused[0] in continuous.cycle_budget_ids(recovered)
