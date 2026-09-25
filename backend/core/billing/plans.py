"""Skynet Pro: the monthly platform plan and the limits it lifts.

Credits pay for usage at cost; Pro pays for the fixed platform behind it
(storage, job history, concurrent runs). The plan is mirrored from Stripe onto
``billing_customers`` by the webhook, and this module is the single place that
turns that mirrored status into an entitlement.
"""

from __future__ import annotations

PLAN_FREE = "free"
PLAN_PRO = "pro"

# Stripe subscription statuses that keep Pro limits on. ``past_due`` stays
# entitled while Stripe's smart retries run, so a single declined renewal
# doesn't lock a paying user out of their own data mid-cycle; Stripe moves the
# subscription to ``canceled`` or ``unpaid`` once retries are exhausted.
PRO_ENTITLED_STATUSES = frozenset({"active", "trialing", "past_due"})


def is_pro_status(status: str | None) -> bool:
    """Return whether a mirrored Stripe subscription status grants Pro.

    Args:
        status: ``billing_customers.subscription_status``, or ``None`` when the
            account never subscribed.

    Returns:
        True when the status keeps the account on Pro limits.
    """
    return status in PRO_ENTITLED_STATUSES
