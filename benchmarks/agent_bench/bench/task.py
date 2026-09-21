"""Task and check definitions for the agent benchmark."""

from __future__ import annotations

import importlib
import pkgutil
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from bench.world import World


@dataclass
class Run:
    """What one agent attempt produced, as seen by a task's checks."""

    state: dict[str, Any]
    initial: dict[str, Any]
    calls: list[dict[str, Any]]
    answer: str

    def ok_calls(self, tool: str | None = None) -> list[dict[str, Any]]:
        """Return the successful calls, optionally only those to ``tool``."""
        return [c for c in self.calls if c["ok"] and (tool is None or c["tool"] == tool)]


@dataclass
class Check:
    """One named pass/fail assertion about a :class:`Run`."""

    name: str
    fn: Callable[[Run], bool]


@dataclass
class Task:
    """One benchmark task: a user request, a world setup, checks and an oracle."""

    id: str
    category: str
    difficulty: str
    prompt: str
    checks: list[Check]
    oracle: Callable[[World], str]
    setup: Callable[[World], None] | None = None
    wizard_state: dict[str, Any] = field(default_factory=dict)
    history: list[tuple[str, str]] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    notes: str = ""


def load_tasks() -> dict[str, Task]:
    """Import every module under ``bench.tasks`` and collect their ``TASKS`` lists.

    Returns:
        Tasks keyed by id, in module then list order.

    Raises:
        ValueError: When two tasks share an id.
    """
    package = importlib.import_module("bench.tasks")
    tasks: dict[str, Task] = {}
    for info in sorted(pkgutil.iter_modules(package.__path__), key=lambda i: i.name):
        module = importlib.import_module(f"bench.tasks.{info.name}")
        for task in getattr(module, "TASKS", []):
            if task.id in tasks:
                raise ValueError(f"duplicate task id: {task.id}")
            tasks[task.id] = task
    return tasks


def grade(task: Task, run: Run) -> dict[str, Any]:
    """Evaluate every check of ``task`` against ``run``.

    A check that raises counts as failed, so a malformed agent answer can
    never crash the grader.

    Args:
        task: The task being graded.
        run: The agent attempt.

    Returns:
        ``{"score": fraction passed, "passed": all passed, "checks": {name: bool}}``.
    """
    outcome: dict[str, bool] = {}
    for check in task.checks:
        try:
            outcome[check.name] = bool(check.fn(run))
        except Exception:
            outcome[check.name] = False
    total = len(outcome) or 1
    return {
        "score": sum(outcome.values()) / total,
        "passed": all(outcome.values()) and bool(outcome),
        "checks": outcome,
    }
