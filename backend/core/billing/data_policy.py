"""Per-user choice of which OpenRouter providers may receive prompts on platform-paid calls.

The three settings mirror OpenRouter's own privacy controls:

- ``allow``: any provider, including ones that may train on or store prompts.
- ``deny``: only providers that neither train on nor retain prompts (the default).
- ``zdr``: only endpoints with a zero-data-retention agreement.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Mapping
from typing import Any, Literal, get_args

import httpx
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from ..storage.models import ModelPrivacyPreferenceModel

logger = logging.getLogger(__name__)

DataPolicy = Literal["allow", "deny", "zdr"]
DATA_POLICIES: tuple[str, ...] = get_args(DataPolicy)
DEFAULT_DATA_POLICY: DataPolicy = "deny"
ZDR_ENDPOINTS_URL = "https://openrouter.ai/api/v1/endpoints/zdr"
_ZDR_TTL_SECONDS = 3600.0

_engine: Engine | None = None
_zdr_lock = threading.Lock()
_zdr_cache: tuple[float, frozenset[str]] | None = None


def configure_data_policy(engine: Engine | None) -> None:
    """Set the database engine used for model privacy preference reads.

    Args:
        engine: Shared application engine, or ``None`` in isolated tests.
    """
    global _engine
    _engine = engine


def data_policy_for(username: str) -> DataPolicy:
    """Return the caller's stored setting, failing closed to ``deny``.

    A lookup that cannot complete must not widen where prompts go, so missing
    storage, a missing row, and an unknown stored value all read as ``deny``.

    Args:
        username: Authenticated owner of the run.

    Returns:
        The effective data policy for platform-paid model calls.
    """
    if _engine is None:
        return DEFAULT_DATA_POLICY
    try:
        with Session(_engine) as session:
            row = session.get(ModelPrivacyPreferenceModel, username)
    except Exception:
        logger.warning("Model privacy preference lookup failed; using deny", exc_info=True)
        return DEFAULT_DATA_POLICY
    if row is None or row.data_policy not in DATA_POLICIES:
        return DEFAULT_DATA_POLICY
    return row.data_policy  # type: ignore[return-value]


def apply_data_policy(request: Mapping[str, Any], policy: DataPolicy) -> dict[str, Any]:
    """Force the setting onto a request's provider routing, overriding any guest value.

    Args:
        request: Final request body from the optimizer child.
        policy: The owner's effective setting.

    Returns:
        A copy whose ``provider`` routing carries ``data_collection`` and ``zdr``.
    """
    body = dict(request)
    routing = body.get("provider")
    routing = dict(routing) if isinstance(routing, Mapping) else {}
    routing["data_collection"] = "allow" if policy == "allow" else "deny"
    if policy == "zdr":
        routing["zdr"] = True
    else:
        routing.pop("zdr", None)
    body["provider"] = routing
    return body


def zero_retention_models(client: httpx.Client | None = None) -> frozenset[str]:
    """Return model slugs with at least one zero-data-retention endpoint, cached for an hour.

    Args:
        client: Optional HTTP client for tests; a short-lived one is used otherwise.

    Returns:
        Model ids from OpenRouter's public ZDR endpoint list, or the last known
        set (empty when never fetched) if the list is unavailable.
    """
    global _zdr_cache
    with _zdr_lock:
        if _zdr_cache is not None and time.monotonic() - _zdr_cache[0] < _ZDR_TTL_SECONDS:
            return _zdr_cache[1]
    try:
        if client is None:
            with httpx.Client(timeout=10.0) as owned:
                response = owned.get(ZDR_ENDPOINTS_URL)
        else:
            response = client.get(ZDR_ENDPOINTS_URL)
        response.raise_for_status()
        models = frozenset(
            row["model_id"]
            for row in response.json().get("data") or []
            if isinstance(row, dict) and isinstance(row.get("model_id"), str)
        )
    except (httpx.HTTPError, ValueError):
        logger.warning("OpenRouter ZDR endpoint list unavailable", exc_info=True)
        with _zdr_lock:
            return _zdr_cache[1] if _zdr_cache is not None else frozenset()
    with _zdr_lock:
        _zdr_cache = (time.monotonic(), models)
    return models
