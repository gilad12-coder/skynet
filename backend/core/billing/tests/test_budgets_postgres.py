"""Exercise actual PostgreSQL row locks against an explicitly supplied disposable database."""

from __future__ import annotations

import importlib.util
import os
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Barrier
from uuid import uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Engine, create_engine, func, select, text
from sqlalchemy.orm import Session

from core.billing.budgets import BudgetConflictError, BudgetInFlightError, BudgetService
from core.storage.models import (
    Base,
    BillingCustomerModel,
    BillingProviderKeyModel,
    CreditLedgerModel,
    ExecutionBudgetModel,
    ExecutionOperationModel,
    ExecutionUsageEvidenceModel,
    JobModel,
)
from core.storage.preflights import PreflightStore, WizardPreflightModel

TEST_DB_URL = os.environ.get("SKYNET_BUDGET_TEST_DB_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DB_URL or not TEST_DB_URL.startswith("postgresql"),
    reason="Set SKYNET_BUDGET_TEST_DB_URL to an explicitly disposable PostgreSQL database.",
)


@pytest.fixture
def database() -> Iterator[Engine]:
    """Isolate each race in its own schema without touching pre-existing data."""
    schema = f"budget_test_{uuid4().hex}"
    admin = create_engine(TEST_DB_URL)
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(TEST_DB_URL, connect_args={"options": f"-csearch_path={schema}"})
    tables = [
        model.__table__
        for model in (
            BillingCustomerModel,
            CreditLedgerModel,
            ExecutionBudgetModel,
            ExecutionOperationModel,
            ExecutionUsageEvidenceModel,
            JobModel,
        )
    ]
    try:
        Base.metadata.create_all(engine, tables=tables)
        with Session(engine) as session:
            session.add(
                BillingCustomerModel(
                    username="alice", stripe_customer_id="fixture", credit_balance=50, grant_remaining=0
                )
            )
            session.commit()
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def _reserve(service: BudgetService, budget_id: str, key: str, maximum: int = 40):
    """Reserve one fixture attempt through the production database transaction."""
    return service.reserve(
        budget_id,
        "alice",
        operation_key=key,
        generation=0,
        phase="setup",
        cost_kind="model",
        request_fingerprint="fixture",
        price_snapshot={"version": "fixture-v1"},
        max_credits=maximum,
    )


@pytest.mark.parametrize("shared_budget", [False, True])
def test_parallel_admission_cannot_overcommit(database: Engine, shared_budget: bool) -> None:
    """Enforce wallet-wide and budget-specific limits under real overlapping transactions."""
    service = BudgetService(engine=database)
    first = service.create("alice", 50, idempotency_key="first")
    second = first if shared_budget else service.create("alice", 50, idempotency_key="second")
    barrier = Barrier(2)

    def run(value: tuple[str, str]) -> str:
        """Begin both admissions together before either can claim account funding."""
        barrier.wait(timeout=5)
        try:
            return _reserve(service, value[0], value[1]).state
        except BudgetInFlightError:
            return "contended"

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(run, [(first.id, "one"), (second.id, "two")]))
    assert sorted(outcomes) == ["contended", "reserved"]
    with Session(database) as session:
        assert session.scalar(select(func.count()).select_from(ExecutionOperationModel)) == 1


def test_parallel_duplicate_attempt_has_one_physical_dispatch(database: Engine) -> None:
    """Deduplicate concurrent creation and grant physical dispatch to one caller."""
    service = BudgetService(engine=database)
    budget = service.create("alice", 50, idempotency_key="draft")
    barrier = Barrier(2)

    def run(_: int) -> tuple[str, bool]:
        """Race the same operation identity through reserve and dispatch."""
        barrier.wait(timeout=5)
        operation = _reserve(service, budget.id, "same")
        return operation.id, service.mark_dispatched(operation.id, "alice").dispatch_claimed

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(run, range(2)))
    assert len({operation_id for operation_id, _ in outcomes}) == 1
    assert sorted(claimed for _, claimed in outcomes) == [False, True]
    assert service.get(budget.id, "alice").reserved_credits == 40


