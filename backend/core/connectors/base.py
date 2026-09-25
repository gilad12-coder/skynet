"""Shared types and helpers behind the browse/preview/import connector contract.

Every provider registered in :mod:`core.connectors.registry` exposes the same
few functions; this module holds the value types they exchange and the
file-oriented helpers the object-store style providers (GitHub, S3, GCS,
Azure Blob) build on.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .tabular import PREVIEW_BYTES, PREVIEW_ROWS, is_text_format, parse_table

Fetch = Callable[[int | None], tuple[bytes, bool]]


@dataclass(frozen=True)
class Entry:
    """One row of a connector's browse listing.

    ``kind`` is ``"folder"`` for anything the browser can descend into (a
    bucket, a repo, a spreadsheet, a prefix) and ``"file"`` for something the
    user can preview and import (an object, a sheet tab).
    """

    ref: str
    name: str
    kind: str
    size: int | None = None
    modified: str | None = None


@dataclass(frozen=True)
class Credential:
    """What a provider hands the vault after validating pasted credentials."""

    secret: str
    auth_method: str
    account_label: str | None


def preview_file(fetch: Fetch, name: str) -> dict[str, Any]:
    """Decode the first rows of a remote file.

    Text formats are read from a byte-range so a preview never pulls a whole
    multi-hundred-megabyte CSV; JSON and Parquet need the complete file.

    Args:
        fetch: Downloads the file, taking an optional byte cap and returning
            ``(content, truncated)``.
        name: File name, used to pick the decoder.

    Returns:
        ``{"columns": [...], "rows": [...], "num_rows_total": None}``.
    """
    content, truncated = fetch(PREVIEW_BYTES) if is_text_format(name) else fetch(None)
    table = parse_table(content, name, limit=PREVIEW_ROWS, truncated=truncated)
    return {"columns": table.columns, "rows": table.rows, "num_rows_total": None}


def import_file(fetch: Fetch, name: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Download a remote file completely and decode every row.

    Args:
        fetch: Downloads the file, taking an optional byte cap.
        name: File name, used to pick the decoder.

    Returns:
        ``(rows, column_schema)`` ready for the library's gated save.
    """
    content, _ = fetch(None)
    table = parse_table(content, name)
    return table.rows, table.column_schema


def range_header(max_bytes: int | None) -> dict[str, str]:
    """Build a ``Range`` header asking for one byte more than the cap.

    The extra byte is how the caller learns the file continues past the cap.

    Args:
        max_bytes: The cap, or ``None`` for the whole file.

    Returns:
        The header, or an empty dict.
    """
    return {"Range": f"bytes=0-{max_bytes}"} if max_bytes is not None else {}


def split_location(location: str) -> tuple[str, str]:
    """Split ``"bucket/some/prefix/"`` into ``("bucket", "some/prefix/")``.

    Args:
        location: A browse location or file ref.

    Returns:
        ``(container, path)``; ``path`` is empty at a container's root.
    """
    container, _, path = location.lstrip("/").partition("/")
    return container, path
