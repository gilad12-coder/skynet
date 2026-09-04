"""Bind terminal outcomes and recovery points to a fenced execution generation."""

from alembic import op

revision = "483e71b29f0c"
down_revision = "927cb56e104a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add optional lifecycle evidence without reclassifying historical jobs."""
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS execution_generation INTEGER NOT NULL DEFAULT 0")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS execution_budget_id VARCHAR(64)")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS execution_budget_generation INTEGER")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS stop_reason VARCHAR(32)")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_availability VARCHAR(16)")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS recovery JSONB")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS terminal_evidence JSONB")
    op.execute("ALTER TABLE gepa_checkpoints ADD COLUMN IF NOT EXISTS manifest JSONB")


def downgrade() -> None:
    """Remove the new lifecycle metadata columns."""
    op.execute("ALTER TABLE gepa_checkpoints DROP COLUMN IF EXISTS manifest")
    for column in (
        "terminal_evidence",
        "recovery",
        "result_availability",
        "stop_reason",
        "execution_generation",
        "execution_budget_id",
        "execution_budget_generation",
    ):
        op.execute(f"ALTER TABLE jobs DROP COLUMN IF EXISTS {column}")
