"""Verify durable budget admission and reconciliation without paid provider calls."""

from __future__ import annotations

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from pathlib import Path
from threading import Barrier
from typing import Any

import pytest
from sqlalchemy import Engine, create_engine, func, select
from sqlalchemy.orm import Session

from core.billing.budget_amounts import credit_units
from core.billing.budgets import (
    BudgetBoundExceededError,
    BudgetConflictError,
    BudgetFencedError,
    BudgetFundingLostError,
    BudgetInFlightError,
    BudgetInsufficientError,
    BudgetNotFoundError,
    BudgetService,
    BudgetTotalConflictError,
    BudgetUnreconciledError,
)
from core.billing.operation_pricing import CreditCharge, OperationQuote
from core.billing.pricing import ModelUsage
from core.billing.runtime import BudgetRuntime
from core.billing.service import StripeBillingService, committed_spend_credits, legacy_job_committed_credits
from core.storage.models import (
    Base,
    BillingCustomerModel,
    CreditLedgerModel,
    ExecutionOperationModel,
    ExecutionUsageEvidenceModel,
    JobModel,
)


@pytest.fixture
def engine(tmp_path: Path) -> Iterator[Engine]:
    """Create a private transactional wallet database for each test."""
    database = create_engine(f"sqlite:///{tmp_path / 'budgets.db'}", connect_args={"timeout": 10})
    Base.metadata.create_all(database)
    with Session(database) as session:
        session.add_all(
            [
                BillingCustomerModel(
                    username=name, stripe_customer_id=f"local-{name}", credit_balance=50, grant_remaining=0
                )
                for name in ("alice", "bob")
            ]
        )
        session.commit()
    yield database
    database.dispose()


def _reserve(service: BudgetService, budget_id: str, key: str = "call", **kwargs: Any) -> Any:
    """Reserve a fully specified deterministic model request."""
    values = {
        "operation_key": key,
        "generation": 0,
        "phase": "setup",
        "cost_kind": "model",
        "request_fingerprint": "resolved-request",
        "price_snapshot": {"version": "fixture-v1"},
        "max_credits": 10,
    }
    values.update(kwargs)
    return service.reserve(budget_id, "alice", **values)


def _balance(engine: Engine) -> int:
    """Read actual debited wallet balance independently of outstanding holds."""
    with Session(engine) as session:
        return session.get(BillingCustomerModel, "alice").credit_balance


@pytest.mark.parametrize("reason", ["user_cancelled", "user_paused", "budget_reached"])
@pytest.mark.parametrize("phase", ["setup", "run"])
def test_closed_admission_prevents_reserved_dispatch_but_accepts_existing_receipts(
    engine: Engine, reason: str, phase: str
) -> None:
    """Reject an unstarted paid request after stop while reconciling already dispatched usage.

    Args:
        engine: Private funded ledger database.
        reason: Terminal or paused admission stop recorded after reservation.
        phase: Setup or attached execution whose admission is stopped.
    """
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="stop-race")
    if phase == "run":
        service.attach_to_job(budget.id, "alice", "job", expected_revision=budget.revision)
    waiting = _reserve(service, budget.id, "waiting", phase=phase, max_credits=5)
    running = _reserve(service, budget.id, "running", phase=phase, max_credits=5)
    service.mark_dispatched(running.id, "alice")
    service.stop_admission(budget.id, "alice", reason=reason)
    with pytest.raises(BudgetConflictError, match="not admitting"):
        service.mark_dispatched(waiting.id, "alice", "must-not-start")
    assert service.get_operation(waiting.id, "alice").state == "reserved"
    assert service.get_operation(waiting.id, "alice").provider_request_id is None
    late = service.mark_dispatched(running.id, "alice", "already-dispatched")
    assert late.dispatch_claimed is False
    assert late.provider_request_id == "already-dispatched"
    service.settle(running.id, "alice", evidence_key="final", actual_credits=2, evidence={"actual": True})
    assert service.get_operation(running.id, "alice").state == "settled"
    assert service.get(budget.id, "alice").reserved_credits == 5


