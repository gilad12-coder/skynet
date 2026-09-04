"""Persist and verify bounded recovery work without reserving it twice."""

from __future__ import annotations

import copy
import math
from collections.abc import Mapping
from decimal import Decimal, InvalidOperation
from typing import Any

from .operation_pricing import OperationQuote, json_fingerprint
from .vercel_usage import quote_vercel_sandbox

RECOVERY_ADMISSION_VERSION = 1
_VOLATILE_PRICE_FIELDS = frozenset({"retrieved_at", "version"})


class RecoveryAdmissionError(ValueError):
    """Reject recovery when persisted work cannot be bounded and enforced."""


def _amount(value: Any) -> Decimal:
    """Read a finite nonnegative credit amount from persisted evidence."""
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as error:
        raise RecoveryAdmissionError("Recovery admission contains an invalid credit bound.") from error
    if not amount.is_finite() or amount < 0:
        raise RecoveryAdmissionError("Recovery admission contains an invalid credit bound.")
    return amount


def _price_binding(snapshot: Mapping[str, Any]) -> str:
    """Bind applicable prices while permitting only their retrieval timestamp to change."""
    stable = {key: copy.deepcopy(value) for key, value in snapshot.items() if key not in _VOLATILE_PRICE_FIELDS}
    return json_fingerprint(stable)


def model_call_bound(role: str, model: str, quote: OperationQuote, *, count: int = 1) -> dict[str, Any]:
    """Record an observed model request ceiling that a recovery gateway can enforce.

    Args:
        role: Fixed task, judge, or optimization route.
        model: Exact provider model slug.
        quote: Verified provider quote for an actual physical request.
        count: Maximum calls permitted under this bound.

    Returns:
        Prompt-free pricing, model, call-count, and credit-bound evidence.
    """
    if count <= 0:
        raise RecoveryAdmissionError("Recovery model call bounds require a positive count.")
    return {
        "role": role,
        "model": model,
        "count": count,
        "max_credits": str(quote.maximum.total),
        "max_wallet_credits": str(quote.maximum.wallet),
        "price_binding": _price_binding(quote.price_snapshot),
        "price_snapshot": copy.deepcopy(dict(quote.price_snapshot)),
    }


def quote_fits_bound(bound: Mapping[str, Any], role: str, model: str, quote: OperationQuote) -> bool:
    """Check an actual replay request against its persisted model and price ceiling.

    Args:
        bound: One persisted model-call bound.
        role: Actual fixed route role.
        model: Actual exact provider model.
        quote: Fresh verified quote for the resolved replay request.

    Returns:
        Whether identity, prices, and scope/wallet maxima remain within the plan.
    """
    return (
        bound.get("role") == role
        and bound.get("model") == model
        and bound.get("price_binding") == _price_binding(quote.price_snapshot)
        and quote.maximum.total <= _amount(bound.get("max_credits"))
        and quote.maximum.wallet <= _amount(bound.get("max_wallet_credits"))
    )


def _validate_model_bound(bound: Any) -> Mapping[str, Any]:
    """Validate one persisted model call cap without reconstructing its prompt.

    Args:
        bound: Candidate prompt-free model-call evidence.

    Returns:
        Validated mapping.

    Raises:
        RecoveryAdmissionError: When identity, prices, count, or maxima are incomplete.
    """
    if not isinstance(bound, Mapping):
        raise RecoveryAdmissionError("Recovery admission contains an invalid model call bound.")
    count = bound.get("count")
    snapshot = bound.get("price_snapshot")
    if (
        isinstance(count, bool)
        or not isinstance(count, int)
        or count <= 0
        or not isinstance(bound.get("role"), str)
        or not bound["role"]
        or not isinstance(bound.get("model"), str)
        or not bound["model"]
        or not isinstance(snapshot, Mapping)
        or bound.get("price_binding") != _price_binding(snapshot)
    ):
        raise RecoveryAdmissionError("Recovery admission contains an invalid model call bound.")
    _amount(bound.get("max_credits"))
    _amount(bound.get("max_wallet_credits"))
    return bound


