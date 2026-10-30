"""Render the account export bundle in the file formats the app's table exports offer.

The bundle from :func:`core.api.account_data_service.export_account` is one
nested JSON document. JSON and Pickle carry it whole. The tabular formats
(CSV, Excel, Parquet, Feather) need flat tables, so :func:`bundle_tables`
splits it: every list section becomes a table with one row per item, every
object section becomes a one-row table, and lists of objects nested inside a
row (an agent conversation's messages, the billing ledger) become their own
table linked back by ``parent_id``. Any other nested value is written as a
JSON string in its cell.

CSV, Parquet and Feather ship as a ZIP with one file per table; Excel ships as
one workbook with one sheet per table. Everything is built with the standard
library and pyarrow, so no extra dependency is needed.
"""

from __future__ import annotations

import csv
import io
import json
import pickle
import re
import zipfile
from dataclasses import dataclass
from typing import Any, Literal
from xml.sax.saxutils import escape

import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.parquet as pq

ExportFormat = Literal["json", "csv", "xlsx", "parquet", "feather", "pkl"]

EXPORT_FORMATS: tuple[ExportFormat, ...] = ("json", "csv", "xlsx", "parquet", "feather", "pkl")

FILE_STEM = "skynet-account-export"

# Excel refuses to open a workbook with a longer cell, so longer text is cut and marked.
_XLSX_CELL_LIMIT = 32767
_XLSX_TRUNCATED = "…[truncated, see the JSON export]"
_XML_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")

Cell = str | int | float | bool | None


@dataclass(frozen=True)
class RenderedExport:
    """A rendered export file ready to send.

    Attributes:
        content: The file bytes.
        media_type: The response content type.
        filename: The download filename, extension included.
    """

    content: bytes
    media_type: str
    filename: str


@dataclass(frozen=True)
class ExportTable:
    """One flat table cut from the bundle.

    Attributes:
        name: Table name, used for the file or sheet name.
        columns: Column order, in first-seen order across rows.
        rows: One dict per row, keyed by column.
    """

    name: str
    columns: list[str]
    rows: list[dict[str, Cell]]


def _is_row_list(value: Any) -> bool:
    """Return whether ``value`` is a non-empty list made only of dicts.

    Args:
        value: Any bundle value.

    Returns:
        True when the value can become a child table.
    """
    return isinstance(value, list) and bool(value) and all(isinstance(item, dict) for item in value)


def _cell(value: Any) -> Cell:
    """Reduce a bundle value to a flat cell, writing nested values as JSON.

    Args:
        value: Any JSON-safe bundle value.

    Returns:
        A primitive cell value.
    """
    if value is None or isinstance(value, str | int | float | bool):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _table(name: str, rows: list[dict[str, Cell]]) -> ExportTable:
    """Build a table whose columns are the union of its rows' keys.

    Args:
        name: Table name.
        rows: Flat rows.

    Returns:
        The table, with every row holding every column.
    """
    columns: list[str] = []
    for row in rows:
        for key in row:
            if key not in columns:
                columns.append(key)
    return ExportTable(name=name, columns=columns, rows=[{col: row.get(col) for col in columns} for row in rows])


def _flatten_rows(name: str, items: list[dict[str, Any]], tables: list[ExportTable]) -> None:
    """Add a table for ``items`` and a child table for each nested list of objects.

    Args:
        name: Table name for the items.
        items: The section's rows.
        tables: Output list the tables are appended to.
    """
    rows: list[dict[str, Cell]] = []
    children: dict[str, list[dict[str, Cell]]] = {}
    for index, item in enumerate(items):
        row: dict[str, Cell] = {}
        parent_id = item.get("id", index)
        for key, value in item.items():
            if _is_row_list(value):
                children.setdefault(key, []).extend(
                    {"parent_id": _cell(parent_id), **{k: _cell(v) for k, v in child.items()}} for child in value
                )
            else:
                row[key] = _cell(value)
        rows.append(row)
    tables.append(_table(name, rows))
    tables.extend(_table(f"{name}_{key}", child_rows) for key, child_rows in children.items())


