"""Clear the free grants that older accounts still hold."""

import sqlalchemy as sa

from alembic import op

revision = "c4f1a7d9e2b5"
down_revision = "b8e2d4f6a1c3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Zero every leftover grant so only purchased balance can be spent."""
    if not sa.inspect(op.get_bind()).has_table("billing_customers"):
        return
    op.execute("UPDATE billing_customers SET grant_remaining = 0 WHERE grant_remaining > 0")


def downgrade() -> None:
    """Leave grants at zero, since the cleared amounts were not recorded."""
