"""Verify checkpoint-bound recovery operation and runtime ceilings."""

from __future__ import annotations

from decimal import Decimal

import pytest

from core.billing.operation_pricing import CreditCharge, OperationQuote, json_fingerprint
from core.billing.recovery_admission import (
    RecoveryAdmissionError,
    build_recovery_plan,
    model_call_bound,
    runtime_bound,
    validate_recovery_plan,
    validate_recovery_runtime,
)


def _manifest() -> dict[str, str]:
    """Return stable compatibility evidence for one test checkpoint."""
    return {
        "checkpoint_sha256": "checkpoint",
        "configuration_sha256": "configuration",
        "source_sha256": "source",
    }


def _bound(*, maximum: str = "2", count: int = 1) -> dict[str, object]:
    """Return one enforceable prompt-free model call cap.

    Args:
        maximum: Scope and wallet credit ceiling for each call.
        count: Maximum physical calls permitted during seed replay.

    Returns:
        Persistable model-call evidence.
    """
    quote = OperationQuote(
        request_fingerprint="private-request",
        maximum=CreditCharge(total=Decimal(maximum), wallet=Decimal(maximum)),
        price_snapshot={"version": "fixture-v1", "provider": "fixture", "rate": "0.01"},
    )
    return model_call_bound("task", "fixture/model", quote, count=count)


def _runtime() -> dict[str, object]:
    """Return one immutable managed-sandbox recovery ceiling."""
    return runtime_bound(
        "vercel",
        {
            "image": "fixture@sha256:" + "a" * 64,
            "lifetime_seconds": 60,
        },
    )


def test_plan_aggregates_runtime_seed_and_one_execution_operation() -> None:
    """Prove the exact headroom held before an automatic requeue."""
    manifest = _manifest()
    seed = _bound(maximum="2", count=3)
    execution = _bound(maximum="4")
    plan = build_recovery_plan(
        manifest,
        runtime=_runtime(),
        seed_bounds=[seed],
        execution_bound={"model_calls": [execution], "max_credits": "4", "max_wallet_credits": "4"},
        seed_marker_seen=True,
    )

    validated = validate_recovery_plan(plan, manifest)

    assert validated["eligible"] is True
    expected = Decimal(10) + Decimal(str(_runtime()["max_credits"]))
    assert Decimal(validated["max_credits"]) == expected
    assert Decimal(validated["max_wallet_credits"]) == expected
    assert validated["runtime"]["request"]["lifetime_ms"] == 60_000


def test_plan_without_finite_seed_marker_is_recovery_ineligible() -> None:
    """Reject a checkpoint whose evaluator did not publish an enforceable seed boundary."""
    manifest = _manifest()
    plan = build_recovery_plan(
        manifest,
        runtime=_runtime(),
        seed_bounds=[],
        execution_bound={"model_calls": [_bound()], "max_credits": "2", "max_wallet_credits": "2"},
        seed_marker_seen=False,
    )

    assert plan["eligible"] is False
    with pytest.raises(RecoveryAdmissionError, match="seed-evaluation completion marker"):
        validate_recovery_plan(plan, manifest)


def test_plan_rejects_changed_runtime_and_malformed_execution_cap() -> None:
    """Refuse deployment drift and an execution aggregate without a physical call bound."""
    manifest = _manifest()
    plan = build_recovery_plan(
        manifest,
        runtime=_runtime(),
        seed_bounds=[_bound()],
        execution_bound={"model_calls": [_bound()], "max_credits": "2", "max_wallet_credits": "2"},
        seed_marker_seen=True,
    )
    changed = _runtime()
    changed["request"]["lifetime_ms"] = 1
    with pytest.raises(RecoveryAdmissionError, match="differs"):
        validate_recovery_runtime(plan, changed)

    malformed = dict(plan)
    malformed["execution_headroom"] = {"model_calls": [], "max_credits": "2", "max_wallet_credits": "2"}
    malformed.pop("fingerprint")
    malformed["fingerprint"] = json_fingerprint(malformed)
    with pytest.raises(RecoveryAdmissionError, match="next-operation"):
        validate_recovery_plan(malformed, manifest)
