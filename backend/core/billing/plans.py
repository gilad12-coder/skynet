"""Skynet Pro: the monthly platform plan and the limits it lifts.

Credits pay for usage at cost; Pro pays for the fixed platform behind it
(storage, job history, concurrent runs). The plan is mirrored from Stripe onto
``billing_customers`` by the webhook, and this module is the single place that
turns that mirrored status into an entitlement.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from ..config import settings

PLAN_FREE = "free"
PLAN_PRO = "pro"

PAST_DUE_STATUS = "past_due"

# Stripe subscription statuses that count as a live Pro subscription. ``past_due``
# is live while Stripe's smart retries run, so a single declined renewal doesn't
# lock a paying user out of their own data mid-cycle; the limits it grants are
# bounded separately by :func:`has_pro_entitlement`.
PRO_ENTITLED_STATUSES = frozenset({"active", "trialing", PAST_DUE_STATUS})


def is_pro_status(status: str | None) -> bool:
    """Return whether a mirrored Stripe subscription status is a live Pro subscription.

    Args:
        status: ``billing_customers.subscription_status``, or ``None`` when the
            account never subscribed.

    Returns:
        True when the subscription is live (possibly still retrying payment).
    """
    return status in PRO_ENTITLED_STATUSES


def has_pro_entitlement(
    status: str | None,
    past_due_since: datetime | None,
    *,
    now: datetime | None = None,
) -> bool:
    """Return whether a mirrored subscription currently grants the Pro limits.

    A ``past_due`` subscription keeps Pro for ``pro_past_due_grace_days`` after
    the failed renewal, then lapses to the free limits even though Stripe may
    keep retrying for weeks.

    Args:
        status: ``billing_customers.subscription_status``.
        past_due_since: When the webhook first saw the subscription go
            ``past_due``; ``None`` for any other status.
        now: Clock override for tests.

    Returns:
        True when the account is on Pro limits right now.
    """
    if not is_pro_status(status):
        return False
    if status != PAST_DUE_STATUS:
        return True
    # A past_due row without its timestamp can't prove it is inside the grace,
    # and granting it indefinitely is exactly what the grace exists to stop.
    if past_due_since is None:
        return False
    if past_due_since.tzinfo is None:
        past_due_since = past_due_since.replace(tzinfo=UTC)
    grace = timedelta(days=settings.pro_past_due_grace_days)
    return (now or datetime.now(UTC)) < past_due_since + grace
