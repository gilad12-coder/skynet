"""Notion connector: import a database as a table.

Linking takes an internal-integration token; the integration sees whichever
pages and databases were shared with it. Browsing searches the workspace's
databases, and importing walks one database's pages, flattening each
property into a column.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from .base import Credential, Entry
from .records import PREVIEW_ROWS, cell, import_payload, preview_payload, row_cap
from .transport import get_json, post_json
from .vault import ConnectorSecret

PROVIDER = "notion"
API_URL = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"
PAGE_SIZE = 100
LIST_LIMIT = 50


def _headers(token: str) -> dict[str, str]:
    """Bearer headers for the Notion API.

    Args:
        token: Integration token.

    Returns:
        The headers.
    """
    return {"Authorization": f"Bearer {token}", "Notion-Version": NOTION_VERSION, "Accept": "application/json"}


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate an integration token against ``/users/me``.

    Args:
        fields: ``{"token": ...}``.

    Returns:
        The credential to store, labelled with the workspace name.

    Raises:
        DomainError: 400 when Notion rejects the token.
    """
    token = fields.get("token", "").strip()
    if not token:
        raise DomainError("connectors.invalid_credentials", status=400)
    try:
        me = get_json(f"{API_URL}/users/me", provider=PROVIDER, headers=_headers(token))
    except DomainError as exc:
        if exc.code == "connectors.rejected":
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise
    bot = me.get("bot") if isinstance(me, dict) else None
    workspace = bot.get("workspace_name") if isinstance(bot, dict) else None
    label = workspace or (me.get("name") if isinstance(me, dict) else None)
    return Credential(secret=token, auth_method="token", account_label=label if isinstance(label, str) else None)


def _plain_text(parts: Any) -> str:
    """Join a rich-text array into one string.

    Args:
        parts: The ``rich_text``/``title`` array.

    Returns:
        The text.
    """
    return "".join(p.get("plain_text", "") for p in parts if isinstance(p, dict)) if isinstance(parts, list) else ""


def _title(database: dict[str, Any]) -> str:
    """Name of a database, falling back to its id.

    Args:
        database: The database object.

    Returns:
        The title.
    """
    return _plain_text(database.get("title")) or str(database.get("id", ""))


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """Search the databases shared with the integration.

    Args:
        secret: The stored connector.
        location: Ignored; databases have no hierarchy here.
        search: Title filter.

    Returns:
        File entries keyed by database id.
    """
    body = post_json(
        f"{API_URL}/search",
        provider=PROVIDER,
        headers=_headers(secret.access_token),
        body={
            "query": search.strip(),
            "filter": {"property": "object", "value": "database"},
            "sort": {"direction": "descending", "timestamp": "last_edited_time"},
            "page_size": LIST_LIMIT,
        },
    )
    return [
        Entry(ref=item["id"], name=_title(item), kind="file", modified=item.get("last_edited_time"))
        for item in (body.get("results") if isinstance(body, dict) else None) or []
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    ]


def _property_value(prop: dict[str, Any]) -> Any:
    """Flatten one page property into a scalar.

    Args:
        prop: The property object.

    Returns:
        The value.
    """
    kind = prop.get("type")
    value = prop.get(kind) if isinstance(kind, str) else None
    if kind in {"title", "rich_text"}:
        return _plain_text(value)
    if kind in {"number", "checkbox", "url", "email", "phone_number", "created_time", "last_edited_time"}:
        return value
    if kind in {"select", "status"}:
        return value.get("name") if isinstance(value, dict) else None
    if kind == "multi_select":
        return ", ".join(v.get("name", "") for v in value or [] if isinstance(v, dict))
    if kind == "date":
        return value.get("start") if isinstance(value, dict) else None
    if kind == "people":
        return ", ".join(v.get("name") or v.get("id", "") for v in value or [] if isinstance(v, dict))
    if kind == "files":
        return ", ".join(
            (v.get("file") or v.get("external") or {}).get("url", "") for v in value or [] if isinstance(v, dict)
        )
    if kind == "relation":
        return ", ".join(v.get("id", "") for v in value or [] if isinstance(v, dict))
    if kind == "unique_id" and isinstance(value, dict):
        prefix = value.get("prefix")
        return f"{prefix}-{value.get('number')}" if prefix else value.get("number")
    if kind in {"formula", "rollup"} and isinstance(value, dict):
        return _property_value(value) if value.get("type") in {"number", "date", "string", "boolean"} else cell(value)
    if kind in {"string", "boolean"}:
        return value
    return cell(value)


def _row(page: dict[str, Any]) -> dict[str, Any]:
    """Flatten a page's properties into a row.

    Args:
        page: The page object.

    Returns:
        The row, property names as columns.
    """
    props = page.get("properties") or {}
    return {name: _property_value(prop) for name, prop in props.items() if isinstance(prop, dict)}


def _query(token: str, database_id: str, limit: int) -> list[dict[str, Any]]:
    """Read up to ``limit`` pages of a database.

    Args:
        token: Integration token.
        database_id: The database.
        limit: Row cap.

    Returns:
        The rows.
    """
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    url = f"{API_URL}/databases/{quote(database_id, safe='')}/query"
    while len(rows) < limit:
        body: dict[str, Any] = {"page_size": min(PAGE_SIZE, limit - len(rows))}
        if cursor:
            body["start_cursor"] = cursor
        page = post_json(url, provider=PROVIDER, headers=_headers(token), body=body)
        rows.extend(_row(p) for p in page.get("results") or [] if isinstance(p, dict))
        cursor = page.get("next_cursor") if page.get("has_more") else None
        if not cursor:
            break
    return rows


def _columns(token: str, database_id: str) -> tuple[list[str], str]:
    """Read a database's property names (in Notion's order) and title.

    Args:
        token: Integration token.
        database_id: The database.

    Returns:
        ``(column_names, title)``.
    """
    database = get_json(
        f"{API_URL}/databases/{quote(database_id, safe='')}", provider=PROVIDER, headers=_headers(token)
    )
    props = database.get("properties") if isinstance(database, dict) else None
    names = list(props) if isinstance(props, dict) else []
    # Notion lists the title property last; it reads better first.
    title_prop = next((n for n, p in (props or {}).items() if isinstance(p, dict) and p.get("type") == "title"), None)
    if title_prop:
        names = [title_prop] + [n for n in names if n != title_prop]
    return names, _title(database) if isinstance(database, dict) else database_id


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Read the first pages of a database.

    Args:
        secret: The stored connector.
        ref: Database id.

    Returns:
        The preview envelope.
    """
    columns, _ = _columns(secret.access_token, ref)
    return preview_payload(_query(secret.access_token, ref, PREVIEW_ROWS), columns)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Read a whole database into library rows.

    Args:
        secret: The stored connector.
        ref: Database id.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    columns, title = _columns(secret.access_token, ref)
    rows = _query(secret.access_token, ref, row_cap())
    return rows, import_payload(rows, columns), title
