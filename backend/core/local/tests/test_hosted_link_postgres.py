"""Live-Postgres test for the cross-process single-flight refresh of the hosted link.

The API process and the worker process share one desktop token pair. Only
``pg_advisory_xact_lock`` keeps them from sending the same refresh token twice,
which hosted (#782) treats as theft after a 30 s grace and answers by revoking
the link. SQLite cannot run that lock, so this module needs a real Postgres.

It is gated on ``APP_TEST_DB_URL``, the same opt-in as
``core/storage/tests/test_remote_jobstore_postgres.py``, and never on
``REMOTE_DB_URL``. It creates and drops its own schema, so it does not touch
other tables::

    APP_TEST_DB_URL=postgresql://skynet:skynet@localhost:5432/testdb \\
        pytest backend/core/local/tests/test_hosted_link_postgres.py

Without that env var the module is skipped, so unit-test CI is unaffected.
"""

from __future__ import annotations

import contextlib
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor

import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from ...config import app_env, settings
from ...storage.models import UserConnectorModel
from .. import hosted_link
from .fake_hosted import API_ORIGIN, APP_ORIGIN, FakeHosted

TEST_DB_URL = app_env("APP_TEST_DB_URL")
_USER = "local@skynet.local"

pytestmark = pytest.mark.skipif(
    not TEST_DB_URL or not TEST_DB_URL.startswith("postgresql"),
    reason="APP_TEST_DB_URL not set to a postgresql:// URL; the advisory-lock path needs a live Postgres.",
)


@pytest.fixture
def engines() -> Iterator[tuple[Engine, Engine]]:
    """Return two engines on one throwaway schema, as the API and the worker have.

    Yields:
        Two engines with separate connection pools.
    """
    assert TEST_DB_URL is not None
    schema = f"hosted_link_{uuid.uuid4().hex[:12]}"
    admin = create_engine(TEST_DB_URL)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    pair = tuple(create_engine(TEST_DB_URL, connect_args={"options": f"-csearch_path={schema}"}) for _ in range(2))
    UserConnectorModel.__table__.create(pair[0])
    try:
        yield pair[0], pair[1]
    finally:
        for eng in pair:
            eng.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


@pytest.fixture
def hosted(monkeypatch: pytest.MonkeyPatch) -> FakeHosted:
    """Point the link client at a fake hosted server, with no in-process lock.

    The process lock is replaced by a no-op, so only the Postgres advisory lock
    can serialize the two callers, as between two processes.

    Args:
        monkeypatch: Pytest fixture used to change settings and module state.

    Returns:
        The fake server.
    """
    fake = FakeHosted()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "api_host", "127.0.0.1")
    monkeypatch.setattr(settings, "port", 8110)
    monkeypatch.setattr(settings, "hosted_app_url", APP_ORIGIN)
    monkeypatch.setattr(settings, "hosted_api_url", API_ORIGIN)
    monkeypatch.setattr(settings, "byok_vault_key", SecretStr(Fernet.generate_key().decode()))
    monkeypatch.setattr(hosted_link, "_TRANSPORT", fake.transport())
    monkeypatch.setattr(hosted_link, "_REFRESH_LOCK", contextlib.nullcontext())
    hosted_link.clear_used_states()
    return fake


def test_two_engines_refresh_once(engines: tuple[Engine, Engine], hosted: FakeHosted) -> None:
    """The API and the worker find the token old at once; hosted sees one refresh.

    Args:
        engines: Two engines on the same database, as two processes have.
        hosted: The fake hosted server.
    """
    api, worker = engines
    hosted.access_ttl = 120
    url = hosted_link.start_link(_USER, device_name="Test Mac")
    _redirect, code, state = hosted.authorize(url)
    hosted_link.finish_link(api, code=code, state=state)
    hosted.access_ttl = 3600
    hosted.refresh_delay = 0.3

    with ThreadPoolExecutor(max_workers=2) as pool:
        tokens = list(pool.map(lambda eng: hosted_link.access_token(eng, _USER), (api, worker)))

    hosted.refresh_delay = 0.0
    assert tokens[0] == tokens[1]
    assert hosted.refresh_count == 1
    assert hosted.reuse_notices == 0
    assert hosted_link.hosted_get(worker, _USER, "/desktop/v1/balance")["available_cents"] == 1234
