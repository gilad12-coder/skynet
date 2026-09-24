"""Snowflake connector: import a table or view through the SQL REST API.

Linking takes the account identifier, a programmatic access token and the
warehouse to run on (plus an optional role). Browsing walks databases,
schemas and tables with ``SHOW`` statements; reading issues a ``SELECT``
and drains the result partitions. Nothing beyond ``httpx`` is needed.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from .base import Credential, Entry
from .records import PREVIEW_ROWS, cell, import_payload, preview_payload, row_cap
from .transport import get_json, label, post_json
from .vault import ConnectorSecret

PROVIDER = "snowflake"
STATEMENT_TIMEOUT_S = 60
ACCOUNT = re.compile(r"^[A-Za-z0-9_.-]+$")
POLL_LIMIT = 60


def _config(secret: ConnectorSecret) -> dict[str, str]:
    """Unpack the stored credential.

    Args:
        secret: The vault entry.

    Returns:
        ``{"account", "token", "warehouse", "role"}``.
    """
    return json.loads(secret.access_token)


def _headers(token: str) -> dict[str, str]:
    """Headers for the SQL API with a programmatic access token.

    Args:
        token: The token.

    Returns:
        The headers.
    """
    return {
        "Authorization": f"Bearer {token}",
        "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
        "Accept": "application/json",
    }


def _base_url(account: str) -> str:
    """Build the account's API origin.

    Args:
        account: Account identifier such as ``xy12345.eu-central-1``.

    Returns:
        The ``/api/v2/statements`` URL.
    """
    return f"https://{account}.snowflakecomputing.com/api/v2/statements"


def _quote(identifier: str) -> str:
    """Quote an identifier for SQL.

    Args:
        identifier: The raw identifier.

    Returns:
        The double-quoted identifier.
    """
    return '"' + identifier.replace('"', '""') + '"'


def _execute(config: dict[str, str], statement: str) -> tuple[list[dict[str, Any]], list[list[Any]]]:
    """Run one statement and drain every partition.

    Args:
        config: The unpacked credential.
        statement: The SQL to run.

    Returns:
        ``(row_type, rows)`` where ``row_type`` is the column metadata.

    Raises:
        DomainError: 502 ``query_failed`` when Snowflake reports an error.
    """
    url = _base_url(config["account"])
    headers = _headers(config["token"])
    body: dict[str, Any] = {"statement": statement, "timeout": STATEMENT_TIMEOUT_S, "warehouse": config["warehouse"]}
    if config.get("role"):
        body["role"] = config["role"]
    try:
        page = post_json(url, provider=PROVIDER, headers=headers, body=body)
    except DomainError as exc:
        if exc.code == "connectors.provider_error" and exc.params.get("status_code") == 422:
            raise DomainError("connectors.query_failed", status=502, provider=label(PROVIDER), reason="") from exc
        raise
    handle = page.get("statementHandle") if isinstance(page, dict) else None
    polls = 0
    while isinstance(page, dict) and "resultSetMetaData" not in page and handle:
        polls += 1
        if polls > POLL_LIMIT:
            raise DomainError("connectors.query_failed", status=502, provider=label(PROVIDER), reason="timeout")
        page = get_json(f"{url}/{quote(handle, safe='')}", provider=PROVIDER, headers=headers)
    if not isinstance(page, dict) or "resultSetMetaData" not in page:
        message = page.get("message") if isinstance(page, dict) else None
        raise DomainError("connectors.query_failed", status=502, provider=label(PROVIDER), reason=str(message or ""))
    meta = page["resultSetMetaData"]
    rows = list(page.get("data") or [])
    for index in range(1, len(meta.get("partitionInfo") or [])):
        part = get_json(
            f"{url}/{quote(handle, safe='')}", provider=PROVIDER, headers=headers, params={"partition": index}
        )
        rows.extend(part.get("data") or [])
    return list(meta.get("rowType") or []), rows


def _records(row_type: list[dict[str, Any]], rows: list[list[Any]]) -> list[dict[str, Any]]:
    """Zip column metadata with the positional rows the API returns.

    Args:
        row_type: Column metadata.
        rows: Positional rows.

    Returns:
        Row dicts.
    """
    names = [c.get("name", f"column_{i + 1}") for i, c in enumerate(row_type)]
    return [dict(zip(names, row, strict=False)) for row in rows]


def _coerce(value: Any, column: dict[str, Any]) -> Any:
    """Turn the API's string-typed cell into a scalar of the column's type.

    Args:
        value: The cell as returned.
        column: The column metadata.

    Returns:
        A JSON-safe scalar.
    """
    if value is None or not isinstance(value, str):
        return cell(value)
    kind = str(column.get("type", "")).lower()
    if kind == "fixed":
        return int(value) if column.get("scale") in (0, None) and value.lstrip("-").isdigit() else float(value)
    if kind == "real":
        return float(value)
    if kind == "boolean":
        return value.lower() == "true"
    return value


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate account, token and warehouse by running ``SELECT CURRENT_USER()``.

    Args:
        fields: ``{"account": ..., "token": ..., "warehouse": ..., "role": ...}``.

    Returns:
        The credential to store, labelled ``user@account``.

    Raises:
        DomainError: 400 when a field is missing or Snowflake rejects the token.
    """
    account = fields.get("account", "").strip().lower()
    token = fields.get("token", "").strip()
    warehouse = fields.get("warehouse", "").strip()
    role = fields.get("role", "").strip()
    if not account or not token or not warehouse or not ACCOUNT.match(account):
        raise DomainError("connectors.invalid_credentials", status=400)
    config = {"account": account, "token": token, "warehouse": warehouse, "role": role}
    try:
        _, rows = _execute(config, "SELECT CURRENT_USER() AS USER")
    except DomainError as exc:
        if exc.code == "connectors.rejected":
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise
    user = rows[0][0] if rows and rows[0] else None
    label_text = f"{user}@{account}" if isinstance(user, str) else account
    return Credential(secret=json.dumps(config), auth_method="token", account_label=label_text)


