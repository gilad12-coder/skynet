"""Monthly spend caps for the platform-paid services users never pay for directly.

Dictation (Groq Whisper) and embeddings run on the platform's own keys and are
not metered against user credits, so nothing else bounds what a bug, a runaway
client or an abusive account can spend on them. Each service gets a counter in
Redis keyed by calendar month (UTC); callers check :func:`budget_open` before a
paid call and add the call's cost with :func:`record_spend` after it. The unit
is the caller's choice (dollars for dictation, tokens for embeddings) as long
as the cap uses the same one.

The first spend that crosses a cap logs one ERROR per service per month, which
the alert log handler forwards to the operator webhook. Everything fails open:
without Redis, or when Redis errors, calls are allowed and nothing is counted,
because a monitoring outage must not take dictation or search down with it.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from redis.exceptions import RedisError

from .rate_limit import shared_redis_client

logger = logging.getLogger("skynet.api.platform_budget")

# Outlives the longest month so a counter is still readable on its last day.
_COUNTER_TTL_SECONDS = 35 * 24 * 3600


def _month_key(service: str, now: datetime | None) -> str:
    """Return the Redis counter key for ``service`` in the current UTC month.

    Args:
        service: Short service tag, e.g. ``"groq"``.
        now: Clock override for tests; ``None`` reads the real UTC time.

    Returns:
        The counter key.
    """
    stamp = now or datetime.now(UTC)
    return f"skynet:platform-budget:{service}:{stamp:%Y-%m}"


def budget_open(service: str, cap: float, *, now: datetime | None = None) -> bool:
    """Return whether ``service`` may still spend this month.

    Args:
        service: Short service tag, e.g. ``"groq"``.
        cap: Monthly cap in the caller's unit; ``0`` or less disables it.
        now: Clock override for tests.

    Returns:
        False only when a readable counter has reached the cap.
    """
    client = shared_redis_client()
    if cap <= 0 or client is None:
        return True
    try:
        spent = client.get(_month_key(service, now))
    except RedisError as err:
        logger.warning("platform budget read failed for %s: %s", service, err)
        return True
    return spent is None or float(spent) < cap


def record_spend(service: str, amount: float, cap: float, *, now: datetime | None = None) -> None:
    """Add ``amount`` to this month's counter and alert once when it crosses ``cap``.

    Args:
        service: Short service tag, e.g. ``"groq"``.
        amount: Cost of the call just made, in the cap's unit.
        cap: Monthly cap; ``0`` or less disables counting.
        now: Clock override for tests.
    """
    client = shared_redis_client()
    if cap <= 0 or amount <= 0 or client is None:
        return
    key = _month_key(service, now)
    try:
        total = float(client.incrbyfloat(key, amount))
        client.expire(key, _COUNTER_TTL_SECONDS, nx=True)
        crossed = total >= cap > total - amount
        # SET NX makes the alert fire once per month even when replicas cross together.
        if crossed and client.set(f"{key}:alerted", "1", nx=True, ex=_COUNTER_TTL_SECONDS):
            logger.error(
                "Platform budget reached for %s: %.2f of %.2f this month. Calls are refused until the month rolls over or the cap is raised.",
                service,
                total,
                cap,
            )
    except RedisError as err:
        logger.warning("platform budget write failed for %s: %s", service, err)
