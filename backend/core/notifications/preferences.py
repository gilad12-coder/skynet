"""Durable email-notification preference lookup shared by API and workers."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from ..storage.models import NotificationPreferenceModel

logger = logging.getLogger(__name__)

NotificationCategory = Literal["job_updates", "sharing_updates"]
_engine: Engine | None = None


@dataclass(frozen=True)
class RunNotificationSettings:
    """Effective run-email cadence for one account; defaults match the API defaults."""

    cadence: str = "done"
    live_mode: str = "per_stage"
    live_count: int = 3
    digest_minutes: int = 60
    stuck_fraction: float = 0.25
    budget_alert_fraction: float = 0.8

    @property
    def milestones(self) -> bool:
        """Whether milestone mail (new best, stuck, budget, needs input) is on."""
        return self.cadence in ("milestones", "live")

    @property
    def live(self) -> bool:
        """Whether stage-change progress mail is on."""
        return self.cadence == "live"


def configure_notification_preferences(engine: Engine | None) -> None:
    """Set the database engine used for notification preference reads.

    Args:
        engine: Shared application engine, or ``None`` to restore the default
            enabled behavior in isolated tests.
    """
    global _engine
    _engine = engine


def notification_category_enabled(username: str, category: NotificationCategory) -> bool:
    """Return whether ``username`` allows the optional email category.

    Missing rows and unavailable storage fail open so a preference lookup can
    never fail the job or sharing action that triggered it. Account-security
    mail does not pass through this function and remains unaffected.

    Args:
        username: Recipient identity.
        category: Optional email category being considered.

    Returns:
        ``False`` only when the stored category preference is explicitly off.
    """
    if _engine is None:
        return True
    try:
        with Session(_engine) as session:
            row = session.get(NotificationPreferenceModel, username)
    except Exception:
        logger.warning("Notification preference lookup failed; using enabled default", exc_info=True)
        return True
    if row is None:
        return True
    if category == "job_updates":
        return bool(row.job_updates_enabled)
    return bool(row.sharing_updates_enabled)


def run_notification_settings(username: str) -> RunNotificationSettings | None:
    """Return ``username``'s run-email cadence, or ``None`` when job mail is off.

    ``job_updates_enabled=false`` is the master switch for every run email, so
    it short-circuits to ``None``. Missing rows and unavailable storage fail
    open to the defaults, which (cadence ``done``) send no in-run mail at all.

    Args:
        username: Recipient identity.

    Returns:
        The effective settings, or ``None`` when the account disabled job mail.
    """
    if _engine is None:
        return RunNotificationSettings()
    try:
        with Session(_engine) as session:
            row = session.get(NotificationPreferenceModel, username)
    except Exception:
        logger.warning("Notification preference lookup failed; using default cadence", exc_info=True)
        return RunNotificationSettings()
    if row is None:
        return RunNotificationSettings()
    if not row.job_updates_enabled:
        return None
    return RunNotificationSettings(
        cadence=row.cadence,
        live_mode=row.live_mode,
        live_count=row.live_count,
        digest_minutes=row.digest_minutes,
        stuck_fraction=row.stuck_fraction,
        budget_alert_fraction=row.budget_alert_fraction,
    )
