"""Live per-model OpenRouter token prices, cached in-process.

OpenRouter is the platform's only managed provider, and its public model
listing (``GET /api/v1/models``) publishes the per-token USD price of every
category a text request can bill: prompt, completion, cache read, cache write
and internal reasoning. LiteLLM's static table lags those prices and has no
cache-discount or reasoning rows for most OpenRouter slugs, so the metered
charge prices from this listing whenever a response did not report its own
``usage.cost``.

The listing is fetched lazily, refreshed hourly, and seeded by the model
catalog build (which already downloads it). A failed fetch is retried at most
once a minute so an OpenRouter outage never adds a network timeout to every
charge. The module is a leaf: it imports nothing from the rest of ``core``.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)

MODELS_URL = "https://openrouter.ai/api/v1/models"
_TTL_SECONDS = 3600.0
_RETRY_SECONDS = 60.0
_TIMEOUT_SECONDS = 3.0


@dataclass(frozen=True)
class TokenPrices:
    """Per-token USD prices of one model's text billing categories.

    A cache or reasoning price of ``None`` means OpenRouter publishes no
    separate rate, so those tokens bill at the plain prompt or completion rate.
    """

    prompt: float
    completion: float
    cache_read: float | None = None
    cache_write: float | None = None
    reasoning: float | None = None


_lock = threading.Lock()
_prices: dict[str, TokenPrices] = {}
_fetched_at = 0.0
_failed_at = 0.0
# Tests flip this off (see core/conftest.py) so pricing never depends on the network.
fetch_enabled = True


def _rate(pricing: Mapping[str, Any], field: str) -> float | None:
    """Parse one non-negative per-token rate from an OpenRouter pricing dict.

    Args:
        pricing: The ``pricing`` object of a listing row.
        field: The rate's key, e.g. ``"prompt"``.

    Returns:
        The rate in USD per token, or ``None`` when absent, malformed or
        negative (OpenRouter marks router slugs whose price varies with ``-1``).
    """
    try:
        value = float(pricing[field])
    except (KeyError, TypeError, ValueError):
        return None
    return value if value >= 0 else None


def prices_from_pricing(pricing: Any) -> TokenPrices | None:
    """Build :class:`TokenPrices` from a listing row's ``pricing`` object.

    Args:
        pricing: The raw ``pricing`` value of an OpenRouter model row.

    Returns:
        The parsed prices, or ``None`` when the prompt or completion rate is
        missing — a model without both cannot be priced from the listing.
    """
    if not isinstance(pricing, Mapping):
        return None
    prompt = _rate(pricing, "prompt")
    completion = _rate(pricing, "completion")
    if prompt is None or completion is None:
        return None
    return TokenPrices(
        prompt=prompt,
        completion=completion,
        cache_read=_rate(pricing, "input_cache_read"),
        cache_write=_rate(pricing, "input_cache_write"),
        reasoning=_rate(pricing, "internal_reasoning"),
    )


def remember(rows: Iterable[Any]) -> None:
    """Replace the cached prices with a freshly downloaded model listing.

    Args:
        rows: The ``data`` rows of ``GET /api/v1/models``.
    """
    global _fetched_at
    parsed: dict[str, TokenPrices] = {}
    for row in rows:
        if not isinstance(row, Mapping) or not isinstance(row.get("id"), str):
            continue
        prices = prices_from_pricing(row.get("pricing"))
        if prices is not None:
            parsed[row["id"]] = prices
    if not parsed:
        return
    with _lock:
        _prices.clear()
        _prices.update(parsed)
        _fetched_at = time.monotonic()


def _refresh_if_stale() -> None:
    """Download the listing when the cache is older than the TTL.

    Failures are logged and throttled so a down listing costs one timeout a
    minute, not one per charge; the stale cache keeps serving meanwhile.
    """
    global _failed_at
    now = time.monotonic()
    with _lock:
        fresh = _prices and now - _fetched_at < _TTL_SECONDS
        throttled = now - _failed_at < _RETRY_SECONDS
    if not fetch_enabled or fresh or throttled:
        return
    try:
        response = httpx.get(MODELS_URL, timeout=_TIMEOUT_SECONDS)
        response.raise_for_status()
        rows = response.json().get("data", [])
    except (httpx.HTTPError, ValueError, AttributeError) as exc:
        with _lock:
            _failed_at = now
        logger.warning("OpenRouter price listing unavailable: %s", exc)
        return
    remember(rows)


def _slug_candidates(model_id: str) -> list[str]:
    """List the OpenRouter slugs a LiteLLM model id may correspond to.

    Args:
        model_id: A LiteLLM id such as ``openrouter/anthropic/claude-x``.

    Returns:
        Candidate listing ids, most specific first.
    """
    name = model_id.removeprefix("litellm_proxy/")
    candidates = [name]
    if name.startswith("openrouter/"):
        candidates.append(name.removeprefix("openrouter/"))
    return candidates


def live_prices(model_id: str) -> TokenPrices | None:
    """Return a model's current OpenRouter prices, refreshing the cache if stale.

    Args:
        model_id: The model id as billed (LiteLLM or bare OpenRouter slug).

    Returns:
        The model's prices, or ``None`` when the listing does not price it.
    """
    _refresh_if_stale()
    with _lock:
        for slug in _slug_candidates(model_id):
            prices = _prices.get(slug)
            if prices is not None:
                return prices
    return None


def reset() -> None:
    """Drop the cache and failure throttle, for tests."""
    global _fetched_at, _failed_at
    with _lock:
        _prices.clear()
        _fetched_at = 0.0
        _failed_at = 0.0
