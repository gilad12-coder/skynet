"""Add the per-identity agent engine preference.

Revision ID: c4bbf54b3990
Revises: d2a8f4c6e1b9
Create Date: 2026-10-21 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "c4bbf54b3990"
down_revision: str | Sequence[str] | None = "d2a8f4c6e1b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the agent engine preference table idempotently."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_engine_preferences (
            username VARCHAR(255) PRIMARY KEY,
            engine VARCHAR(16) NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        )
        """
    )


def downgrade() -> None:
    """Drop the agent engine preference table."""
    op.execute("DROP TABLE IF EXISTS agent_engine_preferences")
