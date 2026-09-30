"""Run Skynet's Deep Research engine in the native agent runtime."""

from __future__ import annotations

from .native_runtime import run_native_engine
from .protocol import EngineContext, EvalServer, Result, Task


class DeepResearchEngine:
    """Select the round-based Deep Research loop, which needs a coding-agent proposer."""

    name = "deep_research"

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Delegate the research loop to the selected execution runtime.

        Args:
            task: Optimization inputs.
            server: Skynet scorer and budget.
            ctx: Model routing, runtime and workspace.

        Returns:
            The best server-verified candidate and execution evidence.
        """
        return run_native_engine(self.name, task, server, ctx)
