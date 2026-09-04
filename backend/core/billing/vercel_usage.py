"""Reserve ephemeral Vercel compute and settle only final provider usage."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from decimal import Decimal
from typing import Any

import httpx

from .operation_pricing import (
    ChargePolicy,
    OperationQuote,
    UnpricedOperationError,
    exact_nonnegative,
    json_fingerprint,
    operation_quote,
)
from .runtime import BudgetRuntime, OperationCompletedError, UsagePendingError

_PRICING_URL = "https://vercel.com/docs/sandbox/pricing"
_SCHEMA_URL = "https://github.com/vercel/sandbox/blob/main/packages/vercel-sandbox/src/api-client/validators.ts"
_PRICE_VERSION = "vercel-sandbox-public-pro-2026-09-02"
_REGIONAL_RATES = {
    "iad1": (Decimal("0.128"), Decimal("0.0212")),
    "cle1": (Decimal("0.128"), Decimal("0.0212")),
    "cdg1": (Decimal("0.177"), Decimal("0.0292")),
    "sfo1": (Decimal("0.177"), Decimal("0.0294")),
}
_CREATION_USD = Decimal("0.0000006")
_MS_PER_HOUR = Decimal(3_600_000)
_IMMUTABLE_IMAGE = re.compile(r".+@sha256:[0-9a-f]{64}\Z")
_SANDBOX_POLICY = ChargePolicy("sandbox")
_SESSION_FIELDS = (
    "id",
    "status",
    "region",
    "vcpus",
    "memory",
    "timeout",
    "startedAt",
    "stoppedAt",
    "activeCpuDurationMs",
    "networkTransfer",
)


def vercel_sandbox_credit_range(request: Mapping[str, Any]) -> tuple[Decimal, Decimal]:
    """Return the current at-cost session floor and enforceable request bound.

    Args:
        request: Final immutable sandbox resource request accepted by
            :func:`quote_vercel_sandbox`.

    Returns:
        The smallest published creation-plus-memory charge and the request's
        maximum covered credit amount, both without model markup.

    Raises:
        UnpricedOperationError: When the request cannot be bounded.
    """
    maximum = quote_vercel_sandbox(request).maximum.total
    vcpus = request["vcpus"]
    minimum_memory_rate = min(memory for _cpu, memory in _REGIONAL_RATES.values())
    minimum_usd = _CREATION_USD + Decimal(vcpus * 2) * minimum_memory_rate / Decimal(60)
    minimum = _SANDBOX_POLICY.convert(minimum_usd).total
    return minimum, maximum


def _integer(value: Any, name: str) -> int:
    """Require an explicit nonnegative provider counter without truncating decimals.

    Args:
        value: Counter from trusted provider metadata.
        name: Field used to explain incomplete evidence.

    Returns:
        The validated whole-number counter.

    Raises:
        UsagePendingError: When the counter is missing or invalid.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise UsagePendingError(f"Vercel usage is awaiting a valid {name} counter.")
    return value


