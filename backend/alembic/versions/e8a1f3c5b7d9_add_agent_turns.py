"""add agent_turns + agent_turn_events — resumable wizard-agent turns

Revision ID: e8a1f3c5b7d9
Revises: d7a3c9e1f4b2
Create Date: 2026-10-03 12:00:00.000000

The hosting edge closes any HTTP request after 15 minutes, so a long
code-agent turn must outlive its stream connection: the turn runs as a
server-side task, every SSE event is persisted with a sequence number, and a
reconnecting client (possibly on another replica) replays from the last
sequence it saw. Postgres-only with ``IF NOT EXISTS`` to stay idempotent —
the SQLite test schema comes from the ORM models directly.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "e8a1f3c5b7d9"
down_revision: str | Sequence[str] | None = "d7a3c9e1f4b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the agent_turns and agent_turn_events tables."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_turns (
            turn_id VARCHAR(64) PRIMARY KEY,
            owner VARCHAR(255) NOT NULL,
            status VARCHAR(16) NOT NULL,
            cancel_requested BOOLEAN NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            heartbeat_at TIMESTAMP WITH TIME ZONE NOT NULL,
            last_read_at TIMESTAMP WITH TIME ZONE NOT NULL
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_agent_turns_heartbeat_at ON agent_turns (heartbeat_at)")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_turn_events (
            turn_id VARCHAR(64) NOT NULL,
            seq INTEGER NOT NULL,
            event VARCHAR(64) NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (turn_id, seq)
        )
        """
    )


def downgrade() -> None:
    """Drop the agent_turn_events and agent_turns tables."""
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("DROP TABLE IF EXISTS agent_turn_events")
    op.execute("DROP TABLE IF EXISTS agent_turns")
