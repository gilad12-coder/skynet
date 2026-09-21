"""Sanity-check every task: the oracle must pass, a do-nothing agent must not.

python -m bench.validate [task-id-prefix]
"""

from __future__ import annotations

import sys

from bench.server import build_world
from bench.task import Run, grade, load_tasks
from bench.world import HANDLERS, tool_specs


def main() -> int:
    """Validate handlers and tasks; return a process exit code."""
    prefix = sys.argv[1] if len(sys.argv) > 1 else ""
    tasks = {k: v for k, v in load_tasks().items() if k.startswith(prefix)}
    failures = 0
    probe = build_world(next(iter(tasks.values()))) if tasks else None
    missing = [s["name"] for s in tool_specs() if s["name"] not in HANDLERS]
    if probe is not None and missing:
        print(f"WARN {len(missing)} tools have no handler: {missing}")
    for task in tasks.values():
        world = build_world(task)
        try:
            answer = task.oracle(world)
        except Exception as exc:
            print(f"FAIL {task.id}: oracle raised {exc!r}")
            failures += 1
            continue
        snap = world.snapshot()
        result = grade(task, Run(snap["state"], snap["initial"], snap["calls"], answer))
        null_world = build_world(task).snapshot()
        null = grade(task, Run(null_world["state"], null_world["initial"], [], ""))
        bad = [n for n, ok in result["checks"].items() if not ok]
        if bad:
            print(f"FAIL {task.id}: oracle fails checks {bad}")
            failures += 1
        elif null["passed"] or null["score"] > 0.5:
            print(f"FAIL {task.id}: do-nothing agent scores {null['score']:.2f}")
            failures += 1
        else:
            print(
                f"ok   {task.id} [{task.category}/{task.difficulty}] checks={len(task.checks)} null={null['score']:.2f}"
            )
    print(f"{len(tasks)} tasks, {failures} failing")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
