"""Verify interrupted Vercel billing recovers exact receipts without new paid work."""

from __future__ import annotations

import threading
from collections.abc import Iterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from core.billing import vercel_usage
from core.billing.budgets import BudgetNotFoundError, BudgetService, OperationSnapshot
from core.billing.operation_pricing import ChargePolicy
from core.billing.runtime import UsagePendingError
from core.billing.vercel_reconciliation import VercelSessionUsageClient, VercelUsageReconciler
from core.billing.vercel_usage import quote_vercel_sandbox, vercel_actual_usd
from core.storage.models import Base, BillingCustomerModel

from .test_vercel_usage import CREATE, RECEIPT


@pytest.fixture
def ledger(tmp_path: Path) -> Iterator[BudgetService]:
    """Create a private funded wallet for reconciliation-only tests.

    Args:
        tmp_path: Test-owned directory.

    Yields:
        Ledger with no real provider or Stripe connection.
    """
    engine = create_engine(f"sqlite:///{tmp_path / 'reconciliation.db'}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(username="alice", stripe_customer_id="fixture", credit_balance=100, grant_remaining=0)
        )
        session.commit()
    yield BudgetService(engine=engine)
    engine.dispose()


def _admit(ledger: BudgetService, *, key: str = "draft", session_id: str | None = "session-one") -> OperationSnapshot:
    """Leave a realistically quoted sandbox attempt awaiting its final usage.

    Args:
        ledger: Test ledger.
        key: Distinct budget creation identity.
        session_id: Provider identity, absent when creation's response was lost.

    Returns:
        Dispatched covered attempt.
    """
    budget = ledger.create("alice", 20, idempotency_key=key)
    quote = quote_vercel_sandbox(CREATE)
    operation = ledger.reserve(
        budget.id,
        "alice",
        operation_key="sandbox",
        generation=0,
        phase="setup",
        cost_kind="sandbox",
        request_fingerprint=quote.request_fingerprint,
        price_snapshot=quote.price_snapshot,
        max_credits=quote.maximum.total,
    )
    return ledger.mark_dispatched(operation.id, "alice", session_id)


def _unavailable(session_id: str) -> Mapping[str, Any]:
    """Fail if a recovery path unexpectedly contacts an already-destroyed provider resource.

    Args:
        session_id: Unexpected provider identity.

    Raises:
        AssertionError: Always, since durable receipts should suffice.
    """
    raise AssertionError(f"Unexpected provider request for {session_id}")


