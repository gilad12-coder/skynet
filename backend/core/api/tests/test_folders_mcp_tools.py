"""Tests for the folder and run tools that the MCP server exposes.

Covers which folder routes become MCP tools, the compact organize listing
(ownership, filters, empty states, folder names the caller may not see), the
``reuse_existing`` retry-safe create, and a bulk move driven through the MCP
client end to end.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastmcp import Client, FastMCP
from fastmcp.server.providers.openapi.routing import MCPType, RouteMap
from sqlalchemy.orm import Session

from ...storage.models import JobModel
from ..auth import AuthenticatedUser, get_authenticated_user
from ..mcp_mount import AGENT_TAG, _trim_tool_spec
from ..routers.folders import create_folders_router
from .test_folders_router import _MemStore

_EXPECTED_TOOLS = {
    "list_folders",
    "create_folder",
    "update_folder",
    "delete_folder",
    "move_folder",
    "list_folder_runs",
    "move_runs_to_folder",
    "list_runs_for_organizing",
}


def _seed(
    store: _MemStore,
    optimization_id: str,
    *,
    username: str = "alice",
    name: str | None = None,
    description: str = "",
    dataset: str | None = None,
    model: str | None = None,
    status: str = "success",
    age_minutes: int = 0,
) -> None:
    """Insert a job with the overview fields the organize listing reads.

    Args:
        store: The in-memory store to seed into.
        optimization_id: Optimization id for the job.
        username: Owner username.
        name: Run name (defaults to the id).
        description: Task description.
        dataset: Dataset filename.
        model: Model name.
        status: Job status.
        age_minutes: How long ago the job was created.
    """
    overview = {
        "optimization_type": "run",
        "name": name or optimization_id,
        "username": username,
        "description": description,
        "dataset_filename": dataset,
        "model_name": model,
    }
    created = datetime.now(UTC) - timedelta(minutes=age_minutes)
    with Session(store.engine) as session:
        session.add(
            JobModel(
                optimization_id=optimization_id,
                status=status,
                created_at=created,
                completed_at=created,
                latest_metrics={},
                result=None,
                payload_overview=overview,
                payload={"username": username},
                username=username,
            )
        )
        session.commit()


def _app(store: _MemStore, user: str = "alice") -> FastAPI:
    """Build an app with only the folders router, authenticated as ``user``.

    Args:
        store: Job store wired into the router factory.
        user: Username to authenticate as.

    Returns:
        The FastAPI app.
    """
    app = FastAPI()
    app.include_router(create_folders_router(job_store=store))
    identity = AuthenticatedUser(username=user, role="user", groups=())
    app.dependency_overrides[get_authenticated_user] = lambda: identity
    return app


def _client(store: _MemStore, user: str = "alice") -> TestClient:
    """Build a REST client over the folders router.

    Args:
        store: Job store wired into the router factory.
        user: Username to authenticate as.

    Returns:
        A ``TestClient``.
    """
    return TestClient(_app(store, user), raise_server_exceptions=False)


def _mcp(store: _MemStore, user: str = "alice") -> FastMCP:
    """Project the folders router into MCP the way ``mount_mcp_on_app`` does.

    Args:
        store: Job store wired into the router factory.
        user: Username to authenticate as.

    Returns:
        The FastMCP server.
    """
    return FastMCP.from_fastapi(
        app=_app(store, user),
        route_maps=[RouteMap(tags={AGENT_TAG}, mcp_type=MCPType.TOOL), RouteMap(mcp_type=MCPType.EXCLUDE)],
        mcp_component_fn=_trim_tool_spec,
    )


def _tool_json(result) -> dict:
    """Decode the JSON body of an MCP tool result.

    Args:
        result: The ``CallToolResult`` from the client.

    Returns:
        The decoded body.
    """
    return json.loads(result.content[0].text)


async def test_folder_tree_and_filing_routes_are_mcp_tools_but_sharing_is_not() -> None:
    """The organize tools are listed with stable names; sharing stays REST-only."""
    async with Client(_mcp(_MemStore())) as client:
        tools = {t.name: t for t in await client.list_tools()}
    assert set(tools) >= _EXPECTED_TOOLS
    assert not [name for name in tools if "sharing" in name or "claim" in name or "transfer" in name]
    assert tools["delete_folder"].annotations.destructiveHint is True
    assert tools["list_runs_for_organizing"].annotations.readOnlyHint is True
    assert "authorization" not in tools["move_runs_to_folder"].inputSchema.get("properties", {})


def test_organize_listing_empty_state_is_explicit() -> None:
    """A caller with no runs gets zero counts and a hint, not a bare empty list."""
    body = _client(_MemStore()).get("/folders/runs").json()
    assert body["items"] == []
    assert body["total_runs"] == 0
    assert body["matched"] == 0
    assert body["next_offset"] is None
    assert body["hint"].startswith("0 runs")


def test_organize_listing_shows_only_own_runs_with_compact_fields() -> None:
    """Other users' runs never appear, and each item carries the organize fields."""
    store = _MemStore()
    _seed(store, "a1", description="Classify support tickets", dataset="tickets.csv", model="gpt-x")
    _seed(store, "b1", username="bob")
    body = _client(store).get("/folders/runs").json()
    assert [item["optimization_id"] for item in body["items"]] == ["a1"]
    item = body["items"][0]
    assert set(item) == {
        "optimization_id",
        "name",
        "task",
        "dataset",
        "model",
        "status",
        "folder_id",
        "folder",
        "created_at",
    }
    assert item["task"] == "Classify support tickets"
    assert item["dataset"] == "tickets.csv"
    assert item["model"] == "gpt-x"
    assert item["folder_id"] is None


