"""Attribute each billed model call to the run stage, pair, candidate and case it served.

Tags travel with the request as one header, so they cross every boundary a
call can take: a worker child's HTTP call to the gateway, a sandbox command's
mailbox document, and the guest proxy. They are display attribution only. The
money a call costs and the role it is billed under come from the trusted
route, never from a tag, so a forged tag can only mislabel its own run's rows.
"""

from __future__ import annotations

import contextlib
import contextvars
import json
import re
from collections.abc import Iterator, Mapping
from typing import Any

USAGE_TAGS_HEADER = "x-skynet-usage-tags"
TAG_KEYS = ("stage", "pair", "candidate", "case", "caller", "kind")
# ``caller`` values: which optimizer drove an optimization-route call.
CALLER_PROPOSER = "proposer"
CALLER_REFLECTION = "reflection"
# ``kind`` values: what an engine that makes several sorts of model calls used one for.
KIND_MUTATION = "mutation"
KIND_META_NOTES = "meta_notes"
_MAX_VALUE_CHARS = 64
_MAX_HEADER_CHARS = 512
_VALUE = re.compile(r"[A-Za-z0-9_.:@/+ -]+")

_scope: contextvars.ContextVar[dict[str, str] | None] = contextvars.ContextVar("usage_tags", default=None)


def clean_tags(tags: Mapping[str, Any] | None) -> dict[str, str]:
    """Keep only known keys with short, printable values.

    Args:
        tags: Candidate tags from any source, trusted or not.

    Returns:
        The tags safe to store and display; unknown keys and odd values are dropped.
    """
    cleaned: dict[str, str] = {}
    for key in TAG_KEYS:
        value = (tags or {}).get(key)
        if value is None or isinstance(value, bool):
            continue
        text = str(value).strip()[:_MAX_VALUE_CHARS]
        if text and _VALUE.fullmatch(text):
            cleaned[key] = text
    return cleaned


def encode_tags(tags: Mapping[str, Any]) -> str:
    """Serialize tags for the request header.

    Args:
        tags: Tags to send.

    Returns:
        Compact JSON, empty when nothing is worth sending.
    """
    cleaned = clean_tags(tags)
    return json.dumps(cleaned, separators=(",", ":"), sort_keys=True) if cleaned else ""


def parse_tags(header: str | None) -> dict[str, str]:
    """Read tags from a request header, ignoring anything malformed.

    Args:
        header: The raw header value, or ``None``.

    Returns:
        The cleaned tags; empty for a missing, oversized or invalid header.
    """
    if not header or len(header) > _MAX_HEADER_CHARS:
        return {}
    try:
        value = json.loads(header)
    except ValueError:
        return {}
    return clean_tags(value) if isinstance(value, dict) else {}


def header_tags(headers: Mapping[str, str] | None) -> dict[str, str]:
    """Read the tags header from a header mapping of any case.

    Args:
        headers: Request headers.

    Returns:
        The cleaned tags.
    """
    for name, value in (headers or {}).items():
        if name.lower() == USAGE_TAGS_HEADER:
            return parse_tags(value)
    return {}


def current_tags() -> dict[str, str]:
    """Return the tags of the innermost open :func:`usage_scope`.

    Returns:
        A copy of the active tags, empty outside any scope.
    """
    return dict(_scope.get() or {})


@contextlib.contextmanager
def usage_scope(**tags: Any) -> Iterator[None]:
    """Tag every model call made while the block runs on this context.

    Scopes nest: an inner one keeps the outer's tags and overrides those it sets.

    Args:
        **tags: ``stage``, ``pair``, ``candidate``, ``case``, ``caller`` or ``kind``; ``None`` keeps the outer value.

    Yields:
        Nothing; the scope ends when the block does.
    """
    token = _scope.set({**current_tags(), **clean_tags(tags)})
    try:
        yield
    finally:
        _scope.reset(token)


class TagsToken:
    """Undo one :func:`usage_tags_token` from the context that opened it."""

    def __init__(self, token: contextvars.Token[dict[str, str] | None]) -> None:
        """Hold the context variable token to restore.

        Args:
            token: Token returned when the tags were set.
        """
        self._token = token

    def reset(self) -> None:
        """Restore the outer tags; a no-op when called from another context."""
        with contextlib.suppress(ValueError):
            _scope.reset(self._token)


def usage_tags_token(**tags: Any) -> TagsToken:
    """Open a tag scope that a callback closes later, unlike :func:`usage_scope`.

    Args:
        **tags: Tags to add; ``None`` keeps the outer value.

    Returns:
        A token whose ``reset`` restores the outer tags.
    """
    return TagsToken(_scope.set({**current_tags(), **clean_tags(tags)}))


def with_tags_header(headers: Mapping[str, str] | None, tags: Mapping[str, Any]) -> dict[str, str]:
    """Return headers carrying ``tags`` merged over any tags already present.

    Args:
        headers: Existing request headers.
        tags: Tags that take precedence over the existing header's.

    Returns:
        A new header mapping; unchanged apart from the tags header.
    """
    result = {name: value for name, value in (headers or {}).items() if name.lower() != USAGE_TAGS_HEADER}
    encoded = encode_tags({**header_tags(headers), **clean_tags(tags)})
    if encoded:
        result[USAGE_TAGS_HEADER] = encoded
    return result
