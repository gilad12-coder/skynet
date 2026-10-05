"""Break one run's charges and model activity down from its billing records.

Every billed model call and sandbox charge of a run is an execution operation
on the run's budget, so summing operations adds up exactly to what the run
charged, for every optimizer alike. Rows are pre-aggregated per role, model,
stage, pair and candidate; the client regroups them by any of those.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from ..storage.models import ExecutionBudgetModel, ExecutionOperationModel, ExecutionUsageEvidenceModel
from .budget_amounts import CENT_SCALE, cents_from_units
from .pricing import CENT_USD_VALUE, ModelUsage, usage_cost_usd

ROLE_TASK = "task"
ROLE_REFLECTION = "reflection"
ROLE_PROPOSER = "proposer"
ROLE_SCORER = "scorer"
ROLE_SANDBOX = "sandbox"
ROLE_SETUP = "setup"
ROLE_OTHER = "other"
ROLE_ROUNDING = "rounding"

BILLING_SKYNET = "skynet"
BILLING_BYOK = "byok"
BILLING_DIRECT = "direct"

_CALL_STATES = ("dispatched", "pending", "settled")
_UNSETTLED_STATES = ("reserved", "dispatched", "pending")


@dataclass
class UsageRow:
    """One aggregate of operations sharing a role, model, stage, pair, candidate and billing."""

    role: str
    model: str | None
    stage: str | None
    pair: str | None
    candidate: str | None
    billing: str
    charged_units: int = 0
    provider_cents: Decimal | None = None
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms_total: int = 0
    latency_calls: int = 0
    unpriced_calls: int = 0
    pending_calls: int = 0


@dataclass(frozen=True)
class OperationRecord:
    """The fields of one operation and its latest evidence that the breakdown reads."""

    phase: str
    cost_kind: str
    role: str | None
    state: str
    policy: Mapping[str, Any]
    wallet_units: int
    evidence: Mapping[str, Any]
    quoted_model: str | None = None


def _role(record: OperationRecord, *, proposer: bool) -> str:
    """Name the run role an operation served.

    Args:
        record: The operation.
        proposer: Whether the run's optimization model is a proposer agent rather than DSPy reflection.

    Returns:
        One of the ``ROLE_*`` names.
    """
    if record.phase == "setup":
        return ROLE_SETUP
    if record.cost_kind == "sandbox":
        return ROLE_SANDBOX
    return {
        "task": ROLE_TASK,
        "optimization": ROLE_PROPOSER if proposer else ROLE_REFLECTION,
        "judge": ROLE_SCORER,
    }.get(record.role or "", ROLE_OTHER)


def _int(value: Any) -> int:
    """Read a nonnegative token count, treating anything else as zero."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _tokens(usage: Mapping[str, Any] | None) -> tuple[int, int]:
    """Read input and output tokens from any provider usage shape.

    Args:
        usage: OpenAI-style, Anthropic-style or Responses usage, or ``None``.

    Returns:
        ``(input, output)`` tokens; Anthropic's cache tokens count as input.
    """
    if not isinstance(usage, Mapping):
        return 0, 0
    if "prompt_tokens" in usage or "completion_tokens" in usage:
        return _int(usage.get("prompt_tokens")), _int(usage.get("completion_tokens"))
    # Anthropic reports cached input apart from ``input_tokens``; Responses folds it in.
    cached = _int(usage.get("cache_read_input_tokens")) + _int(usage.get("cache_creation_input_tokens"))
    return _int(usage.get("input_tokens")) + cached, _int(usage.get("output_tokens"))


def _byok_provider_cents(record: OperationRecord) -> Decimal | None:
    """Recover the at-cost provider charge of a BYOK call from the fee Skynet billed on it.

    Args:
        record: A BYOK model operation.

    Returns:
        Provider cents, or ``None`` when the recorded fee fraction cannot be inverted.
    """
    try:
        fraction = Decimal(str(record.policy.get("byok_fee_fraction")))
    except ArithmeticError:
        return None
    return cents_from_units(record.wallet_units) / fraction if fraction > 0 else None


