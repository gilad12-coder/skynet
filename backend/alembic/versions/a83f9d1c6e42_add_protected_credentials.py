"""Store execution-scoped credentials outside persisted submission payloads.

Revision ID: a83f9d1c6e42
Revises: 7ba4d90362ef
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy import inspect

from alembic import op

revision = "a83f9d1c6e42"
down_revision = "7ba4d90362ef"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the encrypted credential table for protected parent relays."""
    if inspect(op.get_bind()).has_table("protected_credentials"):
        return
    op.create_table(
        "protected_credentials",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("username", sa.String(255), nullable=False),
        sa.Column(
            "binding_id",
            sa.String(64),
            sa.ForeignKey("execution_budgets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("audience_hash", sa.String(64), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("secret_ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("username", "binding_id", "purpose", name="uq_protected_credential_binding"),
    )
    op.create_index("ix_protected_credentials_username", "protected_credentials", ["username"])
    op.create_index("ix_protected_credentials_binding_id", "protected_credentials", ["binding_id"])


def downgrade() -> None:
    """Remove execution-scoped encrypted credentials."""
    op.drop_table("protected_credentials")
