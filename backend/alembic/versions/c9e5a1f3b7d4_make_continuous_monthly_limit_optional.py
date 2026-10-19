"""make the continuous monthly limit optional

Revision ID: c9e5a1f3b7d4
Revises: b8d4f0e2a6c3
Create Date: 2026-10-19 07:00:00.000000

A plan may have no monthly limit; then only the wallet balance gates a run.
This is its own revision because databases that already ran
``a7c3e9d1f5b2`` keep the column ``NOT NULL`` otherwise.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c9e5a1f3b7d4"
down_revision: str | None = "b8d4f0e2a6c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Allow a plan without a monthly limit."""
    op.alter_column("continuous_plans", "monthly_limit_cents", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    """Give unlimited plans their per-run budget as the limit, then require one."""
    op.execute("UPDATE continuous_plans SET monthly_limit_cents = cycle_budget_cents WHERE monthly_limit_cents IS NULL")
    op.alter_column("continuous_plans", "monthly_limit_cents", existing_type=sa.Integer(), nullable=False)
