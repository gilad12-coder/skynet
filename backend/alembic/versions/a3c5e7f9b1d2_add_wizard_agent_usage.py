"""add wizard_agent_usage — daily turn counts of the free wizard agent

Revision ID: a3c5e7f9b1d2
Revises: f2b4d6a8c0e1
Create Date: 2026-10-04 18:00:00.000000

The black-box wizard's agent no longer spends the user's credits. Each turn
counts against a per-user daily cap instead, kept here per UTC day.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "a3c5e7f9b1d2"
down_revision: str | Sequence[str] | None = "f2b4d6a8c0e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the per-day wizard agent usage table idempotently."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS wizard_agent_usage (
            day DATE NOT NULL,
            username VARCHAR(255) NOT NULL,
            turns INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, username)
        )
        """
    )


def downgrade() -> None:
    """Drop the wizard agent usage table."""
    op.execute("DROP TABLE IF EXISTS wizard_agent_usage")