def test_legacy_commitments_protect_wallet_from_new_reservations(engine: Engine) -> None:
    """Keep active legacy ceilings covered when modern setup reserves the same wallet.

    Args:
        engine: Private funded ledger database.
    """
    service = BudgetService(engine=engine)
    budget = service.create("alice", 50, idempotency_key="draft")
    with Session(engine) as session:
        session.add(
            JobModel(
                optimization_id="legacy",
                username="alice",
                status="running",
                payload_overview={"max_cost_credits": 30, "token_source": "managed"},
            )
        )
        session.commit()
    assert StripeBillingService(engine=engine).spendable_credits("alice") == 20
    assert service.get(budget.id, "alice").account_available_credits == 20
    with pytest.raises(BudgetInFlightError):
        _reserve(service, budget.id, max_credits=21)
    _reserve(service, budget.id, max_credits=20)
    assert StripeBillingService(engine=engine).spendable_credits("alice") == 0


def test_legacy_debit_consumes_its_own_commitment_only(engine: Engine) -> None:
    """Protect other legacy jobs and modern holds while the original legacy run settles.

    Args:
        engine: Private funded ledger database.
    """
    service = BudgetService(engine=engine)
    budget = service.create("alice", 50, idempotency_key="draft")
    _reserve(service, budget.id, max_credits=20)
    with Session(engine) as session:
        session.add_all(
            [
                JobModel(
                    optimization_id=identity,
                    username="alice",
                    status="running",
                    payload_overview={"max_cost_credits": ceiling},
                )
                for identity, ceiling in [("finishing", 20), ("other", 10)]
            ]
        )
        session.commit()
    billing = StripeBillingService(engine=engine)
    usage = [ModelUsage(model="unpriced-fixture", input_tokens=1_000_000, output_tokens=0)]
    assert billing.debit_run("alice", usage, model=None, description="interactive") == 0
    assert billing.debit_run("alice", usage, model=None, description="legacy", optimization_id="finishing") == 20
    assert _balance(engine) == 30
    assert service.get(budget.id, "alice").reserved_credits == 20


def test_only_verified_budget_attachments_avoid_legacy_double_count(engine: Engine) -> None:
    """Exclude an actual matching root attachment and retain spoofed metadata commitments.

    Args:
        engine: Private funded ledger database.
    """
    service = BudgetService(engine=engine)
    budget = service.create("alice", 50, idempotency_key="root")
    service.attach_to_job(budget.id, "alice", "protected", expected_revision=1)
    with Session(engine) as session:
        session.add_all(
            [
                JobModel(
                    optimization_id="protected",
                    username="alice",
                    status="running",
                    execution_budget_id=budget.id,
                    execution_budget_generation=0,
                    payload_overview={"max_cost_credits": 50},
                ),
                JobModel(
                    optimization_id="spoofed",
                    username="alice",
                    status="pending",
                    execution_budget_id=budget.id,
                    execution_budget_generation=0,
                    payload_overview={"max_cost_credits": 7},
                ),
            ]
        )
        session.commit()
        assert legacy_job_committed_credits(session, "alice") == 7
    _reserve(service, budget.id, phase="run", max_credits=10)
    assert StripeBillingService(engine=engine).spendable_credits("alice") == 33
    with Session(engine) as session:
        session.get(JobModel, "protected").execution_budget_generation = 99
        session.commit()
        assert legacy_job_committed_credits(session, "alice") == 57


def test_legacy_commitments_count_active_roots_and_byok_fee_only(engine: Engine) -> None:
    """Ignore terminal jobs, child duplicates, and other owners while retaining paused promises.

    Args:
        engine: Private funded ledger database.
    """
    with Session(engine) as session:
        session.add_all(
            [
                JobModel(
                    optimization_id=status, username="alice", status=status, payload_overview={"max_cost_credits": 5}
                )
                for status in (
                    "pending",
                    "validating",
                    "running",
                    "paused",
                    "completed",
                    "failed",
                    "cancelled",
                    "budget_reached",
                )
            ]
        )
        session.add_all(
            [
                JobModel(
                    optimization_id="byok",
                    username="alice",
                    status="running",
                    payload_overview={"max_cost_credits": 100, "token_source": "byok"},
                ),
                JobModel(
                    optimization_id="child",
                    username="alice",
                    parent_optimization_id="running",
                    status="running",
                    payload_overview={"max_cost_credits": 500},
                ),
                JobModel(
                    optimization_id="foreign",
                    username="bob",
                    status="running",
                    payload_overview={"max_cost_credits": 500},
                ),
            ]
        )
        session.commit()
        assert legacy_job_committed_credits(session, "alice") == 20 + committed_spend_credits(100, "byok")


