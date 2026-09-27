"""Tests for the platform budget's in-process fallback when Redis is unavailable."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from redis.exceptions import RedisError

from ...config import settings
from .. import platform_budget

_NOW = datetime(2026, 9, 1, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _fresh_fallback() -> Iterator[None]:
    """Isolate each test from the module-level fallback counters."""
    platform_budget._fallback_spent.clear()
    yield
    platform_budget._fallback_spent.clear()


class _BrokenRedis:
    """Redis double whose every call raises, like an unreachable server."""

    def get(self, _key: str) -> None:
        """Raise the error a dead connection raises."""
        raise RedisError("down")

    def incrbyfloat(self, _key: str, _amount: float) -> None:
        """Raise the error a dead connection raises."""
        raise RedisError("down")


def test_without_redis_the_budget_closes_at_the_fallback_share(monkeypatch: pytest.MonkeyPatch) -> None:
    """With Redis unset, each process may spend only its fraction of the cap."""
    monkeypatch.setattr(platform_budget, "shared_redis_client", lambda: None)
    monkeypatch.setattr(settings, "platform_budget_fallback_fraction", 0.1)
    assert platform_budget.budget_open("svc", 100, now=_NOW)
    platform_budget.record_spend("svc", 9, 100, now=_NOW)
    assert platform_budget.budget_open("svc", 100, now=_NOW)
    platform_budget.record_spend("svc", 1, 100, now=_NOW)
    assert not platform_budget.budget_open("svc", 100, now=_NOW)
    assert platform_budget.budget_open("other", 100, now=_NOW)


def test_redis_errors_fall_back_to_the_in_process_counter(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Redis that errors counts spend locally instead of failing open."""
    monkeypatch.setattr(platform_budget, "shared_redis_client", _BrokenRedis)
    monkeypatch.setattr(settings, "platform_budget_fallback_fraction", 0.5)
    platform_budget.record_spend("svc", 50, 100, now=_NOW)
    assert not platform_budget.budget_open("svc", 100, now=_NOW)


def test_zero_fallback_fraction_refuses_every_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """A fraction of 0 makes a Redis outage refuse all budgeted calls."""
    monkeypatch.setattr(platform_budget, "shared_redis_client", lambda: None)
    monkeypatch.setattr(settings, "platform_budget_fallback_fraction", 0.0)
    assert not platform_budget.budget_open("svc", 100, now=_NOW)


def test_disabled_cap_stays_open_without_redis(monkeypatch: pytest.MonkeyPatch) -> None:
    """A cap of 0 still means unbounded, Redis or not."""
    monkeypatch.setattr(platform_budget, "shared_redis_client", lambda: None)
    monkeypatch.setattr(settings, "platform_budget_fallback_fraction", 0.0)
    assert platform_budget.budget_open("svc", 0, now=_NOW)


def test_fallback_counter_resets_with_the_month(monkeypatch: pytest.MonkeyPatch) -> None:
    """Spend counted in one month does not close the next month's budget."""
    monkeypatch.setattr(platform_budget, "shared_redis_client", lambda: None)
    monkeypatch.setattr(settings, "platform_budget_fallback_fraction", 0.1)
    platform_budget.record_spend("svc", 10, 100, now=_NOW)
    next_month = datetime(2026, 10, 1, tzinfo=UTC)
    assert platform_budget.budget_open("svc", 100, now=next_month)
    platform_budget.record_spend("svc", 1, 100, now=next_month)
    assert list(platform_budget._fallback_spent) == ["skynet:platform-budget:svc:2026-10"]
