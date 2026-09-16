"""Run the pinned upstream Best-of-N engine through Skynet's model transport."""

from __future__ import annotations

import math
from typing import Any

from gepa.oa.config import OptimizeAnythingConfig
from gepa.oa.engines.best_of_n import BestOfNEngine as UpstreamBestOfN

from ....exceptions import ServiceError
from ..budget_stop import BudgetReached
from .feedback import emit_candidate
from .protocol import EngineContext, EvalServer, Result, Task
from .upstream import local_result, reflection_endpoint, upstream_server


class _SampleStream:
    """Announce each fully scored sample as a root of the run's candidate tree.

    Upstream scores the samples one after another, one scorer run per case,
    so consecutive runs group into samples by count alone; a sample cut short
    by the budget never completes its group and stays out of the tree.
    """

    def __init__(self, task: Task, server: EvalServer, ctx: EngineContext) -> None:
        """Bind the stream to the cases upstream scores samples on.

        Args:
            task: Optimization inputs; upstream uses the train set, else the val set.
            server: Run accounting, for the scorer runs spent per sample.
            ctx: The job's progress sink.
        """
        cases = task.train_set or task.val_set or []
        self._case_ids = {id(example): str(index) for index, example in enumerate(cases)}
        self._per_sample = max(1, len(cases))
        self._server = server
        self._sink = ctx.progress_callback
        self._samples = 0
        self._seen = 0
        self._scores: list[tuple[str, float]] = []

    def __call__(self, candidate: Any, example: Any, score: float) -> None:
        """Record one scored case, announcing the sample once its last case is in.

        Args:
            candidate: The sample being scored.
            example: The case scored, ``None`` in single-task mode.
            score: The case's score.
        """
        self._seen += 1
        if isinstance(score, float | int) and math.isfinite(score):
            self._scores.append((self._case_ids.get(id(example), "?"), float(score)))
        if self._seen < self._per_sample:
            return
        scores, self._scores, self._seen = self._scores, [], 0
        sample, self._samples = self._samples, self._samples + 1
        if not scores:
            return
        emit_candidate(
            self._sink,
            candidate_id=str(sample),
            parent_id=None,
            generation=0,
            score=sum(value for _, value in scores) / len(scores),
            per_example=[] if example is None else scores,
            candidate=candidate,
            discovered_at_evals=self._server.used,
            iteration=sample,
        )


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
        upstream = upstream_server(task, server, ctx, on_eval=_SampleStream(task, server, ctx))
        result = None
        budget_stop = None
        try:
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
        except BudgetReached as exc:
            budget_stop = exc
        if budget_stop is None:
            budget_stop = next(iter(getattr(upstream, "platform_budget_stops", [])), None)
        if result is None:
            if budget_stop is not None:
                raise budget_stop
            raise ServiceError("Best-of-N did not produce a result.")
        engine.process_result(result, upstream.output_dir)
        adapted = local_result(result, server)
        evaluated = any("score" in row for row in result.metadata.get("bon_cost_log", []))
        if budget_stop is not None:
            if evaluated:
                budget_stop.result = adapted
                budget_stop.evidence.update(
                    selection_scope="training",
                    final_evaluation_completed=False,
                    final_evaluation_reason="budget_reached",
                )
            raise budget_stop
        if not evaluated:
            if task.seed_candidate is None:
                raise ServiceError("Best-of-N stopped before producing a fully evaluated candidate.")
            adapted.best_score = None
        return adapted
