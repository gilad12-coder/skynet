"""Verify the per-run usage breakdown adds up to the run's charges for every optimizer shape."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from core.billing.budget_amounts import cent_units
from core.billing.run_usage import (
    BILLING_BYOK,
    BILLING_DIRECT,
    BILLING_SKYNET,
    ROLE_PROPOSER,
    ROLE_REFLECTION,
    ROLE_ROUNDING,
    ROLE_SANDBOX,
    ROLE_SCORER,
    ROLE_SETUP,
    ROLE_TASK,
    OperationRecord,
    aggregate,
    billed_cents,
    load_records,
    serialize,
    with_rounding,
)
from core.storage.models import Base, ExecutionBudgetModel, ExecutionOperationModel, ExecutionUsageEvidenceModel

_MANAGED = {"kind": "managed_model", "byok_fee_fraction": "0.05"}
_BYOK = {"kind": "byok_model", "byok_fee_fraction": "0.05"}


def _op(
    *,
    role: str | None = "task",
    cost_kind: str = "model",
    phase: str = "run",
    state: str = "settled",
    policy: dict[str, Any] = _MANAGED,
    cents: str = "1",
    evidence: dict[str, Any] | None = None,
    quoted_model: str | None = None,
) -> OperationRecord:
    """Build one operation record with sensible defaults."""
    return OperationRecord(phase, cost_kind, role, state, policy, cent_units(cents), evidence or {}, quoted_model)


def _call(model: str = "openai/gpt-4o-mini", **tags: str) -> dict[str, Any]:
    """Build model-call evidence with OpenAI-style usage."""
    evidence: dict[str, Any] = {
        "model": model,
        "usage": {"prompt_tokens": 100, "completion_tokens": 20},
        "latency_ms": 400,
    }
    if tags:
        evidence["tags"] = tags
    return evidence


def test_dspy_run_splits_task_and_reflection_by_stage_and_candidate() -> None:
    """Group DSPy calls by role, stage and candidate while summing tokens and latency."""
    rows = aggregate(
        [
            _op(evidence=_call(stage="baseline")),
            _op(evidence=_call(stage="baseline")),
            _op(role="optimization", cents="3", evidence=_call("openai/gpt-5", stage="training", candidate="2")),
        ],
        proposer=False,
    )
    assert [(row.role, row.stage, row.candidate, row.calls) for row in rows] == [
        (ROLE_TASK, "baseline", None, 2),
        (ROLE_REFLECTION, "training", "2", 1),
    ]
    assert rows[0].input_tokens == 200
    assert rows[0].output_tokens == 40
    assert rows[0].latency_ms_total == 800
    assert rows[0].latency_calls == 2


def test_rows_add_up_to_every_charge_including_setup_and_sandbox() -> None:
    """Keep compute and setup as their own rows so the total equals what the run charged."""
    records = [
        _op(phase="setup", cents="2", evidence=_call()),
        _op(role="runtime", cost_kind="sandbox", cents="7.5", evidence={"provider": "vercel"}),
        _op(role="judge", cents="0.25", evidence=_call(candidate="1", case="ex-3")),
        _op(role="optimization", cents="4", evidence=_call("anthropic/claude-sonnet-4.5")),
    ]
    rows = aggregate(records, proposer=True)
    assert {row.role for row in rows} == {ROLE_SETUP, ROLE_SANDBOX, ROLE_SCORER, ROLE_PROPOSER}
    assert sum(row.charged_units for row in rows) == sum(record.wallet_units for record in records)
    sandbox = next(row for row in rows if row.role == ROLE_SANDBOX)
    assert sandbox.model is None
    assert sandbox.calls == 0


def test_byok_calls_report_the_provider_charge_behind_the_fee() -> None:
    """Invert the BYOK fee to estimate what the owner's provider charged."""
    (row,) = aggregate([_op(policy=_BYOK, cents="0.5", evidence=_call())], proposer=False)
    assert row.billing == BILLING_BYOK
    assert row.provider_cents == Decimal(10)


def test_unsettled_and_undispatched_calls() -> None:
    """Count in-flight calls as pending, and never count a reservation that sent nothing as a call."""
    (row,) = aggregate(
        [
            _op(state="pending", cents="0", evidence=_call()),
            _op(state="reserved", cents="0", quoted_model="openai/gpt-4o-mini"),
        ],
        proposer=False,
    )
    assert row.calls == 1
    assert row.pending_calls == 2


def test_anthropic_usage_counts_cached_input() -> None:
    """Count Anthropic's separately reported cache tokens as input."""
    usage = {"input_tokens": 10, "cache_read_input_tokens": 90, "cache_creation_input_tokens": 5, "output_tokens": 7}
    (row,) = aggregate([_op(evidence={"model": "anthropic/claude", "usage": usage})], proposer=False)
    assert (row.input_tokens, row.output_tokens) == (105, 7)


