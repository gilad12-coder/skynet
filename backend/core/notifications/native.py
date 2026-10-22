"""Hand queued macOS notifications to the Mac app, and keep none in limbo.

:class:`core.notifications.channels.MacOSChannel` marks a delivery
``queued``. The open Mac app claims queued deliveries; a claim leases them
(``claimed``) for :data:`CLAIM_LEASE`. The app shows them through the system
notification center and then confirms them, which marks them ``sent``. A
claim whose answer never arrives runs out and is handed out again, and a
repeat shows with the same tag, so it replaces the earlier banner. A delivery
the app could not show within :data:`CLAIM_WINDOW` (the app was closed, or
notifications were not allowed) is marked ``expired`` once no lease on it is
active; the inbox still has it. The window counts from the delivery's
``since`` (when it was queued: at the event, or when its hold released it),
so a long hold never uses up the window before the app can claim the row.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, or_, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from ..config import settings
from ..storage.models import NotificationModel
from .catalog import MACOS
from .channels import Delivery, push_payload

CLAIM_WINDOW = timedelta(days=1)
CLAIM_LEASE = timedelta(seconds=60)
CLAIM_BATCH = 20
EXPIRE_BATCH = 100

_STATE = NotificationModel.deliveries[(MACOS, "state")].as_string()
_LEASE = NotificationModel.deliveries[(MACOS, "lease")].as_float()
_SINCE = NotificationModel.deliveries[(MACOS, "since")].as_float()


@dataclass(frozen=True)
class NativeNotification:
    """What the Mac app shows for one notification: display text and the app path it opens."""

    id: str
    title: str
    body: str
    url: str
    tag: str


def _mark(row: NotificationModel, state: dict[str, object]) -> None:
    """Replace the row's macOS delivery entry.

    Args:
        row: The notification row, locked by the caller.
        state: The new ``deliveries["macos"]`` value.
    """
    deliveries = dict(row.deliveries or {})
    deliveries[MACOS] = state
    row.deliveries = deliveries


def _payload(row: NotificationModel, locale: str | None) -> NativeNotification:
    """Build the display text for one row.

    Args:
        row: The notification row.
        locale: The Mac app's UI locale.

    Returns:
        The notification as the app shows it.
    """
    payload = push_payload(
        Delivery(
            notification_id=row.id,
            username=row.username,
            event_type=row.event_type,
            optimization_id=row.optimization_id,
            title=row.title,
            link=row.link,
            facts=dict(row.facts or {}),
        ),
        locale,
    )
    return NativeNotification(id=row.id, **payload)


def claim_native(
    engine: Engine, username: str, locale: str | None = None, now: datetime | None = None
) -> list[NativeNotification]:
    """Lease ``username``'s queued macOS deliveries, oldest first, and expire stale ones.

    Args:
        engine: Database engine holding the notifications table.
        username: The signed-in local user.
        locale: The Mac app's UI locale for the display text.
        now: Clock override for tests.

    Returns:
        The notifications to show; empty outside local mode.
    """
    if not settings.local_mode:
        return []
    now = now or datetime.now(UTC)
    cutoff = now - CLAIM_WINDOW
    claimable = or_(_STATE == "queued", and_(_STATE == "claimed", now.timestamp() > _LEASE))
    # Rows queued before ``since`` was recorded fall back to their event time.
    stale_window = or_(cutoff.timestamp() > _SINCE, and_(_SINCE.is_(None), NotificationModel.created_at < cutoff))
    open_window = or_(cutoff.timestamp() <= _SINCE, and_(_SINCE.is_(None), NotificationModel.created_at >= cutoff))
    with Session(engine) as session:
        # SKIP LOCKED: a second window's claim, or a writer on one row, never waits on this one.
        # A stale row with an active lease is on screen now; it expires only if its confirm never comes.
        # The limit keeps each poll's work bounded; the next poll expires the rest.
        stale = session.scalars(
            select(NotificationModel)
            .where(NotificationModel.username == username, stale_window, claimable)
            .order_by(NotificationModel.created_at)
            .limit(EXPIRE_BATCH)
            .with_for_update(skip_locked=True)
        )
        for row in stale:
            _mark(row, {"state": "expired", "at": now.isoformat()})
        rows = session.scalars(
            select(NotificationModel)
            .where(NotificationModel.username == username, open_window, claimable)
            .order_by(NotificationModel.created_at)
            .limit(CLAIM_BATCH)
            .with_for_update(skip_locked=True)
        ).all()
        claimed = [_payload(row, locale) for row in rows]
        for row in rows:
            since = (row.deliveries or {}).get(MACOS, {}).get("since")
            lease = {"state": "claimed", "lease": (now + CLAIM_LEASE).timestamp()}
            _mark(row, lease if since is None else {**lease, "since": since})
        session.commit()
    return claimed


def confirm_native(engine: Engine, username: str, ids: Iterable[str], now: datetime | None = None) -> int:
    """Mark the claimed deliveries the Mac app has shown as ``sent``.

    Args:
        engine: Database engine holding the notifications table.
        username: The signed-in local user.
        ids: Notification ids the app showed.
        now: Clock override for tests.

    Returns:
        How many deliveries turned ``sent``; 0 outside local mode.
    """
    wanted = list(dict.fromkeys(ids))
    if not settings.local_mode or not wanted:
        return 0
    now = now or datetime.now(UTC)
    with Session(engine) as session:
        rows = session.scalars(
            select(NotificationModel)
            .where(NotificationModel.username == username, NotificationModel.id.in_(wanted), _STATE == "claimed")
            .with_for_update(skip_locked=True)
        ).all()
        for row in rows:
            _mark(row, {"state": "sent", "at": now.isoformat()})
        session.commit()
    return len(rows)
