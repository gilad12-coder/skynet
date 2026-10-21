"""split the old continuous models switch into one switch per role

Revision ID: d2a8f4c6e1b9
Revises: c9e5a1f3b7d4
Create Date: 2026-10-19 12:00:00.000000

Plans enabled before SKY-100 stored ``permitted`` as
``{"data", "models", "optimizers"}``. Checks now switch only models, one
switch per role, so ``models`` becomes both ``task_model`` and
``reflection_model``. A row that already names a role is left as it is, so
running this twice changes nothing.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "d2a8f4c6e1b9"
down_revision: str | None = "c9e5a1f3b7d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
_ROLES = ("task_model", "reflection_model")
_OLD_SWITCHES = frozenset({"data", "models", "optimizers"})
_plans = sa.table("continuous_plans", sa.column("id", sa.String(36)), sa.column("permitted", _JSON))


def upgrade() -> None:
    """Give every old-shape plan both role switches, set to its old ``models`` switch."""
    bind = op.get_bind()
    for plan_id, permitted in bind.execute(sa.select(_plans.c.id, _plans.c.permitted)).all():
        if not isinstance(permitted, dict) or any(role in permitted for role in _ROLES):
            continue
        if not _OLD_SWITCHES & permitted.keys():
            continue
        allowed = bool(permitted.get("models"))
        bind.execute(_plans.update().where(_plans.c.id == plan_id).values(permitted=dict.fromkeys(_ROLES, allowed)))


def downgrade() -> None:
    """Map the role switches back to the old ``models`` switch, on when either role was on."""
    bind = op.get_bind()
    for plan_id, permitted in bind.execute(sa.select(_plans.c.id, _plans.c.permitted)).all():
        if not isinstance(permitted, dict) or not any(role in permitted for role in _ROLES):
            continue
        allowed = any(bool(permitted.get(role)) for role in _ROLES)
        bind.execute(
            _plans.update()
            .where(_plans.c.id == plan_id)
            .values(permitted={"data": False, "models": allowed, "optimizers": False})
        )
