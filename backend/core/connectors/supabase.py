"""Supabase connector: import a table from any project the user can reach.

Linking goes through "Continue with Supabase" when the deployment registered a
Supabase OAuth app: the grant covers every project in the user's
organizations, browsing lists those projects and then their tables, and reads
run through the Management API's read-only SQL endpoint. Without OAuth the user pastes a
project's Postgres connection URL instead, which is read like any PostgreSQL
database.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from ..config import settings
from . import sql_base
from .base import Credential, Entry
from .oauth import OAuthApp
from .oauth import oauth_available as _oauth_available
from .postgres import HIDDEN_SCHEMAS as POSTGRES_HIDDEN_SCHEMAS
from .postgres import SCHEMES
from .records import PREVIEW_ROWS, cell, import_payload, preview_payload, row_cap
from .transport import get_json, label, post_json
from .vault import ConnectorSecret

PROVIDER = "supabase"
API_URL = "https://api.supabase.com/v1"
# Schemas Supabase itself manages; user tables live in ``public`` or schemas the user made.
HIDDEN_SCHEMAS = POSTGRES_HIDDEN_SCHEMAS | frozenset(
    {
        "auth",
        "storage",
        "realtime",
        "_realtime",
        "_analytics",
        "extensions",
        "graphql",
        "graphql_public",
        "net",
        "pgbouncer",
        "pgsodium",
        "pgsodium_masks",
        "supabase_functions",
        "supabase_migrations",
        "vault",
        "cron",
    }
)


def _headers(token: str) -> dict[str, str]:
    """Bearer headers for the Management API.

    Args:
        token: OAuth access token.

    Returns:
        The headers.
    """
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def oauth_app() -> OAuthApp:
    """Describe the Supabase OAuth app from settings.

    Returns:
        The app; ``client_id`` is ``None`` when unconfigured.
    """
    secret = settings.supabase_oauth_client_secret
    return OAuthApp(
        provider=PROVIDER,
        authorize_url=f"{API_URL}/oauth/authorize",
        token_url=f"{API_URL}/oauth/token",
        scopes="",
        client_id=settings.supabase_oauth_client_id,
        client_secret=secret.get_secret_value() if secret is not None else None,
        extra_authorize_params={},
        basic_auth_form=True,
    )


def oauth_available() -> bool:
    """Report whether "Continue with Supabase" can be offered.

    Returns:
        ``True`` when the client id and the vault key are configured.
    """
    return _oauth_available(oauth_app())


def fetch_account_label(token: str) -> str | None:
    """Name the organizations an OAuth grant covers.

    Args:
        token: A Supabase access token.

    Returns:
        The organization names joined by commas, or ``None`` when unavailable.
    """
    try:
        orgs = get_json(f"{API_URL}/organizations", provider=PROVIDER, headers=_headers(token))
    except DomainError:
        return None
    names = (
        [o["name"] for o in orgs if isinstance(o, dict) and isinstance(o.get("name"), str)]
        if isinstance(orgs, list)
        else []
    )
    return ", ".join(names) or None


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate a project's Postgres connection URL by connecting with it.

    Args:
        fields: ``{"url": ...}``.

    Returns:
        The credential to store.
    """
    return sql_base.verify(sql_base.normalise_url(fields.get("url", ""), SCHEMES, PROVIDER), PROVIDER)


def _literal(value: str) -> str:
    """Quote a string as a SQL literal.

    Args:
        value: The raw string.

    Returns:
        The single-quoted literal.
    """
    return "'" + value.replace("'", "''") + "'"


def _identifier(name: str) -> str:
    """Quote a name as a SQL identifier.

    Args:
        name: The raw schema or table name.

    Returns:
        The double-quoted identifier.
    """
    return '"' + name.replace('"', '""') + '"'


