"""Verify lifecycle endpoints fence paid admission before acknowledging user actions."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.api.routers.optimizations import create_optimizations_router, lifecycle

from .conftest import bypass_auth
from .mocks import _BaseFakeJobStore


def test_cancel_closes_paid_admission_before_status_mutation(monkeypatch: pytest.MonkeyPatch) -> None:
    """Prevent additional provider dispatch after cancellation returns to the user."""
    store = _BaseFakeJobStore()
    store.seed_job("protected-cancel", status="running", username="alice")
    store.update_job("protected-cancel", execution_budget_id="budget")
    store.engine = object()
    calls = []

    class Budgets:
        """Capture the trusted admission closure without creating any paid work."""

        def stop_admission(self, identity: str, username: str, *, reason: str) -> None:
            """Require the budget to close while the run is still active."""
            assert store.get_job("protected-cancel")["status"] == "running"
            calls.append((identity, username, reason))

    monkeypatch.setattr(lifecycle, "BudgetService", lambda **kwargs: Budgets())
    app = FastAPI()
    app.include_router(create_optimizations_router(job_store=store, get_worker_ref=lambda: None))
    bypass_auth(app)
    response = TestClient(app).post("/optimizations/protected-cancel/cancel")
    assert response.status_code == 200
    assert calls == [("budget", "alice", "user_cancelled")]
    assert store.get_job("protected-cancel")["status"] == "cancelled"


@pytest.mark.parametrize("action", ["retry", "restart", "clone"])
def test_protected_fresh_run_requires_new_budget_configuration(action: str) -> None:
    """Avoid transferring spent funding and setup evidence into a different execution."""
    store = _BaseFakeJobStore()
    store.seed_job("protected", status="failed", username="alice")
    store.update_job("protected", execution_budget_id="spent-budget")
    app = FastAPI()
    app.include_router(create_optimizations_router(job_store=store, get_worker_ref=lambda: None))
    bypass_auth(app)
    response = TestClient(app).post(f"/optimizations/protected/{action}", json={"count": 1})
    assert response.status_code == 409
    assert len(store.list_jobs()) == 1
