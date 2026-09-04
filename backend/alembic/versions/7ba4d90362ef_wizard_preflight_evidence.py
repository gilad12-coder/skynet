"""Persist content-addressed wizard verification evidence."""

import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "7ba4d90362ef"
down_revision = "483e71b29f0c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the evidence table used by setup and submission."""
    if inspect(op.get_bind()).has_table("wizard_preflights"):
        return
    op.create_table(
        "wizard_preflights",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("budget_id", sa.String(36), sa.ForeignKey("execution_budgets.id"), nullable=False),
        sa.Column("username", sa.String(255), nullable=False),
        sa.Column("scope", sa.String(24), nullable=False),
        sa.Column("workflow", sa.String(24), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("result", postgresql.JSONB(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claim_token", sa.String(36), nullable=True),
        sa.Column("execution_generation", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("budget_id", "scope", "fingerprint", name="uq_wizard_preflight_content"),
    )
    op.create_index("ix_wizard_preflights_budget_id", "wizard_preflights", ["budget_id"])


def downgrade() -> None:
    """Remove setup evidence while preserving authoritative usage ledgers."""
    op.drop_table("wizard_preflights")