def test_pair_filter_keeps_only_that_pairs_calls() -> None:
    """Narrow a grid run to one pair's tagged calls."""
    rows = aggregate(
        [_op(evidence=_call(pair="0")), _op(evidence=_call(pair="1")), _op(role="runtime", cost_kind="sandbox")],
        proposer=False,
        pair="1",
    )
    assert [(row.pair, row.calls) for row in rows] == [("1", 1)]


def test_direct_proposer_usage_is_a_row_with_an_estimate_and_no_charge() -> None:
    """Show calls paid on the owner's own Anthropic key, estimated, with nothing charged by Skynet."""
    usage = {"model": "claude-sonnet-4-5", "calls": 4, "prompt_tokens": 1000, "completion_tokens": 200}
    (row,) = aggregate([], proposer=True, direct_usage=[usage])
    assert (row.role, row.billing, row.calls, row.charged_units) == (ROLE_PROPOSER, BILLING_DIRECT, 4, 0)
    assert row.provider_cents is not None
    assert row.provider_cents > 0
    assert aggregate([], proposer=True, direct_usage=[usage], pair="0") == []


def test_rounding_row_brings_the_rows_up_to_the_billed_charge() -> None:
    """Add the gap to whole billed cents as its own row, so the rows equal the charge."""
    rows = aggregate(
        [_op(cents="0.4", evidence=_call()), _op(role="runtime", cost_kind="sandbox", cents="0.3")], proposer=False
    )
    rounded = with_rounding(rows, 1)
    assert rounded[-1].role == ROLE_ROUNDING
    assert sum(row.charged_units for row in rounded) == cent_units(1)
    assert with_rounding(rows, None) == rows


def test_no_rounding_row_when_rows_already_match() -> None:
    """Leave whole-cent rows alone."""
    rows = aggregate([_op(cents="2", evidence=_call())], proposer=False)
    assert with_rounding(rows, 2) == rows


def test_serialize_renders_cents() -> None:
    """Render units as cents for JSON."""
    (document,) = serialize(aggregate([_op(cents="1.23456789", evidence=_call())], proposer=False))
    assert document["charged_cents"] == 1.2346
    assert document["provider_cents"] is None
    assert document["billing"] == BILLING_SKYNET


@pytest.fixture
def engine(tmp_path: Path) -> Iterator[Engine]:
    """Create a private billing database."""
    database = create_engine(f"sqlite:///{tmp_path / 'usage.db'}")
    Base.metadata.create_all(database)
    yield database
    database.dispose()


def test_load_records_merges_evidence_per_operation(engine: Engine) -> None:
    """Read each operation with its evidence rows merged in order, and ignore other budgets."""
    now = datetime.now(UTC)
    with Session(engine) as session:
        for budget_id in ("b1", "b2"):
            session.add(
                ExecutionBudgetModel(
                    id=budget_id,
                    username="alice",
                    creation_key=budget_id,
                    creation_fingerprint="f",
                    total_cents=100,
                    created_at=now,
                    updated_at=now,
                )
            )
        for index, budget_id in enumerate(("b1", "b2")):
            session.add(
                ExecutionOperationModel(
                    id=f"op{index}",
                    budget_id=budget_id,
                    operation_key="k",
                    attempt=0,
                    generation=0,
                    phase="run",
                    cost_kind="model",
                    role="task",
                    request_fingerprint="r",
                    admission_fingerprint="a",
                    price_snapshot={"policy": _MANAGED},
                    state="settled",
                    max_units=cent_units(5),
                    max_wallet_units=cent_units(5),
                    actual_units=cent_units(2),
                    actual_wallet_units=cent_units(2),
                    created_at=now,
                    updated_at=now,
                )
            )
        for offset, evidence in enumerate((_call(stage="training"), {"generation": {"total_cost": 0.02}})):
            session.add(
                ExecutionUsageEvidenceModel(
                    id=f"ev{offset}",
                    operation_id="op0",
                    evidence_key=f"e{offset}",
                    fingerprint="f",
                    actual_units=0,
                    actual_wallet_units=0,
                    billed_cents=0,
                    final=True,
                    evidence=evidence,
                    created_at=now + timedelta(seconds=offset),
                )
            )
        session.commit()
    (record,) = load_records(engine, "b1")
    assert billed_cents(engine, "b1") == 0
    assert billed_cents(engine, "missing") is None
    assert record.policy == _MANAGED
    assert record.wallet_units == cent_units(2)
    assert record.evidence["tags"] == {"stage": "training"}
    assert "generation" in record.evidence
