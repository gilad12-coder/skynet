"""Read-only client for the Sentry issues API, used by the admin dashboard.

The dashboard lists the organization's unresolved issues across every project
(backend, worker and frontend all report to the same organization). It needs
``SENTRY_API_TOKEN`` and ``SENTRY_ORG``; without them the dashboard shows an
empty state instead of calling Sentry.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlsplit

import requests

logger = logging.getLogger(__name__)

SENTRY_TIMEOUT_SECONDS = 5.0
SENTRY_STATS_PERIOD = "14d"
_US_API = "https://sentry.io"
_EU_API = "https://de.sentry.io"


class SentryUnavailableError(RuntimeError):
    """Sentry could not be reached or rejected the request."""


def sentry_api_base(dsn: str | None) -> str:
    """Pick the Sentry API origin for the organization's data region.

    An EU organization's DSN points at ``*.ingest.de.sentry.io`` and its API
    lives on ``de.sentry.io``; everything else uses ``sentry.io``.

    Args:
        dsn: The configured Sentry DSN, or ``None``.

    Returns:
        The API origin, without a trailing slash.
    """
    host = urlsplit(dsn).hostname or "" if dsn else ""
    return _EU_API if host.endswith(".de.sentry.io") else _US_API


def fetch_unresolved_issues(*, token: str, org: str, base_url: str, limit: int) -> list[dict[str, Any]]:
    """Return the organization's most frequent unresolved issues of the last 14 days.

    Args:
        token: Sentry auth token with ``event:read``.
        org: Organization slug.
        base_url: API origin from :func:`sentry_api_base`.
        limit: Maximum number of issues.

    Returns:
        The raw issue objects, most frequent first.

    Raises:
        SentryUnavailableError: On a network error, a non-2xx reply or a body
            that is not a list.
    """
    try:
        response = requests.get(
            f"{base_url}/api/0/organizations/{org}/issues/",
            params={"query": "is:unresolved", "statsPeriod": SENTRY_STATS_PERIOD, "sort": "freq", "limit": limit},
            headers={"Authorization": f"Bearer {token}"},
            timeout=SENTRY_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise SentryUnavailableError("sentry request failed") from exc
    if not response.ok:
        logger.warning("sentry issues request returned %s", response.status_code)
        raise SentryUnavailableError(f"sentry returned {response.status_code}")
    try:
        body = response.json()
    except ValueError as exc:
        raise SentryUnavailableError("sentry returned a non-JSON body") from exc
    if not isinstance(body, list):
        raise SentryUnavailableError("sentry returned an unexpected body")
    return [item for item in body if isinstance(item, dict)]