def test_budget_creation_revision_and_owner(engine: Engine) -> None:
    """Keep creation retries stable and reject stale edits or another owner."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    assert service.create("alice", 20, idempotency_key="draft").id == budget.id
    assert service.find_by_creation_key("alice", "draft") == budget
    assert service.find_by_creation_key("alice", "missing") is None
    assert service.find_by_creation_key("bob", "draft") is None
    with pytest.raises(BudgetConflictError):
        service.create("alice", 21, idempotency_key="draft")
    with pytest.raises(BudgetNotFoundError):
        service.get(budget.id, "bob")
    _reserve(service, budget.id, max_credits=12)
    with pytest.raises(BudgetTotalConflictError, match=r"minimum.*12") as rejected:
        service.update_total(budget.id, "alice", 11, expected_revision=1)
    assert rejected.value.current_total_credits == 20
    assert rejected.value.minimum_total_credits == 12
    changed = service.update_total(budget.id, "alice", 30, expected_revision=1)
    assert changed.revision == 2
    with pytest.raises(BudgetTotalConflictError) as stale:
        service.update_total(budget.id, "alice", 40, expected_revision=1)
    assert stale.value.current_total_credits == 30
    assert stale.value.minimum_total_credits == 12
    assert service.get(budget.id, "alice").total_credits == 30


def test_attachment_is_once_and_can_join_submission_transaction(engine: Engine) -> None:
    """Bind a single root job and roll attachment back with a failed submission."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    with Session(engine) as transaction:
        service.attach_to_job(budget.id, "alice", "job-first", expected_revision=1, session=transaction)
        transaction.rollback()
    assert service.get(budget.id, "alice").job_id is None
    attached = service.attach_to_job(budget.id, "alice", "job-first", expected_revision=1)
    assert attached.job_id == "job-first"
    assert service.attach_to_job(budget.id, "alice", "job-first", expected_revision=1) == attached
    with pytest.raises(BudgetConflictError):
        service.attach_to_job(budget.id, "alice", "job-second", expected_revision=attached.revision)


def test_submission_consumes_setup_authority_after_pending_tests_finish(engine: Engine) -> None:
    """Prevent stale draft tabs from admitting setup costs after successful submission."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    operation = _reserve(service, budget.id)
    with pytest.raises(BudgetInFlightError):
        service.attach_to_job(budget.id, "alice", "job", expected_revision=1)
    service.release(operation.id, "alice")
    service.attach_to_job(budget.id, "alice", "job", expected_revision=1)
    with pytest.raises(BudgetConflictError):
        _reserve(service, budget.id, "stale-tab")
    assert _reserve(service, budget.id, "run", phase="run").state == "reserved"


def test_partial_failure_and_replay_settle_once(engine: Engine) -> None:
    """Keep partial failure usage charged and unknown remaining usage covered."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    operation = _reserve(service, budget.id)
    assert service.mark_dispatched(operation.id, "alice", "provider-1").dispatch_claimed
    assert not service.mark_dispatched(operation.id, "alice", "provider-1").dispatch_claimed
    partial = service.settle(
        operation.id,
        "alice",
        evidence_key="partial",
        actual_credits="2.2",
        evidence={"model": "fixture", "failed": True},
        final=False,
    )
    assert partial.state == "pending"
    assert partial.budget.setup_spent_credits == Decimal("2.2")
    assert partial.budget.reserved_credits == Decimal("7.8")
    assert partial.budget.available_credits == 10
    assert partial.budget.billed_credits == 3
    assert partial.budget.wallet_reserved_credits == 7
    with pytest.raises(BudgetUnreconciledError):
        service.release(operation.id, "alice")
    complete = service.settle(
        operation.id, "alice", evidence_key="final", actual_credits="3.1", evidence={"failed": True, "reconciled": True}
    )
    assert complete.state == "settled"
    assert complete.budget.reserved_credits == 0
    assert complete.budget.available_credits == Decimal("16.9")
    assert complete.budget.billed_credits == 4
    assert (
        service.settle(
            operation.id,
            "alice",
            evidence_key="final",
            actual_credits="3.1",
            evidence={"failed": True, "reconciled": True},
        )
        == complete
    )
    assert _balance(engine) == 46
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(CreditLedgerModel)) == 2
        assert session.scalar(select(func.count()).select_from(ExecutionUsageEvidenceModel)) == 2


