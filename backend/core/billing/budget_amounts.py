"""Represent exact cent amounts and account holds without provider dependencies."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..storage.models import ExecutionBudgetModel

CENT_SCALE = 1_000_000_000
MAX_CENTS = 1_000_000_000


def cent_units(value: Decimal | str | int | float) -> int:
    """Convert cents to exact billionth-cent units without silently rounding.

    Args:
        value: Nonnegative finite amount with at most nine fractional digits.

    Returns:
        Exact integer representation.

    Raises:
        ValueError: When the amount is negative, nonfinite or cannot be represented.
    """
    try:
        amount = Decimal(str(value))
        units = amount * CENT_SCALE
        if not amount.is_finite() or amount < 0 or amount > MAX_CENTS or units != units.to_integral_value():
            raise ValueError("Cent amounts require nonnegative values with at most nine fractional digits.")
        return int(units)
    except (InvalidOperation, TypeError) as exc:
        raise ValueError("Invalid cent amount.") from exc


def cents_from_units(units: int) -> Decimal:
    """Return the exact cent amount represented by integer units."""
    return Decimal(units) / CENT_SCALE


def ceil_cents(units: int) -> int:
    """Round one cumulative amount upward to whole cents."""
    return (units + CENT_SCALE - 1) // CENT_SCALE


def budget_wallet_hold(budget: ExecutionBudgetModel) -> int:
    """Return wallet coverage beyond the cumulative amount already debited."""
    return max(0, ceil_cents(budget.wallet_settled_units + budget.wallet_reserved_units) - budget.billed_cents)


def wallet_reserved_cents(session: Session, username: str) -> int:
    """Sum an account's active budget holds while its wallet row is locked.

    Args:
        session: Caller-owned transaction, serialized by the account wallet row.
        username: Account whose covered work must remain funded.

    Returns:
        Whole cents committed beyond amounts already debited.
    """
    budgets = session.scalars(select(ExecutionBudgetModel).where(ExecutionBudgetModel.username == username))
    return sum(budget_wallet_hold(budget) for budget in budgets)
