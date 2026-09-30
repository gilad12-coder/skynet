"""Add the per-identity model data-privacy preference.

Revision ID: e1a2b3c4d5f6
Revises: d248adf3b659
Create Date: 2026-09-29 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "e1a2b3c4d5f6"
down_revision: str | Sequence[str] | None = "d248adf3b659"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the model privacy preference table idempotently."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS model_privacy_preferences (
            username VARCHAR(255) PRIMARY KEY,
            data_policy VARCHAR(16) NOT NULL DEFAULT 'deny',
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        )
        """
    )


def downgrade() -> None:
    """Drop the model privacy preference table."""
    op.execute("DROP TABLE IF EXISTS model_privacy_preferences")