def test_aggregate_rounding_and_phase_cost_dimensions(engine: Engine) -> None:
    """Avoid a one-credit minimum for every subcall and retain phase/type attribution."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 10, idempotency_key="draft")
    for key, phase, kind, actual in [
        ("setup-model", "setup", "model", "0.1"),
        ("run-model", "run", "model", "0.2"),
        ("runtime", "run", "sandbox", "0.7"),
    ]:
        if key == "run-model":
            service.attach_to_job(budget.id, "alice", "job", expected_revision=1)
        operation = _reserve(service, budget.id, key, phase=phase, cost_kind=kind, max_credits=1)
        service.mark_dispatched(operation.id, "alice")
        service.settle(operation.id, "alice", evidence_key=key, actual_credits=actual, evidence={"cost_kind": kind})
    snapshot = service.get(budget.id, "alice")
    assert snapshot.setup_spent_credits == Decimal("0.1")
    assert snapshot.run_spent_credits == Decimal("0.9")
    assert snapshot.billed_credits == 1
    assert _balance(engine) == 49


def test_byok_scope_reserves_and_settles_platform_fee_only(engine: Engine) -> None:
    """Keep provider-paid token cost outside both Total and the Skynet wallet."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 100, idempotency_key="draft")
    operation = _reserve(service, budget.id, max_credits=8, max_wallet_credits=8)
    assert operation.budget.reserved_credits == 8
    assert operation.budget.wallet_reserved_credits == 8
    service.mark_dispatched(operation.id, "alice")
    result = service.settle(
        operation.id,
        "alice",
        evidence_key="provider",
        actual_credits=3,
        actual_wallet_credits=3,
        evidence={"source": "byok", "provider_cost_credits": 27},
    )
    assert result.budget.external_spent_credits == 0
    assert result.budget.billed_credits == 3
    assert result.budget.available_credits == 97
    assert _balance(engine) == 47


def test_contention_differs_from_exhaustion(engine: Engine) -> None:
    """Report reversible in-flight contention separately from insufficient coverage."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    first = _reserve(service, budget.id, "first", max_credits=15)
    with pytest.raises(BudgetInFlightError):
        _reserve(service, budget.id, "second", max_credits=10)
    with pytest.raises(BudgetInsufficientError):
        _reserve(service, budget.id, "oversize", max_credits=21)
    service.release(first.id, "alice")
    assert _reserve(service, budget.id, "second", max_credits=10).state == "reserved"


def test_wallet_holds_span_budgets_and_protect_against_legacy_debits(engine: Engine) -> None:
    """Keep covered funding unavailable to other drafts and older interactive surfaces."""
    service = BudgetService(engine=engine)
    first = service.create("alice", 100, idempotency_key="first")
    second = service.create("alice", 100, idempotency_key="second")
    _reserve(service, first.id, max_credits=45)
    with pytest.raises(BudgetInFlightError):
        _reserve(service, second.id, max_credits=10)
    billing = StripeBillingService(engine=engine)
    assert billing.spendable_credits("alice") == 5
    billed = billing.debit_run(
        "alice", [ModelUsage("unpriced-fixture", 1_000_000, 0)], model="unpriced-fixture", description="legacy surface"
    )
    assert billed == 5
    assert _balance(engine) == 45
    assert service.get(first.id, "alice").wallet_reserved_credits == 45


def test_fencing_releases_only_undispatched_work(engine: Engine) -> None:
    """Fence old dispatch and wait for unresolved prior-generation costs before recovery."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 30, idempotency_key="draft")
    not_started = _reserve(service, budget.id, "not-started")
    dispatched = _reserve(service, budget.id, "started")
    service.mark_dispatched(dispatched.id, "alice")
    fenced = service.fence_generation(budget.id, "alice", expected_generation=0)
    assert fenced.generation == 1
    assert fenced.reserved_credits == 10
    assert service.get_operation(not_started.id, "alice").state == "released"
    with pytest.raises(BudgetFencedError):
        service.mark_dispatched(not_started.id, "alice")
    with pytest.raises(BudgetFencedError):
        _reserve(service, budget.id, "old-worker")
    with pytest.raises(BudgetUnreconciledError):
        _reserve(service, budget.id, "new-worker", generation=1)
    late = service.mark_dispatched(dispatched.id, "alice", provider_request_id="provider-late")
    assert late.provider_request_id == "provider-late"
    assert late.dispatch_claimed is False
    service.settle(
        dispatched.id, "alice", evidence_key="late-provider", actual_credits=2, evidence={"reconciled": True}
    )
    assert _reserve(service, budget.id, "new-worker", generation=1).generation == 1


