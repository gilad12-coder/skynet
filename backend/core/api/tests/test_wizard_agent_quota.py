"""Tests for the free wizard agent's daily turn cap."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import create_engine

from ...config import settings
from ...storage.models import Base, WizardAgentUsageModel
from .. import wizard_agent_quota
from ..errors import DomainError
from ..wizard_agent_quota import consume_wizard_agent_turn


@pytest.fixture
def engine():
    """Return an in-memory SQLite engine holding only the usage table."""
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng, tables=[WizardAgentUsageModel.__table__])
    return eng


def test_turns_count_up_to_the_cap_then_refuse(engine, monkeypatch) -> None:
    """The cap's worth of turns pass; the next is a 429 naming the cap."""
    monkeypatch.setattr(settings, "wizard_agent_daily_turns", 3)
    for _ in range(3):
        consume_wizard_agent_turn(engine, "alice")
    with pytest.raises(DomainError) as exc:
        consume_wizard_agent_turn(engine, "alice")
    assert exc.value.status_code == 429
    assert exc.value.code == wizard_agent_quota.DAILY_LIMIT_CODE
    assert exc.value.params == {"limit": 3}


def test_cap_is_per_user_and_per_day(engine, monkeypatch) -> None:
    """Another account, or the next UTC day, starts from zero."""
    monkeypatch.setattr(settings, "wizard_agent_daily_turns", 1)
    monkeypatch.setattr(wizard_agent_quota, "_utc_today", lambda: date(2026, 1, 1))
    consume_wizard_agent_turn(engine, "Alice")
    consume_wizard_agent_turn(engine, "bob")
    with pytest.raises(DomainError):
        consume_wizard_agent_turn(engine, "alice")
    monkeypatch.setattr(wizard_agent_quota, "_utc_today", lambda: date(2026, 1, 2))
    consume_wizard_agent_turn(engine, "alice")


def test_zero_cap_or_no_engine_skips_the_count(engine, monkeypatch) -> None:
    """A cap of 0 disables the limit, and a store without SQL never blocks."""
    monkeypatch.setattr(settings, "wizard_agent_daily_turns", 0)
    for _ in range(5):
        consume_wizard_agent_turn(engine, "alice")
    monkeypatch.setattr(settings, "wizard_agent_daily_turns", 1)
    for _ in range(3):
        consume_wizard_agent_turn(None, "alice")
