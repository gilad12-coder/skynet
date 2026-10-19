"""add continuous optimization plans and cycles

Revision ID: a7c3e9d1f5b2
Revises: d1e2f3a4b5c6
Create Date: 2026-10-18 09:00:00.000000

Adds ``continuous_plans`` (one schedule per successful source run) and
``continuous_cycles`` (one row per scheduled check). The unique
``(plan_id, slot)`` pair stops two workers from recording the same check.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a7c3e9d1f5b2"
down_revision: str | None = "d1e2f3a4b5c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    """Create the continuous plan and cycle tables."""
    op.create_table(
        "continuous_plans",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("username", sa.String(255), nullable=False),
        sa.Column("source_optimization_id", sa.String(36), nullable=False),
        sa.Column("incumbent_optimization_id", sa.String(36), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("pause_reason", sa.String(32), nullable=True),
        sa.Column("schedule", sa.String(16), nullable=False),
        sa.Column("next_check_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("permitted", _JSON, nullable=False),
        sa.Column("source", _JSON, nullable=True),
        sa.Column("pending_inputs", _JSON, nullable=False),
        sa.Column("baseline_snapshot", _JSON, nullable=False),
        sa.Column("monthly_limit_cents", sa.Integer(), nullable=True),
        sa.Column("cycle_budget_cents", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("source_optimization_id", name="uq_continuous_plans_source_optimization_id"),
    )
    op.create_index("ix_continuous_plans_username", "continuous_plans", ["username"])
    op.create_index("ix_continuous_plans_next_check_at", "continuous_plans", ["next_check_at"])
    op.create_table(
        "continuous_cycles",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("plan_id", sa.String(36), nullable=False),
        sa.Column("slot", sa.String(40), nullable=False),
        sa.Column("month", sa.String(7), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("changes", _JSON, nullable=False),
        sa.Column("detail_code", sa.String(64), nullable=True),
        sa.Column("detail_params", _JSON, nullable=False),
        sa.Column("snapshot", _JSON, nullable=True),
        sa.Column("optimization_id", sa.String(36), nullable=True),
        sa.Column("execution_budget_id", sa.String(36), nullable=True),
        sa.Column("incumbent_score", sa.Float(), nullable=True),
        sa.Column("candidate_score", sa.Float(), nullable=True),
        sa.Column("spent_cents", sa.Integer(), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("plan_id", "slot", name="uq_continuous_cycles_plan_slot"),
    )
    op.create_index("ix_continuous_cycles_plan_id", "continuous_cycles", ["plan_id"])


def downgrade() -> None:
    """Drop the continuous plan and cycle tables."""
    op.drop_index("ix_continuous_cycles_plan_id", table_name="continuous_cycles")
    op.drop_table("continuous_cycles")
    op.drop_index("ix_continuous_plans_next_check_at", table_name="continuous_plans")
    op.drop_index("ix_continuous_plans_username", table_name="continuous_plans")
    op.drop_table("continuous_plans")