def test_evidence_conflicts_do_not_mutate_original_charge(engine: Engine) -> None:
    """Reject changed payloads under the same immutable usage event identity."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    operation = _reserve(service, budget.id)
    service.mark_dispatched(operation.id, "alice")
    service.settle(operation.id, "alice", evidence_key="usage", actual_credits=2, evidence={"cache_read": 10})
    with pytest.raises(BudgetConflictError):
        service.settle(operation.id, "alice", evidence_key="usage", actual_credits=4, evidence={"cache_read": 0})
    assert _balance(engine) == 48
    with Session(engine) as session:
        event = session.scalar(select(ExecutionUsageEvidenceModel))
        assert event.evidence == {"cache_read": 10}


def test_pending_evidence_is_immutable_without_inventing_a_charge(engine: Engine) -> None:
    """Preserve an incomplete receipt durably without claiming zero actual usage."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    operation = _reserve(service, budget.id)
    service.mark_dispatched(operation.id, "alice")
    for _ in range(2):
        service.mark_pending(operation.id, "alice", evidence_key="receipt", evidence={"cpu_ms": 100, "network": None})
    with pytest.raises(BudgetConflictError, match="immutable"):
        service.mark_pending(operation.id, "alice", evidence_key="receipt", evidence={"cpu_ms": 200})
    with Session(engine) as session:
        events = list(session.scalars(select(ExecutionUsageEvidenceModel)))
        assert len(events) == 1
        assert events[0].issue == "usage_pending"
        assert events[0].evidence == {"cpu_ms": 100, "network": None}
        assert events[0].billed_credits == 0
    assert service.get(budget.id, "alice").reserved_credits == 10
    assert _balance(engine) == 50


def test_explicit_resume_requires_reconciliation_and_is_not_triggered_by_funding(engine: Engine) -> None:
    """Keep stopped envelopes closed through top-ups until the lifecycle coordinator resumes."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    attached = service.attach_to_job(budget.id, "alice", "job-one", expected_revision=1)
    operation = _reserve(service, budget.id, phase="run")
    service.mark_dispatched(operation.id, "alice")
    service.stop_admission(budget.id, "alice", reason="paused")
    changed = service.update_total(budget.id, "alice", 30, expected_revision=attached.revision)
    assert changed.state == "closed"
    with pytest.raises(BudgetUnreconciledError):
        service.resume_admission(budget.id, "alice", expected_generation=0)
    service.settle(operation.id, "alice", evidence_key="receipt", actual_credits=2, evidence={"measured": True})
    with pytest.raises(BudgetFencedError):
        service.resume_admission(budget.id, "alice", expected_generation=1)
    assert service.resume_admission(budget.id, "alice", expected_generation=0).state == "attached"


def test_overrun_retains_evidence_and_coverage_without_unbounded_debit(engine: Engine) -> None:
    """Quarantine reported usage above a verified bound instead of charging beyond it."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    operation = _reserve(service, budget.id, max_credits=5)
    admitted = _reserve(service, budget.id, "already-admitted", max_credits=2)
    service.mark_dispatched(operation.id, "alice")
    with pytest.raises(BudgetBoundExceededError):
        service.settle(
            operation.id, "alice", evidence_key="overrun", actual_credits=6, evidence={"provider_request": "x"}
        )
    snapshot = service.get(budget.id, "alice")
    assert snapshot.state == "blocked"
    assert snapshot.reserved_credits == 7
    assert _balance(engine) == 50
    with Session(engine) as session:
        event = session.scalar(select(ExecutionUsageEvidenceModel))
        assert event.actual_units == credit_units(6)
        assert event.issue == "bound_exceeded"
    with pytest.raises(BudgetConflictError):
        _reserve(service, budget.id, "next")
    with pytest.raises(BudgetConflictError, match="quarantined"):
        service.mark_dispatched(admitted.id, "alice")
    assert service.stop_admission(budget.id, "alice", reason="paused").state == "blocked"
    with pytest.raises(BudgetConflictError):
        service.resume_admission(budget.id, "alice", expected_generation=0)


