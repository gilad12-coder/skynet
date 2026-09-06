"""Verify the probe-then-continue projection that pauses a run outgrowing its limit."""

from __future__ import annotations

import queue
import shutil
from decimal import Decimal
from types import SimpleNamespace

import pytest

from core.billing.budgets import BudgetService
from core.constants import TQDM_TOTAL_KEY
from core.service_gateway.optimization.trajectory import GEPA_STATE_FILENAME
from core.storage.tests.test_remote_jobstore import SQLiteJobStore, _fund_checkpoint
from core.worker.budget_probe import (
    STOP_REASON_BUDGET_PROJECTED,
    planned_calls_from_progress,
    probe_ready,
    project_total_credits,
)
from core.worker.constants import EVENT_PROGRESS
from core.worker.engine import BackgroundWorker, CancellationError

from .test_checkpoint_helpers import _PAYLOAD, _CheckpointStore, _state


def test_planned_calls_come_only_from_a_positive_integer_total() -> None:
    """Accept the optimizer bar's integer total and reject every other shape."""
    assert planned_calls_from_progress({TQDM_TOTAL_KEY: 230}) == 230
    assert planned_calls_from_progress({}) is None
    assert planned_calls_from_progress({TQDM_TOTAL_KEY: None}) is None
    assert planned_calls_from_progress({TQDM_TOTAL_KEY: 0}) is None
    assert planned_calls_from_progress({TQDM_TOTAL_KEY: True}) is None
    assert planned_calls_from_progress({TQDM_TOTAL_KEY: "230"}) is None


def test_probe_waits_for_the_larger_of_the_absolute_and_fractional_floors() -> None:
    """Short plans wait for the absolute floor, long plans for the fractional one."""
    assert probe_ready(9, 100) is False
    assert probe_ready(10, 100) is True
    assert probe_ready(10, 1000) is False
    assert probe_ready(50, 1000) is True


def test_projection_scales_run_spend_but_carries_setup_spend_over() -> None:
    """Only per-evaluation spend grows with the plan; the total rounds up."""
    assert project_total_credits(Decimal(2), Decimal(3), 23, 230) == 32
    assert project_total_credits(Decimal(0), Decimal("2.5"), 10, 30) == 8


def _settle_run_spend(budgets: BudgetService, budget_id: str, credits: int) -> None:
    """Settle one run-phase operation for ``credits`` on the funded fixture budget.

    Args:
        budgets: Budget service bound to the fixture store.
        budget_id: The funded fixture budget.
        credits: Whole credits the operation actually cost.
    """
    operation = budgets.reserve(
        budget_id,
        "resume-owner",
        operation_key=f"probe-{credits}",
        generation=0,
        phase="run",
        cost_kind="sandbox",
        request_fingerprint="fixture-session",
        price_snapshot={"version": "fixture"},
        max_credits=credits,
    )
    budgets.mark_dispatched(operation.id, "resume-owner", "fixture-session")
    budgets.settle(operation.id, "resume-owner", evidence_key="closed", actual_credits=credits, evidence={})


def _gateway(budgets: BudgetService, budget_id: str) -> SimpleNamespace:
    """Model the trusted parent transport's runtime handle on the fixture budget."""
    return SimpleNamespace(runtime=SimpleNamespace(service=budgets, budget_id=budget_id, username="resume-owner"))


