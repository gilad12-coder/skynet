"""add billing debt and uncollected credits — stop absorbing revenue silently

Revision ID: c3e5a7b9d1f2
Revises: b8d2f4a6c1e3
Create Date: 2026-09-26 18:00:00.000000

``billing_customers.debt_credits`` carries credits a refund or chargeback
reversed after the account had already spent them; spending stays blocked
until a top-up repays it. ``credit_ledger.uncollected_credits`` records the
part of a run charge or clawback the balance could not cover, so revenue lost
to the zero-balance floor is queryable. Postgres-only with ``IF NOT EXISTS``
to stay idempotent — the SQLite test schema comes from the ORM models directly.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "c3e5a7b9d1f2"
down_revision: str | Sequence[str] | None = "b8d2f4a6c1e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the debt and uncollected-credit columns."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TABLE billing_customers ADD COLUMN IF NOT EXISTS debt_credits BIGINT NOT NULL DEFAULT 0")
    op.execute(
        "DO $$ BEGIN "
        "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_billing_customers_debt_credits_non_negative') "
        "THEN ALTER TABLE billing_customers ADD CONSTRAINT ck_billing_customers_debt_credits_non_negative "
        "CHECK (debt_credits >= 0); "
        "END IF; END $$"
    )
    op.execute("ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS uncollected_credits BIGINT")


def downgrade() -> None:
    """Drop the debt and uncollected-credit columns."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TABLE credit_ledger DROP COLUMN IF EXISTS uncollected_credits")
    op.execute("ALTER TABLE billing_customers DROP CONSTRAINT IF EXISTS ck_billing_customers_debt_credits_non_negative")
    op.execute("ALTER TABLE billing_customers DROP COLUMN IF EXISTS debt_credits")