def aggregate(
    records: Iterable[OperationRecord],
    *,
    proposer: bool,
    direct_usage: Iterable[Mapping[str, Any]] = (),
    pair: str | None = None,
) -> list[UsageRow]:
    """Group a run's operations into usage rows.

    Args:
        records: The run budget's operations.
        proposer: Whether the run's optimization model is a proposer agent.
        direct_usage: Proposer usage paid on the owner's own key, which has no operation.
        pair: Keep only operations tagged with this grid pair.

    Returns:
        Rows in first-seen order.
    """
    rows: dict[tuple[Any, ...], UsageRow] = {}

    def row_for(role: str, model: str | None, tags: Mapping[str, Any], billing: str) -> UsageRow:
        """Return the row for one grouping key, creating it on first use."""
        key = (role, model, tags.get("stage"), tags.get("pair"), tags.get("candidate"), billing)
        if key not in rows:
            rows[key] = UsageRow(role, model, *key[2:5], billing)
        return rows[key]

    for record in records:
        tags = record.evidence.get("tags") if isinstance(record.evidence.get("tags"), Mapping) else {}
        if pair is not None and tags.get("pair") != pair:
            continue
        model_call = record.cost_kind == "model"
        byok = record.policy.get("kind") == "byok_model"
        model = (str(record.evidence.get("model") or record.quoted_model or "") or None) if model_call else None
        row = row_for(_role(record, proposer=proposer), model, tags, BILLING_BYOK if byok else BILLING_SKYNET)
        row.charged_units += record.wallet_units
        if byok:
            provider = _byok_provider_cents(record)
            if provider is None:
                row.unpriced_calls += 1
            else:
                row.provider_cents = (row.provider_cents or Decimal(0)) + provider
        if record.state in _UNSETTLED_STATES:
            row.pending_calls += 1
        if not model_call or record.state not in _CALL_STATES:
            continue
        row.calls += 1
        input_tokens, output_tokens = _tokens(record.evidence.get("usage"))
        row.input_tokens += input_tokens
        row.output_tokens += output_tokens
        latency = record.evidence.get("latency_ms")
        if isinstance(latency, int) and latency >= 0:
            row.latency_ms_total += latency
            row.latency_calls += 1
    if pair is None:
        for usage in direct_usage:
            model = str(usage.get("model") or "") or None
            row = row_for(ROLE_PROPOSER, model, {}, BILLING_DIRECT)
            row.calls += _int(usage.get("calls"))
            cache_read, cache_write = (
                _int(usage.get("cache_read_input_tokens")),
                _int(usage.get("cache_creation_input_tokens")),
            )
            prompt, completion = (
                _int(usage.get("prompt_tokens")) + cache_read + cache_write,
                _int(usage.get("completion_tokens")),
            )
            row.input_tokens += prompt
            row.output_tokens += completion
            if model is not None:
                usd = usage_cost_usd(
                    ModelUsage(model, prompt, completion, cache_read_tokens=cache_read, cache_write_tokens=cache_write)
                )
                row.provider_cents = (row.provider_cents or Decimal(0)) + Decimal(str(usd)) / Decimal(
                    str(CENT_USD_VALUE)
                )
    return list(rows.values())


def load_records(engine: Engine, budget_id: str) -> list[OperationRecord]:
    """Read a budget's operations with each one's latest evidence.

    Args:
        engine: Database engine holding the billing tables.
        budget_id: The run's execution budget.

    Returns:
        One record per operation attempt, oldest first.
    """
    with Session(engine) as session:
        operations = session.execute(
            select(ExecutionOperationModel)
            .where(ExecutionOperationModel.budget_id == budget_id)
            .order_by(ExecutionOperationModel.created_at)
        ).scalars()
        operations = list(operations)
        evidence: dict[str, Mapping[str, Any]] = {}
        if operations:
            for operation_id, document in session.execute(
                select(ExecutionUsageEvidenceModel.operation_id, ExecutionUsageEvidenceModel.evidence)
                .where(ExecutionUsageEvidenceModel.operation_id.in_([operation.id for operation in operations]))
                .order_by(ExecutionUsageEvidenceModel.created_at)
            ):
                if isinstance(document, Mapping):
                    evidence[operation_id] = {**evidence.get(operation_id, {}), **document}
        return [
            OperationRecord(
                phase=operation.phase,
                cost_kind=operation.cost_kind,
                role=operation.role,
                state=operation.state,
                policy=(operation.price_snapshot or {}).get("policy") or {},
                wallet_units=operation.actual_wallet_units,
                evidence=evidence.get(operation.id, {}),
                quoted_model=(operation.price_snapshot or {}).get("model"),
            )
            for operation in operations
        ]


def billed_cents(engine: Engine, budget_id: str) -> int | None:
    """Read how many whole cents a budget has billed to the wallet.

    Args:
        engine: Database engine holding the billing tables.
        budget_id: The run's execution budget.

    Returns:
        The billed cents, or ``None`` when the budget does not exist.
    """
    with Session(engine) as session:
        return session.execute(
            select(ExecutionBudgetModel.billed_cents).where(ExecutionBudgetModel.id == budget_id)
        ).scalar_one_or_none()


def with_rounding(rows: list[UsageRow], billed: int | None) -> list[UsageRow]:
    """Add a row for the wallet rounding its fractional charges up to whole cents.

    The wallet bills the ceiling of the run's running total, so the operations
    sum to slightly less than the charge. The extra row keeps every grouping
    adding up to exactly what the wallet charged.

    Args:
        rows: The run's usage rows.
        billed: Whole cents the budget billed, or ``None`` when unknown.

    Returns:
        ``rows``, plus a rounding row when the charge exceeds their sum.
    """
    if billed is None:
        return rows
    gap = billed * CENT_SCALE - sum(row.charged_units for row in rows)
    if gap <= 0:
        return rows
    return [
        *rows,
        UsageRow(
            role=ROLE_ROUNDING,
            model=None,
            stage=None,
            pair=None,
            candidate=None,
            billing=BILLING_SKYNET,
            charged_units=gap,
        ),
    ]


def serialize(rows: Iterable[UsageRow]) -> list[dict[str, Any]]:
    """Render rows for JSON, with cents as decimals rounded to a hundredth of a cent.

    Args:
        rows: Aggregated usage rows.

    Returns:
        JSON-ready dicts.
    """
    result = []
    for row in rows:
        document = asdict(row)
        document["charged_cents"] = float(round(cents_from_units(document.pop("charged_units")), 4))
        provider = document.pop("provider_cents")
        document["provider_cents"] = None if provider is None else float(round(provider, 4))
        result.append(document)
    return result
