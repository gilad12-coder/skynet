"""Verify continuous optimization against real jobs, preflight and protected budgets."""

from __future__ import annotations

import calendar
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
from core.api.routers import submissions
from core.api.routers._helpers import automated_run_ids
from core.api.routers.continuous import create_continuous_router
from core.api.tests.test_protected_submissions import _Gateway, _Harness, _SQLiteJobStore
from core.billing.budgets import BudgetService
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
    assert state == {"plan": None, "eligible": True}

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
    assert payload["data"]["cases"][-1] == {"input": {"question": "Q10?"}, "expected": {"answer": "C"}}
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
    env.edit_cycle(cycle.id, status="checking", optimization_id=None, lease_until=now - timedelta(seconds=1))
    env.sweep(now)
    [retried] = env.cycles()
    assert retried.optimization_id == cycle.optimization_id
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
    _finish(env, cycle.optimization_id, status="failed")
    env.sweep(_due(env) - timedelta(days=1))
    [cycle] = env.cycles()
    assert (cycle.status, cycle.detail_code) == ("failed", "continuous.run_failed")
    assert env.plan().incumbent_optimization_id == source_id


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

    for _ in range(3):
        env.rows = _cases(["B"] * 10) if env.rows[0]["answer"] != "B" else _cases(["C"] * 10)
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
    """A waiting plan is dropped when its run fails, so the run never shows a dead plan."""
    optimization_id = env.client.post("/optimize", json=_incumbent_payload()).json()["optimization_id"]
    _enable(env, optimization_id, permitted={"models": True}, source=None)
    _finish(env, optimization_id, status="failed")
    env.sweep(datetime.now(UTC))
    assert env.client.get(f"/optimizations/{optimization_id}/continuous").json() == {"plan": None, "eligible": False}
