"""Shared plumbing for the SQLAlchemy-backed database connectors.

PostgreSQL and MySQL differ only in their URL scheme and their system
schemas; everything else (validating a connection, listing schemas and
tables, reading rows) goes through SQLAlchemy reflection here, which also
keeps identifiers out of hand-built SQL.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import MetaData, Table, create_engine, inspect, select, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import ArgumentError, NoSuchTableError, OperationalError, SQLAlchemyError
from sqlalchemy.pool import NullPool

from ..api.errors import DomainError
from .base import Credential, Entry
from .records import PREVIEW_ROWS, cell, import_payload, preview_payload, row_cap
from .transport import label
from .vault import ConnectorSecret

CONNECT_TIMEOUT = 15
REASON_LIMIT = 200


def make_engine(url: str) -> Engine:
    """Open a throwaway engine for one request.

    Args:
        url: A SQLAlchemy URL.

    Returns:
        The engine; callers dispose of it.
    """
    return create_engine(url, poolclass=NullPool, connect_args={"connect_timeout": CONNECT_TIMEOUT})


def _reason(exc: BaseException) -> str:
    """Shorten a driver error for the user-facing message.

    Args:
        exc: The SQLAlchemy exception.

    Returns:
        The first line of the driver's message, capped.
    """
    original = getattr(exc, "orig", None) or exc
    first_line = str(original).strip().splitlines()[0] if str(original).strip() else exc.__class__.__name__
    return first_line[:REASON_LIMIT]


def _query_failed(provider: str, exc: SQLAlchemyError) -> DomainError:
    """Map a database failure to a domain error.

    Args:
        provider: Provider slug.
        exc: The failure.

    Returns:
        The error to raise.
    """
    if isinstance(exc, NoSuchTableError):
        return DomainError("connectors.not_found", status=404, provider=label(provider))
    return DomainError("connectors.query_failed", status=502, provider=label(provider), reason=_reason(exc))


def normalise_url(raw: str, schemes: dict[str, str], provider: str) -> str:
    """Validate a pasted connection URL and pin it to our driver.

    Args:
        raw: The pasted URL.
        schemes: Accepted scheme prefixes mapped to the driver-qualified one.
        provider: Provider slug for errors.

    Returns:
        The URL with the driver-qualified scheme.

    Raises:
        DomainError: 400 when the URL is malformed or uses another scheme.
    """
    candidate = raw.strip()
    scheme = urlsplit(candidate).scheme.lower()
    if scheme not in schemes:
        raise DomainError("connectors.invalid_credentials", status=400)
    try:
        url = make_url(candidate).set(drivername=schemes[scheme])
    except ArgumentError as exc:
        raise DomainError("connectors.invalid_credentials", status=400) from exc
    if not url.host or not url.database:
        raise DomainError("connectors.invalid_credentials", status=400)
    return url.render_as_string(hide_password=False)


def account_label(url: str) -> str:
    """Describe a connection without its password.

    Args:
        url: A SQLAlchemy URL.

    Returns:
        ``user@host/database``.
    """
    parsed = make_url(url)
    user = f"{parsed.username}@" if parsed.username else ""
    return f"{user}{parsed.host}/{parsed.database}"


def verify(url: str, provider: str) -> Credential:
    """Open a connection and run a trivial query.

    Args:
        url: The normalised URL.
        provider: Provider slug.

    Returns:
        The credential to store.

    Raises:
        DomainError: 400 when the server refuses the connection; 502 ``unreachable``
            when it cannot be reached.
    """
    engine = make_engine(url)
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except OperationalError as exc:
        reason = _reason(exc).lower()
        if "password" in reason or "authentication" in reason or "access denied" in reason or "denied" in reason:
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise DomainError("connectors.unreachable", status=502, provider=label(provider)) from exc
    except SQLAlchemyError as exc:
        raise _query_failed(provider, exc) from exc
    finally:
        engine.dispose()
    return Credential(secret=url, auth_method="credentials", account_label=account_label(url))


def _split_ref(ref: str) -> tuple[str | None, str]:
    """Split ``schema.table`` (or a bare table name).

    Args:
        ref: A file ref from :func:`browse`.

    Returns:
        ``(schema, table)``.

    Raises:
        DomainError: 400 when the ref is empty.
    """
    schema, sep, table = ref.partition(".")
    if not sep:
        schema, table = None, ref
    if not table:
        raise DomainError("connectors.invalid_ref", status=400)
    return schema or None, table


def browse(secret: ConnectorSecret, location: str, search: str, provider: str, hidden: frozenset[str]) -> list[Entry]:
    """List schemas at the root, or the tables and views of one schema.

    Args:
        secret: The stored connector (its token is the URL).
        location: Empty for the root, else a schema name.
        search: Name filter.
        provider: Provider slug.
        hidden: System schemas to leave out.

    Returns:
        The entries.
    """
    engine = make_engine(secret.access_token)
    needle = search.strip().lower()
    try:
        inspector = inspect(engine)
        if not location:
            schemas = [s for s in inspector.get_schema_names() if s not in hidden and not s.startswith("pg_")]
            return [Entry(ref=s, name=s, kind="folder") for s in schemas if needle in s.lower()]
        names = inspector.get_table_names(schema=location) + inspector.get_view_names(schema=location)
        return [Entry(ref=f"{location}.{n}", name=n, kind="file") for n in sorted(names) if needle in n.lower()]
    except SQLAlchemyError as exc:
        raise _query_failed(provider, exc) from exc
    finally:
        engine.dispose()


def _read(url: str, ref: str, limit: int, provider: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Read the first ``limit`` rows of a table.

    Args:
        url: The connection URL.
        ref: ``schema.table``.
        limit: Row cap.
        provider: Provider slug.

    Returns:
        ``(rows, column_names)``.
    """
    schema, name = _split_ref(ref)
    engine = make_engine(url)
    try:
        table = Table(name, MetaData(), schema=schema, autoload_with=engine)
        columns = [c.name for c in table.columns]
        with engine.connect() as connection:
            result = connection.execute(select(table).limit(limit))
            rows = [{k: cell(v) for k, v in row.items()} for row in result.mappings()]
    except SQLAlchemyError as exc:
        raise _query_failed(provider, exc) from exc
    finally:
        engine.dispose()
    return rows, columns


def preview(secret: ConnectorSecret, ref: str, provider: str) -> dict[str, Any]:
    """Read the first rows of a table.

    Args:
        secret: The stored connector.
        ref: ``schema.table``.
        provider: Provider slug.

    Returns:
        The preview envelope.
    """
    rows, columns = _read(secret.access_token, ref, PREVIEW_ROWS, provider)
    return preview_payload(rows, columns)


def import_ref(secret: ConnectorSecret, ref: str, provider: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Read a table into library rows, up to the row cap.

    Args:
        secret: The stored connector.
        ref: ``schema.table``.
        provider: Provider slug.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    rows, columns = _read(secret.access_token, ref, row_cap(), provider)
    return rows, import_payload(rows, columns), _split_ref(ref)[1]
