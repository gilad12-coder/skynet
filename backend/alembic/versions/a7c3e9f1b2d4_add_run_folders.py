"""Add run folders with Drive-style sharing.

Revision ID: a7c3e9f1b2d4
Revises: e1a2b3c4d5f6
Create Date: 2026-10-01 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "a7c3e9f1b2d4"
down_revision: str | Sequence[str] | None = "e1a2b3c4d5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the run folder tables idempotently."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS run_folders (
            id VARCHAR(36) PRIMARY KEY,
            owner_username VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            parent_id VARCHAR(36),
            editors_can_share BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_run_folders_owner_username ON run_folders (owner_username)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_run_folders_parent_id ON run_folders (parent_id)")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS run_folder_share_links (
            token VARCHAR(48) PRIMARY KEY,
            folder_id VARCHAR(36) NOT NULL,
            created_by VARCHAR(255) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            revoked_at TIMESTAMP WITH TIME ZONE,
            general_access VARCHAR(16) NOT NULL DEFAULT 'restricted',
            general_role VARCHAR(16) NOT NULL DEFAULT 'viewer'
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_run_folder_share_links_folder_id ON run_folder_share_links (folder_id)")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS run_folder_share_grants (
            folder_id VARCHAR(36) NOT NULL,
            grantee_username VARCHAR(255) NOT NULL,
            role VARCHAR(16) NOT NULL,
            created_by VARCHAR(255) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            PRIMARY KEY (folder_id, grantee_username)
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_run_folder_share_grants_folder_id ON run_folder_share_grants (folder_id)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_run_folder_share_grants_grantee ON run_folder_share_grants (grantee_username)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS run_folder_items (
            optimization_id VARCHAR(36) PRIMARY KEY,
            folder_id VARCHAR(36) NOT NULL,
            added_by VARCHAR(255) NOT NULL,
            added_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_run_folder_items_folder_id ON run_folder_items (folder_id)")


def downgrade() -> None:
    """Drop the run folder tables."""
    op.execute("DROP TABLE IF EXISTS run_folder_items")
    op.execute("DROP TABLE IF EXISTS run_folder_share_grants")
    op.execute("DROP TABLE IF EXISTS run_folder_share_links")
    op.execute("DROP TABLE IF EXISTS run_folders")
