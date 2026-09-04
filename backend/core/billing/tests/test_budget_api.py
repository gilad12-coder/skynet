"""Verify authenticated draft budget restoration, ownership, and concurrent edits."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from core.api.auth import AuthenticatedUser, get_authenticated_user
from core.api.routers.execution_budgets import budget_http_error, create_execution_budgets_router
from core.billing.budgets import BudgetTotalConflictError
from core.storage.models import Base, BillingCustomerModel


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    """Serve a private funded wallet through the real authenticated router."""
    engine = create_engine(f"sqlite:///{tmp_path / 'api.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add_all(
            [
                BillingCustomerModel(
                    username=name, stripe_customer_id=f"local-{name}", credit_balance=50, grant_remaining=0
                )
                for name in ("alice", "bob")
            ]
        )
        session.commit()
    app = FastAPI()
    app.include_router(create_execution_budgets_router(job_store=SimpleNamespace(engine=engine)))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser("alice", "user", ())
    with TestClient(app) as connection:
        yield connection
    engine.dispose()


def test_budget_api_replays_create_and_preserves_revision(client: TestClient) -> None:
    """Keep a network retry on one budget and reject stale total edits."""
    first = client.post("/execution-budgets", json={"total_credits": 20}, headers={"Idempotency-Key": "draft"})
    assert first.status_code == 200
    body = first.json()
    replay = client.post("/execution-budgets", json={"total_credits": 20}, headers={"Idempotency-Key": "draft"})
    assert replay.json()["id"] == body["id"]
    assert "username" not in body
    assert body["setup_spent_credits"] == "0"
    updated = client.patch(
        f"/execution-budgets/{body['id']}", json={"total_credits": 30, "expected_revision": body["revision"]}
    )
    assert updated.status_code == 200
    stale = client.patch(
        f"/execution-budgets/{body['id']}", json={"total_credits": 40, "expected_revision": body["revision"]}
    )
    assert stale.status_code == 409
    assert client.get(f"/execution-budgets/{body['id']}").json()["total_credits"] == 30


def test_budget_total_conflict_carries_authoritative_rollback_values() -> None:
    """Expose the accepted total and funded floor through the production error envelope."""
    error = budget_http_error(
        BudgetTotalConflictError(
            "rejected",
            current_total_credits=30,
            minimum_total_credits=12,
        )
    )
    assert error.status_code == 409
    assert error.code == "budget.conflict"
    assert error.params == {"current_total_credits": 30, "minimum_total_credits": 12}


def test_budget_api_hides_another_accounts_budget(client: TestClient) -> None:
    """Require ownership on restoration and mutations, not just a valid UUID."""
    created = client.post("/execution-budgets", json={"total_credits": 20}, headers={"Idempotency-Key": "draft"}).json()
    client.app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser("bob", "user", ())
    assert client.get(f"/execution-budgets/{created['id']}").status_code == 404
    assert (
        client.patch(
            f"/execution-budgets/{created['id']}", json={"total_credits": 30, "expected_revision": 1}
        ).status_code
        == 404
    )


def test_budget_api_requires_idempotency_and_does_not_promise_wallet_funding(client: TestClient) -> None:
    """Validate the chosen total while showing actual account funding separately."""
    assert client.post("/execution-budgets", json={"total_credits": 20}).status_code == 422
    assert (
        client.post(
            "/execution-budgets", json={"total_credits": 1.5}, headers={"Idempotency-Key": "fractional"}
        ).status_code
        == 422
    )
    large = client.post("/execution-budgets", json={"total_credits": 100}, headers={"Idempotency-Key": "larger-limit"})
    assert large.status_code == 200
    assert large.json()["account_available_credits"] == 50
    assert large.json()["total_credits"] == 100
