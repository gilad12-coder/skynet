"""add a repeat rule to continuous plans

Revision ID: b8d4f0e2a6c3
Revises: a7c3e9d1f5b2
Create Date: 2026-10-19 10:00:00.000000

Adds ``continuous_plans.schedule_rule``: every N hours, days, weeks or months
at a time of day in the owner's time zone. Plans saved before it keep their
``daily``/``weekly`` name and read as a rule at 09:00 UTC.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b8d4f0e2a6c3"
down_revision: str | None = "a7c3e9d1f5b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    """Add the nullable schedule rule column."""
    op.add_column("continuous_plans", sa.Column("schedule_rule", _JSON, nullable=True))


def downgrade() -> None:
    """Drop the schedule rule column."""
    op.drop_column("continuous_plans", "schedule_rule")
