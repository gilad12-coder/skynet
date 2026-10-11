"""Notification public surface.

Every run and sharing event goes through :func:`.dispatch.notify`, which
stores the inbox item and routes it to the user's channels (see
:mod:`.channels`). The helpers re-exported here gather each event's facts for
the worker and API layers.
"""

from .dispatch import notify, start_notification_hold_sweeper
from .notifier import (
    notify_job_completed,
    notify_ownership_transfer,
    notify_role_change,
    notify_share_invite,
)
from .preferences import configure_notification_preferences

__all__ = [
    "configure_notification_preferences",
    "notify",
    "notify_job_completed",
    "notify_ownership_transfer",
    "notify_role_change",
    "notify_share_invite",
    "start_notification_hold_sweeper",
]
