"""Run the pinned upstream Best-of-N engine through Skynet's model transport."""

from __future__ import annotations

from gepa.oa.config import OptimizeAnythingConfig
from gepa.oa.engines.best_of_n import BestOfNEngine as UpstreamBestOfN

from ....exceptions import ServiceError
from .protocol import EngineContext, EvalServer, Result, Task
from .upstream import local_result, reflection_endpoint, upstream_server


class BestOfNEngine:
    """Adapt the upstream independent-sampling baseline without rewriting its loop."""

    name = "best_of_n"

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Run upstream sampling with the configured metered optimization model.

        Args:
            task: Starting point and optimization examples.
            server: Skynet scorer and budget.
            ctx: Configured model and artifact directory.

        Returns:
            The fully evaluated winner, or an unscored seed if no candidate completes.

        Raises:
            ServiceError: If given named components or a seedless run has no completed candidate.
        """
        if not task.str_mode:
            raise ServiceError("Best-of-N supports text starting points only.")
        upstream = upstream_server(task, server, ctx)
        with reflection_endpoint(ctx) as connection:
            engine = UpstreamBestOfN(
                OptimizeAnythingConfig(
                    engine=self.name,
                    max_evals=server.remaining,
                    stop_at_score=ctx.stop_at_score,
                    engine_config={"model": "openai/skynet-reflection", "lm_kwargs": connection},
                )
            )
            result = engine.run(upstream.task, upstream)
        engine.process_result(result, upstream.output_dir)
        adapted = local_result(result, server)
        if not any("score" in row for row in result.metadata.get("bon_cost_log", [])):
            if task.seed_candidate is None:
                raise ServiceError("Best-of-N stopped before producing a fully evaluated candidate.")
            adapted.best_score = None
        return adapted
