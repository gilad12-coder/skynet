"""Pick the model agent interviews run on when the user chooses none.

Interviews send short questions and option lists, so the user mostly waits on
time to the first token and a short reply. Every input comes from OpenRouter,
with no list of labs or models written in:

1. Candidates are the catalog's featured models (each leading lab's newest,
   strongest releases, chosen from release dates and benchmarks) that are
   served through OpenRouter, priced and benchmarked.
2. "Small" keeps the cheaper half by input plus output price.
3. Models beaten on benchmark score, price and reply time at once drop out.
4. The fastest remaining model wins. Reply time is the fastest healthy
   endpoint's median time to first token plus a short reply at its median
   throughput, from OpenRouter's last-30-minute endpoint stats.

The pick refreshes in the background every 30 minutes. When the stats can't be
fetched it keeps the last pick, and before the first one it falls back to the
cheapest small candidate.
"""

from __future__ import annotations

import json
import logging
import os
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from threading import Lock, Thread

from ..config import settings
from .model_catalog import CatalogModel, ModelCatalogResponse, agent_model_id, catalog_snapshot, featured_score

logger = logging.getLogger(__name__)

_OPENROUTER_PREFIX = "openrouter/"
_ENDPOINTS_URL = "https://openrouter.ai/api/v1/models/{model}/endpoints"
_STATS_TTL_SECONDS = 30 * 60
# Tokens in a typical interview reply: one question and a few short options.
_REPLY_TOKENS = 150
# An endpoint that failed more than 1% of requests over the last day would
# stall interviews more than its speed saves.
_MIN_UPTIME_PERCENT = 99.0
_FETCH_TIMEOUT_SECONDS = 6

_lock = Lock()
_pick: str | None = None
_picked_at: float = 0.0
_refresh_in_flight = False


def _price(model: CatalogModel) -> float:
    """Return a model's input plus output price per token.

    Args:
        model: A priced catalog entry.

    Returns:
        The summed per-token price in USD.
    """
    return (model.input_cost_per_token or 0.0) + (model.output_cost_per_token or 0.0)


def small_candidates(catalog: ModelCatalogResponse) -> list[CatalogModel]:
    """Return the featured OpenRouter models in the cheaper half by price.

    Args:
        catalog: A built catalog.

    Returns:
        The candidates, cheapest first; empty when nothing qualifies.
    """
    featured = [
        m
        for m in catalog.models
        if m.featured
        and m.available
        and m.value.startswith(_OPENROUTER_PREFIX)
        and m.input_cost_per_token is not None
        and m.output_cost_per_token is not None
        and featured_score(m.value) is not None
    ]
    if not featured:
        return []
    median = statistics.median(_price(m) for m in featured)
    return sorted((m for m in featured if _price(m) <= median), key=_price)


def reply_ms(endpoints: list[dict]) -> float | None:
    """Return the fastest healthy endpoint's time to a short reply.

    Args:
        endpoints: OpenRouter's ``data.endpoints`` list for one model.

    Returns:
        Milliseconds to the first token plus :data:`_REPLY_TOKENS` at median
        throughput, or ``None`` when no endpoint has stats and enough uptime.
    """
    best: float | None = None
    for endpoint in endpoints:
        latency = endpoint.get("latency_last_30m") or {}
        throughput = endpoint.get("throughput_last_30m") or {}
        uptime = endpoint.get("uptime_last_1d")
        first_token, tokens_per_second = latency.get("p50"), throughput.get("p50")
        if not first_token or not tokens_per_second or uptime is None or uptime < _MIN_UPTIME_PERCENT:
            continue
        total = float(first_token) + _REPLY_TOKENS / float(tokens_per_second) * 1000
        best = total if best is None else min(best, total)
    return best


def choose(candidates: list[CatalogModel], times: dict[str, float]) -> str | None:
    """Return the fastest candidate no other candidate beats on every axis.

    Args:
        candidates: Output of :func:`small_candidates`.
        times: Measured reply milliseconds by catalog id; unmeasured
            candidates are left out.

    Returns:
        The winning catalog id, or ``None`` when no candidate was measured.
    """
    measured = [(m, featured_score(m.value) or 0.0, _price(m), times[m.value]) for m in candidates if m.value in times]

    def beaten(entry: tuple[CatalogModel, float, float, float]) -> bool:
        _, score, price, ms = entry
        return any(
            o_score >= score and o_price <= price and o_ms <= ms and (o_score, o_price, o_ms) != (score, price, ms)
            for o, o_score, o_price, o_ms in measured
            if o is not entry[0]
        )

    frontier = [entry for entry in measured if not beaten(entry)]
    if not frontier:
        return None
    return min(frontier, key=lambda entry: entry[3])[0].value


