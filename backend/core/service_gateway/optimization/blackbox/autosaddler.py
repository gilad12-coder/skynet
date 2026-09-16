"""AutoSaddler engine: run the pinned upstream loop inside the managed sandbox.

Skynet does not reimplement AutoSaddler. The upstream ``microsoft/AutoSaddler``
v2 engine, run store, policies and Claude provider run unchanged in an isolated
sandbox; Skynet contributes only a scenario plugin (evaluator, evidence builder
and prompt pack in ``autosaddler_runner.py`` and ``autosaddler_plugin/``) and
scores every candidate through the parent-owned evaluator budget.
"""

from __future__ import annotations

from .native_runtime import run_native_engine
from .protocol import EngineContext, EvalServer, Result, Task


class AutoSaddlerEngine:
    """Delegate to the upstream AutoSaddler engine running in the sandbox."""

    name = "autosaddler"

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Run the pinned upstream engine with Skynet's evaluator and plugin.

        Args:
            task: Seed candidate, objective and visible examples.
            server: Skynet evaluator and shared evaluation budget.
            ctx: Run context carrying the native execution options.

        Returns:
            The best development-confirmed candidate upstream selected.
        """
        return run_native_engine(self.name, task, server, ctx)
