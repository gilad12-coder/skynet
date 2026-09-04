"""Add durable shared budgets, physical-attempt reservations and usage evidence.

Revision ID: 927cb56e104a
Revises: c4d5e6f7a8b9
"""

from __future__ import annotations

from alembic import op

revision = "927cb56e104a"
down_revision = "c4d5e6f7a8b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create spending authority independently of job success and notification state."""
    op.execute("""
        CREATE TABLE IF NOT EXISTS execution_budgets (
            id VARCHAR(36) PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            creation_key VARCHAR(128) NOT NULL,
            creation_fingerprint VARCHAR(64) NOT NULL,
            total_credits BIGINT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            generation INTEGER NOT NULL DEFAULT 0,
            state VARCHAR(24) NOT NULL DEFAULT 'open',
            blocked_reason VARCHAR(128),
            job_id VARCHAR(36) UNIQUE,
            settled_units BIGINT NOT NULL DEFAULT 0,
            wallet_settled_units BIGINT NOT NULL DEFAULT 0,
            reserved_units BIGINT NOT NULL DEFAULT 0,
            wallet_reserved_units BIGINT NOT NULL DEFAULT 0,
            billed_credits BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT uq_execution_budget_creation UNIQUE (username, creation_key),
            CONSTRAINT ck_execution_budget_total CHECK (total_credits > 0),
            CONSTRAINT ck_execution_budget_amounts CHECK (
                settled_units >= 0 AND wallet_settled_units >= 0 AND reserved_units >= 0
                AND wallet_reserved_units >= 0 AND billed_credits >= 0
            )
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_execution_budgets_username ON execution_budgets (username)")
    op.execute("""
        CREATE TABLE IF NOT EXISTS execution_operations (
            id VARCHAR(36) PRIMARY KEY,
            budget_id VARCHAR(36) NOT NULL REFERENCES execution_budgets(id),
            operation_key VARCHAR(128) NOT NULL,
            attempt INTEGER NOT NULL,
            generation INTEGER NOT NULL,
            phase VARCHAR(8) NOT NULL,
            cost_kind VARCHAR(32) NOT NULL,
            role VARCHAR(64),
            request_fingerprint VARCHAR(128) NOT NULL,
            admission_fingerprint VARCHAR(64) NOT NULL,
            price_snapshot JSONB NOT NULL,
            state VARCHAR(24) NOT NULL DEFAULT 'reserved',
            max_units BIGINT NOT NULL,
            max_wallet_units BIGINT NOT NULL,
            actual_units BIGINT NOT NULL DEFAULT 0,
            actual_wallet_units BIGINT NOT NULL DEFAULT 0,
            provider_request_id VARCHAR(255),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            dispatched_at TIMESTAMP WITH TIME ZONE,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT uq_execution_operation_attempt UNIQUE (budget_id, operation_key, attempt),
            CONSTRAINT ck_execution_operation_phase CHECK (phase IN ('setup', 'run')),
            CONSTRAINT ck_execution_operation_amounts CHECK (
                max_units >= 0 AND max_wallet_units >= 0 AND actual_units >= 0 AND actual_wallet_units >= 0
            )
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_execution_operations_budget_id ON execution_operations (budget_id)")
    op.execute("""
        CREATE TABLE IF NOT EXISTS execution_usage_evidence (
            id VARCHAR(36) PRIMARY KEY,
            operation_id VARCHAR(36) NOT NULL REFERENCES execution_operations(id),
            evidence_key VARCHAR(128) NOT NULL,
            fingerprint VARCHAR(64) NOT NULL,
            actual_units BIGINT NOT NULL,
            actual_wallet_units BIGINT NOT NULL,
            billed_credits BIGINT NOT NULL,
            final BOOLEAN NOT NULL,
            issue VARCHAR(32),
            evidence JSONB NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT uq_execution_usage_evidence UNIQUE (operation_id, evidence_key)
        )
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_execution_usage_evidence_operation_id ON execution_usage_evidence (operation_id)"
    )
    op.execute("ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS budget_id VARCHAR(36)")
    op.execute("ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS settlement_key VARCHAR(64)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_credit_ledger_budget_id ON credit_ledger (budget_id)")
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_settlement_key_key ON credit_ledger (settlement_key)")


def downgrade() -> None:
    """Remove reservation infrastructure only through an explicit schema rollback."""
    # Dropping the columns removes both migration-created indexes and ORM-created constraints.
    op.execute("ALTER TABLE credit_ledger DROP COLUMN IF EXISTS settlement_key")
    op.execute("ALTER TABLE credit_ledger DROP COLUMN IF EXISTS budget_id")
    op.execute("DROP TABLE IF EXISTS execution_usage_evidence")
    op.execute("DROP TABLE IF EXISTS execution_operations")
    op.execute("DROP TABLE IF EXISTS execution_budgets")
