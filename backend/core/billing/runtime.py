"""Admit each physical paid operation before dispatch and retain uncertain usage."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Generic, TypeVar

from .budgets import (
    BudgetConflictError,
    BudgetFencedError,
    BudgetInFlightError,
    BudgetInsufficientError,
    BudgetService,
    BudgetUnreconciledError,
    OperationSnapshot,
)
from .operation_pricing import ChargePolicy, OperationQuote, json_fingerprint
from .signals import BudgetStopLatch

T = TypeVar("T")


class UsagePendingError(RuntimeError):
    """Prevent replay while a dispatched operation's bill remains unconfirmed."""


class OperationCompletedError(RuntimeError):
    """Require the caller to retrieve its durable result instead of dispatching again."""


@dataclass(frozen=True)
class PaidResult(Generic[T]):
    """Carry trusted provider usage separately from an optimizer's output."""

    value: T
    provider_usd: Decimal | None
    evidence: Mapping[str, Any]
    provider_request_id: str | None = None
    final: bool = True


class BudgetRuntime:
    """Bind trusted dispatch to one owner, phase, and fenced budget generation."""

    def __init__(
        self,
        service: BudgetService,
        *,
        username: str,
        budget_id: str,
        generation: int,
        phase: str,
        stop: BudgetStopLatch | None = None,
        wait_timeout: float = 600,
        recovery_headroom_operation_id: str | None = None,
        recovery_execution_headroom: tuple[Decimal, Decimal] | None = None,
    ) -> None:
        """Bind the spending context without passing database credentials to guest code.

        Args:
            service: Authoritative ledger in the trusted API or worker parent.
            username: Authenticated owner, never a guest-supplied account name.
            budget_id: The same budget used by setup and the submitted root job.
            generation: Epoch authorizing new work; replaced workers are fenced.
            phase: Setup or run attribution.
            stop: Optional shared stop latch for all concurrent optimizer lanes.
            wait_timeout: Maximum wait for covered work before reporting uncertainty.
            recovery_headroom_operation_id: Pre-authorized recovery hold consumed by replayed physical work.
            recovery_execution_headroom: Scope and wallet coverage retained for the first resumed operation.
        """
        self.service = service
        self.username = username
        self.budget_id = budget_id
        self.generation = generation
        self.phase = phase
        self.stop = stop or BudgetStopLatch()
        self.wait_timeout = wait_timeout
        self._changed = threading.Condition()
        self._recovery_headroom_operation_id = recovery_headroom_operation_id
        self._recovery_execution_headroom = recovery_execution_headroom
        self._release_headroom_after_next = False
        self._recovery_headroom_lock = threading.RLock()

    def check_admission(self) -> None:
        """Fence unpaid control calls against the same cancellation and recovery authority.

        Raises:
            BudgetReached: When the run stopped at its approved limit.
            BudgetError: When this owner or execution generation no longer admits work.
        """
        self.stop.check()
        budget = self.service.get(self.budget_id, self.username)
        if budget.generation != self.generation:
            raise BudgetFencedError("The execution generation is obsolete.")
        if budget.blocked_reason == "budget_reached":
            raise self.stop.trip("The approved budget has been reached.")
        if budget.state not in {"open", "attached"}:
            raise BudgetConflictError("This budget is not admitting new work.")
        if (self.phase == "setup") != (budget.job_id is None):
            raise BudgetConflictError("The operation phase does not match the budget's submission state.")

    def reserve(
        self,
        quote: OperationQuote,
        *,
        operation_key: str,
        cost_kind: str,
        role: str | None = None,
        attempt: int = 0,
        recovery_headroom: bool | None = None,
    ) -> OperationSnapshot:
        """Wait for in-flight coverage before declaring genuine budget exhaustion.

        Args:
            quote: Verified final request, resource bounds, and recorded prices.
            operation_key: Stable logical operation identity.
            cost_kind: Model or sandbox cost attribution.
            role: Task, judge, optimization, or runtime role.
            attempt: Physical retry number with independent usage coverage.
            recovery_headroom: Whether a model request claimed the bounded recovery
                hold. None lets non-model restoration operations use the hold.

        Returns:
            The admitted physical attempt or its existing idempotent record.

        Raises:
            UsagePendingError: When old or unconfirmed work prevents safe admission.
            BudgetReached: When no covered work can release sufficient allowance.
        """
        deadline = time.monotonic() + self.wait_timeout
        while True:
            self.stop.check()
            try:
                with self._recovery_headroom_lock:
                    use_headroom = recovery_headroom is not False
                    headroom_operation_id = self._recovery_headroom_operation_id if use_headroom else None
                    release_after = self._release_headroom_after_next and use_headroom
                    operation = self.service.reserve(
                        self.budget_id,
                        self.username,
                        operation_key=operation_key,
                        generation=self.generation,
                        phase=self.phase,
                        cost_kind=cost_kind,
                        request_fingerprint=quote.request_fingerprint,
                        price_snapshot=quote.price_snapshot,
                        max_credits=quote.maximum.total,
                        max_wallet_credits=quote.maximum.wallet,
                        attempt=attempt,
                        role=role,
                        headroom_operation_id=headroom_operation_id,
                    )
                    if headroom_operation_id is not None and release_after:
                        self.release_recovery_headroom()
                return operation
            except BudgetUnreconciledError as error:
                raise UsagePendingError(
                    "Previous work is awaiting confirmed usage; its coverage is retained."
                ) from error
            except BudgetInFlightError as error:
                if time.monotonic() >= deadline:
                    raise UsagePendingError(
                        "Covered work has not settled; no overlapping work was admitted."
                    ) from error
                with self._changed:
                    self._changed.wait(timeout=min(1.0, max(0.0, deadline - time.monotonic())))
            except BudgetInsufficientError as error:
                if self.phase == "setup":
                    raise
                self.service.stop_admission(self.budget_id, self.username, reason="budget_reached")
                raise self.stop.trip(str(error)) from error

    def finish_recovery_seed(self) -> None:
        """Retain only one proved operation after mandatory seed evaluation completes."""
        with self._recovery_headroom_lock:
            operation_id = self._recovery_headroom_operation_id
            remaining = self._recovery_execution_headroom
            if operation_id is None or remaining is None:
                return
            self.service.trim_recovery_headroom(
                operation_id,
                self.username,
                max_credits=remaining[0],
                max_wallet_credits=remaining[1],
            )
            if self._recovery_headroom_operation_id == operation_id:
                self._release_headroom_after_next = True

    def release_recovery_headroom(self) -> None:
        """Release any recovery coverage not transferred into physical work."""
        with self._recovery_headroom_lock:
            operation_id = self._recovery_headroom_operation_id
            self._recovery_headroom_operation_id = None
            self._release_headroom_after_next = False
        if operation_id is not None:
            self.service.release(operation_id, self.username)

    def execute(
        self,
        quote: OperationQuote,
        policy: ChargePolicy,
        dispatch: Callable[[], PaidResult[T]],
        *,
        operation_key: str,
        cost_kind: str,
        role: str | None = None,
        attempt: int = 0,
        recovery_headroom: bool | None = None,
    ) -> T:
        """Dispatch once under coverage and settle actual usage on every outcome.

        Args:
            quote: Bound tied to the exact request the adapter will dispatch.
            policy: The same conversion policy recorded in the quote.
            dispatch: Trusted single-attempt transport; it must not perform hidden retries.
            operation_key: Logical identity retained across delivery retries.
            cost_kind: Model or sandbox category.
            role: Optional model role attribution.
            attempt: Independent physical retry number.
            recovery_headroom: Whether this model attempt owns the bounded
                recovery hold. None is reserved for non-model restoration work.

        Returns:
            Provider result after evidence has been durably recorded.

        Raises:
            UsagePendingError: When dispatch may have incurred cost without final evidence.
            OperationCompletedError: When a completed attempt is replayed without its saved result.
        """
        if quote.price_snapshot.get("policy") != policy.snapshot():
            raise ValueError("Settlement policy must match the admitted quote.")
        operation = self.reserve(
            quote,
            operation_key=operation_key,
            cost_kind=cost_kind,
            role=role,
            attempt=attempt,
            recovery_headroom=recovery_headroom,
        )
        if operation.state == "settled":
            raise OperationCompletedError("The operation already completed; retrieve its saved result.")
        claimed = self.service.mark_dispatched(operation.id, self.username)
        if not claimed.dispatch_claimed:
            raise UsagePendingError("The attempt was already dispatched; do not repeat it.")
        try:
            result = dispatch()
            if result.provider_request_id:
                self.service.mark_dispatched(operation.id, self.username, result.provider_request_id)
            if result.provider_usd is None:
                self.service.mark_pending(
                    operation.id,
                    self.username,
                    evidence_key=json_fingerprint(dict(result.evidence)),
                    evidence=dict(result.evidence),
                )
                raise UsagePendingError("Provider usage is not yet confirmed; the reservation remains active.")
            charge = policy.convert(result.provider_usd)
            self.service.settle(
                operation.id,
                self.username,
                evidence_key=json_fingerprint(dict(result.evidence)),
                actual_credits=charge.total,
                actual_wallet_credits=charge.wallet,
                evidence=dict(result.evidence),
                final=result.final,
            )
            if not result.final:
                raise UsagePendingError("Provider usage is incomplete; remaining coverage is retained.")
            return result.value
        except BaseException:
            current = self.service.get_operation(operation.id, self.username)
            if current.state in {"dispatched", "pending"}:
                self.service.mark_pending(operation.id, self.username)
            raise
        finally:
            with self._changed:
                self._changed.notify_all()
