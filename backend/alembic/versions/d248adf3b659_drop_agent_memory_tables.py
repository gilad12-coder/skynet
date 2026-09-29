"""drop the agent memory tables

Revision ID: d248adf3b659
Revises: d4f6a8c0e2b4
Create Date: 2026-09-28 12:00:00.000000

The generalist agent's permanent memory feature was removed, so its three
tables go with it, along with every stored memory. They carry only primary
keys — no secondary indexes, foreign keys or enum types — so dropping the
tables removes everything the two creating migrations (113ea57a3b82 and
29d9f24ddac9) added. ``downgrade`` recreates them empty. Postgres-only and
idempotent, like those migrations; the SQLite test schema comes from the ORM
models directly.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "d248adf3b659"
down_revision: str | Sequence[str] | None = "d4f6a8c0e2b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Drop the agent memory log, summary and settings tables."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("DROP TABLE IF EXISTS agent_memory_settings")
    op.execute("DROP TABLE IF EXISTS agent_memory_summaries")
    op.execute("DROP TABLE IF EXISTS agent_memories")


def downgrade() -> None:
    """Recreate the agent memory tables empty, as the original migrations did."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_memories (
            username VARCHAR(255) NOT NULL,
            seq INTEGER NOT NULL,
            content VARCHAR(280) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            PRIMARY KEY (username, seq)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_memory_summaries (
            username VARCHAR(255) NOT NULL,
            block_size INTEGER NOT NULL,
            block_index INTEGER NOT NULL,
            content VARCHAR(280) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            PRIMARY KEY (username, block_size, block_index)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_memory_settings (
            username VARCHAR(255) PRIMARY KEY,
            wake_lines INTEGER,
            entry_chars INTEGER,
            recall_chars INTEGER,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        )
        """
    )
