"""The structured fields a run-log record can carry beyond its level, logger and message.

A record names where it came from (``source``), may name a typed ``event`` with
JSON ``fields``, and may belong to one ``candidate`` and ``case``. Producers set
them with :func:`event_extra`; every handler that persists a record reads them
back with :func:`entry_fields`, so the run log keeps them whichever path the
record took to the database.
"""

from __future__ import annotations

import logging
from typing import Any

# Where a record came from. "host" is Skynet's own code; the rest originate in a
# sandbox and are attributed by the host, never by what the sandbox claims.
SOURCES = ("host", "engine", "proposer", "scorer", "sandbox")
SANDBOX_SOURCES = frozenset(SOURCES) - {"host"}
RECORD_ATTR = "run_log"

# Column widths of ``job_logs``; a value longer than its column is cut to fit.
LEVEL_CHARS = 20
LOGGER_CHARS = 255
SOURCE_CHARS = 32
EVENT_CHARS = 255
CANDIDATE_CHARS = 64
CASE_CHARS = 255
_ELLIPSIS = "..."


def fit(value: str | None, limit: int) -> str | None:
    """Cut ``value`` to ``limit`` characters, ending it with ``...`` when cut.

    Args:
        value: Text bound for a fixed-width column, or ``None``.
        limit: The column's width.

    Returns:
        ``value`` unchanged when it fits, else its head plus ``...``.
    """
    if value is None or len(value) <= limit:
        return value
    return value[: limit - len(_ELLIPSIS)] + _ELLIPSIS


def event_extra(
    *,
    source: str = "host",
    event: str | None = None,
    fields: dict[str, Any] | None = None,
    candidate: Any = None,
    case: Any = None,
    **extra: Any,
) -> dict[str, Any]:
    """Build the ``extra`` mapping that attaches run-log fields to a log call.

    Args:
        source: One of :data:`SOURCES`.
        event: Typed event name, such as ``candidate.scored``.
        fields: JSON-serializable event payload.
        candidate: Candidate the record belongs to.
        case: Case the record belongs to.
        **extra: Other record attributes to set alongside, such as ``sandbox_owner``.

    Returns:
        A mapping for ``logger.log(..., extra=...)``.
    """
    return {
        **extra,
        RECORD_ATTR: {
            "source": source,
            "event": event,
            "fields": fields,
            "candidate": None if candidate is None else str(candidate),
            "case": None if case is None else str(case),
        },
    }


def entry_fields(record: logging.LogRecord) -> dict[str, Any]:
    """Read a record's run-log fields as ``append_log`` keyword arguments.

    Args:
        record: Any log record; one without run-log fields is a host record.

    Returns:
        ``source``, ``event``, ``fields``, ``candidate`` and ``case``.
    """
    data = getattr(record, RECORD_ATTR, None)
    return normalize(data if isinstance(data, dict) else {})


def normalize(data: dict[str, Any]) -> dict[str, Any]:
    """Coerce loosely typed run-log fields, such as a forwarded event's, to their stored shape.

    Args:
        data: Mapping that may hold ``source``, ``event``, ``fields``, ``candidate`` and ``case``.

    Returns:
        The five fields, with an unknown source read as ``host`` and non-mapping fields dropped.
    """
    source = data.get("source")
    fields = data.get("fields")

    def text(key: str) -> str | None:
        """Return ``data[key]`` as text, or ``None`` when absent."""
        value = data.get(key)
        return None if value is None else str(value)

    return {
        "source": source if source in SOURCES else "host",
        "event": text("event"),
        "fields": fields if isinstance(fields, dict) and fields else None,
        "candidate": text("candidate"),
        "case": text("case"),
    }
