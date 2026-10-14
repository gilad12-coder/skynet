"""add jobs.sandbox_image — the image a protected run is pinned to

Revision ID: f2b4d6a8c0e1
Revises: e8a1f3c5b7d9
Create Date: 2026-10-04 12:00:00.000000

A protected run executes its optimizer, code included, inside one sandbox
image. Recording that image on the first launch lets every later box for the
run, including a resume after a redeploy, boot from the same image, so its
checkpoints stay loadable whatever the workers run.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "f2b4d6a8c0e1"
down_revision: str | Sequence[str] | None = "e8a1f3c5b7d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the nullable sandbox_image column to jobs."""
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sandbox_image VARCHAR(255)")


def downgrade() -> None:
    """Drop the sandbox_image column from jobs."""
    op.execute("ALTER TABLE jobs DROP COLUMN IF EXISTS sandbox_image")
