"""Add the provider profile picture to users.

Revision ID: d8e1f2a3b4c5
Revises: c4bbf54b3990
Create Date: 2026-10-31 00:00:00.000000

The web reads the picture from the sign-in session. The Mac app signs in a
local user, so hosted keeps the picture and returns it from desktop whoami.
SQLite test schemas come from ``create_all``.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "d8e1f2a3b4c5"
down_revision: str | Sequence[str] | None = "c4bbf54b3990"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the nullable ``users.image_url`` column idempotently."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS image_url VARCHAR(2048)")


def downgrade() -> None:
    """Drop the ``users.image_url`` column."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS image_url")
