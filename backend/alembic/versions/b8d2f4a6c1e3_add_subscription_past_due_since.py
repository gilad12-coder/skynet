"""add subscription_past_due_since — bound the Pro past_due grace period

Revision ID: b8d2f4a6c1e3
Revises: 26ac720977c4
Create Date: 2026-09-26 12:00:00.000000

A failed Pro renewal leaves the subscription ``past_due`` while Stripe retries,
which can last weeks. The webhook now stamps when that state began so Pro
limits lapse after a fixed grace. Rows already ``past_due`` are backfilled from
``updated_at`` (the last webhook sync), which is the closest record of when the
status was mirrored. Postgres-only with ``IF NOT EXISTS`` to stay idempotent —
the SQLite test schema comes from the ORM models directly.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "b8d2f4a6c1e3"
down_revision: str | Sequence[str] | None = "26ac720977c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the past_due timestamp and backfill rows already past due."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute(
        "ALTER TABLE billing_customers ADD COLUMN IF NOT EXISTS subscription_past_due_since TIMESTAMP WITH TIME ZONE"
    )
    op.execute(
        "UPDATE billing_customers SET subscription_past_due_since = updated_at "
        "WHERE subscription_status = 'past_due' AND subscription_past_due_since IS NULL"
    )


def downgrade() -> None:
    """Drop the past_due timestamp."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TABLE billing_customers DROP COLUMN IF EXISTS subscription_past_due_since")
