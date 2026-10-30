"""add structured run-log fields to job_logs

Revision ID: c5e7a9b1d3f4
Revises: b4d6f8a0c2e3
Create Date: 2026-10-05 12:00:00.000000

Adds ``source``, ``event``, ``fields``, ``candidate`` and ``case_id`` to
``job_logs`` so a run log can carry typed events from inside the sandbox. All
are nullable: existing rows stay as they are and read as host lines.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "c5e7a9b1d3f4"
down_revision: str | None = "b4d6f8a0c2e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = (
    ("source", sa.String(32)),
    ("event", sa.String(255)),
    ("fields", sa.JSON().with_variant(JSONB(), "postgresql")),
    ("candidate", sa.String(64)),
    ("case_id", sa.String(255)),
)


def upgrade() -> None:
    """Add the run-log columns to ``job_logs``."""
    for name, type_ in _COLUMNS:
        op.add_column("job_logs", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    """Drop the run-log columns from ``job_logs``."""
    for name, _ in reversed(_COLUMNS):
        op.drop_column("job_logs", name)
