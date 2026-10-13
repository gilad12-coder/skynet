"""add north-star metric views

Revision ID: d1e2f3a4b5c6
Revises: c8d9e0f1a2b3
Create Date: 2026-10-13 18:45:00.000000

Creates three read-only views over ``telemetry_events``, ``users`` and
``jobs`` that the admin ``GET /telemetry/metrics/north-star`` endpoint reads:
First Lifts per signup week, new vs returning lifted users per week, and
owners whose lifted program is served externally on two or more days a week.
Postgres-only; other dialects skip it.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "d1e2f3a4b5c6"
down_revision: str | None = "c8d9e0f1a2b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# A frozen copy of core.api.routers.telemetry.METRIC_VIEW_DDL as of this
# revision: a migration must keep producing the same schema even after the
# router's SQL changes.
_QUALIFYING_RUN = """
    CASE WHEN jsonb_typeof({p} -> 'lift') = 'number' THEN ({p} ->> 'lift')::numeric END >= 0.02
    AND {p} -> 'held_out' = 'true'::jsonb
    AND CASE WHEN jsonb_typeof({p} -> 'held_out_rows') = 'number'
        THEN ({p} ->> 'held_out_rows')::numeric END >= 20
    AND {p} -> 'from_sample' = 'false'::jsonb
"""

_VIEWS: dict[str, str] = {
    "metric_first_lifts_weekly": f"""
CREATE OR REPLACE VIEW metric_first_lifts_weekly AS
WITH first_runs AS (
    SELECT DISTINCT ON (e.username) e.username, e.received_at, e.properties
    FROM telemetry_events e
    WHERE e.event_name = 'run_completed' AND e.username IS NOT NULL
    ORDER BY e.username, e.received_at, e.id
)
SELECT
    date_trunc('week', u.created_at AT TIME ZONE 'UTC')::date AS signup_week,
    count(*) AS signups,
    count(*) FILTER (
        WHERE f.username IS NOT NULL
        AND f.received_at <= u.created_at + interval '48 hours'
        AND {_QUALIFYING_RUN.format(p="f.properties")}
    ) AS first_lifts
FROM users u
LEFT JOIN first_runs f ON f.username = u.email
WHERE NOT u.is_internal
GROUP BY 1
""",
    "metric_lifted_users_weekly": f"""
CREATE OR REPLACE VIEW metric_lifted_users_weekly AS
WITH lifted AS (
    SELECT DISTINCT e.username, date_trunc('week', e.received_at AT TIME ZONE 'UTC')::date AS week
    FROM telemetry_events e
    JOIN users u ON u.email = e.username AND NOT u.is_internal
    WHERE e.event_name = 'run_completed' AND {_QUALIFYING_RUN.format(p="e.properties")}
),
first_weeks AS (
    SELECT username, min(week) AS first_week FROM lifted GROUP BY username
)
SELECT
    l.week,
    count(*) FILTER (WHERE l.week = f.first_week) AS new_lifted,
    count(*) FILTER (WHERE l.week > f.first_week) AS returning_lifted
FROM lifted l
JOIN first_weeks f ON f.username = l.username
GROUP BY l.week
""",
    "metric_lifted_in_use_weekly": f"""
CREATE OR REPLACE VIEW metric_lifted_in_use_weekly AS
WITH program_days AS (
    SELECT
        j.username,
        date_trunc('week', e.received_at AT TIME ZONE 'UTC')::date AS week,
        count(DISTINCT (e.received_at AT TIME ZONE 'UTC')::date) AS days
    FROM telemetry_events e
    JOIN jobs j ON j.optimization_id = e.properties ->> 'optimization_id'
    JOIN users u ON u.email = j.username AND NOT u.is_internal
    WHERE e.event_name = 'serve_inference'
    AND e.properties ->> 'channel' IN ('api_token', 'share_link')
    GROUP BY j.optimization_id, j.username, 2
)
SELECT d.week, count(DISTINCT d.username) AS users_in_use
FROM program_days d
WHERE d.days >= 2
AND EXISTS (
    SELECT 1 FROM telemetry_events r
    WHERE r.event_name = 'run_completed'
    AND r.username = d.username
    AND r.received_at < ((d.week + 7)::timestamp AT TIME ZONE 'UTC')
    AND {_QUALIFYING_RUN.format(p="r.properties")}
)
GROUP BY d.week
""",
}


def upgrade() -> None:
    """Create (or replace) the three metric views on Postgres."""
    if op.get_bind().dialect.name != "postgresql":
        return
    for ddl in _VIEWS.values():
        op.execute(ddl)


def downgrade() -> None:
    """Drop the three metric views on Postgres."""
    if op.get_bind().dialect.name != "postgresql":
        return
    for name in reversed(list(_VIEWS)):
        op.execute(f"DROP VIEW IF EXISTS {name}")
