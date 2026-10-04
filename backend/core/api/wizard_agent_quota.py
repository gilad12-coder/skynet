"""Daily turn cap of the free black-box wizard agent.

The wizard agent (its interview and chat) does not spend the user's credits.
What bounds it instead is a per-account count of turns per UTC day, shared
across replicas through the ``wizard_agent_usage`` table.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..storage.models import WizardAgentUsageModel
from .errors import DomainError

DAILY_LIMIT_CODE = "wizard_agent.daily_limit_reached"


def _utc_today() -> date:
    """Return the current UTC date."""
    return datetime.now(UTC).date()


def _try_increment(engine: Any, day: date, username: str, cap: int) -> bool:
    """Count one turn on an existing row that is still under the cap.

    Args:
        engine: SQLAlchemy engine holding the usage table.
        day: UTC day the turn counts against.
        username: Account starting the turn.
        cap: Turns allowed per day.

    Returns:
        Whether a row was below the cap and now holds the turn.
    """
    with Session(engine) as session:
        result = session.execute(
            update(WizardAgentUsageModel)
            .where(
                WizardAgentUsageModel.day == day,
                WizardAgentUsageModel.username == username,
                WizardAgentUsageModel.turns < cap,
            )
            .values(turns=WizardAgentUsageModel.turns + 1)
        )
        session.commit()
        return result.rowcount == 1


def _try_insert_first(engine: Any, day: date, username: str) -> bool:
    """Record an account's first turn of the day.

    Args:
        engine: SQLAlchemy engine holding the usage table.
        day: UTC day the turn counts against.
        username: Account starting the turn.

    Returns:
        Whether the row was created; ``False`` when it already exists.
    """
    with Session(engine) as session:
        session.add(WizardAgentUsageModel(day=day, username=username, turns=1))
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            return False
        return True


def consume_wizard_agent_turn(engine: Any, username: str) -> None:
    """Count one wizard agent turn for today, or refuse it at the daily cap.

    The conditional update keeps concurrent turns from overshooting the cap;
    when two first turns of the day race to insert, the loser retries the
    update. A store with no SQL engine (legacy/in-memory) or a cap of 0 skips
    the count.

    Args:
        engine: SQLAlchemy engine holding the usage table, or ``None``.
        username: Account starting the turn.

    Raises:
        DomainError: 429 when the account has used today's turns.
    """
    cap = settings.wizard_agent_daily_turns
    if engine is None or cap <= 0 or not username:
        return
    normalized = username.strip().lower()
    day = _utc_today()
    if _try_increment(engine, day, normalized, cap):
        return
    if _try_insert_first(engine, day, normalized):
        return
    if _try_increment(engine, day, normalized, cap):
        return
    raise DomainError(DAILY_LIMIT_CODE, status=429, limit=cap)
