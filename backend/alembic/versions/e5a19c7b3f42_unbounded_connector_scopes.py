"""Store connector scopes as unbounded text.

Google returns every scope the user has granted the client, not just the ones a
connector asked for, so linking Drive, Cloud Storage and BigQuery overflowed the
original ``varchar(255)`` and failed the OAuth callback.
"""

import sqlalchemy as sa

from alembic import op

revision = "e5a19c7b3f42"
down_revision = "d41f7a2c9e05"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Widen ``user_connectors.scopes`` to text."""
    op.alter_column("user_connectors", "scopes", type_=sa.Text(), existing_type=sa.String(255), existing_nullable=True)


def downgrade() -> None:
    """Narrow ``user_connectors.scopes`` back to 255 characters, cutting longer lists."""
    op.execute("UPDATE user_connectors SET scopes = LEFT(scopes, 255) WHERE length(scopes) > 255")
    op.alter_column("user_connectors", "scopes", type_=sa.String(255), existing_type=sa.Text(), existing_nullable=True)
