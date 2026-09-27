"""preview merge connector scopes and pro subscription

Revision ID: 26ac720977c4
Revises: e5a19c7b3f42, a7c3e91d4b58
Create Date: 2026-09-25 16:05:02.626078

"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = '26ac720977c4'
down_revision: str | None = ('e5a19c7b3f42', 'a7c3e91d4b58')
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