def bundle_tables(bundle: dict[str, Any]) -> list[ExportTable]:
    """Split the nested export bundle into flat tables.

    The top-level scalars (format, time, username) become an ``export_info``
    table. Empty sections still produce a table, so a reader always finds the
    same set of files.

    Args:
        bundle: The bundle from ``export_account``.

    Returns:
        The tables, in bundle order.
    """
    tables: list[ExportTable] = []
    info: dict[str, Cell] = {}
    for key, value in bundle.items():
        if isinstance(value, list):
            _flatten_rows(key, value, tables)
        elif isinstance(value, dict):
            nested = {k: v for k, v in value.items() if _is_row_list(v) or (isinstance(v, list) and not v)}
            _flatten_rows(key, [{k: v for k, v in value.items() if k not in nested}], tables)
            for child, child_rows in nested.items():
                _flatten_rows(f"{key}_{child}", child_rows, tables)
        elif value is None:
            tables.append(ExportTable(name=key, columns=[], rows=[]))
        else:
            info[key] = _cell(value)
    return [_table("export_info", [info]), *tables]


def _arrow_table(table: ExportTable) -> pa.Table:
    """Build a typed Arrow table, keeping a column numeric or boolean only when every value is.

    Args:
        table: A flat export table.

    Returns:
        The Arrow table; mixed columns fall back to strings.
    """
    arrays: dict[str, pa.Array] = {}
    for column in table.columns:
        values = [row[column] for row in table.rows]
        present = [v for v in values if v is not None]
        if present and all(isinstance(v, bool) for v in present):
            arrays[column] = pa.array(values, type=pa.bool_())
        elif present and all(isinstance(v, int) and not isinstance(v, bool) for v in present):
            arrays[column] = pa.array(values, type=pa.int64())
        elif present and all(isinstance(v, int | float) and not isinstance(v, bool) for v in present):
            arrays[column] = pa.array([None if v is None else float(v) for v in values], type=pa.float64())
        else:
            arrays[column] = pa.array([None if v is None else str(v) for v in values], type=pa.string())
    return pa.table(arrays) if arrays else pa.table({})


def _csv_bytes(table: ExportTable) -> bytes:
    """Write one table as UTF-8 CSV with a BOM so Excel reads Hebrew correctly.

    Args:
        table: A flat export table.

    Returns:
        The CSV bytes.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(table.columns)
    for row in table.rows:
        writer.writerow(["" if row[col] is None else row[col] for col in table.columns])
    return buffer.getvalue().encode("utf-8-sig")


def _parquet_bytes(table: ExportTable) -> bytes:
    """Write one table as Parquet.

    Args:
        table: A flat export table.

    Returns:
        The Parquet bytes.
    """
    sink = io.BytesIO()
    pq.write_table(_arrow_table(table), sink)
    return sink.getvalue()


def _feather_bytes(table: ExportTable) -> bytes:
    """Write one table as Feather (Arrow IPC file).

    Args:
        table: A flat export table.

    Returns:
        The Feather bytes.
    """
    sink = io.BytesIO()
    feather.write_feather(_arrow_table(table), sink)
    return sink.getvalue()


def _zip(tables: list[ExportTable], extension: str, write: Any) -> bytes:
    """Pack one file per table into a ZIP.

    Args:
        tables: The flat tables.
        extension: File extension without the dot.
        write: Function turning a table into file bytes.

    Returns:
        The ZIP bytes.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for table in tables:
            archive.writestr(f"{FILE_STEM}/{table.name}.{extension}", write(table))
    return buffer.getvalue()


