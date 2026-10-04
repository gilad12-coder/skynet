"""Persist encrypted secrets users save for reuse across repository runs."""

import sqlalchemy as sa

from alembic import op

revision = "b8e2d4f6a1c3"
down_revision = "a7c3e9f1b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the user_secrets table unless startup already created it."""
    if sa.inspect(op.get_bind()).has_table("user_secrets"):
        return
    op.create_table(
        "user_secrets",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("username", sa.String(255), nullable=False, index=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("secret_ciphertext", sa.LargeBinary, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("username", "name", name="uq_user_secrets_username_name"),
    )


def downgrade() -> None:
    """Remove saved user secrets."""
    op.drop_table("user_secrets")
