"""When a continuous plan checks: a schedule rule and its next run times.

A rule reads like the repeat settings of common automation tools: every N
hours, days, weeks or months, at a wall-clock time in the owner's time zone,
on chosen weekdays (weekly) or a day of the month (monthly). Times are
computed in that zone, so a 09:00 check stays at 09:00 across daylight-saving
changes. A day of the month a month doesn't have (the 31st in April) falls on
that month's last day instead of being skipped. On top of the repeat, the
owner can turn single checks off (``skip``) or add single checks (``extra``),
each a local ``YYYY-MM-DDTHH:MM`` slot picked on the calendar.
"""

from __future__ import annotations

import calendar
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator

Frequency = Literal["hourly", "daily", "weekly", "monthly"]

MAX_EVERY: dict[str, int] = {"hourly": 12, "daily": 30, "weekly": 8, "monthly": 12}
# Long enough to reach the next run of the sparsest rule (every 12 months on the 31st).
# Skips can push the next run further out, so the window is counted from the last skip.
_SEARCH_DAYS = 800
_LEGACY_DEFAULT_TIME = "09:00"
_MAX_SLOTS = 400


# A plan's repeat rule; ``weekdays`` count from Monday = 0.
class ScheduleRule(BaseModel):
    frequency: Frequency
    every: int = Field(default=1, ge=1, le=30)
    time: str = Field(default="09:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    weekdays: list[int] = Field(default_factory=list, max_length=7)
    month_day: int = Field(default=1, ge=1, le=31)
    timezone: str = Field(default="UTC", min_length=1, max_length=64)
    skip: list[str] = Field(default_factory=list, max_length=_MAX_SLOTS)
    extra: list[str] = Field(default_factory=list, max_length=_MAX_SLOTS)

    @field_validator("skip", "extra")
    @classmethod
    def _slots(cls, value: list[str]) -> list[str]:
        """Keep each local slot once, in order, and refuse anything not a real date and time.

        Args:
            value: Local ``YYYY-MM-DDTHH:MM`` slots.

        Returns:
            The sorted, unique slots.

        Raises:
            ValueError: On a slot that is not a valid date and time.
        """
        for slot in value:
            try:
                datetime.strptime(slot, "%Y-%m-%dT%H:%M")
            except ValueError as exc:
                raise ValueError(f"{slot!r} is not a YYYY-MM-DDTHH:MM time") from exc
        return sorted(set(value))

    @field_validator("weekdays")
    @classmethod
    def _weekdays(cls, value: list[int]) -> list[int]:
        """Keep each weekday once, in order, and refuse anything outside 0..6.

        Args:
            value: Weekday numbers, Monday = 0.

        Returns:
            The sorted, unique weekdays.

        Raises:
            ValueError: On a number outside 0..6.
        """
        if any(day < 0 or day > 6 for day in value):
            raise ValueError("weekdays run from 0 (Monday) to 6 (Sunday)")
        return sorted(set(value))

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str) -> str:
        """Refuse a zone name the server's time-zone database doesn't know.

        Args:
            value: IANA zone name, such as ``Europe/Berlin``.

        Returns:
            The zone name.

        Raises:
            ValueError: On an unknown zone.
        """
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"unknown time zone {value!r}") from exc
        return value

    @model_validator(mode="after")
    def _shape(self) -> ScheduleRule:
        """Check the fields the frequency uses.

        Returns:
            The validated rule.

        Raises:
            ValueError: On an interval too long for the frequency, or a weekly rule with no weekday.
        """
        if self.every > MAX_EVERY[self.frequency]:
            raise ValueError(f"a {self.frequency} schedule repeats at most every {MAX_EVERY[self.frequency]}")
        if self.frequency == "weekly" and not self.weekdays:
            raise ValueError("a weekly schedule needs at least one weekday")
        return self


def legacy_rule(schedule: str) -> ScheduleRule:
    """Read a plan saved before rules existed (``daily`` or ``weekly``) as a rule.

    Args:
        schedule: The stored frequency name.

    Returns:
        A daily rule, or a weekly rule on Mondays, at 09:00 UTC.
    """
    if schedule == "daily":
        return ScheduleRule(frequency="daily", time=_LEGACY_DEFAULT_TIME)
    return ScheduleRule(frequency="weekly", weekdays=[0], time=_LEGACY_DEFAULT_TIME)


