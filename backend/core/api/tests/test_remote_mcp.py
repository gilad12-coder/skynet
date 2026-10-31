"""Tests for the hosted remote MCP server and its tools (SKY-229).

The app mounts the real stateless Streamable HTTP server over in-memory
SQLite. Grants and tokens are written to the database directly; the OAuth
flow that issues them is covered in ``test_mcp_oauth.py``. The service-layer
functions are replaced in the ``remote_mcp`` namespace, so each test checks
what a tool hands to the service layer.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...config import settings
from ...models.optimizations import JobCancelResponse
from ...storage.models import Base, McpGrantModel, McpTokenModel, UserModel
from .. import remote_mcp
from ..auth import hash_api_token
from ..errors import DomainError
from ..remote_mcp import mount_remote_mcp
from .test_submissions_router import unified_payload

RESOURCE = "https://mcp.example.test/mcp"
MCP_URL = RESOURCE
USER = "alice@example.test"
READ_TOKEN = "skym_at_read-only-token"
WRITE_TOKEN = "skym_at_read-write-token"


class _Store:
    """Minimal store exposing the engine and the MAU admission hook."""

    def __init__(self, engine: Any) -> None:
        """Hold the engine the token checks open sessions on.

        Args:
            engine: SQLAlchemy engine with the schema created.
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


def _seed_token(engine: Any, token: str, scopes: str, grant_id: str) -> None:
    """Write a live grant and its access token.

    Args:
        engine: SQLAlchemy engine.
        token: Plaintext access token.
        scopes: Space-separated granted scopes.
        grant_id: Grant ID.
    """
    now = datetime.now(UTC)
    with Session(engine) as session:
        session.add(
            McpGrantModel(
                id=grant_id,
                username=USER,
                client_id="mcpc_test",
                client_name="Test agent",
                scopes=scopes,
                resource=RESOURCE,
                created_at=now,
                absolute_expires_at=now + timedelta(days=1),
            )
        )
        session.add(
            McpTokenModel(
                token_hash=hash_api_token(token),
                grant_id=grant_id,
                kind="access",
                created_at=now,
                expires_at=now + timedelta(hours=1),
            )
        )
        session.commit()


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Build an app with the remote MCP server over in-memory SQLite.

    Args:
        monkeypatch: Pytest monkeypatch fixture.

    Yields:
        A ``(client, store, calls)`` tuple; ``calls`` records service-layer calls.
    """
    monkeypatch.setattr(settings, "mcp_resource_url", RESOURCE)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(UserModel(email=USER, name="Alice Example", password_hash="x"))
        session.commit()
    _seed_token(engine, READ_TOKEN, "runs:read", "mg_read")
    _seed_token(engine, WRITE_TOKEN, "runs:read runs:write", "mg_write")
    store = _Store(engine)
    calls: dict[str, Any] = {}
    worker = object()
    app = FastAPI()

    @app.get("/mcp")
    def api_mcp() -> dict[str, str]:
        """Stand in for the internal API ``/mcp`` route."""
        return {"served_by": "api"}

    mount_remote_mcp(app, service="svc", job_store=store, get_worker=lambda: worker)
    calls["worker"] = worker
    with TestClient(app) as client:
        yield client, store, calls


def _rpc(client: TestClient, method: str, params: dict[str, Any], token: str | None = WRITE_TOKEN) -> Any:
    """Send one JSON-RPC request to the MCP endpoint.

    Args:
        client: Test client.
        method: JSON-RPC method.
        params: JSON-RPC params.
        token: Bearer token, or ``None`` for no header.

    Returns:
        The HTTP response.
    """
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return client.post(MCP_URL, headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})


def _call(client: TestClient, tool: str, arguments: dict[str, Any], token: str = WRITE_TOKEN) -> dict[str, Any]:
    """Call a tool and return its JSON-RPC result.

    Args:
        client: Test client.
        tool: Tool name.
        arguments: Tool arguments.
        token: Bearer token.

    Returns:
        The ``result`` member.
    """
    resp = _rpc(client, "tools/call", {"name": tool, "arguments": arguments}, token)
    assert resp.status_code == 200, resp.text
    return resp.json()["result"]


def _payload(result: dict[str, Any]) -> dict[str, Any]:
    """Return the structured payload of a successful tool result."""
    assert not result.get("isError"), result
    return result["structuredContent"]


def _error_text(result: dict[str, Any]) -> str:
    """Return the text of a failed tool result."""
    assert result.get("isError") is True, result
    return result["content"][0]["text"]


def test_missing_token_gets_the_rfc9728_challenge(harness: Any) -> None:
    """Point a client without a token at the protected resource metadata."""
    client, _store, _calls = harness
    resp = _rpc(client, "tools/list", {}, token=None)
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == (
        'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"'
    )


def test_unknown_token_gets_invalid_token(harness: Any) -> None:
    """Refuse a token that the server did not issue."""
    client, _store, _calls = harness
    resp = _rpc(client, "tools/list", {}, token="skym_at_forged")
    assert resp.status_code == 401
    assert 'error="invalid_token"' in resp.headers["www-authenticate"]
    assert resp.json() == {"error": "invalid_token"}


def test_token_for_another_resource_is_refused(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Refuse a token whose audience is another resource URL on this host."""
    client, _store, _calls = harness
    monkeypatch.setattr(settings, "mcp_resource_url", "https://mcp.example.test/other")
    resp = client.post(
        "https://mcp.example.test/other",
        headers={"Authorization": f"Bearer {WRITE_TOKEN}", "Accept": "application/json, text/event-stream"},
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
    )
    assert resp.status_code == 401


