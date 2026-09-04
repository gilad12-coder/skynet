"""Verify protected Vercel admission and stopped-session metering without paid calls."""

from __future__ import annotations

import json
from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import Engine, create_engine, select
from sqlalchemy.orm import Session

from core.billing.budgets import BudgetInsufficientError, BudgetService
from core.billing.operation_pricing import UnpricedOperationError
from core.billing.runtime import BudgetRuntime, UsagePendingError
from core.billing.vercel_usage import quote_vercel_sandbox, vercel_actual_usd, vercel_sandbox_credit_range
from core.service_gateway.optimization.blackbox import sandbox as sandbox_module
from core.service_gateway.optimization.blackbox.sandbox import SandboxSpec, VercelCredentials, VercelSandboxRuntime
from core.storage.models import Base, BillingCustomerModel, ExecutionOperationModel, ExecutionUsageEvidenceModel

IMAGE = "vcr.example/skynet/optimizer@sha256:" + "a" * 64
CREATE = {
    "image": IMAGE,
    "lifetime_ms": 120_000,
    "vcpus": 2,
    "network_disabled": True,
    "ports": [],
    "persistent": False,
}
RECEIPT = {
    "id": "session-one",
    "sourceSandboxName": "sandbox-one",
    "status": "stopped",
    "region": "iad1",
    "vcpus": 2,
    "memory": 4096,
    "timeout": 120_000,
    "cwd": "/vercel/sandbox",
    "requestedAt": 1_000,
    "startedAt": 2_000,
    "stoppedAt": 63_000,
    "activeCpuDurationMs": 5_000,
    "networkTransfer": {"ingress": 0, "egress": 0},
}


@pytest.fixture
def database(tmp_path: Path) -> Iterator[Engine]:
    """Create a private funded wallet and ledger for runtime integration tests."""
    engine = create_engine(f"sqlite:///{tmp_path / 'vercel.db'}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(username="alice", stripe_customer_id="fixture", credit_balance=100, grant_remaining=0)
        )
        session.commit()
    yield engine
    engine.dispose()


def _runtime(database: Engine, total: int = 50) -> BudgetRuntime:
    """Bind real admission to a local database, leaving provider I/O mocked."""
    service = BudgetService(engine=database)
    budget = service.create("alice", total, idempotency_key="draft")
    return BudgetRuntime(service, username="alice", budget_id=budget.id, generation=0, phase="setup", wait_timeout=0)


def test_quote_covers_all_regions_and_settles_cpu_separately_from_wall_time() -> None:
    """Cover maximum active CPU, charge actual CPU, and round only memory duration."""
    quote = quote_vercel_sandbox(CREATE)
    minimum_credits, maximum_credits = vercel_sandbox_credit_range(CREATE)
    maximum_usd = (
        Decimal("0.0000006")
        + Decimal(240_000) * Decimal("0.177") / 3_600_000
        + Decimal(480_000) * Decimal("0.0294") / 3_600_000
    )
    assert quote.maximum.wallet == quote.maximum.total == maximum_usd * 100
    assert minimum_credits == Decimal("0.141393334")
    assert maximum_credits == quote.maximum.total
    actual = vercel_actual_usd(RECEIPT, session_id="session-one", vcpus=2)
    expected = (
        Decimal("0.0000006")
        + Decimal(5_000) * Decimal("0.128") / 3_600_000
        + Decimal(480_000) * Decimal("0.0212") / 3_600_000
    )
    assert actual == expected
    assert actual < maximum_usd
    assert quote.price_snapshot["policy"]["kind"] == "sandbox"


@pytest.mark.parametrize(
    "change",
    [
        {"image": "mutable:latest"},
        {"network_disabled": False},
        {"ports": [8080]},
        {"persistent": True},
        {"lifetime_ms": 0},
        {"vcpus": 3},
    ],
)
def test_unbounded_creation_is_not_quoted(change: dict[str, Any]) -> None:
    """Reject dependencies, network paths, or resource lifetimes without enforceable bounds."""
    with pytest.raises(UnpricedOperationError):
        quote_vercel_sandbox({**CREATE, **change})


@pytest.mark.parametrize(
    "change",
    [
        {"status": "stopping"},
        {"activeCpuDurationMs": None},
        {"activeCpuDurationMs": True},
        {"networkTransfer": {"ingress": 30, "egress": 0}},
        {"networkTransfer": {"ingress": 0, "egress": 5}},
        {"region": "future-region"},
        {"id": "resumed-session"},
        {"memory": 8192},
    ],
)
def test_unconfirmed_usage_is_not_fabricated_or_misclassified(change: dict[str, Any]) -> None:
    """Leave absent metrics and ambiguous transfer pending instead of charging estimates."""
    with pytest.raises(UsagePendingError):
        vercel_actual_usd({**RECEIPT, **change}, session_id="session-one", vcpus=2)


