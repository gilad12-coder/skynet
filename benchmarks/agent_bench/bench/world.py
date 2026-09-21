"""In-memory simulation of the Skynet backend that the benchmark tools act on.

A ``World`` holds one task's state (jobs, datasets, wallet, wizard, memory, ...)
and dispatches tool calls to handler functions registered with :func:`tool`.
Every call is logged so a task's checks can inspect both what the agent did
and the state it left behind.
"""

from __future__ import annotations

import copy
import importlib
import json
import pkgutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

TOOLS_PATH = Path(__file__).resolve().parent.parent / "tools.json"

Handler = Callable[["World", dict[str, Any]], Any]

HANDLERS: dict[str, Handler] = {}
MUTATING: set[str] = set()


class ToolError(Exception):
    """A tool failure the agent sees as an error result (mirrors an HTTP error)."""

    def __init__(self, status: int, detail: str) -> None:
        """Store the HTTP-like status and the human-readable detail.

        Args:
            status: HTTP status code the real backend would have answered with.
            detail: Error message shown to the agent.
        """
        super().__init__(f"HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


def tool(name: str, *, mutates: bool = False) -> Callable[[Handler], Handler]:
    """Register ``fn`` as the handler for the tool called ``name``.

    Args:
        name: Exact tool name from ``tools.json``.
        mutates: True when the tool changes server-side state (jobs, wallet,
            memory, datasets). Wizard-patch and UI-card tools are NOT mutating.

    Returns:
        The decorator that records the handler.
    """

    def register(fn: Handler) -> Handler:
        HANDLERS[name] = fn
        if mutates:
            MUTATING.add(name)
        return fn

    return register


def load_handlers() -> None:
    """Import every module under ``bench.handlers`` so their tools register."""
    package = importlib.import_module("bench.handlers")
    for info in pkgutil.iter_modules(package.__path__):
        importlib.import_module(f"bench.handlers.{info.name}")


def tool_specs() -> list[dict[str, Any]]:
    """Return the tool specs (name, description, parameters) served to agents."""
    return json.loads(TOOLS_PATH.read_text())["tools"]


class World:
    """One task's simulated backend: state, call log, and tool dispatch."""

    def __init__(self, state: dict[str, Any]) -> None:
        """Deep-copy ``state`` so tasks never share mutations.

        Args:
            state: The starting state, normally ``fixtures.base_state()``.
        """
        self.s: dict[str, Any] = copy.deepcopy(state)
        self.calls: list[dict[str, Any]] = []
        self.initial: dict[str, Any] = {}

    def freeze_initial(self) -> None:
        """Snapshot the state after task setup, before the agent acts."""
        self.initial = copy.deepcopy(self.s)

    def call(self, name: str, args: dict[str, Any] | None = None) -> Any:
        """Run one tool call, log it, and merge any ``wizard_state`` patch.

        The real frontend merges ``result.wizard_state`` into the wizard after
        each tool call; the world does the same so later calls see it.

        Args:
            name: Tool name.
            args: Tool arguments as the agent sent them.

        Returns:
            The handler's JSON-serialisable result.

        Raises:
            ToolError: When the tool is unknown, a task-injected fault fires
                (``state["faults"][tool] = {"times": n, "status": ..., "detail": ...}``),
                or the handler rejects the call.
        """
        args = {k: v for k, v in (args or {}).items() if v is not None}
        record: dict[str, Any] = {"tool": name, "args": copy.deepcopy(args), "ok": False}
        self.calls.append(record)
        handler = HANDLERS.get(name)
        try:
            if handler is None:
                raise ToolError(404, f"Unknown tool: {name}")
            fault = self.s.get("faults", {}).get(name)
            if fault and fault.get("times", 0) > 0:
                fault["times"] -= 1
                raise ToolError(fault.get("status", 503), fault.get("detail", "Service temporarily unavailable"))
            result = handler(self, args)
        except ToolError as exc:
            record["error"] = str(exc)
            raise
        record["ok"] = True
        record["result"] = copy.deepcopy(result)
        if isinstance(result, dict) and isinstance(result.get("wizard_state"), dict):
            self.s.setdefault("wizard", {}).update(result["wizard_state"])
        return result

    def try_call(self, name: str, args: dict[str, Any] | None = None) -> Any:
        """Like :meth:`call` but return ``{"error": ...}`` instead of raising.

        Args:
            name: Tool name.
            args: Tool arguments.

        Returns:
            The result, or an error dict when the tool failed.
        """
        try:
            return self.call(name, args)
        except ToolError as exc:
            return {"error": str(exc)}

    def snapshot(self) -> dict[str, Any]:
        """Return the final state, the initial state and the call log as JSON data."""
        return {"state": self.s, "initial": self.initial, "calls": self.calls}
