"""Exercise concurrent desktop link calls against real PostgreSQL row locks (SKY-124, R782B-1, R782C-1, R782D-1).

SQLite ignores ``FOR UPDATE``, so only PostgreSQL at its default READ
COMMITTED level can show the refresh race. Point ``APP_DESKTOP_LINK_TEST_DB_URL``
at an explicitly disposable database to run these tests.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import threading
import time
from collections.abc import Iterator
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import Session

from core.api.account_data_service import delete_account
from core.api.auth import AuthenticatedUser, get_authenticated_user
from core.api.errors import DomainError
from core.api.routers import desktop_link
from core.api.routers.desktop_link import create_desktop_link_router
from core.config import app_env
from core.storage.models import Base, DesktopLinkCodeModel, DesktopLinkModel, DesktopTokenModel, UserModel

TEST_DB_URL = app_env("APP_DESKTOP_LINK_TEST_DB_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DB_URL or not TEST_DB_URL.startswith("postgresql"),
    reason="Set APP_DESKTOP_LINK_TEST_DB_URL to an explicitly disposable PostgreSQL database.",
)

REDIRECT = "http://127.0.0.1:54321/local/hosted-link/callback"
MAC_HOLD_SECONDS = 0.5
DELETION_HOLD_SECONDS = 0.5


class _Store:
    """Minimal store exposing the engine and the MAU admission hook."""

    def __init__(self, engine: Engine) -> None:
        """Hold the engine the routes open sessions on.

        Args:
            engine: Engine bound to the test schema.
        """
        self.engine = engine

    def admit_monthly_active_user(self, username: str, month_start: Any, cap: int) -> bool:
        """Admit every identity; the MAU cap is not under test here.

        Args:
            username: Identity to admit.
            month_start: First day of the month.
            cap: Configured cap.

        Returns:
            Always True.
        """
        return True


async def _domain_error_json(request: Request, exc: Exception) -> JSONResponse:
    """Render a DomainError with its semantic code, like the app's handler.

    Args:
        request: Incoming request.
        exc: The raised DomainError.

    Returns:
        A JSON body with ``code``.
    """
    assert isinstance(exc, DomainError)
    return JSONResponse(status_code=exc.status_code, content={"code": exc.code})


def _add_alice(engine: Engine) -> None:
    """Create the account row of the signed-in browser user.

    Args:
        engine: Engine bound to the test schema.
    """
    with Session(engine) as session:
        session.add(UserModel(email="alice@example.test", name="Alice Example", password_hash="x"))
        session.commit()


@pytest.fixture
def database() -> Iterator[Engine]:
    """Create the desktop link tables in a fresh schema and drop it after.

    Returns:
        An engine whose search path is the new schema.
    """
    schema = f"desktop_link_test_{uuid4().hex}"
    admin = create_engine(TEST_DB_URL)
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(TEST_DB_URL, connect_args={"options": f"-csearch_path={schema}"})
    tables = [model.__table__ for model in (DesktopLinkModel, DesktopTokenModel, DesktopLinkCodeModel, UserModel)]
    try:
        Base.metadata.create_all(engine, tables=tables)
        _add_alice(engine)
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


@pytest.fixture
def full_database() -> Iterator[Engine]:
    """Create every table in a fresh schema and drop it after.

    Account deletion touches every owned table, so it needs the whole schema.
    The pgvector types resolve from ``public``, where the extension lives.

    Returns:
        An engine whose search path is the new schema, then ``public``.
    """
    schema = f"desktop_link_test_{uuid4().hex}"
    admin = create_engine(TEST_DB_URL)
    with admin.begin() as connection:
        connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(TEST_DB_URL, connect_args={"options": f"-csearch_path={schema},public"})
    try:
        Base.metadata.create_all(engine)
        _add_alice(engine)
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def _client(engine: Engine) -> TestClient:
    """Build an app with the desktop link router over ``engine``.

    Args:
        engine: Engine bound to the test schema.

    Returns:
        A test client acting as a signed-in browser user.
    """
    store = _Store(engine)
    app = FastAPI()
    app.state.job_store = store
    app.add_exception_handler(DomainError, _domain_error_json)
    app.include_router(create_desktop_link_router(job_store=store))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(
        username="alice@example.test", role="user", groups=()
    )
    return TestClient(app)


def _approve(client: TestClient) -> tuple[str, str]:
    """Approve a Mac link in the browser.

    Args:
        client: Test client.

    Returns:
        The link code and its PKCE verifier.
    """
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    code = client.post(
        "/desktop/link/authorize",
        json={
            "redirect_uri": REDIRECT,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "identity",
            "device_name": "Mac",
        },
    ).json()["code"]
    return code, verifier


def _exchange(client: TestClient, code: str, verifier: str) -> Any:
    """Exchange a link code at the token endpoint.

    Args:
        client: Test client.
        code: Link code.
        verifier: PKCE verifier.

    Returns:
        The token endpoint response.
    """
    return client.post(
        "/desktop/link/token",
        json={
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": REDIRECT,
            "client_id": "skynet-desktop",
        },
    )


def _link_pair(client: TestClient) -> dict[str, Any]:
    """Authorize a Mac and exchange its code for the first token pair.

    Args:
        client: Test client.

    Returns:
        The token endpoint JSON body.
    """
    return _exchange(client, *_approve(client)).json()


def _refresh(client: TestClient, refresh_token: str) -> Any:
    """Call the refresh grant.

    Args:
        client: Test client.
        refresh_token: Refresh token to rotate.

    Returns:
        The token endpoint response.
    """
    return client.post("/desktop/link/token", json={"grant_type": "refresh_token", "refresh_token": refresh_token})


def test_replayed_token_during_a_concurrent_rotation_revokes_the_link(
    database: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A thief replaying RT0 while the Mac rotates RT1 cannot fork the link (R782B-1).

    The Mac's refresh holds its transaction open inside the rate-limit call.
    The thief starts during that hold. Without the link lock, the thief reads
    no used successor, waits on the RT1 row, and both calls get a pair.
    """
    first_call = threading.Lock()
    mac_in_transaction = threading.Event()

    def hold_first_refresh(key: str, *, limit: int, window_seconds: int) -> None:
        """Hold the first refresh transaction open; let later calls pass.

        Args:
            key: Limiter key.
            limit: Unused.
            window_seconds: Unused.
        """
        if key.startswith("desktop-link-refresh") and first_call.acquire(blocking=False):
            mac_in_transaction.set()
            time.sleep(MAC_HOLD_SECONDS)

    client = _client(database)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    code = client.post(
        "/desktop/link/authorize",
        json={
            "redirect_uri": REDIRECT,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "identity",
            "device_name": "Mac",
        },
    ).json()["code"]
    pair = client.post(
        "/desktop/link/token",
        json={
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": REDIRECT,
            "client_id": "skynet-desktop",
        },
    ).json()
    rt0 = pair["refresh_token"]
    rt1 = _refresh(client, rt0).json()["refresh_token"]

    monkeypatch.setattr(desktop_link, "_limit", hold_first_refresh)
    monkeypatch.setattr(desktop_link, "_send_notice", lambda *args: None)
    results: dict[str, Any] = {}

    def mac() -> None:
        """Rotate the Mac's current refresh token."""
        results["mac"] = _refresh(client, rt1)

    def thief() -> None:
        """Replay the old refresh token once the Mac is mid-rotation."""
        if not mac_in_transaction.wait(timeout=5):
            results["thief"] = "no-hold"
            return
        results["thief"] = _refresh(client, rt0)

    threads = [threading.Thread(target=mac), threading.Thread(target=thief)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert not isinstance(results["thief"], str), results["thief"]
    assert results["mac"].status_code == 200
    assert results["thief"].status_code == 401
    assert results["thief"].json()["code"] == "desktop.link_revoked"
    with Session(database) as session:
        assert session.get(DesktopLinkModel, pair["link_id"]).revoked_at is not None
    assert _refresh(client, results["mac"].json()["refresh_token"]).status_code == 401


def test_account_deletion_during_a_refresh_does_not_deadlock(
    full_database: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Account deletion and a Mac refresh lock link rows and token rows in one order (R782C-1).

    The deletion holds its transaction open after it deletes the links. The refresh starts during that hold. Refresh locks the link,
    then the token. When deletion locked the tokens first, the two
    transactions waited on each other and PostgreSQL aborted one of them.
    """
    monkeypatch.setattr(desktop_link, "_limit", lambda *args, **kwargs: None)
    monkeypatch.setattr(desktop_link, "_send_notice", lambda *args: None)
    client = _client(full_database)
    pair = _link_pair(client)

    deletion_thread_name = "account-deletion"
    deletion_holds_lock = threading.Event()

    def hold_after_link_delete(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        """Hold the deletion transaction open after it deletes the links.

        Args:
            conn: Connection that ran the statement.
            cursor: DBAPI cursor.
            statement: SQL text.
            args: Unused event arguments.
        """
        if (
            threading.current_thread().name == deletion_thread_name
            and not deletion_holds_lock.is_set()
            and statement.lstrip().upper().startswith("DELETE FROM DESKTOP_LINKS")
        ):
            deletion_holds_lock.set()
            time.sleep(DELETION_HOLD_SECONDS)

    event.listen(full_database, "after_cursor_execute", hold_after_link_delete)
    results: dict[str, Any] = {}

    def deletion() -> None:
        """Delete the account in one transaction, like the account router."""
        try:
            with Session(full_database) as session:
                delete_account(session, "alice@example.test")
                session.commit()
            results["deletion"] = "ok"
        except Exception as exc:  # The deadlock error is the observed result.
            results["deletion"] = type(exc).__name__

    def mac() -> None:
        """Refresh the Mac's pair while the deletion holds its first lock."""
        if not deletion_holds_lock.wait(timeout=5):
            results["mac"] = "no-hold"
            return
        try:
            results["mac"] = _refresh(client, pair["refresh_token"]).status_code
        except Exception as exc:  # The deadlock error is the observed result.
            results["mac"] = type(exc).__name__

    threads = [threading.Thread(target=deletion, name=deletion_thread_name), threading.Thread(target=mac)]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
    finally:
        event.remove(full_database, "after_cursor_execute", hold_after_link_delete)

    assert results == {"deletion": "ok", "mac": 401}
    with Session(full_database) as session:
        assert session.query(DesktopLinkModel).count() == 0
        assert session.query(DesktopTokenModel).count() == 0


@pytest.mark.parametrize("pause", ["after-link-delete", "after-token-delete", "during-exchange"])
def test_code_exchange_during_account_deletion_leaves_no_link(
    full_database: Engine, monkeypatch: pytest.MonkeyPatch, pause: str
) -> None:
    """A Mac that exchanges its code while the account is deleted gets no live link (R782D-1).

    The owner has one linked Mac and approves a second one, then deletes the
    account before the second Mac exchanges its code. The first two cases hold the deletion open after its
    link or token statement and exchange during the hold. The third case holds
    the exchange open after it locks the code and deletes during that hold.
    When the deletion read the links before the exchange committed its new
    link, that link and its tokens outlived the account.
    """
    monkeypatch.setattr(desktop_link, "_limit", lambda *args, **kwargs: None)
    monkeypatch.setattr(desktop_link, "_send_notice", lambda *args: None)
    client = _client(full_database)
    _link_pair(client)
    code, verifier = _approve(client)

    deletion_thread_name = "account-deletion"
    other_side_holds = threading.Event()
    held_statement = "DELETE FROM DESKTOP_LINKS" if pause == "after-link-delete" else "DELETE FROM DESKTOP_TOKENS"

    def hold_deletion(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        """Hold the deletion transaction open after the chosen statement.

        Args:
            conn: Connection that ran the statement.
            cursor: DBAPI cursor.
            statement: SQL text.
            args: Unused event arguments.
        """
        if (
            threading.current_thread().name == deletion_thread_name
            and not other_side_holds.is_set()
            and statement.lstrip().upper().startswith(held_statement)
        ):
            other_side_holds.set()
            time.sleep(DELETION_HOLD_SECONDS)

    live_link_count = desktop_link._live_link_count

    def hold_exchange(session: Session, username: str, now: Any) -> int:
        """Hold the first exchange transaction open while it locks the code.

        Args:
            session: Exchange session.
            username: Code owner.
            now: Current UTC time.

        Returns:
            The real live link count.
        """
        if not other_side_holds.is_set():
            other_side_holds.set()
            time.sleep(MAC_HOLD_SECONDS)
        return live_link_count(session, username, now)

    if pause == "during-exchange":
        monkeypatch.setattr(desktop_link, "_live_link_count", hold_exchange)
    else:
        event.listen(full_database, "after_cursor_execute", hold_deletion)
    results: dict[str, Any] = {}

    def deletion() -> None:
        """Delete the account in one transaction, like the account router."""
        if pause == "during-exchange" and not other_side_holds.wait(timeout=5):
            results["deletion"] = "no-hold"
            return
        try:
            with Session(full_database) as session:
                delete_account(session, "alice@example.test")
                session.commit()
            results["deletion"] = "ok"
        except Exception as exc:  # A lock error is the observed result.
            results["deletion"] = type(exc).__name__

    def mac() -> None:
        """Exchange the code; wait for the deletion hold first when it leads."""
        if pause != "during-exchange" and not other_side_holds.wait(timeout=5):
            results["mac"] = "no-hold"
            return
        results["mac"] = _exchange(client, code, verifier)

    threads = [
        threading.Thread(target=deletion, name=deletion_thread_name),
        threading.Thread(target=mac, name="mac"),
    ]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
    finally:
        if pause != "during-exchange":
            event.remove(full_database, "after_cursor_execute", hold_deletion)

    assert results["deletion"] == "ok"
    exchange = results["mac"]
    assert not isinstance(exchange, str), exchange
    with Session(full_database) as session:
        assert session.query(DesktopLinkModel).count() == 0
        assert session.query(DesktopTokenModel).count() == 0
        assert session.query(DesktopLinkCodeModel).count() == 0
    if pause == "during-exchange":
        # The exchange commits first; the deletion then removes what it made.
        assert exchange.status_code == 200
        whoami = client.get(
            "/desktop/v1/whoami", headers={"Authorization": f"Bearer {exchange.json()['access_token']}"}
        )
        assert whoami.status_code == 401
    else:
        # The deletion removed the code first, so the exchange finds none.
        assert exchange.status_code == 400
