"""rename credits to cents — the wallet stores US cents, so say so

Revision ID: d4f6a8c0e2b4
Revises: c3e5a7b9d1f2
Create Date: 2026-09-28 02:00:00.000000

The wallet has always stored integer US cents under the name "credits". This
renames every money column, the ``credit_ledger`` table with its indexes,
sequence and constraints, and the credit-named keys inside stored JSON. Values
are untouched: one stored unit was one cent before and is one cent after.
Postgres-only and idempotent, like the other billing migrations; the SQLite
test schema comes from the ORM models directly.
"""

from __future__ import annotations

import json
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d4f6a8c0e2b4"
down_revision: str | Sequence[str] | None = "c3e5a7b9d1f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = (
    ("billing_customers", "credit_balance", "balance_cents"),
    ("billing_customers", "debt_credits", "debt_cents"),
    ("wallet_ledger", "delta_credits", "delta_cents"),
    ("wallet_ledger", "uncollected_credits", "uncollected_cents"),
    ("execution_budgets", "total_credits", "total_cents"),
    ("execution_budgets", "billed_credits", "billed_cents"),
    ("execution_usage_evidence", "billed_credits", "billed_cents"),
)
_CONSTRAINTS = (
    (
        "billing_customers",
        "ck_billing_customers_credit_balance_non_negative",
        "ck_billing_customers_balance_cents_non_negative",
    ),
    (
        "billing_customers",
        "ck_billing_customers_debt_credits_non_negative",
        "ck_billing_customers_debt_cents_non_negative",
    ),
)
# Every credit-named identifier the codebase used; any of them may have been written as a JSON key.
_JSON_KEYS = {
    "account_available_credits": "account_available_cents",
    "account_committed_credits": "account_committed_cents",
    "actual_credits": "actual_cents",
    "actual_wallet_credits": "actual_wallet_cents",
    "add_credits": "add_funds",
    "available_credits": "available_cents",
    "balance_credits": "balance_cents",
    "billed_credits": "billed_cents",
    "ceil_credits": "ceil_cents",
    "committed_spend_credits": "committed_spend_cents",
    "cost_ceiling_credits": "cost_ceiling_cents",
    "cost_credits": "cost_cents",
    "credit_balance": "balance_cents",
    "credit_stop": "balance_stop",
    "credit_units": "cent_units",
    "credit_usd": "cent_usd",
    "credits_charged": "cents_charged",
    "credits_conversion": "cents_conversion",
    "credits_conversion_markup": "cents_conversion_markup",
    "credits_estimate": "cents_estimate",
    "credits_estimate_flat": "cents_estimate_flat",
    "credits_estimate_one": "cents_estimate_one",
    "credits_exhausted": "balance_exhausted",
    "credits_for_cost_usd": "cents_for_cost_usd",
    "credits_for_usage": "cents_for_usage",
    "credits_from_units": "cents_from_units",
    "credits_high": "cents_high",
    "credits_low": "cents_low",
    "credits_raw": "cents_raw",
    "credits_remaining": "cents_remaining",
    "credits_spent": "cents_spent",
    "credits_spent_since": "cents_spent_since",
    "credits_total": "cents_total",
    "current_total_credits": "current_total_cents",
    "debt_credits": "debt_cents",
    "delta_credits": "delta_cents",
    "enforce_llm_credits": "enforce_llm_balance",
    "estimate_credits_for_rows": "estimate_cents_for_rows",
    "estimate_run_credits": "estimate_run_cents",
    "estimated_credits_high": "estimated_cents_high",
    "estimated_credits_low": "estimated_cents_low",
    "execution_max_credits": "execution_max_cents",
    "execution_max_wallet_credits": "execution_max_wallet_cents",
    "external_spent_credits": "external_spent_cents",
    "floor_credits": "floor_cents",
    "global_daily_spend_ceiling_credits": "global_daily_spend_ceiling_cents",
    "insufficient_credits": "insufficient_funds",
    "interactive_min_balance_credits": "interactive_min_balance_cents",
    "issuing_balance_floor_credits": "issuing_balance_floor_cents",
    "issuing_balance_target_credits": "issuing_balance_target_cents",
    "issuing_credits": "issuing_cents",
    "legacy_job_committed_credits": "legacy_job_committed_cents",
    "liability_credits": "liability_cents",
    "limit_credits": "limit_cents",
    "max_cost_credits": "max_cost_cents",
    "max_credits": "max_cents",
    "max_wallet_credits": "max_wallet_cents",
    "maximum_credits": "maximum_cents",
    "maximum_session_credits": "maximum_session_cents",
    "measured_credits": "measured_cents",
    "minimum_credits": "minimum_cents",
    "minimum_session_credits": "minimum_session_cents",
    "minimum_total_credits": "minimum_total_cents",
    "openrouter_balance_floor_credits": "openrouter_balance_floor_cents",
    "outstanding_credits": "outstanding_cents",
    "paid_balance_credits": "paid_balance_cents",
    "pair_max_credits": "pair_max_cents",
    "pending_credits": "pending_cents",
    "platform_fee_credits_for_usage": "platform_fee_cents_for_usage",
    "project_total_credits": "project_total_cents",
    "projected_credits": "projected_cents",
    "provider_cost_credits": "provider_cost_cents",
    "read_account_balance_credits": "read_account_balance_cents",
    "require_credits": "require_balance",
    "required_credits": "required_cents",
    "reserved_credits": "reserved_cents",
    "run_cost_credits": "run_cost_cents",
    "run_spent_credits": "run_spent_cents",
    "setup_spent_credits": "setup_spent_cents",
    "spendable_credits": "spendable_cents",
    "spent_credits": "spent_cents",
    "topped_up_credits": "topped_up_cents",
    "total_credits": "total_cents",
    "total_outstanding_credits": "total_outstanding_cents",
    "transferred_credits": "transferred_cents",
    "uncollected_credits": "uncollected_cents",
    "vercel_sandbox_credit_range": "vercel_sandbox_cent_range",
    "wallet_reserved_credits": "wallet_reserved_cents",
    "wallet_run_spent_credits": "wallet_run_spent_cents",
    "wallet_setup_spent_credits": "wallet_setup_spent_cents",
}
# System-authored JSON, renamed at every depth.
_DEEP = (
    ("job_progress_events", "metrics"),
    ("jobs", "latest_metrics"),
    ("jobs", "result"),
    ("jobs", "payload_overview"),
    ("jobs", "terminal_evidence"),
    ("jobs", "recovery"),
    ("tagging_sessions", "assist"),
    ("telemetry_events", "properties"),
    ("telemetry_events", "context"),
    ("blackbox_agent_runs", "usage"),
    ("blackbox_agent_runs", "check_result"),
    ("execution_operations", "price_snapshot"),
    ("gepa_checkpoints", "manifest"),
    ("grid_pair_results", "result"),
    ("execution_usage_evidence", "evidence"),
)

