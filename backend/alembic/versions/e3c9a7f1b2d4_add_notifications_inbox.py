"""add the notifications inbox and per-channel notification routing

Revision ID: e3c9a7f1b2d4
Revises: d8a1f3c5e7b9
Create Date: 2026-10-09 12:00:00.000000

Adds ``notifications``: one row per event per identity, kept forever, with
its read state and each channel's delivery state.

Replaces the run-email cadence on ``notification_preferences`` with the
event x channel grid, the hold minutes and the held channels. Progress mail
and the digest are gone, so their columns are dropped. An identity that had
switched run emails off gets a grid with the email column all off; everyone
else gets the default grid (a NULL ``channel_grid``).
"""

from __future__ import annotations

import json
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "e3c9a7f1b2d4"
down_revision: str | None = "d8a1f3c5e7b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_JSON = sa.JSON().with_variant(JSONB(), "postgresql")

# Frozen copy of the event types at this revision: the migration must not
# change meaning if the live list in ``core.notifications.events`` grows.
_RUN_EVENTS = ("needs_input", "budget_near", "failed", "finished", "new_best", "stuck", "shared")

_DROPPED_COLUMNS = (
    ("job_updates_enabled", sa.Boolean(), sa.true()),
    ("sharing_updates_enabled", sa.Boolean(), sa.true()),
    ("cadence", sa.String(16), "done"),
    ("live_mode", sa.String(16), "per_stage"),
    ("live_count", sa.Integer(), "3"),
    ("digest_minutes", sa.Integer(), "60"),
)


def upgrade() -> None:
    """Create the inbox table and move preferences onto the channel grid."""
    op.create_table(
        "notifications",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("username", sa.String(255), nullable=False),
        sa.Column("event_type", sa.String(32), nullable=False),
        sa.Column("optimization_id", sa.String(36), nullable=True),
        sa.Column("title", sa.Text(), nullable=False, server_default=""),
        sa.Column("facts", _JSON, nullable=False),
        sa.Column("link", sa.String(512), nullable=True),
        sa.Column("dedupe_key", sa.String(160), nullable=True),
        sa.Column("in_inbox", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deliveries", _JSON, nullable=False),
        sa.Column("hold_until", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("username", "dedupe_key", name="uq_notifications_username_dedupe"),
    )
    op.create_index("ix_notifications_username_created", "notifications", ["username", "created_at"])
    op.create_index("ix_notifications_hold_until", "notifications", ["hold_until"])

    op.add_column("notification_preferences", sa.Column("channel_grid", _JSON, nullable=True))
    op.add_column(
        "notification_preferences",
        sa.Column("hold_minutes", sa.Integer(), nullable=False, server_default="10"),
    )
    op.add_column("notification_preferences", sa.Column("held_channels", _JSON, nullable=True))

    email_off = json.dumps({event: {"email": False} for event in _RUN_EVENTS})
    value = "CAST(:grid AS JSONB)" if op.get_bind().dialect.name == "postgresql" else ":grid"
    op.execute(
        sa.text(f"UPDATE notification_preferences SET channel_grid = {value} WHERE NOT job_updates_enabled").bindparams(
            grid=email_off
        )
    )

    for name, _, _ in _DROPPED_COLUMNS:
        op.drop_column("notification_preferences", name)


def downgrade() -> None:
    """Restore the cadence columns and drop the inbox; the grid is not carried back."""
    for name, type_, default in _DROPPED_COLUMNS:
        op.add_column(
            "notification_preferences",
            sa.Column(name, type_, nullable=False, server_default=default),
        )
    op.drop_column("notification_preferences", "held_channels")
    op.drop_column("notification_preferences", "hold_minutes")
    op.drop_column("notification_preferences", "channel_grid")
    op.drop_index("ix_notifications_hold_until", table_name="notifications")
    op.drop_index("ix_notifications_username_created", table_name="notifications")
    op.drop_table("notifications")
