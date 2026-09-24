"""Persist encrypted third-party data-account links (connectors)."""

import sqlalchemy as sa

from alembic import op

revision = "d41f7a2c9e05"
down_revision = "c16b8f42d903"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the user_connectors table unless startup already created it."""
    if sa.inspect(op.get_bind()).has_table("user_connectors"):
        return
    op.create_table(
        "user_connectors",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("username", sa.String(255), nullable=False, index=True),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("auth_method", sa.String(16), nullable=False),
        sa.Column("account_label", sa.String(255), nullable=True),
        sa.Column("scopes", sa.String(255), nullable=True),
        sa.Column("secret_ciphertext", sa.LargeBinary, nullable=False),
        sa.Column("refresh_ciphertext", sa.LargeBinary, nullable=True),
        sa.Column("token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="connected"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("username", "provider", name="uq_user_connectors_username_provider"),
    )


def downgrade() -> None:
    """Remove persisted connector links."""
    op.drop_table("user_connectors")