_RENAME_KEYS_FN = """
CREATE OR REPLACE FUNCTION pg_temp.skynet_rename_keys(doc jsonb, names jsonb, deep boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(doc)
    WHEN 'object' THEN (
      SELECT coalesce(jsonb_object_agg(
        coalesce(names ->> key, key),
        CASE WHEN deep THEN pg_temp.skynet_rename_keys(value, names, deep) ELSE value END
      ), '{}'::jsonb)
      FROM jsonb_each(doc)
    )
    WHEN 'array' THEN CASE WHEN deep THEN (
      SELECT coalesce(jsonb_agg(pg_temp.skynet_rename_keys(value, names, deep) ORDER BY ordinality), '[]'::jsonb)
      FROM jsonb_array_elements(doc) WITH ORDINALITY
    ) ELSE doc END
    ELSE doc
  END
$$
"""


def _rename_relations(old: str, new: str) -> None:
    """Rename the ledger table and every index, sequence and constraint named after it.

    Args:
        old: Table name before the rename.
        new: Table name after the rename.
    """
    op.execute(
        f"DO $$ DECLARE r record; BEGIN "
        f"IF to_regclass('{old}') IS NOT NULL AND to_regclass('{new}') IS NULL "
        f"THEN ALTER TABLE {old} RENAME TO {new}; END IF; "
        f"FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        f"WHERE n.nspname = current_schema() AND c.relkind IN ('i', 'S') AND c.relname LIKE '%{old}%' LOOP "
        f"IF r.relkind = 'i' THEN EXECUTE format('ALTER INDEX %I RENAME TO %I', r.relname, "
        f"replace(r.relname, '{old}', '{new}')); "
        f"ELSE EXECUTE format('ALTER SEQUENCE %I RENAME TO %I', r.relname, replace(r.relname, '{old}', '{new}')); "
        f"END IF; END LOOP; "
        f"FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = to_regclass('{new}') "
        f"AND conname LIKE '%{old}%' LOOP "
        f"EXECUTE format('ALTER TABLE {new} RENAME CONSTRAINT %I TO %I', r.conname, "
        f"replace(r.conname, '{old}', '{new}')); "
        f"END LOOP; END $$"
    )


