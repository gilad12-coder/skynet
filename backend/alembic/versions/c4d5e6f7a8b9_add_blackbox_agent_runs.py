"""Add the sandboxed agent run records of black-box jobs.

Revision ID: c4d5e6f7a8b9
Revises: fa6b7c8d9e0f
Create Date: 2026-09-01 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "c4d5e6f7a8b9"
down_revision: str | Sequence[str] | None = "fa6b7c8d9e0f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the per-run table idempotently."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS blackbox_agent_runs (
            optimization_id VARCHAR(36) NOT NULL REFERENCES jobs(optimization_id) ON DELETE CASCADE,
            run_id INTEGER NOT NULL,
            phase VARCHAR(16) NOT NULL,
            trial INTEGER,
            example_id VARCHAR(64),
            case_id VARCHAR(255),
            label VARCHAR(255) NOT NULL DEFAULT '',
            status VARCHAR(16) NOT NULL,
            started_at TIMESTAMP WITH TIME ZONE,
            finished_at TIMESTAMP WITH TIME ZONE,
            model VARCHAR(255),
            exit_code INTEGER,
            timed_out BOOLEAN NOT NULL DEFAULT FALSE,
            elapsed_seconds DOUBLE PRECISION,
            error TEXT,
            usage JSONB NOT NULL DEFAULT '{}'::jsonb,
            check_result JSONB,
            output TEXT,
            transcript TEXT NOT NULL DEFAULT '',
            stored_bytes BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            PRIMARY KEY (optimization_id, run_id)
        )
        """
    )
    op.execute("ALTER TABLE blackbox_agent_runs ADD COLUMN IF NOT EXISTS model VARCHAR(255)")


def downgrade() -> None:
    """Drop the per-run table."""
    op.execute("DROP TABLE IF EXISTS blackbox_agent_runs")