def runtime_bound(kind: str, descriptor: Mapping[str, Any] | None) -> dict[str, Any]:
    """Build the exact outer sandbox resource ceiling for a later restore.

    Args:
        kind: Managed execution runtime.
        descriptor: Parent-owned Vercel image and lifetime profile.

    Returns:
        Runtime identity, enforced resources, price evidence, and maximum credits.
    """
    if kind != "vercel" or not isinstance(descriptor, Mapping):
        raise RecoveryAdmissionError("Recovery requires a recognized bounded sandbox runtime.")
    request = {
        "image": descriptor.get("image"),
        "lifetime_ms": math.ceil(float(descriptor.get("lifetime_seconds", 0)) * 1000),
        "vcpus": 2,
        "network_disabled": True,
        "ports": [],
        "persistent": False,
    }
    quote = quote_vercel_sandbox(request)
    return {
        "kind": "vercel",
        "request": request,
        "request_fingerprint": quote.request_fingerprint,
        "max_credits": str(quote.maximum.total),
        "max_wallet_credits": str(quote.maximum.wallet),
        "price_snapshot": copy.deepcopy(dict(quote.price_snapshot)),
    }


def build_recovery_plan(
    manifest: Mapping[str, Any],
    *,
    runtime: Mapping[str, Any],
    seed_bounds: list[Mapping[str, Any]],
    execution_bound: Mapping[str, Any] | None,
    seed_marker_seen: bool,
    ineligible_reason: str | None = None,
) -> dict[str, Any]:
    """Bind replay caps and aggregate headroom to one checkpoint revision.

    Args:
        manifest: Checkpoint compatibility manifest already bound to state bytes.
        runtime: Enforced outer sandbox resource and price bound.
        seed_bounds: Observed and enforceable mandatory seed-evaluation call caps.
        execution_bound: One priced next-operation bound after seed evaluation.
        seed_marker_seen: Whether the runtime explicitly completed initial seed evaluation.
        ineligible_reason: Earlier precise reason this runtime cannot expose finite bounds.

    Returns:
        Versioned eligible or ineligible recovery admission evidence.
    """
    reason = ineligible_reason
    if reason is None and not seed_marker_seen:
        reason = "The optimizer did not publish a bounded seed-evaluation completion marker."
    if reason is None and execution_bound is None:
        reason = "The checkpoint has no verified next-operation execution headroom bound."
    base: dict[str, Any] = {
        "version": RECOVERY_ADMISSION_VERSION,
        "checkpoint_sha256": manifest.get("checkpoint_sha256"),
        "configuration_sha256": manifest.get("configuration_sha256"),
        "source_sha256": manifest.get("source_sha256"),
        "runtime": copy.deepcopy(dict(runtime)),
        "seed_reevaluation": {"model_calls": [copy.deepcopy(dict(item)) for item in seed_bounds]},
        "execution_headroom": copy.deepcopy(dict(execution_bound)) if execution_bound is not None else None,
    }
    if reason is not None:
        base.update(eligible=False, reason=reason)
    else:
        seed_total = sum(
            (_amount(item.get("max_credits")) * int(item.get("count", 0)) for item in seed_bounds),
            Decimal(0),
        )
        seed_wallet = sum(
            (_amount(item.get("max_wallet_credits")) * int(item.get("count", 0)) for item in seed_bounds),
            Decimal(0),
        )
        total = _amount(runtime.get("max_credits")) + seed_total + _amount(execution_bound.get("max_credits"))
        wallet = (
            _amount(runtime.get("max_wallet_credits"))
            + seed_wallet
            + _amount(execution_bound.get("max_wallet_credits"))
        )
        base.update(
            eligible=True,
            max_credits=str(total),
            max_wallet_credits=str(wallet),
            execution_max_credits=str(_amount(execution_bound.get("max_credits"))),
            execution_max_wallet_credits=str(_amount(execution_bound.get("max_wallet_credits"))),
        )
    base["fingerprint"] = json_fingerprint(base)
    return base