def _month_index(day: date) -> int:
    """Count months from year 0 so two dates' month distance is a subtraction.

    Args:
        day: Any date.

    Returns:
        ``year * 12 + month``.
    """
    return day.year * 12 + day.month


def _slots_by_day(slots: list[str]) -> dict[str, set[str]]:
    """Group local ``YYYY-MM-DDTHH:MM`` slots by their date.

    Args:
        slots: Validated local slots.

    Returns:
        ``HH:MM`` times keyed by ``YYYY-MM-DD``.
    """
    grouped: dict[str, set[str]] = {}
    for slot in slots:
        day, at = slot.split("T")
        grouped.setdefault(day, set()).add(at)
    return grouped


def _day_times(
    rule: ScheduleRule,
    day: date,
    anchor: date,
    skipped: dict[str, set[str]],
    added: dict[str, set[str]],
) -> list[time]:
    """List the wall-clock times the rule fires on one local date.

    Args:
        rule: The schedule rule.
        day: Local date to test.
        anchor: Local date the plan started counting from, so "every 2 weeks" has a phase.
        skipped: The rule's ``skip`` slots, grouped by date.
        added: The rule's ``extra`` slots, grouped by date.

    Returns:
        The times on ``day``, earliest first; empty when the rule skips it.
    """
    key = day.isoformat()
    wall = {at.strftime("%H:%M") for at in _repeat_times(rule, day, anchor)}
    return [time.fromisoformat(at) for at in sorted((wall - skipped.get(key, set())) | added.get(key, set()))]


def _repeat_times(rule: ScheduleRule, day: date, anchor: date) -> list[time]:
    """List the times the repeat alone fires on one local date, before single-check changes.

    Args:
        rule: The schedule rule.
        day: Local date to test.
        anchor: Local date the plan started counting from.

    Returns:
        The repeat's times on ``day``.
    """
    hour, minute = (int(part) for part in rule.time.split(":"))
    at = [time(hour, minute)]
    if rule.frequency == "hourly":
        offset = (day - anchor).days * 24
        return [time(h, minute) for h in range(24) if (offset + h - hour) % rule.every == 0]
    if rule.frequency == "daily":
        return at if (day - anchor).days % rule.every == 0 else []
    if rule.frequency == "weekly":
        anchor_monday = anchor - timedelta(days=anchor.weekday())
        week = (day - anchor_monday).days // 7
        return at if day.weekday() in rule.weekdays and week % rule.every == 0 else []
    if (_month_index(day) - _month_index(anchor)) % rule.every:
        return []
    last = calendar.monthrange(day.year, day.month)[1]
    return at if day.day == min(rule.month_day, last) else []


def next_runs(rule: ScheduleRule, after: datetime, *, anchor: datetime | None = None, count: int = 1) -> list[datetime]:
    """Return the rule's next run times strictly after ``after``, in UTC.

    Args:
        rule: The schedule rule.
        after: Times at or before this are skipped.
        anchor: When the plan started counting intervals; defaults to ``after``.
        count: How many run times to return.

    Returns:
        Up to ``count`` aware UTC datetimes, earliest first.
    """
    zone = ZoneInfo(rule.timezone)
    after = after.astimezone(UTC)
    local_start = after.astimezone(zone).date()
    anchor_day = (anchor or after).astimezone(zone).date()
    skipped = _slots_by_day(rule.skip)
    added = _slots_by_day(rule.extra)
    search_from = max(local_start, date.fromisoformat(max(skipped))) if skipped else local_start
    found: list[datetime] = []
    day = local_start
    while (day - search_from).days < _SEARCH_DAYS:
        for at in _day_times(rule, day, anchor_day, skipped, added):
            when = datetime.combine(day, at, tzinfo=zone).astimezone(UTC)
            if when > after and (not found or when > found[-1]):
                found.append(when)
                if len(found) == count:
                    return found
        day += timedelta(days=1)
    return found