def test_durable_receipt_settles_after_fencing_at_original_prices(
    ledger: BudgetService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Recover once from saved evidence even after provider destruction and price changes.

    Args:
        ledger: Private ledger fixture.
        monkeypatch: Test-only current price override.
    """
    operation = _admit(ledger)
    ledger.mark_pending(
        operation.id, "alice", evidence_key="saved-stop", evidence={"sessions": {"session-one": RECEIPT}}
    )
    ledger.fence_generation(operation.budget_id, "alice", expected_generation=0)
    expected = ChargePolicy("sandbox").convert(vercel_actual_usd(RECEIPT, session_id="session-one", vcpus=2)).total
    monkeypatch.setattr(vercel_usage, "_REGIONAL_RATES", {"iad1": (Decimal(9), Decimal(9))})
    monkeypatch.setattr(vercel_usage, "_SANDBOX_POLICY", ChargePolicy("sandbox", credit_usd=Decimal(9)))
    reconcile = VercelUsageReconciler(ledger, _unavailable)
    first = reconcile.reconcile(operation.id, "alice")
    replay = reconcile.reconcile(operation.id, "alice")
    assert first == replay
    assert first.state == "settled"
    assert first.actual_credits == expected
    assert first.budget.reserved_credits == 0
    assert first.budget.billed_credits == 1


def test_missing_final_metrics_can_arrive_after_stop(ledger: BudgetService) -> None:
    """Refresh incomplete durable stop evidence instead of retaining it forever.

    Args:
        ledger: Private ledger fixture.
    """
    operation = _admit(ledger)
    incomplete = {**RECEIPT, "activeCpuDurationMs": None}
    ledger.mark_pending(
        operation.id, "alice", evidence_key="incomplete", evidence={"sessions": {"session-one": incomplete}}
    )
    identities = []

    def fetch(session_id: str) -> Mapping[str, Any]:
        """Return final provider evidence for the same admitted session.

        Args:
            session_id: Captured identity.

        Returns:
            Complete stopped-session receipt.
        """
        identities.append(session_id)
        return RECEIPT

    assert VercelUsageReconciler(ledger, fetch).reconcile(operation.id, "alice").state == "settled"
    assert identities == ["session-one"]


@pytest.mark.parametrize(
    "receipt", [{**RECEIPT, "networkTransfer": {"ingress": 3, "egress": 0}}, {**RECEIPT, "status": "running"}]
)
def test_uncertain_usage_retains_full_coverage(ledger: BudgetService, receipt: dict[str, Any]) -> None:
    """Never turn raw transfer or unfinished runtime into guessed charges or released holds.

    Args:
        ledger: Private ledger fixture.
        receipt: Provider usage that cannot establish a final charge.
    """
    operation = _admit(ledger)
    with pytest.raises(UsagePendingError):
        VercelUsageReconciler(ledger, lambda session_id: receipt).reconcile(operation.id, "alice")
    current = ledger.get_operation(operation.id, "alice")
    assert current.state == "pending"
    assert current.actual_credits == 0
    assert current.budget.reserved_credits == operation.max_credits
    assert current.budget.billed_credits == 0
    assert ledger.get_reconciliation(operation.id, "alice").evidence


def test_missing_identity_and_wrong_owner_never_issue_provider_calls(ledger: BudgetService) -> None:
    """Keep lost creation identities covered and do not expose another owner's receipts.

    Args:
        ledger: Private ledger fixture.
    """
    operation = _admit(ledger, session_id=None)
    reconcile = VercelUsageReconciler(ledger, _unavailable)
    with pytest.raises(BudgetNotFoundError):
        reconcile.reconcile(operation.id, "bob")
    with pytest.raises(UsagePendingError, match="exact session identity"):
        reconcile.reconcile(operation.id, "alice")
    assert ledger.get(operation.budget_id, "alice").reserved_credits == operation.max_credits


def test_concurrent_reconciliation_settles_once(ledger: BudgetService) -> None:
    """Allow concurrent sweepers without duplicate wallet charges.

    Args:
        ledger: Private ledger fixture.
    """
    operation = _admit(ledger)
    barrier = threading.Barrier(2)

    def fetch(session_id: str) -> Mapping[str, Any]:
        """Make both reconcilers observe pending state before returning the same receipt.

        Args:
            session_id: Admitted identity.

        Returns:
            Final stopped receipt.
        """
        assert session_id == "session-one"
        barrier.wait(timeout=5)
        return RECEIPT

    reconcile = VercelUsageReconciler(ledger, fetch)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(reconcile.reconcile, operation.id, "alice") for _ in range(2)]
        assert all(future.result().state == "settled" for future in futures)
    assert ledger.get(operation.budget_id, "alice").billed_credits == 1


def test_sweep_pages_past_unrecoverable_creation(ledger: BudgetService) -> None:
    """Advance a bounded sweep so an unresolved old operation cannot starve later ones.

    Args:
        ledger: Private ledger fixture.
    """
    lost = _admit(ledger, key="lost", session_id=None)
    final = _admit(ledger, key="final")
    reconcile = VercelUsageReconciler(ledger, lambda session_id: RECEIPT)
    cursor = None
    results = []
    for _ in range(3):
        page = reconcile.sweep(limit=1, after_id=cursor)
        results.extend(page.results)
        cursor = page.next_cursor
        if cursor is None:
            break
    assert {result.operation_id for result in results} == {lost.id, final.id}
    assert ledger.get_operation(final.id, "alice").state == "settled"
    assert ledger.get_operation(lost.id, "alice").state == "dispatched"


def test_provider_client_only_reads_exact_session_and_strips_secrets() -> None:
    """Use one authenticated metadata GET with no creation, resume, or retry path."""
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        """Return a raw provider receipt containing unrelated secret fields.

        Args:
            request: Captured authenticated metadata request.

        Returns:
            Raw provider response.
        """
        requests.append(request)
        return httpx.Response(200, json={"session": {**RECEIPT, "unrelated_secret": "never-persist"}})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        assert VercelSessionUsageClient("parent-token", "team", client=client)("session-one") == {
            key: value for key, value in RECEIPT.items() if key in vercel_usage._SESSION_FIELDS
        }
    [request] = requests
    assert request.method == "GET"
    assert request.url.path == "/api/v2/sandboxes/sessions/session-one"
    assert request.url.params["teamId"] == "team"
    assert request.headers["Authorization"] == "Bearer parent-token"