def _fetch_endpoints(model_value: str, api_key: str) -> list[dict] | None:
    """Fetch OpenRouter's per-endpoint stats for one model.

    Args:
        model_value: A catalog id under the ``openrouter/`` prefix.
        api_key: The platform's OpenRouter key; without one the stats are empty.

    Returns:
        The endpoint list, or ``None`` when the request fails.
    """
    slug = urllib.parse.quote(model_value.removeprefix(_OPENROUTER_PREFIX), safe="/")
    request = urllib.request.Request(
        _ENDPOINTS_URL.format(model=slug),
        headers={"Accept": "application/json", "Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=_FETCH_TIMEOUT_SECONDS) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        logger.warning("OpenRouter endpoint stats for %s failed: %s", model_value, exc)
        return None
    endpoints = (body.get("data") or {}).get("endpoints") if isinstance(body, dict) else None
    return endpoints if isinstance(endpoints, list) else None


def _measure(candidates: list[CatalogModel]) -> dict[str, float]:
    """Measure each candidate's reply time from OpenRouter's endpoint stats.

    Args:
        candidates: Output of :func:`small_candidates`.

    Returns:
        Reply milliseconds by catalog id, for the candidates with stats.
    """
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    if not api_key or not candidates:
        return {}
    with ThreadPoolExecutor(max_workers=min(8, len(candidates))) as pool:
        listings = list(pool.map(lambda m: _fetch_endpoints(m.value, api_key), candidates))
    times: dict[str, float] = {}
    for model, endpoints in zip(candidates, listings, strict=True):
        ms = reply_ms(endpoints or [])
        if ms is not None:
            times[model.value] = ms
    return times


def _refresh() -> None:
    """Recompute the pick and store it; never raises."""
    global _pick, _picked_at, _refresh_in_flight
    try:
        catalog = catalog_snapshot()
        if catalog is not None:
            candidates = small_candidates(catalog)
            winner = choose(candidates, _measure(candidates))
            with _lock:
                if winner:
                    _pick = winner
                    _picked_at = time.monotonic()
                    logger.info("Interview model picked: %s", winner)
    except Exception:
        logger.exception("Interview model refresh failed; keeping the previous pick")
    finally:
        with _lock:
            _refresh_in_flight = False


def _kick_refresh() -> None:
    """Start a background refresh unless one is running."""
    global _refresh_in_flight
    with _lock:
        if _refresh_in_flight:
            return
        _refresh_in_flight = True
    Thread(target=_refresh, name="interview-model-refresh", daemon=True).start()


def interview_model_id() -> str:
    """Return the model an agent interview runs when the user picks none.

    Never blocks: a stale or missing pick starts a background refresh and the
    caller gets the last pick meanwhile.

    Returns:
        ``INTERVIEW_AGENT_MODEL`` when set, else the measured pick, else the
        cheapest small featured model, else the agent default.
    """
    if settings.interview_agent_model.strip():
        return settings.interview_agent_model.strip()
    with _lock:
        pick, stale = _pick, time.monotonic() - _picked_at >= _STATS_TTL_SECONDS
    if pick is None or stale:
        _kick_refresh()
    if pick:
        return pick
    catalog = catalog_snapshot()
    cheapest = small_candidates(catalog) if catalog is not None else []
    return cheapest[0].value if cheapest else agent_model_id(settings.code_agent_model)


def with_interview_default(catalog: ModelCatalogResponse) -> ModelCatalogResponse:
    """Flag the model interviews run by default.

    Args:
        catalog: A cached catalog, left unmodified.

    Returns:
        A copy whose ``is_interview_default`` marks the current pick.
    """
    pick = interview_model_id()
    return catalog.model_copy(
        update={"models": [m.model_copy(update={"is_interview_default": m.value == pick}) for m in catalog.models]}
    )
