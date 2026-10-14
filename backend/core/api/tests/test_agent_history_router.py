"""Tests for the agent-history conversation router's bulk-delete route.

Mounts the conversation router on an in-memory SQLite store (the sibling
routers' pattern: a ``RemoteDBJobStore`` subclass that skips the pgvector
bootstrap so ``Base.metadata.create_all`` stands up the conversation tables).
Covers the per-id outcomes of ``POST /agent/conversations/bulk-delete``: owned
rows delete, duplicates collapse, unknown and other-users' ids are skipped, and
an empty request is a no-op.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ...storage.models import AgentConversationModel, AgentMessageModel, Base
from ...storage.remote import RemoteDBJobStore
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError
from ..routers.agent_history import create_agent_history_router

_ALICE = AuthenticatedUser(username="alice", role="user", groups=())


class _MemStore(RemoteDBJobStore):
    """In-memory SQLite job store for agent-history tests (no pgvector)."""

    def __init__(self) -> None:
        """Build an in-memory SQLite engine and create the ORM tables."""
        self._engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self._engine)
        self._session_factory = sessionmaker(bind=self._engine)


def _client(user: AuthenticatedUser) -> tuple[TestClient, _MemStore]:
    """Mount the agent-history router on a fresh store, authed as ``user``.

    Args:
        user: Identity the auth dependency resolves to for every request.

    Returns:
        A ``(client, store)`` pair sharing one in-memory store.
    """
    store = _MemStore()
    app = FastAPI()
    app.include_router(create_agent_history_router(job_store=store))
    app.dependency_overrides[get_authenticated_user] = lambda: user

    @app.exception_handler(DomainError)
    async def _domain_error_handler(_request, exc: DomainError) -> JSONResponse:
        """Mirror the app-level envelope so tests can assert on ``code``."""
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "code": exc.code, "params": exc.params},
        )

    return TestClient(app), store


def _seed(store: _MemStore, *conversations: tuple[str, str]) -> None:
    """Insert ``(id, username)`` conversation rows directly into the store.

    Args:
        store: The in-memory store to seed.
        conversations: ``(id, username)`` pairs to insert.
    """
    with store._session_factory() as session:
        session.add_all(
            AgentConversationModel(id=cid, username=username, title=cid)
            for cid, username in conversations
        )
        session.commit()


def _ids(store: _MemStore) -> set[str]:
    """Return the set of conversation ids currently in the store.

    Args:
        store: The store to read.

    Returns:
        Every ``AgentConversationModel.id`` present.
    """
    with store._session_factory() as session:
        return {row.id for row in session.query(AgentConversationModel)}


def test_bulk_delete_removes_owned_conversations() -> None:
    """Bulk-delete clears every owned id and leaves none of them behind."""
    client, store = _client(_ALICE)
    _seed(store, ("c-1", "alice"), ("c-2", "alice"))

    resp = client.post("/agent/conversations/bulk-delete", json={"ids": ["c-1", "c-2"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert sorted(body["deleted"]) == ["c-1", "c-2"]
    assert body["skipped"] == []
    assert _ids(store) == set()


def test_bulk_delete_dedupes_and_skips_unknown() -> None:
    """Duplicate ids collapse to one delete; an unknown id is skipped, not fatal."""
    client, store = _client(_ALICE)
    _seed(store, ("c-1", "alice"))

    resp = client.post(
        "/agent/conversations/bulk-delete",
        json={"ids": ["c-1", "c-1", "ghost"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] == ["c-1"]
    assert body["skipped"] == [{"id": "ghost", "reason": "not_found"}]


def test_bulk_delete_skips_other_users_conversations() -> None:
    """A caller cannot bulk-delete another user's conversation — it is skipped."""
    client, store = _client(_ALICE)
    _seed(store, ("bob-1", "bob"))

    resp = client.post("/agent/conversations/bulk-delete", json={"ids": ["bob-1"]})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"deleted": [], "skipped": [{"id": "bob-1", "reason": "not_found"}]}
    assert _ids(store) == {"bob-1"}


def test_bulk_delete_empty_is_noop() -> None:
    """An empty id list deletes nothing and returns empty result lists."""
    client, _ = _client(_ALICE)
    resp = client.post("/agent/conversations/bulk-delete", json={"ids": []})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"deleted": [], "skipped": []}


def _seed_turn(store: _MemStore, conversation_id: str, tool_calls: list[dict]) -> None:
    """Insert one assistant turn carrying ``tool_calls`` into a conversation.

    Args:
        store: The in-memory store to seed.
        conversation_id: The owning conversation.
        tool_calls: The turn's tool-call records.
    """
    with store._session_factory() as session:
        session.add(
            AgentMessageModel(conversation_id=conversation_id, role="assistant", content="", tool_calls=tool_calls)
        )
        session.commit()


def test_tool_call_outcome_is_stored_on_the_call_and_reloads() -> None:
    """The coding tool's finished state lands on its call, so a reload renders the same rows."""
    client, store = _client(_ALICE)
    _seed(store, ("c1", "alice"))
    _seed_turn(
        store,
        "c1",
        [
            {"id": "t1", "tool": "request_code_authoring", "status": "done", "payload": {"result": {"goal": ""}}},
            {"id": "t2", "tool": "other", "status": "done"},
        ],
    )
    outcome = {"status": "done", "check": "passed", "edits": [{"file": "run", "before": "", "after": "x"}]}

    resp = client.put("/agent/conversations/c1/tool-calls/t1/outcome", json={"outcome": outcome})

    assert resp.status_code == 204
    calls = client.get("/agent/conversations/c1").json()["messages"][0]["tool_calls"]
    assert calls[0]["payload"] == {"result": {"goal": ""}, "outcome": outcome}
    assert calls[1] == {"id": "t2", "tool": "other", "status": "done"}


def test_tool_call_outcome_rejects_unknown_calls_and_other_users() -> None:
    """Only the owner can record an outcome, and only on a call the thread holds."""
    client, store = _client(_ALICE)
    _seed(store, ("c1", "alice"), ("c2", "bob"))
    _seed_turn(store, "c1", [{"id": "t1", "tool": "request_code_authoring", "status": "done"}])
    body = {"outcome": {"status": "done"}}

    assert client.put("/agent/conversations/c1/tool-calls/nope/outcome", json=body).status_code == 404
    assert client.put("/agent/conversations/c2/tool-calls/t1/outcome", json=body).status_code == 403
    assert client.put("/agent/conversations/zz/tool-calls/t1/outcome", json=body).status_code == 404