def test_removed_funding_keeps_usage_pending(engine: Engine) -> None:
    """Retain reconciliation evidence if an external wallet adjustment removes funding."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    operation = _reserve(service, budget.id, max_credits=5)
    service.mark_dispatched(operation.id, "alice")
    with Session(engine) as session:
        session.get(BillingCustomerModel, "alice").credit_balance = 0
        session.commit()
    with pytest.raises(BudgetFundingLostError):
        service.settle(operation.id, "alice", evidence_key="usage", actual_credits=3, evidence={"measured": True})
    assert service.get(budget.id, "alice").reserved_credits == 5


def test_no_charge_or_release_for_work_without_dispatch(engine: Engine) -> None:
    """Release unstarted reservations without manufacturing usage or a charge."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    operation = _reserve(service, budget.id)
    with pytest.raises(BudgetConflictError):
        service.settle(operation.id, "alice", evidence_key="invalid", actual_credits=1, evidence={})
    assert service.release(operation.id, "alice").state == "released"
    assert service.release(operation.id, "alice").state == "released"
    assert _balance(engine) == 50
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(ExecutionUsageEvidenceModel)) == 0


def test_attempt_identity_binds_configuration_and_retry_number(engine: Engine) -> None:
    """Reserve each paid retry separately while identical HTTP delivery reuses its hold."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 30, idempotency_key="draft")
    first = _reserve(service, budget.id)
    assert _reserve(service, budget.id).id == first.id
    with pytest.raises(BudgetConflictError):
        _reserve(service, budget.id, request_fingerprint="different")
    second = _reserve(service, budget.id, attempt=1)
    assert second.id != first.id
    assert second.budget.reserved_credits == 20


def test_recovery_headroom_transfers_without_duplicate_reservation(engine: Engine) -> None:
    """Move one aggregate recovery hold into physical work without covering it twice."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 10, idempotency_key="recovery-transfer")
    service.attach_to_job(budget.id, "alice", "recovery-job", expected_revision=budget.revision)
    headroom = _reserve(
        service,
        budget.id,
        "recovery-headroom",
        phase="run",
        cost_kind="recovery_headroom",
        role="recovery",
        max_credits=3,
        max_wallet_credits=3,
    )
    seed = _reserve(
        service,
        budget.id,
        "replayed-seed",
        phase="run",
        max_credits=1,
        max_wallet_credits=1,
        headroom_operation_id=headroom.id,
    )
    duplicate = _reserve(
        service,
        budget.id,
        "replayed-seed",
        phase="run",
        max_credits=1,
        max_wallet_credits=1,
        headroom_operation_id=headroom.id,
    )
    assert duplicate.id == seed.id
    assert duplicate.budget.reserved_credits == 3
    service.mark_dispatched(seed.id, "alice")
    service.settle(
        seed.id,
        "alice",
        evidence_key="seed-usage",
        actual_credits=Decimal("0.4"),
        evidence={"provider": "fixture"},
    )
    trimmed = service.trim_recovery_headroom(
        headroom.id,
        "alice",
        max_credits=1,
        max_wallet_credits=1,
    )
    assert trimmed.budget.reserved_credits == 1
    execution = _reserve(
        service,
        budget.id,
        "resumed-operation",
        phase="run",
        max_credits=1,
        max_wallet_credits=1,
        headroom_operation_id=headroom.id,
    )
    assert execution.budget.reserved_credits == 1
    assert service.get_operation(headroom.id, "alice").state == "released"
    service.mark_dispatched(execution.id, "alice")
    final = service.settle(
        execution.id,
        "alice",
        evidence_key="execution-usage",
        actual_credits=Decimal("0.5"),
        evidence={"provider": "fixture"},
    )
    assert final.budget.reserved_credits == 0
    assert final.budget.run_spent_credits == Decimal("0.9")


