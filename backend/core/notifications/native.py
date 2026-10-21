"""Hand queued macOS notifications to the Mac app, each one once.

:class:`core.notifications.channels.MacOSChannel` marks a delivery
``queued``. The open Mac app claims the queued deliveries, shows them through
the system notification center, and the claim marks them ``sent``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from ..config import settings
from ..storage.models import NotificationModel
from .catalog import MACOS
from .channels import Delivery, push_payload

# Only recent rows can still hold a queued delivery the app has not shown;
# older ones are stale news (the app was closed), and the inbox still has them.
CLAIM_WINDOW = timedelta(days=1)
CLAIM_BATCH = 20


@dataclass(frozen=True)
class NativeNotification:
    """What the Mac app shows for one notification: display text and the app path it opens."""

    id: str
    title: str
    body: str
    url: str
    tag: str


def claim_native(engine: Engine, username: str, now: datetime | None = None) -> list[NativeNotification]:
    """Claim ``username``'s queued macOS deliveries, oldest first.

    Args:
        engine: Database engine holding the notifications table.
        username: The signed-in local user.
        now: Clock override for tests.

    Returns:
        The notifications to show; empty outside local mode.
    """
    if not settings.local_mode:
        return []
    now = now or datetime.now(UTC)
    claimed: list[NativeNotification] = []
    with Session(engine) as session:
        rows = session.scalars(
            select(NotificationModel)
            .where(NotificationModel.username == username, NotificationModel.created_at >= now - CLAIM_WINDOW)
            .order_by(NotificationModel.created_at)
            .with_for_update()
        )
        for row in rows:
            deliveries = dict(row.deliveries or {})
            if (deliveries.get(MACOS) or {}).get("state") != "queued":
                continue
            payload = push_payload(
                Delivery(
                    notification_id=row.id,
                    username=row.username,
                    event_type=row.event_type,
                    optimization_id=row.optimization_id,
                    title=row.title,
                    link=row.link,
                    facts=dict(row.facts or {}),
                )
            )
            claimed.append(NativeNotification(id=row.id, **payload))
            deliveries[MACOS] = {"state": "sent", "at": now.isoformat()}
            row.deliveries = deliveries
            if len(claimed) >= CLAIM_BATCH:
                break
        session.commit()
    return claimed
