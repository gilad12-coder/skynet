"""Row shaping shared by the record-oriented connectors.

Traces, Notion pages and SQL rows arrive as loosely typed records rather
than files. This module turns them into the flat, JSON-safe rows the dataset
library stores, and owns the row cap that keeps an unbounded table or trace
stream from being pulled into memory.
"""

from __future__ import annotations

import base64
import datetime as dt
import decimal
import json
import uuid
from typing import Any

from ..config import settings

PREVIEW_ROWS = 20


def row_cap() -> int:
    """Largest number of rows a record-oriented import will read.

    Returns:
        The cap from settings.
    """
    return settings.connector_import_max_rows


def cell(value: Any) -> Any:
    """Coerce one value into something the library stores as JSON.

    Scalars pass through, temporal/decimal/UUID values become strings, bytes
    are base64'd and anything structured is JSON-encoded so the column stays
    a plain string a prompt can consume.

    Args:
        value: The raw value.

    Returns:
        A JSON-safe scalar.
    """
    if value is None or isinstance(value, str | bool | int | float):
        return value
    if isinstance(value, dt.datetime | dt.date | dt.time | decimal.Decimal | uuid.UUID):
        return str(value)
    if isinstance(value, bytes | bytearray | memoryview):
        return base64.b64encode(bytes(value)).decode("ascii")
    return json.dumps(value, ensure_ascii=False, default=str)


def flatten(record: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    """Pick ``fields`` from a record, spreading one level of nested dicts.

    ``{"input": {"q": 1}, "output": "a"}`` becomes ``{"input.q": 1, "output": "a"}``
    so a trace's prompt variables land in their own columns.

    Args:
        record: The provider's record.
        fields: Top-level keys to keep, in column order.

    Returns:
        The flat row.
    """
    row: dict[str, Any] = {}
    for key in fields:
        value = record.get(key)
        if isinstance(value, dict) and value:
            for sub, inner in value.items():
                row[f"{key}.{sub}"] = cell(inner)
        elif value is not None:
            row[key] = cell(value)
    return row


def column_order(rows: list[dict[str, Any]]) -> list[str]:
    """Union of row keys in first-seen order.

    Args:
        rows: The rows.

    Returns:
        The column names.
    """
    order: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row:
            if key not in seen:
                seen.add(key)
                order.append(key)
    return order


def preview_payload(rows: list[dict[str, Any]], columns: list[str] | None = None) -> dict[str, Any]:
    """Shape rows into the preview envelope the routes return.

    Args:
        rows: Rows to show (already capped).
        columns: Column order, derived from the rows when omitted.

    Returns:
        ``{"columns": [...], "rows": [...], "num_rows_total": None}``.
    """
    names = columns if columns is not None else column_order(rows)
    return {"columns": [{"name": n, "type": "string"} for n in names], "rows": rows, "num_rows_total": None}


def import_payload(rows: list[dict[str, Any]], columns: list[str] | None = None) -> dict[str, Any]:
    """Build the column schema the library stores next to imported rows.

    Args:
        rows: The rows.
        columns: Column order, derived from the rows when omitted.

    Returns:
        The column schema.
    """
    names = columns if columns is not None else column_order(rows)
    return {"column_order": names, "column_roles": {}, "column_kinds": {}}
