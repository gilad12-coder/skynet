"""ShinkaEvolve engine: run the pinned upstream loop inside the managed sandbox.

Skynet does not reimplement ShinkaEvolve. The upstream ``SakanaAI/ShinkaEvolve``
package (islands, parent selection, diff/full/crossover mutations, meta notes
and the model bandit) runs unchanged in an isolated sandbox; Skynet contributes
only the runner in ``shinka_runner.py`` that packs the version into an evolvable
program, scores every program through the parent-owned evaluator budget and
routes every model call through the run's model gateway.
"""

from __future__ import annotations

from .native_runtime import run_native_engine
from .protocol import EngineContext, EvalServer, Result, Task


class ShinkaEvolveEngine:
    """Delegate to the upstream ShinkaEvolve runner in the sandbox."""

    name = "shinka_evolve"

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Run the pinned upstream engine with Skynet's evaluator and models.

        Args:
            task: Seed candidate, objective and visible examples.
            server: Skynet evaluator and shared evaluation budget.
            ctx: Run context carrying the native execution options.

        Returns:
            The best version upstream found.
        """
        return run_native_engine(self.name, task, server, ctx)