def test_only_claimed_concurrent_model_attempt_consumes_recovery_headroom(engine: Engine) -> None:
    """Prevent a later concurrent model call from stealing the first-operation hold."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 10, idempotency_key="recovery-concurrent")
    service.attach_to_job(budget.id, "alice", "recovery-job", expected_revision=budget.revision)
    headroom = _reserve(
        service,
        budget.id,
        "recovery-headroom",
        phase="run",
        cost_kind="recovery_headroom",
        role="recovery",
        max_credits=1,
        max_wallet_credits=1,
    )
    runtime = BudgetRuntime(
        service,
        username="alice",
        budget_id=budget.id,
        generation=0,
        phase="run",
        wait_timeout=0,
        recovery_headroom_operation_id=headroom.id,
        recovery_execution_headroom=(Decimal(1), Decimal(1)),
    )
    runtime.finish_recovery_seed()
    quote = OperationQuote(
        request_fingerprint="bounded-model-call",
        maximum=CreditCharge(total=Decimal(1), wallet=Decimal(1)),
        price_snapshot={"version": "fixture-v1"},
    )
    barrier = Barrier(2)

    def reserve(key: str, claimed: bool) -> Any:
        """Race one claimed and one ordinary physical operation."""
        barrier.wait()
        return runtime.reserve(
            quote,
            operation_key=key,
            cost_kind="model",
            role="task",
            recovery_headroom=claimed,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        operations = list(pool.map(lambda item: reserve(*item), [("claimed", True), ("later", False)]))

    assert len({operation.id for operation in operations}) == 2
    assert service.get(budget.id, "alice").reserved_credits == 2
    assert service.get_operation(headroom.id, "alice").state == "released"
    with Session(engine) as session:
        stored = session.scalars(
            select(ExecutionOperationModel).where(ExecutionOperationModel.cost_kind == "model")
        ).all()
    assert {operation.operation_key for operation in stored} == {"claimed", "later"}


def test_concurrent_wallet_reservations_cannot_overcommit(engine: Engine) -> None:
    """Serialize separate budget admissions against the same prepaid account."""
    service = BudgetService(engine=engine)
    budgets = [service.create("alice", 100, idempotency_key=key).id for key in ("one", "two")]
    barrier = Barrier(2)

    def reserve(budget_id: str) -> str:
        """Race independent requests after both threads have reached admission."""
        barrier.wait(timeout=5)
        try:
            return _reserve(service, budget_id, max_credits=40).state
        except BudgetInFlightError:
            return "contended"

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(reserve, budgets))
    assert sorted(outcomes) == ["contended", "reserved"]
    assert StripeBillingService(engine=engine).spendable_credits("alice") == 10


def test_concurrent_duplicate_dispatch_has_one_sender(engine: Engine) -> None:
    """Give only one competing delivery the authority to send a physical request."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    operation = _reserve(service, budget.id)
    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(
            executor.map(lambda _: service.mark_dispatched(operation.id, "alice").dispatch_claimed, range(2))
        )
    assert sorted(outcomes) == [False, True]
    assert service.get(budget.id, "alice").reserved_credits == 10


@pytest.mark.parametrize("amount", ["NaN", "Infinity", "-1", "0.0000000001"])
def test_amounts_reject_unrepresentable_values(amount: str) -> None:
    """Reject unknown or silently rounded charges at the accounting boundary."""
    with pytest.raises(ValueError):
        credit_units(amount)


def test_uncapped_budget_admits_past_its_total_until_the_account_runs_dry(engine: Engine) -> None:
    """Skip the total checks for an uncapped budget while the wallet still gates admission."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 5, idempotency_key="draft", uncapped=True)
    assert budget.uncapped is True
    assert budget.available_credits == 50
    with pytest.raises(BudgetConflictError):
        service.create("alice", 5, idempotency_key="draft")
    _reserve(service, budget.id, key="first", max_credits=30)
    _reserve(service, budget.id, key="second", max_credits=15)
    assert service.get(budget.id, "alice").available_credits == 5
    with pytest.raises(BudgetInsufficientError, match="cannot fund"):
        _reserve(service, budget.id, key="third", max_credits=60)


def test_uncapped_flag_is_versioned_like_the_total(engine: Engine) -> None:
    """Bump the revision when only the mode changes and keep replays on the original fingerprint."""
    service = BudgetService(engine=engine)
    budget = service.create("alice", 20, idempotency_key="draft")
    assert budget.uncapped is False
    assert service.create("alice", 20, idempotency_key="draft").id == budget.id
    with pytest.raises(BudgetConflictError):
        service.create("alice", 20, idempotency_key="draft", uncapped=True)
    lifted = service.update_total(budget.id, "alice", 20, expected_revision=1, uncapped=True)
    assert lifted.uncapped is True
    assert lifted.revision == 2
    assert lifted.available_credits == 50
    _reserve(service, budget.id, max_credits=30)
    with pytest.raises(BudgetTotalConflictError):
        service.update_total(budget.id, "alice", 20, expected_revision=2)
    capped = service.update_total(budget.id, "alice", 30, expected_revision=2)
    assert capped.uncapped is False
    assert capped.revision == 3
    assert capped.available_credits == 0