def _mock_provider(
    monkeypatch: pytest.MonkeyPatch,
    runtime: BudgetRuntime,
    *,
    receipt: dict[str, Any] | None = None,
    fail_create: bool = False,
) -> list[httpx.Request]:
    """Install a real Python SDK transport with deterministic Vercel API responses.

    Args:
        monkeypatch: Local patch lifetime.
        runtime: Ledger whose pre-dispatch hold is asserted by the provider.
        receipt: Optional stopped-session metadata override.
        fail_create: Simulate a network failure after creation may have been accepted.

    Returns:
        Captured provider requests for replay and lifecycle assertions.
    """
    requests: list[httpx.Request] = []
    sandbox = {"name": "sandbox-one", "currentSessionId": "session-one", "persistent": False}
    final = {**RECEIPT, **(receipt or {})}

    def provider(request: httpx.Request) -> httpx.Response:
        """Require durable coverage before returning realistic provider metadata."""
        requests.append(request)
        if request.method == "POST" and request.url.path.endswith("/v3/sandboxes"):
            assert runtime.service.get(runtime.budget_id, "alice").reserved_credits > 0
            body = json.loads(request.content)
            assert body["persistent"] is False
            assert body["ports"] == []
            assert body["networkPolicy"] == {"mode": "deny-all"}
            assert body["resources"] == {"vcpus": 2, "memory": 4096}
            if fail_create:
                raise httpx.ReadError("creation response lost", request=request)
            active = {
                key: value
                for key, value in RECEIPT.items()
                if key not in {"stoppedAt", "activeCpuDurationMs", "networkTransfer"}
            }
            active["status"] = "running"
            return httpx.Response(
                200, json={"sandbox": {**sandbox, "status": "running"}, "session": active, "routes": []}
            )
        if request.method == "POST" and request.url.path.endswith("/session-one/stop"):
            return httpx.Response(200, json={"sandbox": {**sandbox, "status": "stopped"}, "session": final})
        if request.method == "DELETE":
            return httpx.Response(
                200, json={"sandbox": {**sandbox, "status": "stopped"}, "session": final, "routes": []}
            )
        raise AssertionError(f"Unexpected provider operation: {request.method} {request.url.path}")

    class FixtureClient(httpx.Client):
        """Preserve the SDK's concrete client type validation with a local transport."""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            """Keep response hooks and SDK serialization while replacing network I/O."""
            super().__init__(*args, transport=httpx.MockTransport(provider), **kwargs)

    monkeypatch.setattr(sandbox_module.httpx, "Client", FixtureClient)
    return requests


def _sandbox_runtime(runtime: BudgetRuntime) -> VercelSandboxRuntime:
    """Create a protected runtime with fixed non-secret test credentials."""
    return VercelSandboxRuntime(
        VercelCredentials(token="fixture", team_id="team", project_id="project"), image=IMAGE, budget=runtime
    )


def _spec(lifetime_seconds: int = 120) -> SandboxSpec:
    """Use an offline sandbox identity stable across delivery retries."""
    return SandboxSpec(
        lifetime_seconds=lifetime_seconds, name="sandbox-one", network_disabled=True, operation_key="evaluation-one"
    )


def test_real_sdk_stop_metrics_are_preserved_and_settled_once(
    database: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Meter raw fields discarded by the installed SDK and debit without model markup."""
    runtime = _runtime(database)
    requests = _mock_provider(monkeypatch, runtime)
    sandbox = _sandbox_runtime(runtime).open(_spec())
    sandbox.close()
    sandbox.close()
    assert [request.method for request in requests] == ["POST", "POST", "DELETE"]
    snapshot = runtime.service.get(runtime.budget_id, "alice")
    assert snapshot.reserved_credits == 0
    assert snapshot.billed_credits == 1
    assert snapshot.setup_spent_credits == Decimal("0.300504445")
    with Session(database) as session:
        evidence = session.scalar(
            select(ExecutionUsageEvidenceModel).where(ExecutionUsageEvidenceModel.final.is_(True))
        )
        assert evidence.evidence["session"]["activeCpuDurationMs"] == 5_000
        assert evidence.evidence["session"]["networkTransfer"] == {"ingress": 0, "egress": 0}


def test_uncertain_network_keeps_hold_and_destroys_compute(database: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """Stop costs while preserving coverage for transfer with unknown billing classification."""
    runtime = _runtime(database)
    requests = _mock_provider(monkeypatch, runtime, receipt={"networkTransfer": {"ingress": 42, "egress": 1}})
    sandbox = _sandbox_runtime(runtime).open(_spec())
    with pytest.raises(UsagePendingError, match="classification"):
        sandbox.close()
    assert requests[-1].method == "DELETE"
    snapshot = runtime.service.get(runtime.budget_id, "alice")
    assert snapshot.reserved_credits > 0
    assert snapshot.billed_credits == 0
    assert snapshot.pending_operations == 1
    with Session(database) as session:
        evidence = list(
            session.scalars(select(ExecutionUsageEvidenceModel).order_by(ExecutionUsageEvidenceModel.created_at))
        )[-1]
        assert evidence.issue == "usage_pending"
        assert evidence.evidence["sessions"]["session-one"]["networkTransfer"] == {"ingress": 42, "egress": 1}


def test_lost_creation_response_is_pending_and_never_repeated(
    database: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Retain an uncertain creation hold and block another physical dispatch on replay."""
    runtime = _runtime(database)
    requests = _mock_provider(monkeypatch, runtime, fail_create=True)
    sandbox_runtime = _sandbox_runtime(runtime)
    with pytest.raises(httpx.ReadError):
        sandbox_runtime.open(_spec())
    with pytest.raises(UsagePendingError, match="already dispatched"):
        sandbox_runtime.open(_spec())
    assert len(requests) == 1
    assert runtime.service.get(runtime.budget_id, "alice").pending_operations == 1


def test_insufficient_sandbox_coverage_never_calls_provider(database: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """Require the full hard compute bound before entering the provider SDK."""
    runtime = _runtime(database, total=1)
    requests = _mock_provider(monkeypatch, runtime)
    with pytest.raises(BudgetInsufficientError):
        _sandbox_runtime(runtime).open(_spec(lifetime_seconds=3600))
    assert requests == []
    with Session(database) as session:
        assert session.scalar(select(ExecutionOperationModel)) is None
