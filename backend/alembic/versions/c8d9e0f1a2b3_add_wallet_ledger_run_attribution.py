"""add wallet_ledger run attribution

Revision ID: c8d9e0f1a2b3
Revises: b7c8d9e0f1a2
Create Date: 2026-10-13 16:45:00.000000

Adds ``wallet_ledger.optimization_id`` (indexed) and
``wallet_ledger.from_grant_cents`` so a run charge records which job it billed
and how much came from the free grant versus the paid balance. Both are
nullable and existing rows stay null; there is no backfill.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c8d9e0f1a2b3"
down_revision: str | None = "b7c8d9e0f1a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEX_NAME = "ix_wallet_ledger_optimization_id"


def upgrade() -> None:
    """Add the job id and grant-split columns plus the job id index."""
    op.add_column("wallet_ledger", sa.Column("optimization_id", sa.String(length=36), nullable=True))
    op.add_column("wallet_ledger", sa.Column("from_grant_cents", sa.BigInteger(), nullable=True))
    op.create_index(_INDEX_NAME, "wallet_ledger", ["optimization_id"])


def downgrade() -> None:
    """Drop the index and both columns."""
    op.drop_index(_INDEX_NAME, table_name="wallet_ledger")
    with op.batch_alter_table("wallet_ledger") as batch:
        batch.drop_column("from_grant_cents")
        batch.drop_column("optimization_id")
