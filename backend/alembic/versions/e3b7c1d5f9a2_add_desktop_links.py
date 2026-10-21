"""add desktop link tables

Revision ID: e3b7c1d5f9a2
Revises: d2a8f4c6e1b9
Create Date: 2026-10-21 12:00:00.000000

SKY-124 PR 1: the hosted side of the Mac account link. ``desktop_links`` holds
one row per linked Mac. ``desktop_tokens`` holds the SHA-256 hashes of its
``skyl_`` access and refresh tokens; ``parent_hash`` names the refresh token
that minted a pair, for rotation and reuse detection. ``desktop_link_codes``
holds the hashes of the single-use link codes from the consent page. No
plaintext code or token is stored.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "e3b7c1d5f9a2"
down_revision: str | None = "d2a8f4c6e1b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEXES = (
    ("ix_desktop_links_username", "desktop_links", "username"),
    ("ix_desktop_tokens_link_id", "desktop_tokens", "link_id"),
    ("ix_desktop_tokens_parent_hash", "desktop_tokens", "parent_hash"),
    ("ix_desktop_link_codes_username", "desktop_link_codes", "username"),
)


def upgrade() -> None:
    """Create the desktop link, token and link-code tables and their indexes."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS desktop_links (
            id VARCHAR(40) PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            device_name VARCHAR(128) NOT NULL,
            scopes VARCHAR(255) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            last_used_at TIMESTAMP WITH TIME ZONE,
            revoked_at TIMESTAMP WITH TIME ZONE,
            absolute_expires_at TIMESTAMP WITH TIME ZONE NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS desktop_tokens (
            token_hash VARCHAR(64) PRIMARY KEY,
            link_id VARCHAR(40) NOT NULL,
            kind VARCHAR(16) NOT NULL,
            parent_hash VARCHAR(64),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            used_at TIMESTAMP WITH TIME ZONE
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS desktop_link_codes (
            code_hash VARCHAR(64) PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            code_challenge VARCHAR(64) NOT NULL,
            redirect_uri VARCHAR(255) NOT NULL,
            scopes VARCHAR(255) NOT NULL,
            device_name VARCHAR(128) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            used_at TIMESTAMP WITH TIME ZONE,
            link_id VARCHAR(40)
        )
        """
    )
    for name, table, column in _INDEXES:
        op.create_index(name, table, [column], if_not_exists=True)


def downgrade() -> None:
    """Drop the desktop link tables and their indexes."""
    for name, table, _ in reversed(_INDEXES):
        op.drop_index(name, table_name=table, if_exists=True)
    op.execute("DROP TABLE IF EXISTS desktop_link_codes")
    op.execute("DROP TABLE IF EXISTS desktop_tokens")
    op.execute("DROP TABLE IF EXISTS desktop_links")
