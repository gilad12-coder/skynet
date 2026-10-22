"""The single entry point every run event goes through: :func:`notify`.

``notify`` writes the inbox row, then routes the event to each channel the
user's grid enables. Urgent events go out at once everywhere. Other events
wait ``hold_minutes`` on the channels the user chose to hold; the
:class:`NotificationHoldSweeper` releases them later and drops a channel's
send when the user already read the inbox item.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..storage.models import NotificationModel
from .catalog import INBOX, URGENT_EVENTS
from .channels import Delivery, get_channel
from .preferences import NotificationSettings, delivery_channels, notification_engine, notification_settings

logger = logging.getLogger(__name__)

HOLD_SWEEP_INTERVAL_SECONDS = 30.0
_HOLD_SWEEP_BATCH = 200


def run_link(optimization_id: str) -> str:
    """Return the app path of a run's detail page.

    Args:
        optimization_id: The run.

    Returns:
        A path such as ``/optimizations/<id>``.
    """
    return f"/optimizations/{optimization_id}"


def _delivery(row: NotificationModel) -> Delivery:
    """Build the channel payload for a stored notification.

    Args:
        row: The stored notification.

    Returns:
        The delivery handed to channels.
    """
    return Delivery(
        notification_id=row.id,
        username=row.username,
        event_type=row.event_type,
        optimization_id=row.optimization_id,
        title=row.title,
        link=row.link,
        facts=dict(row.facts or {}),
    )


def _record(engine: Engine, notification_id: str, states: Mapping[str, str], now: datetime, since: datetime) -> None:
    """Merge channel delivery states into a notification's ``deliveries``.

    Args:
        engine: Database engine.
        notification_id: The notification row.
        states: ``{channel: state}`` to record.
        now: Timestamp stored with each state.
        since: When the row became deliverable (its event, or its hold's release).
    """
    with Session(engine) as session:
        row = session.get(NotificationModel, notification_id, with_for_update=True)
        if row is None:
            return
        deliveries = dict(row.deliveries or {})
        for channel, state in states.items():
            deliveries[channel] = {"state": state, "at": now.isoformat()}
            if state == "queued":
                # The Mac app's claim window counts from here, not from the event, so a held row keeps its full day.
                deliveries[channel]["since"] = since.timestamp()
        row.deliveries = deliveries
        session.commit()


def _send(delivery: Delivery, channel_name: str) -> str:
    """Send one delivery on one channel, never raising.

    Args:
        delivery: The notification payload.
        channel_name: Catalog channel name.

    Returns:
        The resulting delivery state.
    """
    channel = get_channel(channel_name)
    if channel is None:
        return "unavailable"
    try:
        return channel.send(delivery)
    except Exception:
        logger.warning("Channel %s failed for notification %s", channel_name, delivery.notification_id, exc_info=True)
        return "failed"


def _route(event_type: str, settings: NotificationSettings) -> tuple[list[str], list[str]]:
    """Split the enabled delivery channels into immediate and held ones.

    Args:
        event_type: The event being routed.
        settings: The recipient's routing.

    Returns:
        ``(immediate, held)`` channel names.
    """
    immediate: list[str] = []
    held: list[str] = []
    for channel in delivery_channels():
        if not settings.enabled(event_type, channel):
            continue
        if event_type not in URGENT_EVENTS and settings.hold_minutes > 0 and channel in settings.held_channels:
            held.append(channel)
        else:
            immediate.append(channel)
    return immediate, held


def notify(
    username: str | None,
    event_type: str,
    optimization_id: str | None = None,
    facts: Mapping[str, Any] | None = None,
    *,
    title: str = "",
    link: str | None = None,
    dedupe_key: str | None = None,
    now: datetime | None = None,
) -> str | None:
    """Record one event for one user and route it to their channels.

    Never raises: a notification failure must not fail the run or request
    that emitted it.

    Args:
        username: Recipient identity; ``None`` or empty is a no-op.
        event_type: One of the catalog event types.
        optimization_id: The run the event is about, when there is one.
        facts: ``score``, ``delta``, ``spent``, ``limit`` (dollars),
            ``duration`` (seconds) and an optional ``detail`` sentence.
        title: The run's display name (or the news headline).
        link: App path the item opens; defaults to the run's page.
        dedupe_key: Makes a repeated emit for the same identity a no-op.
        now: Clock override for tests.

    Returns:
        The notification id, or ``None`` when nothing was recorded.
    """
    engine = notification_engine()
    if engine is None or not username:
        return None
    try:
        return _notify(engine, username, event_type, optimization_id, facts, title, link, dedupe_key, now)
    except Exception:
        logger.warning("Notification %s for %s failed", event_type, optimization_id, exc_info=True)
        return None


def _notify(
    engine: Engine,
    username: str,
    event_type: str,
    optimization_id: str | None,
    facts: Mapping[str, Any] | None,
    title: str,
    link: str | None,
    dedupe_key: str | None,
    now: datetime | None,
) -> str | None:
    """Do the work of :func:`notify`; see it for the arguments.

    Args:
        engine: Database engine.
        username: Recipient identity.
        event_type: Catalog event type.
        optimization_id: The run, when there is one.
        facts: Event facts.
        title: Display title.
        link: App path the item opens.
        dedupe_key: Idempotency key.
        now: Clock override.

    Returns:
        The notification id, or ``None`` when nothing was recorded.
    """
    settings = notification_settings(username)
    if not settings.any_enabled(event_type):
        return None
    now = now or datetime.now(UTC)
    immediate, held = _route(event_type, settings)
    deliveries = {channel: {"state": "held", "at": now.isoformat()} for channel in held}
    row = NotificationModel(
        username=username,
        event_type=event_type,
        optimization_id=optimization_id,
        title=title,
        facts={key: value for key, value in (facts or {}).items() if value is not None},
        link=link if link is not None else (run_link(optimization_id) if optimization_id else None),
        dedupe_key=dedupe_key,
        in_inbox=settings.enabled(event_type, INBOX),
        created_at=now,
        deliveries=deliveries,
        hold_until=now + timedelta(minutes=settings.hold_minutes) if held else None,
    )
    with Session(engine) as session:
        session.add(row)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            return None
        delivery = _delivery(row)
    if immediate:
        states = {ch: _send(delivery, ch) for ch in immediate}
        _record(engine, delivery.notification_id, states, datetime.now(UTC), now)
    return delivery.notification_id


def release_held(engine: Engine, now: datetime | None = None) -> int:
    """Send or drop every held channel whose hold has ended.

    Each row is claimed by atomically clearing its ``hold_until``, so
    concurrent sweepers on several replicas never send the same row twice.
    A held channel is dropped when the user read the inbox item before the
    release, or switched that channel off since the event.

    Args:
        engine: Database engine.
        now: Clock override for tests.

    Returns:
        The number of notifications released.
    """
    now = now or datetime.now(UTC)
    with Session(engine) as session:
        due = list(
            session.scalars(
                select(NotificationModel.id)
                .where(NotificationModel.hold_until.is_not(None), NotificationModel.hold_until <= now)
                .order_by(NotificationModel.hold_until)
                .limit(_HOLD_SWEEP_BATCH)
            )
        )
    released = 0
    for notification_id in due:
        with Session(engine) as session:
            claimed = session.execute(
                update(NotificationModel)
                .where(NotificationModel.id == notification_id, NotificationModel.hold_until.is_not(None))
                .values(hold_until=None)
            ).rowcount
            session.commit()
            if not claimed:
                continue
            row = session.get(NotificationModel, notification_id)
            if row is None:
                continue
            delivery = _delivery(row)
            read = row.read_at is not None
            held = [ch for ch, state in (row.deliveries or {}).items() if (state or {}).get("state") == "held"]
        settings = notification_settings(delivery.username)
        states = {}
        for channel in held:
            if read or not settings.enabled(delivery.event_type, channel):
                states[channel] = "dropped"
            else:
                states[channel] = _send(delivery, channel)
        if states:
            _record(engine, notification_id, states, datetime.now(UTC), now)
        released += 1
    return released


class NotificationHoldSweeper:
    """Background thread that releases held notifications every few seconds."""

    def __init__(self, engine: Engine, interval_seconds: float = HOLD_SWEEP_INTERVAL_SECONDS) -> None:
        """Bind the sweeper.

        Args:
            engine: Database engine holding the notifications table.
            interval_seconds: Seconds between sweeps.
        """
        self._engine = engine
        self._interval_seconds = interval_seconds
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Start the background sweep loop."""
        self._thread = threading.Thread(target=self._run, name="notification-hold-sweeper", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop the background sweep loop."""
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def sweep_once(self) -> int:
        """Run one release pass, never raising.

        Returns:
            The number of notifications released.
        """
        try:
            return release_held(self._engine)
        except Exception:
            logger.warning("Notification hold sweep failed", exc_info=True)
            return 0

    def _run(self) -> None:
        """Run the sweep loop until stopped."""
        while not self._stop_event.wait(self._interval_seconds):
            self.sweep_once()


def start_notification_hold_sweeper(engine: Engine | None) -> NotificationHoldSweeper | None:
    """Start the hold sweeper when a database engine is available.

    Args:
        engine: Database engine, or ``None`` for storage without SQL.

    Returns:
        The started sweeper (callers ``stop()`` it on shutdown), or ``None``.
    """
    if engine is None:
        return None
    sweeper = NotificationHoldSweeper(engine)
    sweeper.start()
    return sweeper