def test_organize_listing_truncates_long_tasks() -> None:
    """A long task description is cut so the listing stays compact."""
    store = _MemStore()
    _seed(store, "a1", description="x" * 500)
    task = _client(store).get("/folders/runs").json()["items"][0]["task"]
    assert len(task) <= 160
    assert task.endswith("…")


def test_organize_listing_search_unfiled_and_status_filters() -> None:
    """``q``, ``unfiled_only`` and ``status`` narrow the matches but not the totals."""
    store = _MemStore()
    _seed(store, "a1", description="Summarize legal contracts", age_minutes=3)
    _seed(store, "a2", dataset="contracts_v2.csv", age_minutes=2)
    _seed(store, "a3", description="Translate menus", status="failed", age_minutes=1)
    alice = _client(store)
    folder_id = alice.post("/folders", json={"name": "Legal"}).json()["id"]
    alice.post("/folders/items", json={"optimization_ids": ["a1"], "folder_id": folder_id})

    contracts = alice.get("/folders/runs", params={"q": "CONTRACT"}).json()
    assert [i["optimization_id"] for i in contracts["items"]] == ["a2", "a1"]
    assert contracts["total_runs"] == 3
    assert contracts["unfiled_runs"] == 2
    assert contracts["matched"] == 2

    by_folder = alice.get("/folders/runs", params={"q": "legal"}).json()
    assert [i["optimization_id"] for i in by_folder["items"]] == ["a1"]
    assert by_folder["items"][0]["folder"] == "Legal"

    unfiled = alice.get("/folders/runs", params={"unfiled_only": "true"}).json()
    assert [i["optimization_id"] for i in unfiled["items"]] == ["a3", "a2"]

    failed = alice.get("/folders/runs", params={"status": "failed"}).json()
    assert [i["optimization_id"] for i in failed["items"]] == ["a3"]

    none = alice.get("/folders/runs", params={"q": "nothing-like-this"}).json()
    assert none["items"] == []
    assert none["hint"].startswith("0 runs match")


def test_organize_listing_rejects_unknown_status() -> None:
    """An unknown status is a structured 422, not an empty page."""
    resp = _client(_MemStore()).get("/folders/runs", params={"status": "bogus"})
    assert resp.status_code == 422


def test_organize_listing_paginates_with_next_offset() -> None:
    """``next_offset`` walks the matches and is null on the last page."""
    store = _MemStore()
    for n in range(5):
        _seed(store, f"a{n}", age_minutes=n)
    alice = _client(store)
    first = alice.get("/folders/runs", params={"limit": 2}).json()
    assert [i["optimization_id"] for i in first["items"]] == ["a0", "a1"]
    assert first["next_offset"] == 2
    last = alice.get("/folders/runs", params={"limit": 2, "offset": 4}).json()
    assert [i["optimization_id"] for i in last["items"]] == ["a4"]
    assert last["next_offset"] is None


def test_organize_listing_hides_names_of_folders_the_caller_cannot_see() -> None:
    """A run filed in someone else's folder keeps its id but not the folder name."""
    store = _MemStore()
    _seed(store, "a1")
    bob = _client(store, "bob")
    secret = bob.post("/folders", json={"name": "Bob private"}).json()["id"]
    bob.post(f"/folders/{secret}/sharing/members", json={"username": "alice", "role": "editor"})
    alice = _client(store)
    assert alice.post("/folders/items", json={"optimization_ids": ["a1"], "folder_id": secret}).status_code == 200
    bob.delete(f"/folders/{secret}/sharing/members/alice")

    item = alice.get("/folders/runs").json()["items"][0]
    assert item["folder_id"] == secret
    assert item["folder"] is None


