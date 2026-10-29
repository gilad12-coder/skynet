"""Add the user_identities table for linked Google and GitHub accounts."""

import sqlalchemy as sa

from alembic import op

revision = "d7a3c9e1f4b2"
down_revision = "c4f1a7d9e2b5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the table that maps provider accounts to Skynet accounts."""
    op.create_table(
        "user_identities",
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("provider_account_id", sa.String(length=255), nullable=False),
        sa.Column("username", sa.String(length=255), nullable=False),
        sa.Column("provider_email", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("provider", "provider_account_id"),
    )
    op.create_index("ix_user_identities_username", "user_identities", ["username"])


def downgrade() -> None:
    """Drop the linked-accounts table."""
    op.drop_index("ix_user_identities_username", table_name="user_identities")
    op.drop_table("user_identities")
