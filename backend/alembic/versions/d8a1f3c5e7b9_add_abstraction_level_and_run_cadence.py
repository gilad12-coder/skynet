"""add abstraction level, onboarding intake and run-email cadence

Revision ID: d8a1f3c5e7b9
Revises: c5e7a9b1d3f4
Create Date: 2026-10-07 12:00:00.000000

Renames the sign-up ``experience_level`` vocabulary to the abstraction levels
(``new`` -> ``guided``, ``familiar`` -> ``standard``; ``expert`` is unchanged)
and adds the nullable onboarding-intake columns to ``users``. Every existing
account keeps ``intake_completed_at`` NULL, so each sees the intake once.

Adds the run-email cadence columns to ``notification_preferences`` with
server defaults equal to the API defaults, and ``jobs.notification_claims``,
the durable once-per-run guard for in-run emails.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "d8a1f3c5e7b9"
down_revision: str | None = "c5e7a9b1d3f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_JSON = sa.JSON().with_variant(JSONB(), "postgresql")

_CADENCE_COLUMNS = (
    ("cadence", sa.String(16), "done"),
    ("live_mode", sa.String(16), "per_stage"),
    ("live_count", sa.Integer(), "3"),
    ("digest_minutes", sa.Integer(), "60"),
    ("stuck_fraction", sa.Float(), "0.25"),
    ("budget_alert_fraction", sa.Float(), "0.8"),
)


def upgrade() -> None:
    """Remap experience levels and add the intake, cadence and claim columns."""
    op.execute("UPDATE users SET experience_level = 'guided' WHERE experience_level = 'new'")
    op.execute("UPDATE users SET experience_level = 'standard' WHERE experience_level = 'familiar'")
    op.add_column("users", sa.Column("intake_completed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("intake_profile", _JSON, nullable=True))
    for name, type_, default in _CADENCE_COLUMNS:
        op.add_column(
            "notification_preferences",
            sa.Column(name, type_, nullable=False, server_default=default),
        )
    op.add_column("jobs", sa.Column("notification_claims", _JSON, nullable=True))


def downgrade() -> None:
    """Drop the added columns and restore the sign-up experience vocabulary."""
    op.drop_column("jobs", "notification_claims")
    for name, _, _ in reversed(_CADENCE_COLUMNS):
        op.drop_column("notification_preferences", name)
    op.drop_column("users", "intake_profile")
    op.drop_column("users", "intake_completed_at")
    op.execute("UPDATE users SET experience_level = 'familiar' WHERE experience_level = 'standard'")
    op.execute("UPDATE users SET experience_level = 'new' WHERE experience_level = 'guided'")
