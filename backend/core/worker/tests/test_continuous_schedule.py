"""Verify continuous-plan repeat rules give the run times their wording promises."""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

from core.worker.continuous_schedule import ScheduleRule, legacy_rule, next_runs

BERLIN = ZoneInfo("Europe/Berlin")


def _local(rule: ScheduleRule, after: datetime, count: int, anchor: datetime | None = None) -> list[datetime]:
    """Return the next run times in the rule's zone.

    Args:
        rule: The rule.
        after: Reference time.
        count: How many runs.
        anchor: Interval anchor.

    Returns:
        Local run times.
    """
    zone = ZoneInfo(rule.timezone)
    return [t.astimezone(zone) for t in next_runs(rule, after, anchor=anchor, count=count)]


def test_daily_keeps_the_wall_clock_time_across_daylight_saving() -> None:
    """09:00 in Berlin stays 09:00 the day after clocks move forward."""
    rule = ScheduleRule(frequency="daily", time="09:00", timezone="Europe/Berlin")
    runs = _local(rule, datetime(2026, 3, 28, 12, tzinfo=UTC), 2)
    assert [(t.day, t.hour, t.minute) for t in runs] == [(29, 9, 0), (30, 9, 0)]
    assert runs[0].utcoffset() != datetime(2026, 3, 28, 12, tzinfo=BERLIN).utcoffset()


def test_weekly_on_chosen_days_every_other_week() -> None:
    """Every 2 weeks on Monday and Thursday skips the off week, counted from the anchor."""
    rule = ScheduleRule(frequency="weekly", every=2, weekdays=[3, 0], time="08:00", timezone="UTC")
    anchor = datetime(2026, 10, 19, tzinfo=UTC)
    runs = _local(rule, anchor, 4, anchor=anchor)
    assert rule.weekdays == [0, 3]
    assert [t.date().isoformat() for t in runs] == ["2026-10-19", "2026-10-22", "2026-11-02", "2026-11-05"]


def test_hourly_every_three_hours_at_the_chosen_minute() -> None:
    """Every 3 hours from 01:20 runs at 01:20, 04:20, 07:20 and so on."""
    rule = ScheduleRule(frequency="hourly", every=3, time="01:20", timezone="UTC")
    anchor = datetime(2026, 10, 19, tzinfo=UTC)
    runs = _local(rule, datetime(2026, 10, 19, 2, tzinfo=UTC), 3, anchor=anchor)
    assert [(t.hour, t.minute) for t in runs] == [(4, 20), (7, 20), (10, 20)]


def test_hourly_phase_carries_across_midnight() -> None:
    """Every 5 hours keeps its 5-hour step through midnight instead of restarting at 00:00."""
    rule = ScheduleRule(frequency="hourly", every=5, time="00:00", timezone="UTC")
    anchor = datetime(2026, 10, 19, tzinfo=UTC)
    runs = next_runs(rule, datetime(2026, 10, 19, 21, tzinfo=UTC), anchor=anchor, count=2)
    assert [t.isoformat() for t in runs] == ["2026-10-20T01:00:00+00:00", "2026-10-20T06:00:00+00:00"]


def test_monthly_31st_falls_on_the_last_day_of_short_months() -> None:
    """The 31st runs on 28 February and 30 April rather than skipping them."""
    rule = ScheduleRule(frequency="monthly", month_day=31, time="12:00", timezone="UTC")
    runs = _local(rule, datetime(2027, 1, 31, 13, tzinfo=UTC), 3)
    assert [t.date().isoformat() for t in runs] == ["2027-02-28", "2027-03-31", "2027-04-30"]


def test_quarterly_counts_months_from_the_anchor() -> None:
    """Every 3 months on the 1st runs in January, April and July for a January anchor."""
    rule = ScheduleRule(frequency="monthly", every=3, month_day=1, time="06:00", timezone="UTC")
    anchor = datetime(2027, 1, 1, tzinfo=UTC)
    runs = _local(rule, anchor, 3, anchor=anchor)
    assert [t.month for t in runs] == [1, 4, 7]


def test_runs_are_strictly_after_the_reference_time() -> None:
    """A run exactly at the reference time is not returned again."""
    rule = ScheduleRule(frequency="daily", time="09:00", timezone="UTC")
    at = datetime(2026, 10, 19, 9, tzinfo=UTC)
    assert next_runs(rule, at)[0] == datetime(2026, 10, 20, 9, tzinfo=UTC)


def test_a_legacy_name_reads_as_a_rule() -> None:
    """Plans saved as ``daily``/``weekly`` become 09:00 UTC rules."""
    assert legacy_rule("daily").frequency == "daily"
    weekly = legacy_rule("weekly")
    assert (weekly.frequency, weekly.weekdays, weekly.time, weekly.timezone) == ("weekly", [0], "09:00", "UTC")


@pytest.mark.parametrize(
    "fields",
    [
        {"frequency": "weekly"},
        {"frequency": "daily", "every": 31},
        {"frequency": "monthly", "month_day": 32},
        {"frequency": "daily", "time": "9:00"},
        {"frequency": "daily", "timezone": "Nowhere/City"},
    ],
)
def test_impossible_rules_are_refused(fields: dict) -> None:
    """A rule with no weekday, too long an interval, a bad time or an unknown zone is refused."""
    with pytest.raises(ValidationError):
        ScheduleRule(**fields)