def _memory_ms(duration_ms: int) -> int:
    """Round provisioned memory duration to Vercel's one-minute billing increments."""
    return max(60_000, ((duration_ms + 59_999) // 60_000) * 60_000)


def quote_vercel_sandbox(request: Mapping[str, Any]) -> OperationQuote:
    """Price an immutable offline sandbox before allocating any provider resources.

    Args:
        request: Final create parameters with lifetime_ms, vcpus, and immutable image.

    Returns:
        Coverage for creation, maximum active CPU, and rounded memory lifetime.

    Raises:
        UnpricedOperationError: When the image, lifetime, or network is unbounded.
    """
    lifetime_ms = request.get("lifetime_ms")
    vcpus = request.get("vcpus")
    if (
        isinstance(lifetime_ms, bool)
        or not isinstance(lifetime_ms, int)
        or not 0 < lifetime_ms <= 86_400_000
        or isinstance(vcpus, bool)
        or not isinstance(vcpus, int)
        or vcpus not in {1, *range(2, 33, 2)}
    ):
        raise UnpricedOperationError("Vercel requires a bounded lifetime and explicit supported CPU allocation.")
    if not _IMMUTABLE_IMAGE.fullmatch(str(request.get("image", ""))):
        raise UnpricedOperationError("Protected Vercel runs require an immutable prebuilt image digest.")
    if (
        request.get("network_disabled") is not True
        or request.get("ports") != []
        or request.get("persistent") is not False
    ):
        raise UnpricedOperationError("Protected Vercel runs require deny-all networking, no ports, and no persistence.")
    # Python SDK 0.4.0 cannot select a region. Cover every currently supported
    # region and settle against the region in the final provider receipt.
    max_cpu = max(rates[0] for rates in _REGIONAL_RATES.values())
    max_memory = max(rates[1] for rates in _REGIONAL_RATES.values())
    maximum = (
        _CREATION_USD
        + Decimal(lifetime_ms * vcpus) * max_cpu / _MS_PER_HOUR
        + Decimal(_memory_ms(lifetime_ms) * vcpus * 2) * max_memory / _MS_PER_HOUR
    )
    return operation_quote(
        request,
        maximum,
        _SANDBOX_POLICY,
        {
            "provider": "vercel",
            "price_version": _PRICE_VERSION,
            "source": _PRICING_URL,
            "rates": {
                region: {"cpu_hour_usd": str(cpu), "memory_gb_hour_usd": str(memory)}
                for region, (cpu, memory) in _REGIONAL_RATES.items()
            },
            "creation_usd": str(_CREATION_USD),
            "network_gb_usd": "0.15",
            "maximum_billable_network_bytes": 0,
            "network_basis": "deny-all/no-exposed-ports; control-plane exclusion inferred from published billing categories",
            "memory_increment_ms": 60_000,
            "request": dict(request),
        },
    )


def vercel_actual_usd(
    session: Mapping[str, Any], *, session_id: str, vcpus: int, price_snapshot: Mapping[str, Any] | None = None
) -> Decimal:
    """Price a fully stopped exact session from provider CPU and lifetime evidence.

    Args:
        session: Metadata read from Vercel's authenticated control plane.
        session_id: The one admitted runtime session, never a resumed replacement.
        vcpus: Allocation covered by the original reservation.
        price_snapshot: Original admission rates; current rates only for standalone pricing checks.

    Returns:
        Creation plus measured CPU and provisioned memory at the regional rate.

    Raises:
        UsagePendingError: When final usage or its billing classification is uncertain.
    """
    if session.get("id") != session_id or session.get("status") != "stopped":
        raise UsagePendingError("Vercel has not confirmed the admitted session is fully stopped.")
    region = session.get("region")
    rates = (
        price_snapshot.get("rates")
        if price_snapshot is not None
        else {
            name: {"cpu_hour_usd": str(cpu), "memory_gb_hour_usd": str(memory)}
            for name, (cpu, memory) in _REGIONAL_RATES.items()
        }
    )
    if not isinstance(region, str) or not isinstance(rates, Mapping) or region not in rates:
        raise UsagePendingError("Vercel returned a region without a verified price snapshot.")
    if _integer(session.get("vcpus"), "vcpus") != vcpus or _integer(session.get("memory"), "memory") != vcpus * 2048:
        raise UsagePendingError("Vercel resource allocation differs from the admitted request.")
    started = _integer(session.get("startedAt"), "startedAt")
    stopped = _integer(session.get("stoppedAt"), "stoppedAt")
    if stopped < started:
        raise UsagePendingError("Vercel returned inconsistent session timestamps.")
    cpu_ms = _integer(session.get("activeCpuDurationMs"), "activeCpuDurationMs")
    network = session.get("networkTransfer")
    if not isinstance(network, Mapping):
        raise UsagePendingError("Vercel has not reported final network transfer.")
    ingress = _integer(network.get("ingress"), "network ingress")
    egress = _integer(network.get("egress"), "network egress")
    # The public counters are usage, not billing totals. Unexpected traffic
    # needs reconciliation; classifying all ingress as paid would overcharge.
    if ingress or egress:
        raise UsagePendingError("Offline Vercel transfer needs provider billing classification before settlement.")
    try:
        regional = rates[region]
        cpu_rate = exact_nonnegative(regional["cpu_hour_usd"])
        memory_rate = exact_nonnegative(regional["memory_gb_hour_usd"])
        creation = exact_nonnegative(price_snapshot["creation_usd"]) if price_snapshot is not None else _CREATION_USD
        if price_snapshot is not None and (
            price_snapshot.get("provider") != "vercel"
            or price_snapshot.get("memory_increment_ms") != 60_000
            or price_snapshot.get("maximum_billable_network_bytes") != 0
        ):
            raise ValueError("Unsupported historical billing policy")
    except (KeyError, TypeError, ValueError) as error:
        raise UsagePendingError("Vercel admission does not contain a usable historical price snapshot.") from error
    return (
        creation
        + Decimal(cpu_ms) * cpu_rate / _MS_PER_HOUR
        + Decimal(_memory_ms(stopped - started) * vcpus * 2) * memory_rate / _MS_PER_HOUR
    )


class VercelUsageReservation:
    """Own coverage and raw control-plane evidence for one sandbox creation."""

    def __init__(self, runtime: BudgetRuntime, request: Mapping[str, Any], *, operation_key: str) -> None:
        """Reserve and claim one physical sandbox creation before any network call.

        Args:
            runtime: Authenticated budget authority retained outside the guest.
            request: Final immutable resource and network parameters.
            operation_key: Stable logical identity for creation replay protection.
        """
        self.runtime = runtime
        self.vcpus = request["vcpus"]
        self.lifetime_ms = request["lifetime_ms"]
        self.quote = quote_vercel_sandbox(request)
        self.operation = runtime.reserve(self.quote, operation_key=operation_key, cost_kind="sandbox", role="runtime")
        if self.operation.state == "settled":
            raise OperationCompletedError("This sandbox operation already completed; retrieve its saved result.")
        claimed = runtime.service.mark_dispatched(self.operation.id, runtime.username)
        if not claimed.dispatch_claimed:
            raise UsagePendingError("This sandbox was already dispatched; reconcile its exact session.")
        self.session_id: str | None = None
        self._sessions: dict[str, dict[str, Any]] = {}

    def capture_response(self, response: httpx.Response) -> None:
        """Preserve narrowly scoped provider metadata before Python SDK field filtering.

        Args:
            response: Authenticated Vercel response from this sandbox's dedicated client.
        """
        path = response.request.url.path
        is_create = path == "/api/v3/sandboxes" and response.request.method == "POST"
        is_session = re.fullmatch(r"/api/v2/sandboxes/sessions/[^/]+(?:/stop)?", path) is not None
        if response.request.url.host != "vercel.com" or not response.is_success or not (is_create or is_session):
            return
        try:
            payload = response.read()
            if len(payload) > 1_000_000:
                return
            body = response.json()
        except (ValueError, httpx.HTTPError):
            return
        session = body.get("session") if isinstance(body, dict) else None
        if isinstance(session, dict) and isinstance(session.get("id"), str):
            self._sessions[session["id"]] = {name: session[name] for name in _SESSION_FIELDS if name in session}
            if is_create:
                self.session_id = session["id"]
                self.runtime.service.mark_dispatched(self.operation.id, self.runtime.username, self.session_id)
            # A worker may die between provider shutdown and SDK deserialization.
            # Preserve that receipt before destroying the provider resource.
            self.pending()

    def confirm_created(self, session: Any) -> None:
        """Bind returned provider identity and verify the funded resource envelope.

        Args:
            session: Exact Python SDK runtime-session handle.

        Raises:
            UsagePendingError: When returned provider limits do not match coverage.
        """
        if self.session_id not in {None, session.id}:
            raise UsagePendingError("Vercel returned a replacement session outside the admitted operation.")
        self.session_id = session.id
        self.runtime.service.mark_dispatched(self.operation.id, self.runtime.username, session.id)
        timeout = session.execution_time_limit
        if (
            session.vcpus != self.vcpus
            or session.memory != self.vcpus * 2048
            or session.region not in _REGIONAL_RATES
            or timeout is None
            or math.ceil(timeout.total_seconds() * 1000) > self.lifetime_ms
        ):
            raise UsagePendingError("Vercel did not confirm the admitted CPU, memory, region, and lifetime limits.")

    def pending(self) -> None:
        """Retain covered funding when creation, shutdown, or billing evidence is uncertain."""
        current = self.runtime.service.get_operation(self.operation.id, self.runtime.username)
        if current.state in {"dispatched", "pending"}:
            evidence = {"provider": "vercel", "session_id": self.session_id, "sessions": self._sessions}
            self.runtime.service.mark_pending(
                self.operation.id,
                self.runtime.username,
                evidence_key=json_fingerprint(evidence),
                evidence=evidence,
            )

    def settle(self) -> None:
        """Settle one fully stopped session at actual cost, retaining uncertainty.

        Raises:
            UsagePendingError: When final provider evidence is missing or ambiguous.
            BudgetError: When provider evidence violates reserved funding bounds.
        """
        try:
            if self.session_id is None:
                raise UsagePendingError("Vercel creation has not returned an exact session identity.")
            session = self._sessions.get(self.session_id, {})
            usd = vercel_actual_usd(
                session, session_id=self.session_id, vcpus=self.vcpus, price_snapshot=self.quote.price_snapshot
            )
            charge = vercel_charge_policy(self.quote.price_snapshot).convert(usd)
            self.runtime.service.settle(
                self.operation.id,
                self.runtime.username,
                evidence_key=f"vercel-stop:{self.session_id}",
                actual_credits=charge.total,
                actual_wallet_credits=charge.wallet,
                evidence={"provider": "vercel", "source": _SCHEMA_URL, "session": session, "provider_usd": str(usd)},
            )
        except BaseException:
            self.pending()
            raise


def vercel_charge_policy(price_snapshot: Mapping[str, Any]) -> ChargePolicy:
    """Recover the admitted at-cost credit conversion without applying newer defaults.

    Args:
        price_snapshot: Original immutable sandbox quote.

    Returns:
        The original sandbox-to-wallet conversion.

    Raises:
        UsagePendingError: When the recorded policy cannot be reconstructed safely.
    """
    policy = price_snapshot.get("policy")
    if (
        not isinstance(policy, Mapping)
        or policy.get("kind") != "sandbox"
        or policy.get("version") != "skynet-operation-pricing-v1"
    ):
        raise UsagePendingError("The Vercel operation has no supported at-cost conversion policy.")
    try:
        credit_usd = exact_nonnegative(policy.get("credit_usd"))
        if credit_usd <= 0:
            raise ValueError("Missing positive credit conversion")
        return ChargePolicy("sandbox", credit_usd=credit_usd)
    except ValueError as error:
        raise UsagePendingError("The Vercel operation has no usable historical credit conversion.") from error
