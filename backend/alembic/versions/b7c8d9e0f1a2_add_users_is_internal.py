"""add users.is_internal

Revision ID: b7c8d9e0f1a2
Revises: a3d5f7b9c1e2
Create Date: 2026-10-13 04:00:00.000000

Adds ``users.is_internal`` so every product metric can exclude our own and
test accounts. The upgrade backfills it to true for synthetic ``.local``
fixtures (the ``%@%.local%`` pattern the share people-picker already treats as
non-identities) and for the configured ``ADMIN_USERNAMES``; every other row,
and every future sign-up, starts false.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from core.config import settings

revision: str = "b7c8d9e0f1a2"
down_revision: str | None = "a3d5f7b9c1e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SYNTHETIC_USERNAME_PATTERN = "%@%.local%"


def upgrade() -> None:
    """Add the flag and mark synthetic and admin accounts internal."""
    op.add_column(
        "users",
        sa.Column("is_internal", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    users = sa.table("users", sa.column("email", sa.String), sa.column("is_internal", sa.Boolean))
    op.execute(
        users.update().where(sa.func.lower(users.c.email).like(_SYNTHETIC_USERNAME_PATTERN)).values(is_internal=True)
    )
    admins = sorted(settings.admin_usernames_set)
    if admins:
        op.execute(users.update().where(sa.func.lower(users.c.email).in_(admins)).values(is_internal=True))


def downgrade() -> None:
    """Drop the flag."""
    with op.batch_alter_table("users") as batch:
        batch.drop_column("is_internal")
