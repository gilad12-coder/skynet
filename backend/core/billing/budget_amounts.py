"""Represent exact credit amounts and account holds without provider dependencies."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..storage.models import ExecutionBudgetModel

CREDIT_SCALE = 1_000_000_000
MAX_CREDITS = 1_000_000_000


def credit_units(value: Decimal | str | int | float) -> int:
    """Convert credits to exact billionth-credit units without silently rounding.

    Args:
        value: Nonnegative finite amount with at most nine fractional digits.

    Returns:
        Exact integer representation.

    Raises:
        ValueError: When the amount is negative, nonfinite or cannot be represented.
    """
    try:
        amount = Decimal(str(value))
        units = amount * CREDIT_SCALE
        if not amount.is_finite() or amount < 0 or amount > MAX_CREDITS or units != units.to_integral_value():
            raise ValueError("Credit amounts require nonnegative values with at most nine fractional digits.")
        return int(units)
    except (InvalidOperation, TypeError) as exc:
        raise ValueError("Invalid credit amount.") from exc


def credits_from_units(units: int) -> Decimal:
    """Return the exact credit amount represented by integer units."""
    return Decimal(units) / CREDIT_SCALE


def ceil_credits(units: int) -> int:
    """Round one cumulative amount upward to whole wallet credits."""
    return (units + CREDIT_SCALE - 1) // CREDIT_SCALE


def budget_wallet_hold(budget: ExecutionBudgetModel) -> int:
    """Return wallet coverage beyond the cumulative amount already debited."""
    return max(0, ceil_credits(budget.wallet_settled_units + budget.wallet_reserved_units) - budget.billed_credits)


def wallet_reserved_credits(session: Session, username: str) -> int:
    """Sum an account's active budget holds while its wallet row is locked.

    Args:
        session: Caller-owned transaction, serialized by the account wallet row.
        username: Account whose covered work must remain funded.

    Returns:
        Whole credits committed beyond amounts already debited.
    """
    budgets = session.scalars(select(ExecutionBudgetModel).where(ExecutionBudgetModel.username == username))
    return sum(budget_wallet_hold(budget) for budget in budgets)