def _rename_column(table: str, old: str, new: str) -> None:
    """Rename one column when it still carries the old name.

    Args:
        table: Table holding the column.
        old: Column name to replace.
        new: Column name to use.
    """
    op.execute(
        f"DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() "
        f"AND table_name = '{table}' AND column_name = '{old}') "
        f"THEN ALTER TABLE {table} RENAME COLUMN {old} TO {new}; END IF; END $$"
    )


def _rename_constraint(table: str, old: str, new: str) -> None:
    """Rename one constraint when it still carries the old name.

    Args:
        table: Table owning the constraint.
        old: Constraint name to replace.
        new: Constraint name to use.
    """
    op.execute(
        f"DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{old}' AND conrelid = to_regclass('{table}')) "
        f"THEN ALTER TABLE {table} RENAME CONSTRAINT {old} TO {new}; END IF; END $$"
    )


def _rename_json(names: dict[str, str]) -> None:
    """Rename credit-named keys inside stored JSON documents.

    Args:
        names: Old key to new key.
    """
    mapping = json.dumps(names).replace("'", "''")
    present = {
        (table, column)
        for table, column in op.get_bind().execute(
            sa.text(
                "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()"
            )
        )
    }
    op.execute(_RENAME_KEYS_FN)
    for table, column in _DEEP:
        if (table, column) not in present:
            continue
        op.execute(
            f"UPDATE {table} SET {column} = pg_temp.skynet_rename_keys({column}::jsonb, '{mapping}'::jsonb, true) "
            f"WHERE {column} IS NOT NULL AND {column}::text ~ '\"({'|'.join(names)})\"'"
        )
    if ("jobs", "payload") not in present or ("telemetry_events", "properties") not in present:
        return
    # The request payload also holds user datasets, whose own column names are left alone.
    op.execute(
        f"UPDATE jobs SET payload = pg_temp.skynet_rename_keys(payload::jsonb, '{mapping}'::jsonb, false) "
        f"WHERE payload IS NOT NULL AND jsonb_typeof(payload::jsonb) = 'object'"
    )
    old, new = ("credits", "cents") if "max_cost_credits" in names else ("cents", "credits")
    op.execute(
        f"UPDATE jobs SET result = jsonb_set(result::jsonb #- '{{details,billing,{old}}}', "
        f"'{{details,billing,{new}}}', result::jsonb #> '{{details,billing,{old}}}') "
        f"WHERE result::jsonb #> '{{details,billing,{old}}}' IS NOT NULL"
    )
    op.execute(
        f"UPDATE telemetry_events SET properties = (properties::jsonb - '{old}') || jsonb_build_object('{new}', "
        f"properties::jsonb -> '{old}') WHERE jsonb_typeof(properties::jsonb) = 'object' AND properties::jsonb ? '{old}'"
    )


def upgrade() -> None:
    """Rename credit columns, the ledger table, constraints and JSON keys to cents."""
    if op.get_bind().dialect.name != "postgresql":
        return
    _rename_relations("credit_ledger", "wallet_ledger")
    for table, old, new in _COLUMNS:
        _rename_column(table, old, new)
    for table, old, new in _CONSTRAINTS:
        _rename_constraint(table, old, new)
    _rename_json(_JSON_KEYS)


def downgrade() -> None:
    """Restore the credit names."""
    if op.get_bind().dialect.name != "postgresql":
        return
    _rename_json({new: old for old, new in _JSON_KEYS.items()})
    for table, old, new in _CONSTRAINTS:
        _rename_constraint(table, new, old)
    for table, old, new in _COLUMNS:
        _rename_column(table, new, old)
    _rename_relations("wallet_ledger", "credit_ledger")