def test_other_hosts_reach_the_api(harness: Any) -> None:
    """Leave ``/mcp`` on the API host to the API."""
    client, _store, _calls = harness
    resp = client.get("https://api.example.test/mcp")
    assert resp.json() == {"served_by": "api"}


def test_unconfigured_server_serves_nothing(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Send every request to the API when no resource URL is configured."""
    client, _store, _calls = harness
    monkeypatch.setattr(settings, "mcp_resource_url", "")
    assert client.get(MCP_URL).json() == {"served_by": "api"}


def test_tools_list_names_the_five_tools(harness: Any) -> None:
    """List check, start, get, list and stop, and no money tools."""
    client, _store, _calls = harness
    resp = _rpc(client, "tools/list", {})
    assert resp.status_code == 200, resp.text
    names = {tool["name"] for tool in resp.json()["result"]["tools"]}
    assert names == {"check_run", "start_run", "get_run", "list_runs", "stop_run"}


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("start_run", {"spec": unified_payload(), "max_cost_cents": 500}),
        ("stop_run", {"optimization_id": "opt-1"}),
    ],
)
def test_read_scope_cannot_start_or_stop(
    harness: Any, monkeypatch: pytest.MonkeyPatch, tool: str, arguments: dict[str, Any]
) -> None:
    """Refuse write tools to a ``runs:read`` token before any service call."""
    client, _store, _calls = harness

    def forbidden(*args: Any, **kwargs: Any) -> Any:
        """Fail the test if a write reaches the service layer."""
        raise AssertionError("service layer called")

    monkeypatch.setattr(remote_mcp, "submit_unified_payload", forbidden)
    monkeypatch.setattr(remote_mcp, "_submit_within_proxy_timeout", forbidden)
    monkeypatch.setattr(remote_mcp, "cancel_optimization", forbidden)
    text = _error_text(_call(client, tool, arguments, token=READ_TOKEN))
    assert "insufficient_scope" in text
    assert "runs:write" in text


def test_start_run_creates_a_budget_with_the_agent_limit(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Submit through the service layer with max_cost_cents and no reused budget."""
    client, _store, calls = harness

    def submit(spec: Any, *, service: Any, job_store: Any, current_user: Any, idempotency_key: Any) -> Any:
        """Record what the tool submits."""
        calls["submit"] = (spec, service, current_user, idempotency_key)
        return SimpleNamespace(model_dump=lambda mode: {"optimization_id": "opt-1", "status": "pending"})

    def within_timeout(username: str, replay_key: str, work: Any) -> Any:
        """Run the submission like the proxy-timeout wrapper does."""
        calls["timeout"] = (username, replay_key)
        return work()

    monkeypatch.setattr(remote_mcp, "submit_unified_payload", submit)
    monkeypatch.setattr(remote_mcp, "_submit_within_proxy_timeout", within_timeout)
    spec = unified_payload(execution_budget_id="eb-someone-else", max_cost_cents=99_999)
    body = _payload(_call(client, "start_run", {"spec": spec, "max_cost_cents": 700, "idempotency_key": "k-1"}))
    assert body == {"optimization_id": "opt-1", "status": "pending"}
    submitted, service, user, key = calls["submit"]
    assert submitted.max_cost_cents == 700
    assert submitted.execution_budget_id is None
    assert service == "svc"
    assert (user.username, user.role) == (USER, "user")
    assert key == "k-1"
    assert calls["timeout"][0] == USER


def test_start_run_reports_a_slow_setup_check(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Tell the agent to retry while the setup check still runs."""
    client, _store, _calls = harness
    monkeypatch.setattr(
        remote_mcp,
        "_submit_within_proxy_timeout",
        lambda username, key, work: JSONResponse(status_code=202, content={}, headers={"Retry-After": "7"}),
    )
    body = _payload(_call(client, "start_run", {"spec": unified_payload(), "max_cost_cents": 500}))
    assert body["status"] == "in_progress"
    assert body["retry_after_seconds"] == 7


def test_start_run_refuses_a_zero_budget(harness: Any) -> None:
    """Require a positive spending limit."""
    client, _store, _calls = harness
    result = _call(client, "start_run", {"spec": unified_payload(), "max_cost_cents": 0})
    assert result.get("isError") is True


def test_start_run_reports_service_errors(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Pass a service-layer refusal, like a low balance, to the agent."""
    client, _store, _calls = harness

    def refuse(username: str, key: str, work: Any) -> Any:
        """Refuse like the budget preflight."""
        raise DomainError("billing.insufficient_balance", status=402)

    monkeypatch.setattr(remote_mcp, "_submit_within_proxy_timeout", refuse)
    text = _error_text(_call(client, "start_run", {"spec": unified_payload(), "max_cost_cents": 500}))
    assert json.loads(text)["code"] == "billing.insufficient_balance"


def test_check_run_estimates_the_floor(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Return the checks, the wizard's floor, a suggested limit and the balance."""
    client, _store, calls = harness
    monkeypatch.setattr(remote_mcp, "enforce_submission_rate", lambda username: calls.setdefault("rate", username))
    monkeypatch.setattr(remote_mcp, "box_hold_cents", lambda: Decimal("40.2"))
    monkeypatch.setattr(remote_mcp, "call_hold_cents", lambda name, source, *, client: Decimal("150.5"))

    class _Billing:
        """Stand in for the billing service."""

        def __init__(self, engine: Any) -> None:
            """Accept the engine."""

        def spendable_cents(self, username: str) -> int:
            """Return a fixed balance."""
            return 2500

    monkeypatch.setattr(remote_mcp, "StripeBillingService", _Billing)
    body = _payload(_call(client, "check_run", {"spec": unified_payload()}, token=READ_TOKEN))
    assert body["min_max_cost_cents"] == 41 + 151
    assert body["suggested_max_cost_cents"] == 500
    assert body["spendable_cents"] == 2500
    assert "checks" in body
    assert calls["rate"] == USER


def test_get_run_is_owner_scoped(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Load the run through the owner check and return its budget."""
    client, _store, calls = harness

    def load(job_store: Any, optimization_id: str, user: Any) -> dict[str, Any]:
        """Record the owner check."""
        calls["load"] = (optimization_id, user.username)
        return {"optimization_id": optimization_id, "result": {"best": 1}}

    monkeypatch.setattr(remote_mcp, "load_job_for_user", load)
    monkeypatch.setattr(
        remote_mcp,
        "build_summary",
        lambda job: SimpleNamespace(status="success", model_dump=lambda mode: {"status": "success"}),
    )
    monkeypatch.setattr(remote_mcp, "execution_budget_view", lambda store, job: {"limit_cents": 500})
    body = _payload(_call(client, "get_run", {"optimization_id": "opt-1"}, token=READ_TOKEN))
    assert calls["load"] == ("opt-1", USER)
    assert body["terminal"] is True
    assert body["result"] == {"best": 1}
    assert body["execution_budget"] == {"limit_cents": 500}


def test_list_runs_lists_only_the_callers_runs(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Filter the list by the token's account and clamp the page size."""
    client, store, calls = harness
    store.count_jobs = lambda **kwargs: calls.setdefault("count", kwargs) and 1
    store.list_jobs = lambda **kwargs: calls.setdefault("list", kwargs) and [{"optimization_id": "opt-1"}]
    monkeypatch.setattr(
        remote_mcp, "build_summary", lambda job: SimpleNamespace(model_dump=lambda mode: {"id": job["optimization_id"]})
    )
    body = _payload(_call(client, "list_runs", {"limit": 5, "status": "running"}, token=READ_TOKEN))
    assert calls["count"]["username"] == USER
    assert calls["list"] == {"status": "running", "username": USER, "limit": 5, "offset": 0}
    assert body["runs"] == [{"id": "opt-1"}]
    assert "Unknown status" in _error_text(_call(client, "list_runs", {"status": "bogus"}, token=READ_TOKEN))


def test_stop_run_cancels_through_the_service_layer(harness: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Cancel like the Stop button, with the background worker."""
    client, _store, calls = harness

    def cancel(job_store: Any, optimization_id: str, user: Any, worker: Any) -> JobCancelResponse:
        """Record the cancellation."""
        calls["cancel"] = (optimization_id, user.username, worker)
        return JobCancelResponse(optimization_id=optimization_id, status="cancelled")

    monkeypatch.setattr(remote_mcp, "cancel_optimization", cancel)
    body = _payload(_call(client, "stop_run", {"optimization_id": "opt-1"}))
    assert body == {"optimization_id": "opt-1", "status": "cancelled"}
    assert calls["cancel"] == ("opt-1", USER, calls["worker"])
