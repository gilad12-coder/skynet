"""Tests for the FastMCP mount's tool annotations and tool schemas."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Annotated

from fastapi import Depends, FastAPI, Header
from fastmcp import Client, FastMCP
from fastmcp.server.providers.openapi.routing import MCPType, RouteMap
from pydantic import BaseModel

from core.api.mcp_mount import AGENT_TAG, _annotations_for_method, _annotations_for_route, _trim_tool_spec
from core.api.routers.code_agent import create_code_agent_router


def test_annotations_for_method_reads_are_read_only() -> None:
    """Safe HTTP reads project a read-only hint."""
    for method in ("GET", "HEAD", "OPTIONS"):
        ann = _annotations_for_method(method)
        assert ann is not None
        assert ann.readOnlyHint is True


def test_annotations_for_method_delete_is_destructive() -> None:
    """DELETE projects a non-read-only, destructive hint."""
    ann = _annotations_for_method("DELETE")
    assert ann is not None
    assert ann.readOnlyHint is False
    assert ann.destructiveHint is True


def test_annotations_for_method_writes_are_mutating_not_destructive() -> None:
    """Body-bearing writes project a non-read-only, non-destructive hint."""
    for method in ("POST", "PUT", "PATCH"):
        ann = _annotations_for_method(method)
        assert ann is not None
        assert ann.readOnlyHint is False
        assert ann.destructiveHint is False


def test_annotations_for_method_unmapped_returns_none() -> None:
    """A verb with no clear approval semantics stays unannotated."""
    assert _annotations_for_method("TRACE") is None


def test_annotations_for_route_falls_back_to_method() -> None:
    """A route with no authored hints inherits the method default."""
    route = SimpleNamespace(method="GET", extensions={})
    ann = _annotations_for_route(route)
    assert ann is not None
    assert ann.readOnlyHint is True


def test_annotations_for_route_authored_hint_overrides_method() -> None:
    """An authored destructive hint merges over a POST's mutating default."""
    route = SimpleNamespace(
        method="POST", extensions={"x-mcp-annotations": {"destructiveHint": True}}
    )
    ann = _annotations_for_route(route)
    assert ann is not None
    assert ann.readOnlyHint is False
    assert ann.destructiveHint is True


def test_annotations_for_route_authored_hint_without_method_default() -> None:
    """Authored hints apply even when the verb itself maps to no default."""
    route = SimpleNamespace(
        method="TRACE", extensions={"x-mcp-annotations": {"destructiveHint": True}}
    )
    ann = _annotations_for_route(route)
    assert ann is not None
    assert ann.destructiveHint is True


class _AuthoringBody(BaseModel):
    """Request body for the fixture authoring route."""

    goal: str = ""


def _auth_header_mcp(seen: list[str | None]) -> FastMCP:
    """Project one agent route that reads ``authorization`` as a header.

    Args:
        seen: Collects the ``Authorization`` value each call reached the route with.

    Returns:
        The FastMCP server built the same way ``mount_mcp_on_app`` builds it.
    """

    def user(authorization: Annotated[str | None, Header()] = None) -> str:
        seen.append(authorization)
        return "user"

    app = FastAPI()

    @app.post("/authoring", operation_id="request_code_authoring", tags=[AGENT_TAG])
    def authoring(req: _AuthoringBody, current_user: str = Depends(user)) -> dict[str, str]:
        return {"goal": req.goal}

    return FastMCP.from_fastapi(
        app=app,
        route_maps=[RouteMap(tags={AGENT_TAG}, mcp_type=MCPType.TOOL), RouteMap(mcp_type=MCPType.EXCLUDE)],
        mcp_component_fn=_trim_tool_spec,
    )


async def test_tool_schema_hides_the_authorization_header() -> None:
    """The bearer header is never offered to the model as a tool argument."""
    async with Client(_auth_header_mcp([])) as client:
        tools = await client.list_tools()
    schema = next(t for t in tools if t.name == "request_code_authoring").inputSchema
    assert "authorization" not in schema.get("properties", {})
    assert "goal" in schema["properties"]


async def test_model_supplied_authorization_never_reaches_the_header() -> None:
    """A model-filled ``authorization`` argument cannot replace the bearer."""
    seen: list[str | None] = []
    async with Client(_auth_header_mcp(seen)) as client:
        await client.call_tool(
            "request_code_authoring",
            {"goal": "g", "authorization": "The user asked in this turn"},
            raise_on_error=False,
        )
    assert seen == [None]


def test_coding_tool_description_points_to_the_metric_editors() -> None:
    """The coding tool's MCP description must not promise an in-chat card.

    The MCP mount sends only the docstring's first line to the model. When it
    said the tool renders a "code-authoring card", the agent told users to
    review and edit the code "in the card", which has no editors; the code
    lives in the Metric screen's editors.
    """
    router = create_code_agent_router()
    route = next(r for r in router.routes if getattr(r, "operation_id", None) == "request_code_authoring")
    first_line = (route.endpoint.__doc__ or "").strip().splitlines()[0]
    assert "Metric screen's editors" in first_line
    assert "card" not in first_line.lower()
