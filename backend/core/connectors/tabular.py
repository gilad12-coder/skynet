"""Decode tabular files (CSV, TSV, JSON, JSONL, Parquet) into library rows.

The file-backed connectors (GitHub, S3, GCS, Azure Blob) all end the same
way: bytes come down, rows go into the dataset library. This module owns
that last step so every provider parses identically, and it owns the size
ceiling that keeps a stray multi-gigabyte object from being pulled into
memory.
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

import numpy.version  # noqa: F401
import pyarrow.parquet as pq

from ..api.errors import DomainError
from ..config import settings
from .huggingface import normalize_cell

SUPPORTED_EXTENSIONS = frozenset({".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".parquet"})
PREVIEW_ROWS = 20
# Text formats can be previewed from their first bytes; a Range request of this
# size is enough for twenty rows of anything short of huge blobs per cell.
PREVIEW_BYTES = 256 * 1024
DOWNLOAD_CEILING_MULTIPLIER = 2


@dataclass(frozen=True)
class Table:
    """Decoded rows plus the column metadata the library wants alongside them."""

    rows: list[dict[str, Any]]
    columns: list[dict[str, str]]
    column_schema: dict[str, Any]


def is_supported(name: str) -> bool:
    """Report whether a file name has an importable extension.

    Args:
        name: File name or object key.

    Returns:
        ``True`` for CSV, TSV, JSON, JSONL and Parquet.
    """
    return PurePosixPath(name).suffix.lower() in SUPPORTED_EXTENSIONS


def download_ceiling() -> int:
    """Largest object the connectors will download, derived from the library cap.

    Returns:
        The ceiling in bytes.
    """
    return settings.dataset_max_file_bytes * DOWNLOAD_CEILING_MULTIPLIER


def check_size(size: int | None) -> None:
    """Refuse objects whose declared size already exceeds the ceiling.

    Args:
        size: The object's size when the provider reports one.

    Raises:
        DomainError: 413 when the object is too large to import.
    """
    if size is not None and size > download_ceiling():
        raise DomainError(
            "connectors.import_too_large",
            status=413,
            max_mb=round(settings.dataset_max_file_bytes / (1024 * 1024), 1),
        )


def is_text_format(name: str) -> bool:
    """Report whether the format can be decoded from a truncated prefix.

    Args:
        name: File name or object key.

    Returns:
        ``True`` for CSV, TSV and JSON Lines.
    """
    return PurePosixPath(name).suffix.lower() in {".csv", ".tsv", ".jsonl", ".ndjson"}


def _trim_partial_line(content: bytes, truncated: bool) -> bytes:
    """Drop the last, possibly cut-off, line of a partially downloaded text file.

    Args:
        content: The bytes fetched.
        truncated: Whether more bytes exist past ``content``.

    Returns:
        ``content`` ending on a line boundary.
    """
    if not truncated:
        return content
    cut = content.rfind(b"\n")
    return content[:cut] if cut > 0 else content


def _rows_from_records(records: list[Any]) -> list[dict[str, Any]]:
    """Coerce a decoded JSON list into row dicts.

    Args:
        records: JSON values; dicts are rows, anything else is wrapped.

    Returns:
        Rows whose values are JSON-safe.
    """
    return [
        {str(k): normalize_cell(v) for k, v in item.items()} if isinstance(item, dict) else {"value": item}
        for item in records
    ]


def _parse_delimited(text: str, delimiter: str, limit: int | None) -> list[dict[str, Any]]:
    """Read a CSV/TSV body whose first line is the header.

    Args:
        text: Decoded file contents.
        delimiter: Column separator.
        limit: Stop after this many rows, if given.

    Returns:
        The rows.
    """
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    rows: list[dict[str, Any]] = []
    for record in reader:
        rows.append({str(k): v for k, v in record.items() if k is not None})
        if limit is not None and len(rows) >= limit:
            break
    return rows


def _parse_json(text: str) -> list[dict[str, Any]]:
    """Read a JSON document that is a list of rows or an envelope around one.

    Args:
        text: Decoded file contents.

    Returns:
        The rows.

    Raises:
        DomainError: 409 when the document holds no list of records.
    """
    document = json.loads(text)
    if isinstance(document, dict):
        nested = next((v for v in document.values() if isinstance(v, list)), None)
        if nested is None:
            raise DomainError("connectors.file_unsupported", status=409)
        document = nested
    if not isinstance(document, list):
        raise DomainError("connectors.file_unsupported", status=409)
    return _rows_from_records(document)


def _parse_jsonl(text: str, limit: int | None) -> list[dict[str, Any]]:
    """Read JSON Lines, skipping blank lines.

    Args:
        text: Decoded file contents.
        limit: Stop after this many rows, if given.

    Returns:
        The rows.
    """
    records: list[Any] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        records.append(json.loads(line))
        if limit is not None and len(records) >= limit:
            break
    return _rows_from_records(records)


def _parse_parquet(content: bytes, limit: int | None) -> tuple[list[dict[str, Any]], list[str]]:
    """Decode a parquet file into rows.

    Args:
        content: The file bytes.
        limit: Stop after this many rows, if given.

    Returns:
        ``(rows, column_names)``; the names preserve the file's column order
        even when no row survives.
    """
    table = pq.read_table(io.BytesIO(content))
    if limit is not None:
        table = table.slice(0, limit)
    rows = [{name: normalize_cell(value) for name, value in raw.items()} for raw in table.to_pylist()]
    return rows, list(table.column_names)


def parse_table(content: bytes, name: str, *, limit: int | None = None, truncated: bool = False) -> Table:
    """Decode one file into rows and column metadata.

    Args:
        content: The file bytes (possibly a prefix for text formats).
        name: File name or object key, used to pick the format.
        limit: Keep only the first ``limit`` rows (previews).
        truncated: Whether ``content`` is a prefix of a larger text file.

    Returns:
        The decoded table.

    Raises:
        DomainError: 409 when the format is unknown or the body is malformed.
    """
    suffix = PurePosixPath(name).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise DomainError("connectors.file_unsupported", status=409)
    column_order: list[str] = []
    try:
        if suffix == ".parquet":
            rows, column_order = _parse_parquet(content, limit)
        else:
            text = _trim_partial_line(content, truncated).decode("utf-8-sig")
            if suffix in {".csv", ".tsv"}:
                rows = _parse_delimited(text, "\t" if suffix == ".tsv" else ",", limit)
            elif suffix == ".json":
                rows = _parse_json(text)
                if limit is not None:
                    rows = rows[:limit]
            else:
                rows = _parse_jsonl(text, limit)
    except (UnicodeDecodeError, ValueError, csv.Error, OSError) as exc:
        raise DomainError("connectors.file_unsupported", status=409) from exc
    for row in rows:
        for key in row:
            if key not in column_order:
                column_order.append(key)
    return Table(
        rows=rows,
        columns=[{"name": column, "type": "string"} for column in column_order],
        column_schema={"column_order": column_order, "column_roles": {}, "column_kinds": {}},
    )