def _column_letter(index: int) -> str:
    """Return the Excel column letters for a zero-based column index.

    Args:
        index: Zero-based column index.

    Returns:
        Letters such as ``A``, ``Z`` or ``AA``.
    """
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _xlsx_cell(ref: str, value: Cell) -> str:
    """Render one worksheet cell as SpreadsheetML.

    Args:
        ref: Cell reference such as ``B3``.
        value: The cell value.

    Returns:
        The ``<c>`` element, or an empty string for a null cell.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return f'<c r="{ref}" t="b"><v>{int(value)}</v></c>'
    if isinstance(value, int | float):
        return f'<c r="{ref}"><v>{value!r}</v></c>'
    text = _XML_ILLEGAL.sub("", str(value))
    if len(text) > _XLSX_CELL_LIMIT:
        text = text[: _XLSX_CELL_LIMIT - len(_XLSX_TRUNCATED)] + _XLSX_TRUNCATED
    return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{escape(text)}</t></is></c>'


def _xlsx_sheet(table: ExportTable) -> str:
    """Render one table as a worksheet, header row first.

    Args:
        table: A flat export table.

    Returns:
        The worksheet XML.
    """
    lines = [list(table.columns), *([row[col] for col in table.columns] for row in table.rows)]
    rows_xml = []
    for row_index, values in enumerate(lines, start=1):
        cells = "".join(_xlsx_cell(f"{_column_letter(i)}{row_index}", v) for i, v in enumerate(values))
        rows_xml.append(f'<row r="{row_index}">{cells}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{''.join(rows_xml)}</sheetData></worksheet>"
    )


def _sheet_names(tables: list[ExportTable]) -> list[str]:
    """Return unique Excel-safe sheet names (31 characters at most).

    Args:
        tables: The flat tables.

    Returns:
        One sheet name per table.
    """
    names: list[str] = []
    for table in tables:
        base = re.sub(r"[\[\]:*?/\\]", "_", table.name)[:31]
        name, suffix = base, 2
        while name.lower() in (n.lower() for n in names):
            tail = f"_{suffix}"
            name, suffix = base[: 31 - len(tail)] + tail, suffix + 1
        names.append(name)
    return names


def _xlsx_bytes(tables: list[ExportTable]) -> bytes:
    """Write every table into one Excel workbook, one sheet each.

    Args:
        tables: The flat tables.

    Returns:
        The ``.xlsx`` bytes.
    """
    names = _sheet_names(tables)
    sheet_overrides = "".join(
        f'<Override PartName="/xl/worksheets/sheet{i}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for i in range(1, len(tables) + 1)
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        f"{sheet_overrides}</Types>"
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/></Relationships>'
    )
    sheets = "".join(
        f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>' for i, name in enumerate(names, start=1)
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<sheets>{sheets}</sheets></workbook>"
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(
            f'<Relationship Id="rId{i}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{i}.xml"/>'
            for i in range(1, len(tables) + 1)
        )
        + "</Relationships>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        for i, table in enumerate(tables, start=1):
            archive.writestr(f"xl/worksheets/sheet{i}.xml", _xlsx_sheet(table))
    return buffer.getvalue()


def render_export(bundle: dict[str, Any], export_format: ExportFormat, date_stamp: str) -> RenderedExport:
    """Render the export bundle as a downloadable file.

    Args:
        bundle: The bundle from ``export_account``.
        export_format: One of :data:`EXPORT_FORMATS`.
        date_stamp: ``YYYY-MM-DD`` appended to the filename.

    Returns:
        The file bytes, content type and filename.
    """
    stem = f"{FILE_STEM}_{date_stamp}"
    if export_format == "json":
        content = json.dumps(bundle, ensure_ascii=False, indent=2).encode("utf-8")
        return RenderedExport(content, "application/json", f"{stem}.json")
    if export_format == "pkl":
        # A plain dict of built-in types, so unpickling needs nothing beyond the Python standard library.
        return RenderedExport(pickle.dumps(bundle, protocol=4), "application/octet-stream", f"{stem}.pkl")
    tables = bundle_tables(bundle)
    if export_format == "xlsx":
        return RenderedExport(
            _xlsx_bytes(tables),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            f"{stem}.xlsx",
        )
    writers = {"csv": _csv_bytes, "parquet": _parquet_bytes, "feather": _feather_bytes}
    return RenderedExport(
        _zip(tables, export_format, writers[export_format]), "application/zip", f"{stem}_{export_format}.zip"
    )
