"""Let an execution budget draw on the account instead of a fixed total.

Revision ID: b7c2e4d9f130
Revises: a83f9d1c6e42
Create Date: 2026-09-05 09:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "b7c2e4d9f130"
down_revision: str | None = "a83f9d1c6e42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the flag that lets a budget admit work past its total until the account runs dry."""
    op.execute("ALTER TABLE execution_budgets ADD COLUMN IF NOT EXISTS uncapped BOOLEAN NOT NULL DEFAULT FALSE")


def downgrade() -> None:
    """Drop the flag; every budget falls back to its stored total."""
    op.execute("ALTER TABLE execution_budgets DROP COLUMN IF EXISTS uncapped")
