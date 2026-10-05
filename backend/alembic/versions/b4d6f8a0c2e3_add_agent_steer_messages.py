"""add agent_steer_messages — messages sent into a running agent turn

Revision ID: b4d6f8a0c2e3
Revises: a3c5e7f9b1d2
Create Date: 2026-10-04 20:00:00.000000

A chat can now send a message while its agent turn is still streaming. The
message waits here until the running loop takes it at its next step, or the
client withdraws it once the turn ends.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "b4d6f8a0c2e3"
down_revision: str | Sequence[str] | None = "a3c5e7f9b1d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the steer message table and its lookup index idempotently."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_steer_messages (
            id VARCHAR(32) PRIMARY KEY,
            steer_key VARCHAR(64) NOT NULL,
            owner VARCHAR(255) NOT NULL,
            text TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            taken_at TIMESTAMP WITH TIME ZONE
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_agent_steer_messages_key ON agent_steer_messages (steer_key, owner)")


def downgrade() -> None:
    """Drop the steer message table."""
    op.execute("DROP TABLE IF EXISTS agent_steer_messages")
