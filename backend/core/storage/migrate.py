"""Keep an adopted database's Alembic version in step at boot.

Production builds its schema with ``Base.metadata.create_all`` and then tracks it
with Alembic, because ``create_all`` never ALTERs an existing table: a migration
that adds a column to a table an earlier boot already created would otherwise
never land — exactly the drift that silently stranded ``billing_provider_keys``.

On an adopted database the pending migrations run *before* ``create_all``: run
after it, a migration that creates or renames a table collides with the empty
table ``create_all`` just made from the new models (the #502 deploy failed on
``wallet_ledger_id_seq`` this way). On a database Alembic has never stamped, the
``create_all`` schema already *is* head, so it is stamped afterwards rather than
replayed (the pgvector baseline migration would fail where the extension is
absent). Both steps run under the same advisory lock as ``create_all`` so
concurrent replicas don't race, and are Postgres-only — SQLite test stores get
``None`` from the lock helper and skip Alembic, since their schema comes
straight from the ORM models.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from alembic.config import Config
from sqlalchemy import inspect, text

from alembic import command

from .schema_lock import schema_bootstrap_lock

# backend/core/storage/migrate.py -> backend/alembic.ini
_ALEMBIC_INI = Path(__file__).resolve().parents[2] / "alembic.ini"


def upgrade_if_adopted(engine: Any) -> None:
    """Apply pending migrations when Alembic already tracks this database.

    Call before ``create_all`` so new tables come from their migrations, not from
    the models.

    Args:
        engine: The store's SQLAlchemy engine. On non-PostgreSQL dialects the lock
            helper yields ``None`` and this returns without touching Alembic.
    """
    with schema_bootstrap_lock(engine) as conn:
        if conn is not None and _is_adopted(conn):
            command.upgrade(_alembic_config(conn), "head")


def stamp_if_unadopted(engine: Any) -> None:
    """Stamp head on a database Alembic has never tracked.

    Call after ``create_all``, whose schema on such a database already is head.

    Args:
        engine: The store's SQLAlchemy engine. On non-PostgreSQL dialects the lock
            helper yields ``None`` and this returns without touching Alembic.
    """
    with schema_bootstrap_lock(engine) as conn:
        if conn is not None and not _is_adopted(conn):
            command.stamp(_alembic_config(conn), "head")


def sync_migration_head(engine: Any) -> None:
    """Upgrade an adopted database, else stamp it at head.

    Args:
        engine: The store's SQLAlchemy engine.
    """
    upgrade_if_adopted(engine)
    stamp_if_unadopted(engine)


def _alembic_config(conn: Any) -> Config:
    """Build an Alembic config that runs on the lock-holding connection.

    Sharing that connection keeps migrations in the locked transaction rather
    than a second, unserialized session.

    Args:
        conn: A live connection bound to the bootstrap transaction.

    Returns:
        The Alembic config bound to ``conn``.
    """
    config = Config(str(_ALEMBIC_INI))
    config.attributes["connection"] = conn
    # Keep env.py from running fileConfig(alembic.ini): that replaces the
    # root handlers and raises the root level to WARN, silencing every app
    # INFO log (JSON format included) for the rest of the process lifetime.
    config.attributes["configure_logger"] = False
    return config


def _is_adopted(conn: Any) -> bool:
    """Return whether ``alembic_version`` exists and already holds a revision.

    Args:
        conn: A live connection bound to the bootstrap transaction.

    Returns:
        ``True`` once Alembic has stamped this database — so pending migrations
        should be applied rather than the freshly built schema stamped at head.
    """
    if not inspect(conn).has_table("alembic_version"):
        return False
    return conn.execute(text("SELECT 1 FROM alembic_version LIMIT 1")).first() is not None
