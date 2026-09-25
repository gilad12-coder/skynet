"""add pro subscription columns — the Skynet Pro platform plan

Revision ID: a7c3e91d4b58
Revises: d41f7a2c9e05
Create Date: 2026-09-25 12:00:00.000000

Skynet Pro is a monthly platform subscription that raises storage, job and
concurrency limits; usage stays on prepaid credits. The webhook mirrors the
Stripe subscription onto ``billing_customers`` so quota checks read the plan
locally. Postgres-only with ``IF NOT EXISTS`` to stay idempotent — the SQLite
test schema comes from the ORM models directly.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "a7c3e91d4b58"
down_revision: str | Sequence[str] | None = "d41f7a2c9e05"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the Pro subscription mirror columns to billing_customers."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TABLE billing_customers ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(64)")
    op.execute("ALTER TABLE billing_customers ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(32)")
    op.execute(
        "ALTER TABLE billing_customers ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMP WITH TIME ZONE"
    )
    op.execute(
        "ALTER TABLE billing_customers "
        "ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end BOOLEAN NOT NULL DEFAULT false"
    )


def downgrade() -> None:
    """Drop the Pro subscription mirror columns."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TABLE billing_customers DROP COLUMN IF EXISTS subscription_cancel_at_period_end")
    op.execute("ALTER TABLE billing_customers DROP COLUMN IF EXISTS subscription_current_period_end")
    op.execute("ALTER TABLE billing_customers DROP COLUMN IF EXISTS subscription_status")
    op.execute("ALTER TABLE billing_customers DROP COLUMN IF EXISTS stripe_subscription_id")