def test_projection_over_limit_pauses_with_evidence_until_the_limit_is_raised(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pause at the checkpoint, close admission, and reopen once the user raises the limit.

    Args:
        monkeypatch: Fixture binding the checkpoint's immutable runtime profile.
    """
    store = SQLiteJobStore()
    store.create_job("probe")
    store.update_job("probe", status="running")
    budgets = _fund_checkpoint(store, "probe", monkeypatch)
    budget_id = store.get_job("probe")["execution_budget_id"]
    _settle_run_spend(budgets, budget_id, 3)
    tracker: dict = {"planned_calls": 230, -1: {"mtime": 1.0, "n": 3, "metric_calls": 23}}

    with pytest.raises(CancellationError):
        BackgroundWorker(job_store=store)._pause_if_over_projection("probe", _gateway(budgets, budget_id), tracker, 0)

    job = store.get_job("probe")
    assert job["status"] == "paused"
    assert job["stop_reason"] == STOP_REASON_BUDGET_PROJECTED
    projection = job["terminal_evidence"]["budget_projection"]
    assert projection["planned_calls"] == 230
    assert projection["done_calls"] == 23
    assert Decimal(projection["spent_credits"]) == 3
    assert projection["projected_credits"] == 30
    assert projection["limit_credits"] == 20
    budget = budgets.get(budget_id, "resume-owner")
    assert budget.state == "closed"
    assert budget.blocked_reason == STOP_REASON_BUDGET_PROJECTED

    budgets.update_total(budget_id, "resume-owner", 40, expected_revision=budget.revision)
    assert store.requeue_for_resume("probe", bump_attempts=False, expected_generation=0, budget_service=budgets) == 0
    assert budgets.get(budget_id, "resume-owner").state == "attached"
    assert store.get_job("probe")["status"] == "pending"


def test_projection_within_limit_keeps_running_and_probes_each_checkpoint_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Leave a run alone while its projection fits, and skip a checkpoint already judged.

    Args:
        monkeypatch: Fixture binding the checkpoint's immutable runtime profile.
    """
    store = SQLiteJobStore()
    store.create_job("fits")
    store.update_job("fits", status="running")
    budgets = _fund_checkpoint(store, "fits", monkeypatch)
    budget_id = store.get_job("fits")["execution_budget_id"]
    _settle_run_spend(budgets, budget_id, 1)
    tracker: dict = {"planned_calls": 230, -1: {"mtime": 1.0, "n": 3, "metric_calls": 23}}
    worker = BackgroundWorker(job_store=store)

    worker._pause_if_over_projection("fits", _gateway(budgets, budget_id), tracker, 0)
    assert store.get_job("fits")["status"] == "running"
    assert budgets.get(budget_id, "resume-owner").state == "attached"
    assert tracker["_probed_calls"] == 23

    unreachable = SimpleNamespace(runtime=SimpleNamespace(service=None, budget_id=budget_id, username="resume-owner"))
    worker._pause_if_over_projection("fits", unreachable, tracker, 0)
    assert store.get_job("fits")["status"] == "running"


def test_projection_waits_for_enough_evaluations_and_a_planned_count() -> None:
    """Neither a thin sample nor a missing plan touches the budget service."""
    worker = BackgroundWorker(job_store=_CheckpointStore())
    unreachable = SimpleNamespace(runtime=SimpleNamespace(service=None, budget_id="b", username="u"))
    worker._pause_if_over_projection("thin", unreachable, {"planned_calls": 230, -1: {"metric_calls": 5}}, 0)
    worker._pause_if_over_projection("unplanned", unreachable, {-1: {"metric_calls": 50}}, 0)
    worker._pause_if_over_projection("fresh", unreachable, {"planned_calls": 230}, 0)


def test_progress_and_checkpoint_feed_the_probe_tracker() -> None:
    """The optimizer bar's total and the saved state's metric calls land in the tracker."""

    class _Store(_CheckpointStore):
        """Accept progress rows the drain records alongside the tracker update."""

        def record_progress(self, *args, **kwargs) -> None:
            """Discard the progress row."""

    store = _Store()
    worker = BackgroundWorker(job_store=store)
    tracker: dict = {"payload": _PAYLOAD}
    events: queue.Queue = queue.Queue()
    events.put({"type": EVENT_PROGRESS, "event": "optimizer", "metrics": {TQDM_TOTAL_KEY: 230, "tqdm_n": 4}})
    worker._drain_subprocess_events("fed", events, checkpoint_tracker=tracker)
    assert tracker["planned_calls"] == 230

    base = worker._prepare_gepa_dir("fed", is_grid=False)
    try:
        (base / GEPA_STATE_FILENAME).write_bytes(_state(2))
        worker._persist_gepa_checkpoint("fed", base, tracker, is_grid=False)
    finally:
        shutil.rmtree(base, ignore_errors=True)
    assert tracker[-1]["metric_calls"] == store.manifests[-1]["metric_calls"] == 10
