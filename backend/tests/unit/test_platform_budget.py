"""Unit tests for the monthly platform budget counters.

Runs against an in-memory ``fakeredis`` double. Covers counting up to the cap,
the once-per-month alert, month rollover, the disabled cap, and the fail-open
behaviour without Redis or when Redis errors.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

import fakeredis
import pytest
from redis.exceptions import RedisError

from core.api import platform_budget
from core.api.platform_budget import budget_open, record_spend

_JAN = datetime(2026, 1, 15, tzinfo=UTC)
_FEB = datetime(2026, 2, 1, tzinfo=UTC)


@pytest.fixture
def fake_redis(monkeypatch: pytest.MonkeyPatch) -> fakeredis.FakeStrictRedis:
    """Point the budget module at a fresh in-memory Redis."""
    client = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr(platform_budget, "shared_redis_client", lambda: client)
    return client


def test_budget_closes_at_the_cap_and_reopens_next_month(fake_redis: fakeredis.FakeStrictRedis) -> None:
    """Spend up to the cap closes the month; a new month starts at zero."""
    record_spend("groq", 4.0, 10.0, now=_JAN)
    assert budget_open("groq", 10.0, now=_JAN)
    record_spend("groq", 6.0, 10.0, now=_JAN)
    assert not budget_open("groq", 10.0, now=_JAN)
    assert budget_open("groq", 10.0, now=_FEB)
    assert budget_open("embeddings", 10.0, now=_JAN)


def test_crossing_alerts_once(fake_redis: fakeredis.FakeStrictRedis, caplog: pytest.LogCaptureFixture) -> None:
    """Only the spend that crosses the cap logs the ERROR the alert handler forwards."""
    caplog.set_level(logging.ERROR, logger="skynet.api.platform_budget")
    for _ in range(4):
        record_spend("groq", 4.0, 10.0, now=_JAN)
    assert len(caplog.records) == 1
    assert "groq" in caplog.records[0].getMessage()


def test_zero_cap_disables_counting(fake_redis: fakeredis.FakeStrictRedis) -> None:
    """A cap of 0 never refuses and writes nothing."""
    record_spend("groq", 99.0, 0, now=_JAN)
    assert budget_open("groq", 0, now=_JAN)
    assert fake_redis.keys("*") == []


def test_fails_open_without_redis(monkeypatch: pytest.MonkeyPatch) -> None:
    """No Redis configured means every call is allowed."""
    monkeypatch.setattr(platform_budget, "shared_redis_client", lambda: None)
    record_spend("groq", 99.0, 1.0, now=_JAN)
    assert budget_open("groq", 1.0, now=_JAN)


def test_fails_open_when_redis_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Redis outage allows the call instead of raising."""

    class _Broken:
        """Redis stub whose every command raises."""

        def __getattr__(self, _name: str):
            """Return a callable that raises ``RedisError``."""

            def _raise(*_args: object, **_kwargs: object) -> None:
                """Raise the outage error."""
                raise RedisError("down")

            return _raise

    monkeypatch.setattr(platform_budget, "shared_redis_client", _Broken)
    record_spend("groq", 1.0, 1.0, now=_JAN)
    assert budget_open("groq", 1.0, now=_JAN)
