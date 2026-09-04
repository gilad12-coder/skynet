"""Reconcile already-dispatched model requests without repeating inference."""

from __future__ import annotations

from collections.abc import Callable
from decimal import Decimal

import httpx

from .budgets import BudgetError, BudgetService, OperationSnapshot
from .model_dispatch import OpenRouterDispatcher
from .operation_pricing import ChargePolicy, exact_nonnegative, json_fingerprint
from .runtime import BudgetRuntime, UsagePendingError
from .vercel_reconciliation import ReconciliationPage, ReconciliationResult


class OpenRouterUsageReconciler:
    """Recover confirmed usage under the exact credential identity and historical prices."""

    def __init__(self, service: BudgetService, resolve_key: Callable[[str, str], str | None]) -> None:
        """Bind reconciliation to a trusted credential resolver.

        Args:
            service: Authoritative operation ledger.
            resolve_key: Account and original credential digest to current usable secret, or None.
        """
        self.service = service
        self.resolve_key = resolve_key

    def reconcile(self, operation_id: str, username: str, *, client: httpx.Client | None = None) -> OperationSnapshot:
        """Look up only the admitted generation and settle the original conversion policy.

        Args:
            operation_id: Durable physical attempt requiring final usage.
            username: Its authoritative owner.
            client: Optional deterministic HTTP test transport.

        Returns:
            Confirmed operation with cumulative exact settlement.

        Raises:
            UsagePendingError: When identity, credentials, or final billing evidence is unavailable.
        """
        record = self.service.get_reconciliation(operation_id, username)
        operation, prices = record.operation, record.price_snapshot
        if operation.state == "settled":
            return operation
        if prices.get("provider") != "openrouter" or operation.cost_kind != "model":
            raise UsagePendingError("This operation is not an admitted OpenRouter generation.")
        identity = operation.provider_request_id
        digest = prices.get("credential_fingerprint")
        key = self.resolve_key(username, str(digest)) if digest else None
        if not identity or not key or json_fingerprint(key) != digest:
            raise UsagePendingError("Original provider identity or credential is unavailable; coverage is retained.")
        values = prices.get("policy") or {}
        if values.get("version") != "skynet-operation-pricing-v1":
            raise UsagePendingError("The original conversion policy is unavailable.")
        kind = values.get("kind")
        if kind not in {"managed_model", "byok_model"}:
            raise UsagePendingError("The original model billing scope is unavailable.")
        policy = ChargePolicy(
            kind=kind,
            credit_usd=exact_nonnegative(values["credit_usd"]),
            model_markup=exact_nonnegative(values["model_markup"]),
            byok_fee_fraction=exact_nonnegative(values["byok_fee_fraction"]),
        )
        if policy.credit_usd == Decimal(0):
            raise UsagePendingError("The original credit conversion is invalid.")
        if client is None:
            with httpx.Client(timeout=15, trust_env=False, follow_redirects=False) as owned:
                return self.reconcile(operation_id, username, client=owned)
        dispatcher = OpenRouterDispatcher(
            BudgetRuntime(
                self.service,
                username=username,
                budget_id=operation.budget_id,
                generation=operation.generation,
                phase=operation.phase,
            ),
            api_key=key,
            model=str(prices["model"]),
            role="reconciliation",
            policy=policy,
            client=client,
        )
        confirmed = dispatcher.reconcile(identity)
        if confirmed is None:
            raise UsagePendingError("The provider has not confirmed this generation's final usage.")
        usd, generation = confirmed
        charge = policy.convert(usd)
        return self.service.settle(
            operation_id,
            username,
            evidence_key=f"openrouter-generation:{identity}",
            actual_credits=charge.total,
            actual_wallet_credits=charge.wallet,
            evidence={"provider": "openrouter", "generation": generation, "provider_usd": str(usd)},
        )

    def sweep(self, *, limit: int = 100, after_id: str | None = None) -> ReconciliationPage:
        """Reconcile one bounded page while leaving every unknown operation covered.

        Args:
            limit: Maximum number of operations visited.
            after_id: Previous page cursor, if any.

        Returns:
            Confirmed or pending results and the next non-starving page cursor.
        """
        attempts = self.service.unsettled_operations(
            provider="openrouter",
            cost_kind="model",
            limit=limit,
            after_id=after_id,
        )
        results = []
        for operation_id, username in attempts:
            try:
                operation = self.reconcile(operation_id, username)
                results.append(ReconciliationResult(operation_id, operation.state))
            except (BudgetError, UsagePendingError) as error:
                results.append(ReconciliationResult(operation_id, "pending", str(error)))
        return ReconciliationPage(tuple(results), attempts[-1][0] if len(attempts) == limit else None)
