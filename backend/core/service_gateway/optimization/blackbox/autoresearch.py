"""Run the pinned upstream AutoResearch engine in its native environment."""

from __future__ import annotations

from .native_runtime import run_native_engine
from .protocol import EngineContext, EvalServer, Result, Task


class AutoResearchEngine:
    """Select upstream AutoResearch without replacing its agentic research loop."""

    name = "autoresearch"

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Delegate the unchanged engine to the selected execution runtime.

        Args:
            task: Optimization inputs.
            server: Skynet scorer and budget.
            ctx: Model routing, runtime and workspace.

        Returns:
            The upstream aggregate incumbent and execution evidence.
        """
        return run_native_engine(self.name, task, server, ctx)