def test_parallel_settlement_replay_debits_once(database: Engine) -> None:
    """Apply concurrent delivery of the same provider evidence exactly once."""
    service = BudgetService(engine=database)
    budget = service.create("alice", 50, idempotency_key="draft")
    operation = _reserve(service, budget.id, "call")
    service.mark_dispatched(operation.id, "alice")
    barrier = Barrier(2)

    def run(_: int) -> int:
        """Race two identical completion callbacks against one physical attempt."""
        barrier.wait(timeout=5)
        result = service.settle(
            operation.id, "alice", evidence_key="provider-event", actual_credits="1.2", evidence={"tokens": 42}
        )
        return result.budget.billed_credits

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert list(executor.map(run, range(2))) == [2, 2]
    with Session(database) as session:
        assert session.get(BillingCustomerModel, "alice").credit_balance == 48
        assert session.scalar(select(func.count()).select_from(CreditLedgerModel)) == 1
        assert session.scalar(select(func.count()).select_from(ExecutionUsageEvidenceModel)) == 1


def test_migration_applies_from_legacy_credit_ledger_and_is_idempotent(database: Engine) -> None:
    """Upgrade an existing wallet schema without requiring application-created budget tables."""
    path = Path(__file__).resolve().parents[3] / "alembic/versions/927cb56e104a_add_execution_budgets.py"
    spec = importlib.util.spec_from_file_location("budget_migration_fixture", path)
    assert spec is not None
    assert spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    extension_path = path.with_name("b7c2e4d9f130_add_execution_budget_uncapped.py")
    extension_spec = importlib.util.spec_from_file_location("uncapped_migration_fixture", extension_path)
    assert extension_spec is not None
    assert extension_spec.loader is not None
    extension = importlib.util.module_from_spec(extension_spec)
    extension_spec.loader.exec_module(extension)
    with database.begin() as connection, Operations.context(MigrationContext.configure(connection)):
        migration.downgrade()
        migration.upgrade()
        migration.upgrade()
        extension.upgrade()
        extension.upgrade()
    service = BudgetService(engine=database)
    budget = service.create("alice", 10, idempotency_key="migrated")
    assert budget.uncapped is False
    operation = _reserve(service, budget.id, "call", maximum=5)
    service.mark_dispatched(operation.id, "alice")
    result = service.settle(operation.id, "alice", evidence_key="usage", actual_credits=2, evidence={})
    assert result.budget.billed_credits == 2


def test_preflight_claim_and_fencing_are_atomic_on_postgres(database: Engine) -> None:
    """Recover an expired setup owner under real row locks without repeating outstanding usage.

    Args:
        database: Explicitly disposable PostgreSQL schema.
    """
    Base.metadata.create_all(database, tables=[BillingProviderKeyModel.__table__, WizardPreflightModel.__table__])
    store = PreflightStore(database)
    service = BudgetService(engine=database)
    budget = service.create("alice", 20, idempotency_key="setup")
    barrier = Barrier(2)

    def claim(_: int):
        """Race two replicas for one content-addressed setup owner.

        Args:
            _: Unused executor input.

        Returns:
            Private ownership claim and public evidence.
        """
        barrier.wait(timeout=5)
        return store.claim(
            username="alice",
            budget_id=budget.id,
            revision=1,
            workflow="anything",
            scope="execution",
            payload={"seed_candidate": "same"},
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        claims = list(executor.map(claim, range(2)))
    assert sum(item.token is not None for item in claims) == 1
    owner = next(item for item in claims if item.token is not None)
    operation = _reserve(service, budget.id, "setup-call", maximum=5)
    service.mark_dispatched(operation.id, "alice")
    with Session(database) as session:
        session.get(WizardPreflightModel, owner.document["id"]).lease_expires_at = datetime.now(UTC) - timedelta(
            seconds=1
        )
        session.commit()
    replacement = store.claim(
        username="alice",
        budget_id=budget.id,
        revision=1,
        workflow="anything",
        scope="execution",
        payload={"seed_candidate": "same"},
    )
    assert replacement.token is None
    assert replacement.generation == 1
    assert service.get(budget.id, "alice").reserved_credits == 5
    with pytest.raises(BudgetConflictError):
        store.finish(owner.document["id"], claim_token=owner.token, status="succeeded", result={"checks": []})
