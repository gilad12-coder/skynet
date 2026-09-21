"""Serve one task's simulated world as an MCP server plus a plain JSON API.

Run one server per (harness, task) attempt::

    python -m bench.server --task <task-id> --port 8765

* ``/mcp``      Streamable-HTTP MCP endpoint (Claude Code, Codex, opencode, DSPy).
* ``/__tools``  Tool specs as JSON (used by the Pi extension).
* ``/__call``   ``POST {"tool": ..., "args": {...}}`` runs a tool without MCP.
* ``/__state``  Final state, initial state and the call log, for grading.
"""

from __future__ import annotations

import argparse
import json
from typing import Any

import uvicorn
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError as McpToolError
from fastmcp.tools import Tool
from fastmcp.tools.tool import ToolResult
from starlette.requests import Request
from starlette.responses import JSONResponse

from bench.fixtures import base_state
from bench.task import Task, load_tasks
from bench.world import ToolError, World, load_handlers, tool_specs


def build_world(task: Task) -> World:
    """Create the world for ``task``: base fixture, wizard state, then task setup.

    Args:
        task: The task whose world to build.

    Returns:
        A world frozen at its pre-agent state.
    """
    load_handlers()
    world = World(base_state())
    world.s.setdefault("wizard", {}).update(task.wizard_state)
    if task.setup:
        task.setup(world)
    world.freeze_initial()
    return world


class WorldTool(Tool):
    """An MCP tool whose schema comes from ``tools.json`` and whose body is the world."""

    world: Any = None

    async def run(self, arguments: dict[str, Any]) -> ToolResult:
        """Dispatch the call into the world and return its JSON result.

        Args:
            arguments: Tool arguments from the agent.

        Returns:
            The tool result as text content holding JSON.

        Raises:
            McpToolError: When the world rejects the call.
        """
        try:
            result = self.world.call(self.name, arguments)
        except ToolError as exc:
            raise McpToolError(str(exc)) from exc
        return ToolResult(content=json.dumps(result, ensure_ascii=False))


def build_app(world: World) -> Any:
    """Return the ASGI app exposing ``world`` over MCP and the JSON side API.

    Args:
        world: The world to serve.

    Returns:
        A Starlette ASGI application.
    """
    mcp = FastMCP("Skynet")
    for spec in tool_specs():
        tool = WorldTool(name=spec["name"], description=spec["description"], parameters=spec["parameters"])
        tool.world = world
        mcp.add_tool(tool)

    @mcp.custom_route("/__tools", methods=["GET"])
    async def tools(_: Request) -> JSONResponse:
        """List the tool specs."""
        return JSONResponse(tool_specs())

    @mcp.custom_route("/__call", methods=["POST"])
    async def call(request: Request) -> JSONResponse:
        """Run one tool call outside MCP."""
        body = await request.json()
        try:
            return JSONResponse({"ok": True, "result": world.call(body["tool"], body.get("args") or {})})
        except ToolError as exc:
            return JSONResponse({"ok": False, "error": str(exc)})

    @mcp.custom_route("/__state", methods=["GET"])
    async def state(_: Request) -> JSONResponse:
        """Return the world snapshot for grading."""
        return JSONResponse(world.snapshot())

    return mcp.http_app(path="/mcp")


def main() -> None:
    """Parse arguments and serve one task's world until killed."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    world = build_world(load_tasks()[args.task])
    uvicorn.run(build_app(world), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