def test_create_folder_reuse_existing_is_retry_safe() -> None:
    """With ``reuse_existing`` a repeat create returns the same folder with 200."""
    store = _MemStore()
    alice = _client(store)
    first = alice.post("/folders", json={"name": "Legal", "reuse_existing": True})
    again = alice.post("/folders", json={"name": "  legal ", "reuse_existing": True})
    assert first.status_code == 201
    assert again.status_code == 200
    assert again.json()["id"] == first.json()["id"]
    assert len(alice.get("/folders").json()["folders"]) == 1


def test_create_folder_reuse_existing_respects_parent_and_owner() -> None:
    """Reuse matches only the caller's own folder under the same parent."""
    store = _MemStore()
    alice = _client(store)
    bob = _client(store, "bob")
    bob_folder = bob.post("/folders", json={"name": "Legal"}).json()["id"]
    top = alice.post("/folders", json={"name": "Legal", "reuse_existing": True}).json()["id"]
    child = alice.post("/folders", json={"name": "Legal", "parent_id": top, "reuse_existing": True}).json()["id"]
    assert len({bob_folder, top, child}) == 3


def test_create_folder_without_reuse_still_allows_duplicates() -> None:
    """The default keeps the UI's Drive-like behavior of allowing two same-named folders."""
    store = _MemStore()
    alice = _client(store)
    assert alice.post("/folders", json={"name": "Legal"}).status_code == 201
    assert alice.post("/folders", json={"name": "Legal"}).status_code == 201
    assert len(alice.get("/folders").json()["folders"]) == 2


async def test_agent_groups_runs_through_mcp_tools() -> None:
    """An agent creates a folder, bulk-moves runs, and sees the result, all over MCP."""
    store = _MemStore()
    _seed(store, "a1", description="Legal contracts A")
    _seed(store, "a2", description="Legal contracts B")
    _seed(store, "b1", username="bob")
    async with Client(_mcp(store)) as client:
        folder = _tool_json(await client.call_tool("create_folder", {"name": "Legal", "reuse_existing": True}))
        retry = _tool_json(await client.call_tool("create_folder", {"name": "Legal", "reuse_existing": True}))
        assert retry["id"] == folder["id"]

        moved = _tool_json(
            await client.call_tool(
                "move_runs_to_folder",
                {"optimization_ids": ["a1", "a2", "b1", "missing"], "folder_id": folder["id"]},
            )
        )
        assert moved["updated"] == ["a1", "a2"]
        assert {s["optimization_id"]: s["reason"] for s in moved["skipped"]} == {
            "b1": "forbidden",
            "missing": "not_found",
        }

        again = _tool_json(
            await client.call_tool("move_runs_to_folder", {"optimization_ids": ["a1", "a2"], "folder_id": folder["id"]})
        )
        assert again["updated"] == ["a1", "a2"]

        folders = _tool_json(await client.call_tool("list_folders", {}))
        assert folders["folders"][0]["run_count"] == 2

        listing = _tool_json(await client.call_tool("list_runs_for_organizing", {}))
        assert listing["unfiled_runs"] == 0
        assert {i["folder"] for i in listing["items"]} == {"Legal"}

        inside = _tool_json(await client.call_tool("list_folder_runs", {"folder_id": folder["id"]}))
        assert {i["optimization_id"] for i in inside["items"]} == {"a1", "a2"}

        renamed = _tool_json(await client.call_tool("update_folder", {"folder_id": folder["id"], "name": "Contracts"}))
        assert renamed["name"] == "Contracts"

        deleted = _tool_json(await client.call_tool("delete_folder", {"folder_id": folder["id"]}))
        assert deleted["deleted"] == [folder["id"]]
        after = _tool_json(await client.call_tool("list_runs_for_organizing", {}))
        assert after["unfiled_runs"] == 2


async def test_mcp_tools_enforce_folder_ownership() -> None:
    """Another user's private folder is invisible and cannot be renamed or filled over MCP."""
    store = _MemStore()
    _seed(store, "a1")
    bob_folder = _client(store, "bob").post("/folders", json={"name": "Bob"}).json()["id"]
    async with Client(_mcp(store)) as client:
        assert _tool_json(await client.call_tool("list_folders", {}))["folders"] == []
        rename = await client.call_tool(
            "update_folder", {"folder_id": bob_folder, "name": "Mine now"}, raise_on_error=False
        )
        assert rename.is_error
        move = await client.call_tool(
            "move_runs_to_folder", {"optimization_ids": ["a1"], "folder_id": bob_folder}, raise_on_error=False
        )
        assert move.is_error
    assert _client(store, "bob").get("/folders").json()["folders"][0]["name"] == "Bob"
