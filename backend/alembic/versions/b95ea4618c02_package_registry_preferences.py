"""Persist caller-owned Python package registry preferences."""

import sqlalchemy as sa

from alembic import op

revision = "b95ea4618c02"
down_revision = "a83f9d1c6e42"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the registry table unless startup already created it."""
    if sa.inspect(op.get_bind()).has_table("package_registry_preferences"):
        return
    op.create_table(
        "package_registry_preferences",
        sa.Column("username", sa.String(255), primary_key=True),
        sa.Column("index_url", sa.String(2048), nullable=False),
    )


def downgrade() -> None:
    """Remove persisted package index preferences."""
    op.drop_table("package_registry_preferences")