def _show(config: dict[str, str], statement: str) -> list[dict[str, Any]]:
    """Run a ``SHOW`` statement and return its rows as dicts.

    Args:
        config: The unpacked credential.
        statement: The statement.

    Returns:
        The rows.
    """
    row_type, rows = _execute(config, statement)
    return _records(row_type, rows)


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List databases, then schemas, then tables and views.

    Args:
        secret: The stored connector.
        location: Empty, ``database`` or ``database.schema``.
        search: Name filter.

    Returns:
        The entries.
    """
    config = _config(secret)
    needle = search.strip().lower()
    parts = [p for p in location.split(".") if p] if location else []
    if not parts:
        rows = _show(config, "SHOW TERSE DATABASES")
        entries = [Entry(ref=r["name"], name=r["name"], kind="folder") for r in rows if isinstance(r.get("name"), str)]
    elif len(parts) == 1:
        rows = _show(config, f"SHOW TERSE SCHEMAS IN DATABASE {_quote(parts[0])}")
        entries = [
            Entry(ref=f"{parts[0]}.{r['name']}", name=r["name"], kind="folder")
            for r in rows
            if isinstance(r.get("name"), str) and r["name"] != "INFORMATION_SCHEMA"
        ]
    elif len(parts) == 2:
        scope = f"{_quote(parts[0])}.{_quote(parts[1])}"
        rows = _show(config, f"SHOW TABLES IN SCHEMA {scope}") + _show(config, f"SHOW VIEWS IN SCHEMA {scope}")
        entries = [
            Entry(
                ref=f"{location}.{r['name']}",
                name=r["name"],
                kind="file",
                size=r.get("rows"),
                modified=r.get("created_on"),
            )
            for r in rows
            if isinstance(r.get("name"), str)
        ]
    else:
        raise DomainError("connectors.invalid_ref", status=400)
    return [e for e in entries if needle in e.name.lower()] if needle else entries


def _read(secret: ConnectorSecret, ref: str, limit: int) -> tuple[list[dict[str, Any]], list[str], str]:
    """Read the first ``limit`` rows of ``database.schema.table``.

    Args:
        secret: The stored connector.
        ref: The fully qualified table name.
        limit: Row cap.

    Returns:
        ``(rows, column_names, table_name)``.

    Raises:
        DomainError: 400 for a ref without three parts.
    """
    parts = ref.split(".")
    if len(parts) != 3 or not all(parts):
        raise DomainError("connectors.invalid_ref", status=400)
    target = ".".join(_quote(p) for p in parts)
    row_type, rows = _execute(_config(secret), f"SELECT * FROM {target} LIMIT {int(limit)}")
    names = [c.get("name", f"column_{i + 1}") for i, c in enumerate(row_type)]
    records = [
        {name: _coerce(value, column) for name, value, column in zip(names, row, row_type, strict=False)}
        for row in rows
    ]
    return records, names, parts[2]


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Read the first rows of a table or view.

    Args:
        secret: The stored connector.
        ref: ``database.schema.table``.

    Returns:
        The preview envelope.
    """
    rows, columns, _ = _read(secret, ref, PREVIEW_ROWS)
    return preview_payload(rows, columns)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Read a table or view into library rows, up to the row cap.

    Args:
        secret: The stored connector.
        ref: ``database.schema.table``.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    rows, columns, name = _read(secret, ref, row_cap())
    return rows, import_payload(rows, columns), name
