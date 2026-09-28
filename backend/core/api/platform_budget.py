"""Monthly spend caps for the platform-paid services users never pay for directly.

Dictation (Groq Whisper) and embeddings run on the platform's own keys and are
not metered against user balances, so nothing else bounds what a bug, a runaway
client or an abusive account can spend on them. Each service gets a counter in
Redis keyed by calendar month (UTC); callers check :func:`budget_open` before a
paid call and add the call's cost with :func:`record_spend` after it. The unit
is the caller's choice (dollars for dictation, tokens for embeddings) as long
as the cap uses the same one.

The first spend that crosses a cap logs one ERROR per service per month, which
the alert log handler forwards to the operator webhook. Without Redis, or when
Redis errors, the budget fails closed to a conservative in-process counter:
each process may spend ``platform_budget_fallback_fraction`` of the cap per
month on its own (``0`` refuses every budgeted call). That keeps dictation and
search working through a Redis outage without leaving spend unbounded.
"""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime

from redis.exceptions import RedisError

from ..config import settings
from .rate_limit import shared_redis_client

logger = logging.getLogger("skynet.api.platform_budget")

# Outlives the longest month so a counter is still readable on its last day.
_COUNTER_TTL_SECONDS = 35 * 24 * 3600

_fallback_lock = threading.Lock()
_fallback_spent: dict[str, float] = {}


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
        False when the shared counter has reached the cap, or when Redis is
        unavailable and this process has used up its fallback share.
    """
    if cap <= 0:
        return True
    key = _month_key(service, now)
    client = shared_redis_client()
    if client is None:
        return _fallback_open(key, cap)
    try:
        spent = client.get(key)
    except RedisError as err:
        logger.warning("platform budget read failed for %s: %s", service, err)
        return _fallback_open(key, cap)
    return spent is None or float(spent) < cap


def record_spend(
    service: str,
    amount: float,
    cap: float,
    *,
    now: datetime | None = None,
    alert: bool = True,
) -> None:
    """Add ``amount`` to this month's counter and alert once when it crosses ``cap``.

    Args:
        service: Short service tag, e.g. ``"groq"``.
        amount: Cost of the call just made, in the cap's unit.
        cap: Monthly cap; ``0`` or less disables counting.
        now: Clock override for tests.
        alert: Whether crossing the cap pages the operator. Per-user caps pass
            False: one heavy user hitting their own ceiling is not an incident.
    """
    if cap <= 0 or amount <= 0:
        return
    key = _month_key(service, now)
    client = shared_redis_client()
    if client is None:
        _fallback_record(key, amount)
        return
    try:
        total = float(client.incrbyfloat(key, amount))
        client.expire(key, _COUNTER_TTL_SECONDS, nx=True)
        crossed = total >= cap > total - amount
        # SET NX makes the alert fire once per month even when replicas cross together.
        if alert and crossed and client.set(f"{key}:alerted", "1", nx=True, ex=_COUNTER_TTL_SECONDS):
            logger.error(
                "Platform budget reached for %s: %.2f of %.2f this month. Calls are refused until the month rolls over or the cap is raised.",
                service,
                total,
                cap,
            )
    except RedisError as err:
        logger.warning("platform budget write failed for %s: %s", service, err)
        _fallback_record(key, amount)


def _fallback_limit(cap: float) -> float:
    """Return this process's share of ``cap`` while Redis is unavailable.

    Args:
        cap: The shared monthly cap.

    Returns:
        The in-process ceiling; ``0`` refuses every call.
    """
    return cap * settings.platform_budget_fallback_fraction


def _fallback_open(key: str, cap: float) -> bool:
    """Return whether the in-process counter for ``key`` is still under its share.

    Args:
        key: Month-scoped counter key from :func:`_month_key`.
        cap: The shared monthly cap.

    Returns:
        True while this process has spent less than its fallback share.
    """
    limit = _fallback_limit(cap)
    with _fallback_lock:
        return limit > 0 and _fallback_spent.get(key, 0.0) < limit


def _fallback_record(key: str, amount: float) -> None:
    """Add ``amount`` to the in-process counter for ``key``.

    Args:
        key: Month-scoped counter key from :func:`_month_key`.
        amount: Cost of the call just made.
    """
    month_suffix = key.rsplit(":", 1)[-1]
    with _fallback_lock:
        # Drop earlier months so a long-lived process does not grow the dict forever.
        for stale in [k for k in _fallback_spent if not k.endswith(month_suffix)]:
            del _fallback_spent[stale]
        _fallback_spent[key] = _fallback_spent.get(key, 0.0) + amount
