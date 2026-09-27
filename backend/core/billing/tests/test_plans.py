"""Tests for Skynet Pro entitlement, including the bounded past-due grace period."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from core.billing.plans import has_pro_entitlement
from core.config import settings

_NOW = datetime(2026, 9, 26, 12, tzinfo=UTC)


@pytest.mark.parametrize("status", ["active", "trialing"])
def test_live_subscription_is_entitled(status: str) -> None:
    """Active and trialing subscriptions grant Pro regardless of any stale past-due stamp."""
    assert has_pro_entitlement(status, None, now=_NOW) is True


@pytest.mark.parametrize("status", [None, "canceled", "incomplete", "unpaid"])
def test_non_pro_status_is_not_entitled(status: str | None) -> None:
    """Statuses outside the Pro set never grant Pro."""
    assert has_pro_entitlement(status, _NOW, now=_NOW) is False


def test_past_due_is_entitled_inside_the_grace_period(monkeypatch: pytest.MonkeyPatch) -> None:
    """A past-due subscription keeps Pro until the grace period runs out."""
    monkeypatch.setattr(settings, "pro_past_due_grace_days", 7)
    assert has_pro_entitlement("past_due", _NOW - timedelta(days=6, hours=23), now=_NOW) is True
    assert has_pro_entitlement("past_due", _NOW - timedelta(days=7), now=_NOW) is False


def test_past_due_accepts_a_naive_timestamp(monkeypatch: pytest.MonkeyPatch) -> None:
    """SQLite hands back naive datetimes; they are read as UTC."""
    monkeypatch.setattr(settings, "pro_past_due_grace_days", 7)
    naive = (_NOW - timedelta(days=1)).replace(tzinfo=None)
    assert has_pro_entitlement("past_due", naive, now=_NOW) is True


def test_past_due_without_a_start_is_not_entitled() -> None:
    """With no recorded start the grace cannot be bounded, so Pro lapses."""
    assert has_pro_entitlement("past_due", None, now=_NOW) is False


def test_zero_grace_lapses_immediately(monkeypatch: pytest.MonkeyPatch) -> None:
    """A grace of 0 days drops Pro as soon as the subscription goes past due."""
    monkeypatch.setattr(settings, "pro_past_due_grace_days", 0)
    assert has_pro_entitlement("past_due", _NOW, now=_NOW) is False
