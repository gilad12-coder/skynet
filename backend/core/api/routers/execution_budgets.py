"""Expose account-owned spending authority shared by wizard setup and its run."""

from __future__ import annotations

from dataclasses import asdict
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from ...billing.budget_amounts import MAX_CREDITS
from ...billing.budgets import (
    BudgetConflictError,
    BudgetError,
    BudgetInFlightError,
    BudgetInsufficientError,
    BudgetNotFoundError,
    BudgetService,
    BudgetSnapshot,
    BudgetTotalConflictError,
)
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]
IdempotencyKey = Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)]


class CreateExecutionBudgetRequest(BaseModel):
    total_credits: int = Field(ge=1, le=MAX_CREDITS, strict=True)
    uncapped: bool = Field(default=False, strict=True)


class UpdateExecutionBudgetRequest(CreateExecutionBudgetRequest):
    expected_revision: int = Field(ge=0, strict=True)


class ExecutionBudgetResponse(BaseModel):
    id: str
    total_credits: int
    uncapped: bool
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


def budget_response(snapshot: BudgetSnapshot) -> ExecutionBudgetResponse:
    """Serialize exact credit amounts without exposing an account identifier.

    Args:
        snapshot: Authoritative state read under the ledger's transaction locks.

    Returns:
        Response whose fractional amounts are decimal strings in JSON.
    """
    return ExecutionBudgetResponse.model_validate(asdict(snapshot))


def budget_http_error(error: BudgetError) -> HTTPException:
    """Map admission failures to stable client states without authorizing work.

    Args:
        error: Expected ledger ownership, funding, or concurrency failure.

    Returns:
        An HTTP error with a machine-readable code and actionable message.
    """
    if isinstance(error, BudgetNotFoundError):
        status, code = 404, "budget.not_found"
    elif isinstance(error, BudgetInsufficientError):
        status, code = 402, "budget.insufficient"
    elif isinstance(error, BudgetInFlightError):
        status, code = 409, "budget.pending"
    elif isinstance(error, BudgetTotalConflictError):
        return DomainError(
            "budget.conflict",
            status=409,
            current_total_credits=error.current_total_credits,
            minimum_total_credits=error.minimum_total_credits,
        )
    elif isinstance(error, BudgetConflictError):
        status, code = 409, "budget.conflict"
    else:
        status, code = 422, "budget.invalid"
    return DomainError(code, status=status)


def create_execution_budgets_router(*, job_store: Any) -> APIRouter:
    """Build authenticated budget routes against the shared account database.

    Args:
        job_store: Job storage exposing the SQLAlchemy wallet engine.

    Returns:
        Router for creating, restoring, and editing a draft's spending limit.
    """
    router = APIRouter(prefix="/execution-budgets")

    def ledger() -> BudgetService:
        """Require authoritative storage when a budget endpoint is actually invoked."""
        engine = getattr(job_store, "engine", None)
        if engine is None:
            raise DomainError("budget.invalid", status=503)
        return BudgetService(engine=engine)

    @router.post("", response_model=ExecutionBudgetResponse)
    def create_budget(
        request: CreateExecutionBudgetRequest,
        user: AuthenticatedUserDep,
        idempotency_key: IdempotencyKey,
    ) -> ExecutionBudgetResponse:
        """Create or replay one account-owned draft budget.

        Args:
            request: User-selected total, shared across setup and execution.
            user: Authenticated budget owner.
            idempotency_key: Stable identity reused after network uncertainty.

        Returns:
            The new or previously created authoritative budget.
        """
        try:
            return budget_response(
                ledger().create(
                    user.username, request.total_credits, idempotency_key=idempotency_key, uncapped=request.uncapped
                )
            )
        except BudgetError as error:
            raise budget_http_error(error) from error

    @router.get("/{budget_id}", response_model=ExecutionBudgetResponse)
    def get_budget(budget_id: str, user: AuthenticatedUserDep) -> ExecutionBudgetResponse:
        """Refresh an owned budget without resetting settled spend or holds.

        Args:
            budget_id: Stable budget saved with the wizard draft.
            user: Authenticated budget owner.

        Returns:
            Current settled and reserved credit totals.
        """
        try:
            return budget_response(ledger().get(budget_id, user.username))
        except BudgetError as error:
            raise budget_http_error(error) from error

    @router.patch("/{budget_id}", response_model=ExecutionBudgetResponse)
    def update_budget(
        budget_id: str, request: UpdateExecutionBudgetRequest, user: AuthenticatedUserDep
    ) -> ExecutionBudgetResponse:
        """Change the approved total only against the revision the user reviewed.

        Args:
            budget_id: Account-owned setup or run spending authority.
            request: New total and optimistic concurrency revision.
            user: Authenticated budget owner.

        Returns:
            Updated total while preserving previous usage and active holds.
        """
        try:
            return budget_response(
                ledger().update_total(
                    budget_id,
                    user.username,
                    request.total_credits,
                    expected_revision=request.expected_revision,
                    uncapped=request.uncapped,
                )
            )
        except BudgetError as error:
            raise budget_http_error(error) from error

    return router
