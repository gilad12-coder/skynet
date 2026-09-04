"""Reserve and settle shared setup/run budgets before admitting paid work.

Provider adapters supply verified request bounds and cumulative actual charges.
This service never estimates provider prices, dispatches work or calls Stripe.
Every mutation locks the account before its budget, so unrelated interactive
debits and concurrent optimizer lanes cannot consume covered funding twice.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import uuid4

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from ..storage.models import (
    BillingCustomerModel,
    CreditLedgerModel,
    ExecutionBudgetModel,
    ExecutionOperationModel,
    ExecutionUsageEvidenceModel,
)
from .budget_amounts import (
    CREDIT_SCALE,
    MAX_CREDITS,
    budget_wallet_hold,
    ceil_credits,
    credit_units,
    credits_from_units,
)
from .service import StripeBillingService, account_committed_credits

_ACTIVE_STATES = ("reserved", "dispatched", "pending")
_DISPATCHED_STATES = ("dispatched", "pending")


class BudgetError(ValueError):
    """Reject invalid spending authority without dispatching paid work."""


class BudgetNotFoundError(BudgetError):
    """Hide missing budgets and budgets owned by another account identically."""


class BudgetConflictError(BudgetError):
    """Reject stale revisions or an idempotency key reused for different work."""


class BudgetTotalConflictError(BudgetConflictError):
    """Return the accepted total and minimum after a rejected budget edit."""

    def __init__(self, message: str, *, current_total_credits: int, minimum_total_credits: int) -> None:
        """Describe the authoritative values the client must restore.

        Args:
            message: Internal diagnostic for logs and focused tests.
            current_total_credits: Last total accepted by the ledger.
            minimum_total_credits: Lowest total that covers settled and reserved work.
        """
        super().__init__(message)
        self.current_total_credits = current_total_credits
        self.minimum_total_credits = minimum_total_credits


class BudgetFencedError(BudgetConflictError):
    """Reject new work from an obsolete execution generation."""


class BudgetInsufficientError(BudgetError):
    """Report work that cannot fit even after outstanding holds are released."""


class BudgetInFlightError(BudgetError):
    """Wait for already-covered work before deciding whether funding is exhausted."""


class BudgetUnreconciledError(BudgetInFlightError):
    """Keep old-generation work covered until its actual usage is established."""


class BudgetBoundExceededError(BudgetError):
    """Block admission after preserving evidence that exceeds its admitted bound."""


class BudgetFundingLostError(BudgetError):
    """Preserve coverage when an external wallet adjustment removed required funds."""


@dataclass(frozen=True)
class BudgetSnapshot:
    """Expose exact scope spending separately from rounded wallet movements."""

    id: str
    username: str
    total_credits: int
    revision: int
    generation: int
    state: str
    job_id: str | None
    setup_spent_credits: Decimal
    run_spent_credits: Decimal
    reserved_credits: Decimal
    available_credits: Decimal
    billed_credits: int
    wallet_setup_spent_credits: Decimal
    wallet_run_spent_credits: Decimal
    wallet_reserved_credits: int
    account_available_credits: int
    external_spent_credits: Decimal
    pending_operations: int
    blocked_reason: str | None


@dataclass(frozen=True)
class OperationSnapshot:
    """Describe one physical attempt and its current shared spending authority."""

    id: str
    budget_id: str
    operation_key: str
    attempt: int
    generation: int
    state: str
    phase: str
    cost_kind: str
    request_fingerprint: str
    max_credits: Decimal
    max_wallet_credits: Decimal
    actual_credits: Decimal
    actual_wallet_credits: Decimal
    provider_request_id: str | None
    budget: BudgetSnapshot
    dispatch_claimed: bool = False


@dataclass(frozen=True)
class ReconciliationSnapshot:
    """Expose trusted historical prices and usage only to parent reconciliation workers."""

    operation: OperationSnapshot
    price_snapshot: dict[str, Any]
    evidence: tuple[dict[str, Any], ...]


def _fingerprint(value: Any) -> str:
    """Hash canonical JSON while rejecting nonfinite or nonserializable evidence.

    Args:
        value: JSON-compatible request identity or usage evidence.

    Returns:
        SHA-256 digest of the canonical representation.
    """
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def _identifier(value: str, *, maximum: int = 128) -> str:
    """Validate a bounded nonempty idempotency or attribution identifier."""
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError("A nonempty bounded identifier is required.")
    return value


def _total(value: int) -> int:
    """Validate an authorized whole-credit budget."""
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_CREDITS:
        raise ValueError("Total budget must be a positive whole-credit amount.")
    return value


class BudgetService:
    """Own budget admission, immutable usage evidence and exactly-once settlement."""

    def __init__(self, *, engine: Any) -> None:
        """Bind the service to the same SQLAlchemy engine as the account wallet.

        Args:
            engine: Application database engine, without any Stripe connection.
        """
        self._engine = engine

    @contextmanager
    def _transaction(self, session: Session | None = None) -> Iterator[Session]:
        """Keep mutations atomic, optionally joining a caller's job-creation transaction.

        Args:
            session: Caller-owned transaction; omitted for a service-owned transaction.

        Yields:
            Session holding the complete atomic operation.
        """
        if session is not None:
            yield session
            return
        with Session(self._engine) as own:
            try:
                if self._engine.dialect.name == "sqlite":
                    own.execute(text("BEGIN IMMEDIATE"))
                yield own
                own.commit()
            except BaseException:
                own.rollback()
                raise

    def _wallet(self, session: Session, username: str) -> BillingCustomerModel:
        """Lock an existing prepaid account before reading or changing commitments.

        Args:
            session: Current mutation transaction.
            username: Authenticated account whose funding is required.

        Returns:
            Locked wallet with its legacy grant resolved.
        """
        wallet = session.get(BillingCustomerModel, username, with_for_update=True)
        if wallet is None:
            raise BudgetInsufficientError("The account has no funded wallet.")
        StripeBillingService(engine=self._engine)._resolve_grant(wallet, datetime.now(UTC))
        return wallet

    def _locked(
        self, session: Session, budget_id: str, username: str
    ) -> tuple[BillingCustomerModel, ExecutionBudgetModel]:
        """Lock the wallet and then its owned budget in a consistent order.

        Args:
            session: Current mutation transaction.
            budget_id: Spending envelope to lock.
            username: Authenticated owner required by the envelope.

        Returns:
            Locked wallet and budget.
        """
        wallet = self._wallet(session, username)
        budget = session.get(ExecutionBudgetModel, budget_id, with_for_update=True)
        if budget is None or budget.username != username:
            raise BudgetNotFoundError("Budget not found.")
        return wallet, budget

    def _operation(
        self, session: Session, operation_id: str, username: str
    ) -> tuple[BillingCustomerModel, ExecutionBudgetModel, ExecutionOperationModel]:
        """Resolve an attempt while retaining wallet-before-budget lock ordering.

        Args:
            session: Current mutation transaction.
            operation_id: Physical attempt being modified.
            username: Authenticated account owner.

        Returns:
            Locked wallet, budget and physical attempt.
        """
        budget_id = session.scalar(
            select(ExecutionOperationModel.budget_id)
            .join(ExecutionBudgetModel, ExecutionBudgetModel.id == ExecutionOperationModel.budget_id)
            .where(ExecutionOperationModel.id == operation_id, ExecutionBudgetModel.username == username)
        )
        if budget_id is None:
            raise BudgetNotFoundError("Operation not found.")
        wallet, budget = self._locked(session, budget_id, username)
        operation = session.get(ExecutionOperationModel, operation_id, with_for_update=True)
        assert operation is not None
        return wallet, budget, operation

    def _snapshot(self, session: Session, budget: ExecutionBudgetModel, wallet: BillingCustomerModel) -> BudgetSnapshot:
        """Read reconciled phase totals while account and budget locks are held.

        Args:
            session: Transaction owning the row locks.
            budget: Current spending envelope.
            wallet: Locked prepaid account.

        Returns:
            Consistent budget and funding amounts for the caller.
        """
        session.flush()
        totals = {
            phase: (int(scope or 0), int(charge or 0))
            for phase, scope, charge in session.execute(
                select(
                    ExecutionOperationModel.phase,
                    func.sum(ExecutionOperationModel.actual_units),
                    func.sum(ExecutionOperationModel.actual_wallet_units),
                )
                .where(ExecutionOperationModel.budget_id == budget.id)
                .group_by(ExecutionOperationModel.phase)
            )
        }
        pending = session.scalar(
            select(func.count())
            .select_from(ExecutionOperationModel)
            .where(
                ExecutionOperationModel.budget_id == budget.id,
                ExecutionOperationModel.state.in_(_DISPATCHED_STATES),
            )
        )
        setup, setup_wallet = totals.get("setup", (0, 0))
        run, run_wallet = totals.get("run", (0, 0))
        return BudgetSnapshot(
            id=budget.id,
            username=budget.username,
            total_credits=budget.total_credits,
            revision=budget.revision,
            generation=budget.generation,
            state=budget.state,
            job_id=budget.job_id,
            setup_spent_credits=credits_from_units(setup),
            run_spent_credits=credits_from_units(run),
            reserved_credits=credits_from_units(budget.reserved_units),
            available_credits=credits_from_units(
                max(0, budget.total_credits * CREDIT_SCALE - budget.settled_units - budget.reserved_units)
            ),
            billed_credits=budget.billed_credits,
            wallet_setup_spent_credits=credits_from_units(setup_wallet),
            wallet_run_spent_credits=credits_from_units(run_wallet),
            wallet_reserved_credits=budget_wallet_hold(budget),
            account_available_credits=max(
                0,
                int(wallet.credit_balance)
                + int(wallet.grant_remaining or 0)
                - account_committed_credits(session, budget.username),
            ),
            external_spent_credits=credits_from_units(budget.settled_units - budget.wallet_settled_units),
            pending_operations=int(pending or 0),
            blocked_reason=budget.blocked_reason,
        )

    def _operation_snapshot(
        self,
        session: Session,
        operation: ExecutionOperationModel,
        budget: ExecutionBudgetModel,
        wallet: BillingCustomerModel,
    ) -> OperationSnapshot:
        """Return one attempt without exposing provider credentials or request content.

        Args:
            session: Transaction owning the row locks.
            operation: Physical attempt whose state to expose.
            budget: Its spending envelope.
            wallet: Its locked prepaid account.

        Returns:
            Attempt state and the shared authoritative totals.
        """
        session.flush()
        return OperationSnapshot(
            id=operation.id,
            budget_id=budget.id,
            operation_key=operation.operation_key,
            attempt=operation.attempt,
            generation=operation.generation,
            state=operation.state,
            phase=operation.phase,
            cost_kind=operation.cost_kind,
            request_fingerprint=operation.request_fingerprint,
            max_credits=credits_from_units(operation.max_units),
            max_wallet_credits=credits_from_units(operation.max_wallet_units),
            actual_credits=credits_from_units(operation.actual_units),
            actual_wallet_credits=credits_from_units(operation.actual_wallet_units),
            provider_request_id=operation.provider_request_id,
            budget=self._snapshot(session, budget, wallet),
        )

    def create(self, username: str, total_credits: int, *, idempotency_key: str) -> BudgetSnapshot:
        """Create or recover a budget envelope without holding its unspent total.

        Args:
            username: Authenticated account owner.
            total_credits: Authorized combined scope limit.
            idempotency_key: Stable creation identity across browser retries.

        Returns:
            Current authoritative budget; paid work still requires a reservation.
        """
        total = _total(total_credits)
        key = _identifier(idempotency_key)
        fingerprint = _fingerprint({"total": total})
        with self._transaction() as session:
            wallet = self._wallet(session, username)
            budget = session.scalar(
                select(ExecutionBudgetModel).where(
                    ExecutionBudgetModel.username == username, ExecutionBudgetModel.creation_key == key
                )
            )
            if budget is not None:
                if budget.creation_fingerprint != fingerprint:
                    raise BudgetConflictError("Creation key was already used with a different total.")
                return self._snapshot(session, budget, wallet)
            if wallet.credit_balance + int(wallet.grant_remaining or 0) <= account_committed_credits(session, username):
                raise BudgetInsufficientError("The account has no available credits.")
            now = datetime.now(UTC)
            budget = ExecutionBudgetModel(
                id=str(uuid4()),
                username=username,
                creation_key=key,
                creation_fingerprint=fingerprint,
                total_credits=total,
                created_at=now,
                updated_at=now,
            )
            session.add(budget)
            return self._snapshot(session, budget, wallet)

    def find_by_creation_key(self, username: str, idempotency_key: str) -> BudgetSnapshot | None:
        """Recover existing account-owned authority by its stable creation identity.

        Args:
            username: Authenticated account owner.
            idempotency_key: Original budget creation identity.

        Returns:
            Current authoritative budget, or ``None`` when no matching creation exists.
        """
        key = _identifier(idempotency_key)
        with self._transaction() as session:
            wallet = self._wallet(session, username)
            budget = session.scalar(
                select(ExecutionBudgetModel).where(
                    ExecutionBudgetModel.username == username,
                    ExecutionBudgetModel.creation_key == key,
                )
            )
            return None if budget is None else self._snapshot(session, budget, wallet)

    def get(self, budget_id: str, username: str, *, session: Session | None = None) -> BudgetSnapshot:
        """Read current owned spending authority, including unresolved coverage.

        Args:
            budget_id: Envelope to read.
            username: Authenticated owner.
            session: Optional existing transaction for atomic setup or submission coordination.

        Returns:
            Authoritative amounts and execution state.
        """
        with self._transaction(session) as session:
            wallet, budget = self._locked(session, budget_id, username)
            return self._snapshot(session, budget, wallet)

    def get_operation(self, operation_id: str, username: str) -> OperationSnapshot:
        """Recover an existing attempt without dispatching or reserving it again.

        Args:
            operation_id: Existing physical attempt.
            username: Authenticated owner.

        Returns:
            Current operation and its shared budget.
        """
        with self._transaction() as session:
            wallet, budget, operation = self._operation(session, operation_id, username)
            return self._operation_snapshot(session, operation, budget, wallet)

    def get_reconciliation(self, operation_id: str, username: str) -> ReconciliationSnapshot:
        """Read immutable admission and receipt evidence for an owned physical attempt.

        Args:
            operation_id: Existing physical attempt.
            username: Authenticated owner or owner resolved by the trusted sweep.

        Returns:
            Current attempt and detached copies of its price and usage evidence.
        """
        with self._transaction() as session:
            wallet, budget, operation = self._operation(session, operation_id, username)
            evidence = session.scalars(
                select(ExecutionUsageEvidenceModel.evidence)
                .where(ExecutionUsageEvidenceModel.operation_id == operation_id)
                .order_by(ExecutionUsageEvidenceModel.created_at, ExecutionUsageEvidenceModel.id)
            ).all()
            return ReconciliationSnapshot(
                self._operation_snapshot(session, operation, budget, wallet),
                json.loads(json.dumps(operation.price_snapshot)),
                tuple(json.loads(json.dumps(document)) for document in evidence),
            )

    def unsettled_operations(
        self, *, provider: str, cost_kind: str, limit: int = 100, after_id: str | None = None
    ) -> list[tuple[str, str]]:
        """Page covered attempts for a trusted provider reconciliation worker.

        Args:
            provider: Provider recorded in the immutable price snapshot.
            cost_kind: Model or sandbox attribution to reconcile.
            limit: Maximum attempts returned in this bounded page.
            after_id: Previous page's final operation ID, if any.

        Returns:
            Operation IDs and their authoritative owners, ordered by ID.

        Raises:
            ValueError: When the page size is outside its bounded range.
        """
        if not 1 <= limit <= 1000:
            raise ValueError("Reconciliation page size must be between 1 and 1000.")
        with self._transaction() as session:
            statement = (
                select(ExecutionOperationModel.id, ExecutionBudgetModel.username)
                .join(ExecutionBudgetModel, ExecutionBudgetModel.id == ExecutionOperationModel.budget_id)
                .where(
                    ExecutionOperationModel.state.in_(_DISPATCHED_STATES),
                    ExecutionOperationModel.cost_kind == cost_kind,
                    ExecutionOperationModel.price_snapshot["provider"].as_string() == provider,
                )
                .order_by(ExecutionOperationModel.id)
                .limit(limit)
            )
            if after_id is not None:
                statement = statement.where(ExecutionOperationModel.id > after_id)
            return list(session.execute(statement))

    def update_total(
        self, budget_id: str, username: str, total_credits: int, *, expected_revision: int
    ) -> BudgetSnapshot:
        """Accept a versioned total without invalidating spent or covered amounts.

        Args:
            budget_id: Envelope being edited.
            username: Authenticated owner.
            total_credits: User's explicitly edited scope ceiling.
            expected_revision: Last accepted revision held by the caller.

        Returns:
            Updated authority, or the same revision for an unchanged total.
        """
        total = _total(total_credits)
        with self._transaction() as session:
            wallet, budget = self._locked(session, budget_id, username)
            minimum = ceil_credits(budget.settled_units + budget.reserved_units)
            if budget.revision != expected_revision:
                raise BudgetTotalConflictError(
                    "The budget changed; refresh its current revision.",
                    current_total_credits=budget.total_credits,
                    minimum_total_credits=minimum,
                )
            if total < minimum:
                raise BudgetTotalConflictError(
                    f"The minimum currently supportable total is {minimum} credits.",
                    current_total_credits=budget.total_credits,
                    minimum_total_credits=minimum,
                )
            if total > budget.total_credits and wallet.credit_balance + int(
                wallet.grant_remaining or 0
            ) <= account_committed_credits(session, username):
                raise BudgetInsufficientError("The account has no available credits for additional work.")
            if total != budget.total_credits:
                budget.total_credits = total
                budget.revision += 1
                budget.updated_at = datetime.now(UTC)
            return self._snapshot(session, budget, wallet)

    def attach_to_job(
        self, budget_id: str, username: str, job_id: str, *, expected_revision: int, session: Session | None = None
    ) -> BudgetSnapshot:
        """Attach one root job, optionally inside its caller-owned creation transaction.

        Args:
            budget_id: Setup envelope consumed by submission.
            username: Authenticated owner.
            job_id: Single root job receiving this allowance.
            expected_revision: Last accepted revision from preflight.
            session: Optional transaction creating and persisting the job atomically.

        Returns:
            Attached budget; identical retries preserve the existing linkage.
        """
        with self._transaction(session) as transaction:
            wallet, budget = self._locked(transaction, budget_id, username)
            if budget.job_id == job_id:
                return self._snapshot(transaction, budget, wallet)
            if budget.job_id is not None:
                raise BudgetConflictError("This setup budget already belongs to a submitted job.")
            if budget.revision != expected_revision or budget.state != "open":
                raise BudgetConflictError("The setup budget changed or is not open.")
            active_setup = transaction.scalar(
                select(ExecutionOperationModel.id)
                .where(
                    ExecutionOperationModel.budget_id == budget.id,
                    ExecutionOperationModel.phase == "setup",
                    ExecutionOperationModel.state.in_(_ACTIVE_STATES),
                )
                .limit(1)
            )
            if active_setup is not None:
                raise BudgetInFlightError("Setup operations must finish reconciliation before submission.")
            existing_job = transaction.scalar(
                select(ExecutionBudgetModel.id).where(ExecutionBudgetModel.job_id == job_id).limit(1)
            )
            if existing_job is not None:
                raise BudgetConflictError("This job already has a different budget.")
            budget.job_id = _identifier(job_id, maximum=36)
            budget.state = "attached"
            budget.revision += 1
            budget.updated_at = datetime.now(UTC)
            return self._snapshot(transaction, budget, wallet)

    def reserve(
        self,
        budget_id: str,
        username: str,
        *,
        operation_key: str,
        generation: int,
        phase: str,
        cost_kind: str,
        request_fingerprint: str,
        price_snapshot: Mapping[str, Any],
        max_credits: Decimal | str | int | float,
        max_wallet_credits: Decimal | str | int | float | None = None,
        attempt: int = 0,
        role: str | None = None,
        headroom_operation_id: str | None = None,
        session: Session | None = None,
    ) -> OperationSnapshot:
        """Admit one physical attempt under its verified scope and wallet bounds.

        Args:
            budget_id: Shared setup/run envelope.
            username: Authenticated owner, never taken from untrusted usage data.
            operation_key: Logical work identity retained across request delivery retries.
            generation: Current execution epoch.
            phase: Setup or run attribution.
            cost_kind: Model, sandbox or other explicitly priced category.
            request_fingerprint: Digest of the exact resolved request and enforced limits.
            price_snapshot: Versioned prices and bound evidence supplied by the adapter.
            max_credits: Maximum combined scope charge for this physical attempt.
            max_wallet_credits: Maximum Skynet wallet charge; defaults to the scope bound.
            attempt: Physical retry number; a new billable retry needs a new attempt.
            role: Optional task, judge, proposer or runtime attribution.
            headroom_operation_id: Recovery hold transferred atomically into this physical operation.
            session: Optional caller transaction for atomic lifecycle publication.

        Returns:
            The reserved operation or its existing identical attempt.

        Raises:
            BudgetInsufficientError: When the required work cannot fit without a budget/funding change.
            BudgetInFlightError: When settling covered work may make the admission possible.
        """
        key = _identifier(operation_key)
        request_fingerprint = _identifier(request_fingerprint)
        cost_kind = _identifier(cost_kind, maximum=32)
        if phase not in {"setup", "run"} or attempt < 0 or generation < 0:
            raise ValueError("Invalid operation phase, attempt or generation.")
        if role is not None:
            _identifier(role, maximum=64)
        scope = credit_units(max_credits)
        charge = credit_units(max_credits if max_wallet_credits is None else max_wallet_credits)
        if charge > scope:
            raise ValueError("Wallet coverage cannot exceed the combined scope coverage.")
        prices = dict(price_snapshot)
        if not prices or not prices.get("version"):
            raise ValueError("A versioned applicable price snapshot is required.")
        admission = _fingerprint(
            {
                "request": request_fingerprint,
                "prices": prices,
                "scope": scope,
                "wallet": charge,
                "phase": phase,
                "kind": cost_kind,
                "role": role,
                "generation": generation,
            }
        )
        with self._transaction(session) as session:
            wallet, budget = self._locked(session, budget_id, username)
            if generation != budget.generation:
                raise BudgetFencedError("The execution generation is obsolete.")
            operation = session.scalar(
                select(ExecutionOperationModel).where(
                    ExecutionOperationModel.budget_id == budget_id,
                    ExecutionOperationModel.operation_key == key,
                    ExecutionOperationModel.attempt == attempt,
                )
            )
            if operation is not None:
                if operation.admission_fingerprint != admission:
                    raise BudgetConflictError("Operation key was reused for different admitted work.")
                return self._operation_snapshot(session, operation, budget, wallet)
            if budget.state not in {"open", "attached"}:
                raise BudgetConflictError("This budget is not admitting new work.")
            if (phase == "setup" and budget.job_id is not None) or (phase == "run" and budget.job_id is None):
                raise BudgetConflictError("The operation phase does not match the budget's submission state.")
            unresolved = session.scalar(
                select(ExecutionOperationModel.id)
                .where(
                    ExecutionOperationModel.budget_id == budget_id,
                    ExecutionOperationModel.generation < generation,
                    ExecutionOperationModel.state.in_(_DISPATCHED_STATES),
                )
                .limit(1)
            )
            if unresolved is not None:
                raise BudgetUnreconciledError("Previous-generation paid work must be reconciled before recovery.")
            headroom = None
            if headroom_operation_id is not None:
                headroom = session.get(ExecutionOperationModel, headroom_operation_id, with_for_update=True)
                if (
                    headroom is None
                    or headroom.budget_id != budget.id
                    or headroom.generation != generation
                    or headroom.cost_kind != "recovery_headroom"
                ):
                    raise BudgetConflictError("The recovery headroom does not belong to this execution generation.")
                if headroom.state != "reserved" or scope > headroom.max_units or charge > headroom.max_wallet_units:
                    raise BudgetInsufficientError("Recovery work exceeded its pre-authorized operation bounds.")
            else:
                remaining = budget.total_credits * CREDIT_SCALE - budget.settled_units
                if scope > remaining:
                    raise BudgetInsufficientError("The next operation exceeds the remaining total budget.")
                if scope > remaining - budget.reserved_units:
                    raise BudgetInFlightError("Covered work must settle before this operation can fit.")
                held = account_committed_credits(session, username)
                wallet_balance = int(wallet.credit_balance) + int(wallet.grant_remaining or 0)
                hold_delta = (
                    ceil_credits(budget.wallet_settled_units + budget.wallet_reserved_units + charge)
                    - budget.billed_credits
                    - budget_wallet_hold(budget)
                )
                if hold_delta > wallet_balance - held:
                    after_release = ceil_credits(budget.wallet_settled_units + charge) - budget.billed_credits
                    if after_release <= wallet_balance:
                        raise BudgetInFlightError("Other covered work currently holds the required wallet credits.")
                    raise BudgetInsufficientError("The account cannot fund the next operation.")
            now = datetime.now(UTC)
            operation = ExecutionOperationModel(
                id=str(uuid4()),
                budget_id=budget.id,
                operation_key=key,
                attempt=attempt,
                generation=generation,
                phase=phase,
                cost_kind=cost_kind,
                role=role,
                request_fingerprint=request_fingerprint,
                admission_fingerprint=admission,
                price_snapshot=prices,
                max_units=scope,
                max_wallet_units=charge,
                created_at=now,
                updated_at=now,
            )
            session.add(operation)
            if headroom is None:
                budget.reserved_units += scope
                budget.wallet_reserved_units += charge
            else:
                headroom.max_units -= scope
                headroom.max_wallet_units -= charge
                headroom.updated_at = now
                if headroom.max_units == 0 and headroom.max_wallet_units == 0:
                    headroom.state = "released"
            budget.updated_at = now
            return self._operation_snapshot(session, operation, budget, wallet)

    def mark_dispatched(
        self, operation_id: str, username: str, provider_request_id: str | None = None
    ) -> OperationSnapshot:
        """Durably mark dispatch before sending a provider request; never release on uncertainty.

        Args:
            operation_id: Reserved physical attempt.
            username: Authenticated owner.
            provider_request_id: Provider identity when known before dispatch.

        Returns:
            Attempt state with dispatch_claimed true only for its single sender.
        """
        with self._transaction() as session:
            wallet, budget, operation = self._operation(session, operation_id, username)
            if operation.generation != budget.generation and operation.state not in _DISPATCHED_STATES:
                raise BudgetFencedError("The execution generation is obsolete.")
            if operation.state not in _ACTIVE_STATES:
                raise BudgetConflictError("A finished or released operation cannot be dispatched.")
            if provider_request_id is not None:
                _identifier(provider_request_id, maximum=255)
                if operation.provider_request_id not in {None, provider_request_id}:
                    raise BudgetConflictError("The operation already has a different provider request identity.")
                operation.provider_request_id = provider_request_id
            if operation.state == "reserved":
                if budget.state == "blocked":
                    raise BudgetConflictError("This budget is quarantined pending usage reconciliation.")
                if budget.state not in {"open", "attached"}:
                    raise BudgetConflictError("This budget is not admitting new work.")
                if (operation.phase == "setup") != (budget.job_id is None):
                    raise BudgetConflictError("The operation phase does not match the budget's submission state.")
                operation.state = "dispatched"
                operation.dispatched_at = datetime.now(UTC)
                claimed = True
            else:
                claimed = False
            operation.updated_at = datetime.now(UTC)
            return replace(self._operation_snapshot(session, operation, budget, wallet), dispatch_claimed=claimed)

    def mark_pending(
        self,
        operation_id: str,
        username: str,
        *,
        evidence_key: str | None = None,
        evidence: Mapping[str, Any] | None = None,
    ) -> OperationSnapshot:
        """Retain coverage after a lost response, interruption or incomplete usage report.

        Args:
            operation_id: Previously dispatched attempt.
            username: Authenticated owner.
            evidence_key: Optional immutable identity for an incomplete provider receipt.
            evidence: Raw trusted usage that cannot yet establish a charge.

        Returns:
            Pending operation with its remaining coverage intact.
        """
        if (evidence_key is None) != (evidence is None):
            raise ValueError("Pending evidence requires both an identity and a document.")
        document = dict(evidence) if evidence is not None else None
        key = _identifier(evidence_key) if evidence_key is not None else None
        fingerprint = _fingerprint({"pending_evidence": document}) if document is not None else None
        with self._transaction() as session:
            wallet, budget, operation = self._operation(session, operation_id, username)
            if operation.state not in _DISPATCHED_STATES:
                raise BudgetConflictError("Only dispatched work can await reconciliation.")
            if key is not None:
                prior = session.scalar(
                    select(ExecutionUsageEvidenceModel).where(
                        ExecutionUsageEvidenceModel.operation_id == operation_id,
                        ExecutionUsageEvidenceModel.evidence_key == key,
                    )
                )
                if prior is not None and prior.fingerprint != fingerprint:
                    raise BudgetConflictError("Pending provider evidence is immutable.")
                if prior is None:
                    session.add(
                        ExecutionUsageEvidenceModel(
                            id=str(uuid4()),
                            operation_id=operation_id,
                            evidence_key=key,
                            fingerprint=fingerprint,
                            actual_units=operation.actual_units,
                            actual_wallet_units=operation.actual_wallet_units,
                            billed_credits=0,
                            final=False,
                            issue="usage_pending",
                            evidence=document,
                            created_at=datetime.now(UTC),
                        )
                    )
            operation.state = "pending"
            operation.updated_at = datetime.now(UTC)
            return self._operation_snapshot(session, operation, budget, wallet)

    def release(self, operation_id: str, username: str) -> OperationSnapshot:
        """Release coverage only when the operation is known never to have dispatched.

        Args:
            operation_id: Unstarted reserved attempt.
            username: Authenticated owner.

        Returns:
            Released operation without a usage charge.

        Raises:
            BudgetUnreconciledError: If the attempt may already have incurred costs.
        """
        with self._transaction() as session:
            wallet, budget, operation = self._operation(session, operation_id, username)
            if operation.state == "released":
                return self._operation_snapshot(session, operation, budget, wallet)
            if operation.state != "reserved" or operation.dispatched_at is not None:
                raise BudgetUnreconciledError("Dispatched work requires actual usage reconciliation, not release.")
            budget.reserved_units -= operation.max_units
            budget.wallet_reserved_units -= operation.max_wallet_units
            operation.state = "released"
            operation.updated_at = budget.updated_at = datetime.now(UTC)
            return self._operation_snapshot(session, operation, budget, wallet)

    def trim_recovery_headroom(
        self,
        operation_id: str,
        username: str,
        *,
        max_credits: Decimal | str | int | float,
        max_wallet_credits: Decimal | str | int | float,
    ) -> OperationSnapshot:
        """Release unused seed coverage while retaining one proved execution operation.

        Args:
            operation_id: Recovery hold already transferred into replayed physical work.
            username: Authenticated account owner.
            max_credits: Remaining combined scope coverage to retain.
            max_wallet_credits: Remaining wallet coverage to retain.

        Returns:
            Updated recovery hold and authoritative budget totals.
        """
        scope = credit_units(max_credits)
        charge = credit_units(max_wallet_credits)
        with self._transaction() as session:
            wallet, budget, operation = self._operation(session, operation_id, username)
            if operation.cost_kind != "recovery_headroom" or operation.state not in {"reserved", "released"}:
                raise BudgetConflictError("Only active recovery headroom can be trimmed.")
            if operation.state == "released":
                if scope or charge:
                    raise BudgetInsufficientError("Recovery consumed its execution headroom before activation.")
                return self._operation_snapshot(session, operation, budget, wallet)
            if scope > operation.max_units or charge > operation.max_wallet_units:
                raise BudgetInsufficientError("Recovery consumed more than its proved seed-evaluation allowance.")
            budget.reserved_units -= operation.max_units - scope
            budget.wallet_reserved_units -= operation.max_wallet_units - charge
            operation.max_units = scope
            operation.max_wallet_units = charge
            operation.updated_at = budget.updated_at = datetime.now(UTC)
            if scope == 0 and charge == 0:
                operation.state = "released"
            return self._operation_snapshot(session, operation, budget, wallet)

    def fence_generation(
        self, budget_id: str, username: str, *, expected_generation: int, session: Session | None = None
    ) -> BudgetSnapshot:
        """Revoke old admission and release only its provably undispatched reservations.

        Args:
            budget_id: Envelope whose old worker is being fenced.
            username: Authenticated owner.
            expected_generation: Generation currently owned by the recovery coordinator.
            session: Optional recovery transaction, retaining account-before-budget locking.

        Returns:
            New epoch, retaining all old dispatched coverage until reconciliation.
        """
        with self._transaction(session) as session:
            wallet, budget = self._locked(session, budget_id, username)
            if budget.generation != expected_generation:
                raise BudgetFencedError("The execution generation has already changed.")
            budget.generation += 1
            for operation in session.scalars(
                select(ExecutionOperationModel).where(
                    ExecutionOperationModel.budget_id == budget_id, ExecutionOperationModel.state == "reserved"
                )
            ):
                budget.reserved_units -= operation.max_units
                budget.wallet_reserved_units -= operation.max_wallet_units
                operation.state = "released"
                operation.updated_at = datetime.now(UTC)
            budget.updated_at = datetime.now(UTC)
            return self._snapshot(session, budget, wallet)

    def stop_admission(
        self,
        budget_id: str,
        username: str,
        *,
        reason: str,
        session: Session | None = None,
    ) -> BudgetSnapshot:
        """Close the envelope to new work while preserving all unsettled obligations.

        Args:
            budget_id: Envelope no longer allowed to admit work.
            username: Authenticated owner.
            reason: Stable terminal or administrative reason.
            session: Optional caller transaction for atomic lifecycle publication.

        Returns:
            Closed authority with pending usage and holds retained.
        """
        with self._transaction(session) as session:
            wallet, budget = self._locked(session, budget_id, username)
            if budget.state == "blocked":
                return self._snapshot(session, budget, wallet)
            budget.state = "closed"
            budget.blocked_reason = _identifier(reason)
            budget.updated_at = datetime.now(UTC)
            return self._snapshot(session, budget, wallet)

    def resume_admission(self, budget_id: str, username: str, *, expected_generation: int) -> BudgetSnapshot:
        """Reopen an explicitly resumed attached job after obligations are reconciled.

        The lifecycle coordinator must first verify the same job's checkpoint
        compatibility and quote coverage. Changing funding never calls this method.

        Args:
            budget_id: Closed execution envelope bound to the resumed root job.
            username: Authenticated owner.
            expected_generation: Epoch authorized by the recovery coordinator.

        Returns:
            Attached authority ready for new per-operation admission.

        Raises:
            BudgetUnreconciledError: When prior work still owns a reservation.
            BudgetInsufficientError: When no total allowance remains.
        """
        with self._transaction() as session:
            wallet, budget = self._locked(session, budget_id, username)
            if budget.generation != expected_generation:
                raise BudgetFencedError("The execution generation is obsolete.")
            if budget.job_id is None or budget.state not in {"closed", "attached"}:
                raise BudgetConflictError("Only an attached, reconciled job can resume admission.")
            active = session.scalar(
                select(ExecutionOperationModel.id)
                .where(
                    ExecutionOperationModel.budget_id == budget_id, ExecutionOperationModel.state.in_(_ACTIVE_STATES)
                )
                .limit(1)
            )
            if active is not None:
                raise BudgetUnreconciledError("Previous paid work must reconcile before admission resumes.")
            if budget.settled_units >= budget.total_credits * CREDIT_SCALE:
                raise BudgetInsufficientError("The total budget has no remaining allowance.")
            budget.state = "attached"
            budget.blocked_reason = None
            budget.updated_at = datetime.now(UTC)
            return self._snapshot(session, budget, wallet)

    def settle(
        self,
        operation_id: str,
        username: str,
        *,
        evidence_key: str,
        actual_credits: Decimal | str | int | float,
        evidence: Mapping[str, Any],
        final: bool = True,
        actual_wallet_credits: Decimal | str | int | float | None = None,
    ) -> OperationSnapshot:
        """Settle cumulative actual usage once, including partial and failed attempts.

        Args:
            operation_id: Physical attempt being reconciled.
            username: Authenticated owner.
            evidence_key: Stable provider-event identity within this attempt.
            actual_credits: Cumulative actual combined scope charge, not an increment.
            evidence: Authoritative provider/runtime usage and its attribution.
            final: Whether all usage is reconciled and remaining coverage can be released.
            actual_wallet_credits: Cumulative wallet charge, excluding externally paid BYOK usage.

        Returns:
            Updated attempt and authoritative budget snapshot.

        Raises:
            BudgetBoundExceededError: After preserving evidence and blocking the faulty priced path.
            BudgetFundingLostError: After preserving evidence when an external adjustment removed funding.
        """
        key = _identifier(evidence_key)
        scope = credit_units(actual_credits)
        charge = credit_units(actual_credits if actual_wallet_credits is None else actual_wallet_credits)
        if charge > scope:
            raise ValueError("Wallet usage cannot exceed combined scope usage.")
        document = dict(evidence)
        fingerprint = _fingerprint({"scope": scope, "wallet": charge, "final": final, "evidence": document})
        issue: str | None = None
        with self._transaction() as session:
            wallet, budget, operation = self._operation(session, operation_id, username)
            prior = session.scalar(
                select(ExecutionUsageEvidenceModel).where(
                    ExecutionUsageEvidenceModel.operation_id == operation_id,
                    ExecutionUsageEvidenceModel.evidence_key == key,
                )
            )
            if prior is not None:
                if prior.fingerprint != fingerprint:
                    raise BudgetConflictError(
                        "Usage evidence is immutable; this identity already has different evidence."
                    )
                issue = prior.issue
            else:
                if operation.state not in _DISPATCHED_STATES:
                    raise BudgetConflictError("Usage may only settle a dispatched attempt.")
                if scope < operation.actual_units or charge < operation.actual_wallet_units:
                    raise BudgetConflictError("Cumulative usage cannot decrease.")
                scope_delta = scope - operation.actual_units
                wallet_delta = charge - operation.actual_wallet_units
                billed = ceil_credits(budget.wallet_settled_units + wallet_delta) - budget.billed_credits
                if scope > operation.max_units or charge > operation.max_wallet_units:
                    issue = "bound_exceeded"
                elif billed > int(wallet.credit_balance) + int(wallet.grant_remaining or 0):
                    issue = "funding_lost"
                event_id = str(uuid4())
                session.add(
                    ExecutionUsageEvidenceModel(
                        id=event_id,
                        operation_id=operation_id,
                        evidence_key=key,
                        fingerprint=fingerprint,
                        actual_units=scope,
                        actual_wallet_units=charge,
                        billed_credits=0 if issue else billed,
                        final=final,
                        issue=issue,
                        evidence=document,
                        created_at=datetime.now(UTC),
                    )
                )
                if issue:
                    budget.state = "blocked"
                    budget.blocked_reason = issue
                    operation.state = "pending"
                else:
                    budget.settled_units += scope_delta
                    budget.wallet_settled_units += wallet_delta
                    budget.reserved_units -= scope_delta
                    budget.wallet_reserved_units -= wallet_delta
                    operation.actual_units = scope
                    operation.actual_wallet_units = charge
                    if final:
                        budget.reserved_units -= operation.max_units - scope
                        budget.wallet_reserved_units -= operation.max_wallet_units - charge
                        operation.state = "settled"
                    else:
                        operation.state = "pending"
                    if billed:
                        from_grant = min(int(wallet.grant_remaining or 0), billed)
                        wallet.grant_remaining = int(wallet.grant_remaining or 0) - from_grant
                        wallet.credit_balance -= billed - from_grant
                        budget.billed_credits += billed
                        session.add(
                            CreditLedgerModel(
                                username=username,
                                delta_credits=-billed,
                                kind="run",
                                description=f"Optimization {operation.phase}: {operation.cost_kind}",
                                budget_id=budget.id,
                                settlement_key=event_id,
                                model=document.get("model"),
                            )
                        )
                        wallet.updated_at = datetime.now(UTC)
                operation.updated_at = budget.updated_at = datetime.now(UTC)
            snapshot = self._operation_snapshot(session, operation, budget, wallet)
        if issue == "bound_exceeded":
            raise BudgetBoundExceededError(
                "Reported usage exceeded its verified bound; evidence and coverage were retained."
            )
        if issue == "funding_lost":
            raise BudgetFundingLostError(
                "Account funding changed after admission; usage remains pending reconciliation."
            )
        return snapshot
