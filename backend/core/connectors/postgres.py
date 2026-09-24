"""PostgreSQL connector: import a table or view over a pasted connection URL."""

from __future__ import annotations

from typing import Any

from . import sql_base
from .base import Credential, Entry
from .vault import ConnectorSecret

PROVIDER = "postgres"
SCHEMES = {
    "postgres": "postgresql+psycopg2",
    "postgresql": "postgresql+psycopg2",
    "postgresql+psycopg2": "postgresql+psycopg2",
}
HIDDEN_SCHEMAS = frozenset({"information_schema", "pg_catalog", "pg_toast"})


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate a connection URL by connecting with it.

    Args:
        fields: ``{"url": ...}``.

    Returns:
        The credential to store.
    """
    return sql_base.verify(sql_base.normalise_url(fields.get("url", ""), SCHEMES, PROVIDER), PROVIDER)


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List schemas, or one schema's tables and views.

    Args:
        secret: The stored connector.
        location: Empty for the root, else a schema name.
        search: Name filter.

    Returns:
        The entries.
    """
    return sql_base.browse(secret, location, search, PROVIDER, HIDDEN_SCHEMAS)


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Read the first rows of a table.

    Args:
        secret: The stored connector.
        ref: ``schema.table``.

    Returns:
        The preview envelope.
    """
    return sql_base.preview(secret, ref, PROVIDER)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Read a table into library rows.

    Args:
        secret: The stored connector.
        ref: ``schema.table``.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    return sql_base.import_ref(secret, ref, PROVIDER)
