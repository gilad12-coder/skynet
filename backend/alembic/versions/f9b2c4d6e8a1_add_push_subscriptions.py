"""add browser web push subscriptions

Revision ID: f9b2c4d6e8a1
Revises: e3c9a7f1b2d4
Create Date: 2026-10-09 18:00:00.000000

Adds ``push_subscriptions``: one row per browser that agreed to receive the
Chrome notification channel, keyed by the push service endpoint.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f9b2c4d6e8a1"
down_revision: str | None = "e3c9a7f1b2d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the push subscription table."""
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("username", sa.String(255), nullable=False),
        sa.Column("endpoint", sa.String(2048), nullable=False),
        sa.Column("p256dh", sa.String(255), nullable=False),
        sa.Column("auth", sa.String(255), nullable=False),
        sa.Column("user_agent", sa.String(512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("endpoint", name="uq_push_subscriptions_endpoint"),
    )
    op.create_index("ix_push_subscriptions_username", "push_subscriptions", ["username"])


def downgrade() -> None:
    """Drop the push subscription table."""
    op.drop_index("ix_push_subscriptions_username", table_name="push_subscriptions")
    op.drop_table("push_subscriptions")
