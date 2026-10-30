"""add slack connections

Revision ID: a3d5f7b9c1e2
Revises: f9b2c4d6e8a1
Create Date: 2026-10-09 20:00:00.000000

Adds ``slack_connections``: one row per identity that installed the Skynet
Slack app, holding the encrypted bot token and where Slack notifications go.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a3d5f7b9c1e2"
down_revision: str | None = "f9b2c4d6e8a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the Slack connection table."""
    op.create_table(
        "slack_connections",
        sa.Column("username", sa.String(255), primary_key=True),
        sa.Column("team_id", sa.String(32), nullable=False),
        sa.Column("team_name", sa.String(255), nullable=False),
        sa.Column("bot_user_id", sa.String(32), nullable=False),
        sa.Column("slack_user_id", sa.String(32), nullable=False),
        sa.Column("bot_token_encrypted", sa.Text(), nullable=False),
        sa.Column("channel_id", sa.String(32), nullable=True),
        sa.Column("channel_name", sa.String(255), nullable=True),
        sa.Column("dm_channel_id", sa.String(32), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="connected"),
        sa.Column("broken_reason", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    """Drop the Slack connection table."""
    op.drop_table("slack_connections")