def validate_recovery_plan(plan: Any, manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Verify a checkpoint-bound plan and return a detached eligible copy.

    Args:
        plan: Persisted recovery admission document.
        manifest: Owning checkpoint compatibility evidence.

    Returns:
        Detached validated plan.

    Raises:
        RecoveryAdmissionError: When eligibility or any bound is not authoritative.
    """
    if not isinstance(plan, dict) or plan.get("version") != RECOVERY_ADMISSION_VERSION:
        raise RecoveryAdmissionError("The checkpoint predates bounded automatic recovery admission.")
    document = copy.deepcopy(plan)
    fingerprint = document.pop("fingerprint", None)
    if fingerprint != json_fingerprint(document):
        raise RecoveryAdmissionError("The checkpoint recovery admission plan failed its integrity check.")
    if document.get("eligible") is not True:
        raise RecoveryAdmissionError(str(document.get("reason") or "This checkpoint is not eligible for recovery."))
    for key in ("checkpoint_sha256", "configuration_sha256", "source_sha256"):
        if document.get(key) != manifest.get(key):
            raise RecoveryAdmissionError(f"Checkpoint recovery admission is incompatible: {key} changed.")
    runtime = document.get("runtime")
    seed = document.get("seed_reevaluation")
    execution = document.get("execution_headroom")
    if not isinstance(runtime, dict) or runtime.get("kind") != "vercel":
        raise RecoveryAdmissionError("Recovery admission has no bounded outer sandbox runtime.")
    try:
        request = runtime.get("request")
        if not isinstance(request, Mapping):
            raise RecoveryAdmissionError("Recovery admission has no bounded Vercel request.")
        quote = quote_vercel_sandbox(request)
        verified_runtime = {
            "kind": "vercel",
            "request": copy.deepcopy(dict(request)),
            "request_fingerprint": quote.request_fingerprint,
            "max_credits": str(quote.maximum.total),
            "max_wallet_credits": str(quote.maximum.wallet),
            "price_snapshot": copy.deepcopy(dict(quote.price_snapshot)),
        }
        validate_recovery_runtime({"runtime": runtime}, verified_runtime)
    except (TypeError, ValueError) as error:
        if isinstance(error, RecoveryAdmissionError):
            raise
        raise RecoveryAdmissionError("Recovery admission contains an invalid sandbox bound.") from error
    if not isinstance(seed, dict) or not isinstance(seed.get("model_calls"), list) or not isinstance(execution, dict):
        raise RecoveryAdmissionError("Recovery admission has no enforceable seed and execution operation bounds.")
    execution_calls = execution.get("model_calls")
    if not isinstance(execution_calls, list) or not execution_calls:
        raise RecoveryAdmissionError("Recovery admission has no enforceable next-operation model bound.")
    seed_total = Decimal(0)
    seed_wallet = Decimal(0)
    for bound in seed["model_calls"]:
        bound = _validate_model_bound(bound)
        seed_total += _amount(bound.get("max_credits")) * bound["count"]
        seed_wallet += _amount(bound.get("max_wallet_credits")) * bound["count"]
    execution_scope = max(_amount(_validate_model_bound(bound).get("max_credits")) for bound in execution_calls)
    execution_wallet = max(_amount(_validate_model_bound(bound).get("max_wallet_credits")) for bound in execution_calls)
    if execution_scope != _amount(execution.get("max_credits")) or execution_wallet != _amount(
        execution.get("max_wallet_credits")
    ):
        raise RecoveryAdmissionError("Recovery admission execution aggregate does not match its model bounds.")
    total = _amount(runtime.get("max_credits")) + seed_total + _amount(execution.get("max_credits"))
    wallet = _amount(runtime.get("max_wallet_credits")) + seed_wallet + _amount(
        execution.get("max_wallet_credits")
    )
    if total != _amount(document.get("max_credits")) or wallet != _amount(document.get("max_wallet_credits")):
        raise RecoveryAdmissionError("Recovery admission aggregate does not match its operation bounds.")
    document["fingerprint"] = fingerprint
    return document


def validate_recovery_runtime(plan: Mapping[str, Any], current: Mapping[str, Any]) -> None:
    """Require the current sandbox profile and price ceiling to match the checkpoint plan.

    Args:
        plan: Validated checkpoint recovery admission evidence.
        current: Fresh bound for the runtime that would restore the checkpoint.

    Raises:
        RecoveryAdmissionError: When deployment configuration or applicable prices changed.
    """
    persisted = plan.get("runtime")
    if not isinstance(persisted, Mapping) or json_fingerprint(dict(persisted)) != json_fingerprint(dict(current)):
        raise RecoveryAdmissionError(
            "The current sandbox runtime or applicable price bound differs from this checkpoint."
        )


def headroom_price_snapshot(plan: Mapping[str, Any]) -> dict[str, Any]:
    """Create immutable ledger evidence for one checkpoint recovery hold."""
    evidence = {
        "provider": "recovery-admission",
        "plan_version": plan.get("version"),
        "plan_fingerprint": plan.get("fingerprint"),
        "checkpoint_sha256": plan.get("checkpoint_sha256"),
    }
    return {**evidence, "version": json_fingerprint(evidence)}