def _sql(token: str, project: str, query: str) -> list[dict[str, Any]]:
    """Run one read query on a project through the Management API.

    Args:
        token: OAuth access token.
        project: Project ref.
        query: The SQL.

    Returns:
        The result rows.
    """
    # The read-only endpoint runs as Supabase's read-only role and needs only the
    # ``database:read`` scope; the plain query endpoint demands ``database:write``.
    rows = post_json(
        f"{API_URL}/projects/{quote(project, safe='')}/database/query/read-only",
        provider=PROVIDER,
        headers=_headers(token),
        body={"query": query},
    )
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def _split_ref(ref: str) -> tuple[str, str, str]:
    """Split an OAuth-mode file ref, ``project/schema.table``.

    Args:
        ref: A file ref from :func:`browse`.

    Returns:
        ``(project, schema, table)``.

    Raises:
        DomainError: 400 when the ref is malformed.
    """
    project, _, qualified = ref.partition("/")
    schema, _, table = qualified.partition(".")
    if not project or not schema or not table:
        raise DomainError("connectors.invalid_ref", status=400)
    return project, schema, table


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List projects, or one project's tables and views.

    Args:
        secret: The stored connector.
        location: Empty for the root; else a project ref (OAuth) or a schema
            name (connection URL).
        search: Name filter.

    Returns:
        The entries.
    """
    if secret.auth_method != "oauth":
        return sql_base.browse(secret, location, search, PROVIDER, HIDDEN_SCHEMAS)
    needle = search.strip().lower()
    if not location:
        projects = get_json(f"{API_URL}/projects", provider=PROVIDER, headers=_headers(secret.access_token))
        return [
            Entry(ref=p["id"], name=p.get("name") or p["id"], kind="folder", modified=p.get("created_at"))
            for p in (projects if isinstance(projects, list) else [])
            if isinstance(p, dict) and isinstance(p.get("id"), str) and needle in str(p.get("name") or p["id"]).lower()
        ]
    hidden = ", ".join(_literal(s) for s in sorted(HIDDEN_SCHEMAS))
    tables = _sql(
        secret.access_token,
        location,
        "SELECT table_schema, table_name FROM information_schema.tables "
        f"WHERE table_schema NOT IN ({hidden}) AND table_schema NOT LIKE 'pg\\_%' "
        "ORDER BY table_schema, table_name",
    )
    entries = []
    for row in tables:
        schema, name = str(row.get("table_schema", "")), str(row.get("table_name", ""))
        display = name if schema == "public" else f"{schema}.{name}"
        if needle in display.lower():
            entries.append(Entry(ref=f"{location}/{schema}.{name}", name=display, kind="file"))
    return entries


def _read(token: str, ref: str, limit: int) -> tuple[list[dict[str, Any]], list[str], str]:
    """Read the first ``limit`` rows of a table through the Management API.

    Args:
        token: OAuth access token.
        ref: ``project/schema.table``.
        limit: Row cap.

    Returns:
        ``(rows, column_names, table_name)``.

    Raises:
        DomainError: 404 when the table does not exist.
    """
    project, schema, table = _split_ref(ref)
    columns = [
        str(r.get("column_name"))
        for r in _sql(
            token,
            project,
            "SELECT column_name FROM information_schema.columns "
            f"WHERE table_schema = {_literal(schema)} AND table_name = {_literal(table)} ORDER BY ordinal_position",
        )
    ]
    if not columns:
        raise DomainError("connectors.not_found", status=404, provider=label(PROVIDER))
    rows = _sql(token, project, f"SELECT * FROM {_identifier(schema)}.{_identifier(table)} LIMIT {int(limit)}")
    return [{k: cell(v) for k, v in row.items()} for row in rows], columns, table


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Read the first rows of a table.

    Args:
        secret: The stored connector.
        ref: ``project/schema.table`` (OAuth) or ``schema.table`` (connection URL).

    Returns:
        The preview envelope.
    """
    if secret.auth_method != "oauth":
        return sql_base.preview(secret, ref, PROVIDER)
    rows, columns, _ = _read(secret.access_token, ref, PREVIEW_ROWS)
    return preview_payload(rows, columns)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Read a table into library rows, up to the row cap.

    Args:
        secret: The stored connector.
        ref: ``project/schema.table`` (OAuth) or ``schema.table`` (connection URL).

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    if secret.auth_method != "oauth":
        return sql_base.import_ref(secret, ref, PROVIDER)
    rows, columns, table = _read(secret.access_token, ref, row_cap())
    return rows, import_payload(rows, columns), table
