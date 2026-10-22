"""Durable notification-routing preferences shared by the API, the worker and the sweeper."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from ..config import settings as app_settings
from ..storage.models import NotificationPreferenceModel
from .catalog import (
    CHANNELS,
    DEFAULT_GRID,
    DEFAULT_HELD_CHANNELS,
    DEFAULT_HOLD_MINUTES,
    DELIVERY_CHANNELS,
    INBOX,
    INBOX_ONLY_EVENTS,
    LOCAL_CHANNELS,
    LOCAL_DEFAULT_CELLS,
    MAX_HOLD_MINUTES,
    MIN_HOLD_MINUTES,
)

logger = logging.getLogger(__name__)

_engine: Engine | None = None

Grid = dict[str, dict[str, bool]]


def grid_channels() -> tuple[str, ...]:
    """Return the grid's channel columns on this deployment.

    Returns:
        The hosted channels, plus the Mac app's own channels in local mode.
    """
    return (*CHANNELS, *LOCAL_CHANNELS) if app_settings.local_mode else CHANNELS


def delivery_channels() -> tuple[str, ...]:
    """Return the channels :func:`core.notifications.dispatch.notify` routes to on this deployment.

    Returns:
        The hosted delivery channels, plus the Mac app's own channels in local mode.
    """
    return (*DELIVERY_CHANNELS, *LOCAL_CHANNELS) if app_settings.local_mode else DELIVERY_CHANNELS


def default_grid() -> Grid:
    """Return a fresh copy of the default event x channel grid.

    Returns:
        A mutable ``{event_type: {channel: enabled}}`` mapping, with the
        local channels' default cells in local mode.
    """
    grid = {event: dict(row) for event, row in DEFAULT_GRID.items()}
    if app_settings.local_mode:
        for event, cells in LOCAL_DEFAULT_CELLS.items():
            grid[event].update(cells)
    return grid


def merge_grid(stored: Mapping[str, Any] | None) -> Grid:
    """Overlay stored grid cells on the default grid.

    Unknown events, unknown channels and non-bool values are ignored, and
    inbox-only events are forced back to inbox-only, so a stale or hand-edited
    row can never route product news to email.

    Args:
        stored: The persisted ``channel_grid`` (possibly partial), or ``None``.

    Returns:
        The complete effective grid.
    """
    grid = default_grid()
    channels = grid_channels()
    if isinstance(stored, Mapping):
        for event, row in stored.items():
            if event not in grid or not isinstance(row, Mapping):
                continue
            for channel, enabled in row.items():
                if channel in channels and isinstance(enabled, bool):
                    grid[event][channel] = enabled
    for event in INBOX_ONLY_EVENTS:
        grid[event] = {channel: channel == INBOX for channel in channels}
    return grid


def clamp_hold_minutes(value: Any) -> int:
    """Clamp a hold length to the supported range.

    Args:
        value: Candidate minutes.

    Returns:
        An integer between the minimum and maximum hold, or the default for
        anything that is not an integer.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return DEFAULT_HOLD_MINUTES
    return max(MIN_HOLD_MINUTES, min(MAX_HOLD_MINUTES, value))


def clean_held_channels(value: Any) -> tuple[str, ...]:
    """Keep only this deployment's delivery channels, in canonical order.

    Args:
        value: Candidate list of channel names, or ``None`` for the default.

    Returns:
        The held channels; the inbox is never held.
    """
    if value is None:
        return DEFAULT_HELD_CHANNELS
    if not isinstance(value, list | tuple):
        return DEFAULT_HELD_CHANNELS
    chosen = set(value)
    return tuple(channel for channel in delivery_channels() if channel in chosen)


@dataclass(frozen=True)
class NotificationSettings:
    """Effective notification routing for one identity; defaults match the API defaults."""

    grid: Grid = field(default_factory=default_grid)
    hold_minutes: int = DEFAULT_HOLD_MINUTES
    held_channels: tuple[str, ...] = DEFAULT_HELD_CHANNELS
    stuck_fraction: float = 0.25
    budget_alert_fraction: float = 0.8

    def enabled(self, event_type: str, channel: str) -> bool:
        """Return whether ``event_type`` is routed to ``channel``.

        Args:
            event_type: One of the catalog event types.
            channel: One of the catalog channels.

        Returns:
            The grid cell, ``False`` for unknown events or channels.
        """
        return bool(self.grid.get(event_type, {}).get(channel, False))

    def any_enabled(self, event_type: str) -> bool:
        """Return whether ``event_type`` reaches the user anywhere at all.

        Args:
            event_type: One of the catalog event types.

        Returns:
            ``True`` when at least one channel cell is on.
        """
        return any(self.grid.get(event_type, {}).values())


def settings_from_row(row: NotificationPreferenceModel | None) -> NotificationSettings:
    """Build effective settings from a stored row.

    Args:
        row: The identity's preference row, or ``None`` when it has none.

    Returns:
        The effective settings.
    """
    if row is None:
        return NotificationSettings()
    return NotificationSettings(
        grid=merge_grid(row.channel_grid),
        hold_minutes=clamp_hold_minutes(row.hold_minutes),
        held_channels=clean_held_channels(row.held_channels),
        stuck_fraction=row.stuck_fraction,
        budget_alert_fraction=row.budget_alert_fraction,
    )


def configure_notification_preferences(engine: Engine | None) -> None:
    """Set the database engine used for notification reads and writes.

    Args:
        engine: Shared application engine, or ``None`` in isolated tests, where
            notifications are neither stored nor sent.
    """
    global _engine
    _engine = engine


def notification_engine() -> Engine | None:
    """Return the engine configured by :func:`configure_notification_preferences`.

    Returns:
        The engine, or ``None`` when notifications are not wired up.
    """
    return _engine


def notification_settings(username: str) -> NotificationSettings:
    """Return ``username``'s effective notification routing.

    Missing rows and unavailable storage fall back to the defaults so a
    preference lookup can never fail the job that triggered it.

    Args:
        username: Recipient identity.

    Returns:
        The effective settings.
    """
    if _engine is None:
        return NotificationSettings()
    try:
        with Session(_engine) as session:
            return settings_from_row(session.get(NotificationPreferenceModel, username))
    except Exception:
        logger.warning("Notification preference lookup failed; using defaults", exc_info=True)
        return NotificationSettings()
