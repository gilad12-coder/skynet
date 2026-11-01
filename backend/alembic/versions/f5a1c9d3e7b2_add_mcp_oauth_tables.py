"""add remote MCP OAuth tables

Revision ID: f5a1c9d3e7b2
Revises: d8e1f2a3b4c5
Create Date: 2026-10-31 12:00:00.000000

SKY-229: OAuth 2.1 for the hosted remote MCP server. ``mcp_oauth_clients``
holds dynamically registered clients. ``mcp_auth_codes`` holds the hashes of
single-use authorization codes. ``mcp_grants`` holds one row per approved
client and account, bound to the MCP resource URL. ``mcp_tokens`` holds the
SHA-256 hashes of its ``skym_`` access and refresh tokens. No plaintext code
or token is stored.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "f5a1c9d3e7b2"
down_revision: str | None = "d8e1f2a3b4c5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEXES = (
    ("ix_mcp_auth_codes_username", "mcp_auth_codes", "username"),
    ("ix_mcp_grants_username", "mcp_grants", "username"),
    ("ix_mcp_tokens_grant_id", "mcp_tokens", "grant_id"),
)


def upgrade() -> None:
    """Create the MCP client, code, grant and token tables and their indexes."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
            client_id VARCHAR(64) PRIMARY KEY,
            client_name VARCHAR(128) NOT NULL,
            redirect_uris TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS mcp_auth_codes (
            code_hash VARCHAR(64) PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            client_id VARCHAR(512) NOT NULL,
            client_name VARCHAR(128) NOT NULL,
            redirect_uri VARCHAR(512) NOT NULL,
            code_challenge VARCHAR(64) NOT NULL,
            scopes VARCHAR(255) NOT NULL,
            resource VARCHAR(512) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            used_at TIMESTAMP WITH TIME ZONE,
            grant_id VARCHAR(40)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS mcp_grants (
            id VARCHAR(40) PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            client_id VARCHAR(512) NOT NULL,
            client_name VARCHAR(128) NOT NULL,
            scopes VARCHAR(255) NOT NULL,
            resource VARCHAR(512) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            last_used_at TIMESTAMP WITH TIME ZONE,
            revoked_at TIMESTAMP WITH TIME ZONE,
            absolute_expires_at TIMESTAMP WITH TIME ZONE NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS mcp_tokens (
            token_hash VARCHAR(64) PRIMARY KEY,
            grant_id VARCHAR(40) NOT NULL,
            kind VARCHAR(16) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            used_at TIMESTAMP WITH TIME ZONE
        )
        """
    )
    for name, table, column in _INDEXES:
        op.create_index(name, table, [column], if_not_exists=True)


def downgrade() -> None:
    """Drop the MCP OAuth tables and their indexes."""
    for name, table, _ in reversed(_INDEXES):
        op.drop_index(name, table_name=table, if_exists=True)
    op.execute("DROP TABLE IF EXISTS mcp_tokens")
    op.execute("DROP TABLE IF EXISTS mcp_grants")
    op.execute("DROP TABLE IF EXISTS mcp_auth_codes")
    op.execute("DROP TABLE IF EXISTS mcp_oauth_clients")
