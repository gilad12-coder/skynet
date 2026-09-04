"""GEPA engine: runs ``gepa.optimize_anything`` against the eval server.

Overlays only what Skynet owns — the scorer budget, the per-lane workspace,
the job-log logger and the stop-at-score stopper — on GEPA's defaults; the
eval server is the single scoring path, exactly like upstream ``gepa.oa``.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from gepa.core.result import GEPAResult
from gepa.core.state import GEPAState
from gepa.gepa_launcher import EngineConfig, GEPAConfig, ReflectionConfig, TrackingConfig, optimize_anything
from gepa.utils.stop_condition import ScoreThresholdStopper

from ....constants import OPTIMIZER_NAME_GEPA
from ....exceptions import ServiceError
from ..trajectory import capture_proposal_prompts, trajectory_watch
from .feedback import STR_CANDIDATE_KEY, emit_scorer_feedback
from .protocol import BudgetExhaustedError, Candidate, EngineContext, EvalServer, Result, Task
from .upstream import GEPA_SOURCE

logger = logging.getLogger(__name__)


class _JobLogger:
    """GEPA ``LoggerProtocol`` adapter that writes into the job log."""

    def log(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Forward one GEPA log line to the job logger.

        Args:
            message: The line GEPA wants logged.
            *args: Ignored; kept for protocol tolerance.
            **kwargs: Ignored; kept for protocol tolerance.
        """
        logger.info("%s", message)


class GepaEngine:
    """Reflective prompt-evolution engine backed by ``optimize_anything``."""

    name = "gepa"

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Optimize ``task`` with GEPA, scoring only through ``server``.

        Args:
            task: The starting point, goal and cases.
            server: The budgeted scorer for this lane.
            ctx: Reflection LM, workspace and stop settings.

        Returns:
            GEPA's validation-best version, or the server's best when the
            budget ran out before GEPA could report.
        """
        if server.remaining <= 0:
            return Result(best_candidate=task.seed_candidate or "", best_score=None, total_evals=0)
        run_dir = str(Path(ctx.run_dir) / self.name)
        Path(run_dir).mkdir(parents=True, exist_ok=True)
        config = GEPAConfig(
            engine=EngineConfig(
                run_dir=run_dir,
                seed=ctx.seed,
                max_metric_calls=server.remaining,
                max_reflection_cost=ctx.proposer_token_budget_usd,
                # Scorers may be user code or a remote endpoint with no
                # concurrency guarantees, and a serial loop keeps the budget
                # accounting exact.
                parallel=False,
                display_progress_bar=False,
            ),
            reflection=ReflectionConfig(reflection_lm=_LaneReflection(ctx.reflection_lm, ctx.check_budget)),
            tracking=TrackingConfig(logger=_JobLogger()),
            stop_callbacks=[ScoreThresholdStopper(ctx.stop_at_score)] if ctx.stop_at_score is not None else None,
        )

        # GEPA hands the dataset rows back by identity and keys each candidate's
        # per-case scores by the case's index in the validation set (the train
        # set when no val set was given). Feedback carries that same index so
        # the tree drawer can pair the scorer's notes with a case's score cell;
        # train-only cases follow after the validation ones.
        validation_set = task.val_set or task.train_set
        example_ids: dict[int, str] = {}
        for index, example in enumerate([*validation_set, *task.train_set]):
            example_ids.setdefault(id(example), str(index))

        def evaluator(candidate: Candidate, example: Any = None) -> tuple[float, dict[str, Any]]:
            """Route one GEPA evaluation through the budgeted server and report its feedback.

            Args:
                candidate: The version GEPA wants scored.
                example: The case, or ``None`` in single-task mode.

            Returns:
                The score and side information.
            """
            if ctx.check_budget is not None:
                ctx.check_budget()
            score, side_info = server.evaluate(candidate, example)
            if ctx.check_budget is not None:
                ctx.check_budget()
            emit_scorer_feedback(
                ctx.progress_callback,
                example_id=example_ids.get(id(example), "?"),
                score=score,
                side_info=side_info,
            )
            return score, side_info

        kwargs: dict[str, Any] = {"seed_candidate": task.seed_candidate, "evaluator": evaluator, "config": config}
        if task.train_set:
            kwargs["dataset"] = task.train_set
        if task.val_set:
            kwargs["valset"] = task.val_set
        if task.objective:
            kwargs["objective"] = task.objective
        if task.background:
            kwargs["background"] = task.background

        # The watcher tails run_dir/gepa_state.bin and forwards each accepted
        # candidate as a live progress event — the same channel DSPy runs
        # stream their trajectory tree through. The proposal capture pins
        # scorer feedback to the iteration that asked for it and snapshots
        # rejected proposals' text, again exactly as the DSPy path does.
        with capture_proposal_prompts(OPTIMIZER_NAME_GEPA), trajectory_watch(run_dir, ctx.progress_callback):
            try:
                gepa_result: GEPAResult[Any, Any] | None = optimize_anything(**kwargs)
            except BudgetExhaustedError:
                gepa_result = _load_result_from_state(run_dir, seed=ctx.seed, str_mode=task.str_mode)

        if gepa_result is None:
            if task.seed_candidate is None:
                raise ServiceError("GEPA stopped before producing a fully evaluated candidate.")
            return Result(best_candidate=task.seed_candidate, best_score=None, total_evals=server.used)

        best: Any = gepa_result.best_candidate
        if isinstance(best, dict) and task.str_mode:
            best = next(iter(best.values()), "")
        return Result(
            best_candidate=best,
            best_score=float(gepa_result.val_aggregate_scores[gepa_result.best_idx]),
            total_evals=server.used,
            metadata={
                "upstream_source": GEPA_SOURCE,
                "candidates": len(gepa_result.candidates),
                "gepa_metric_calls": gepa_result.total_metric_calls,
                "candidate_tree": _candidate_tree(gepa_result, str_mode=task.str_mode),
            },
        )


class _LaneReflection:
    """Expose only this invocation's measured spend to upstream's cost stopper."""

    def __init__(self, reflection_lm: Any, check_budget: Any = None) -> None:
        """Record the shared model's starting cost.

        Args:
            reflection_lm: Metered model callable.
            check_budget: Direct run-wide guard outside DSPy's callback wrapper.
        """
        self.reflection_lm = reflection_lm
        self.check_budget = check_budget
        self.starting_cost = float(getattr(reflection_lm, "total_cost", 0.0))

    @property
    def total_cost(self) -> float:
        """Return measured cost since this lane started."""
        return float(getattr(self.reflection_lm, "total_cost", 0.0)) - self.starting_cost

    def __call__(self, prompt: Any) -> str:
        """Forward an upstream prompt to the selected metered model.

        Args:
            prompt: Text or multimodal messages.

        Returns:
            Model completion text.
        """
        if self.check_budget is not None:
            self.check_budget()
        result = self.reflection_lm(prompt)
        if self.check_budget is not None:
            self.check_budget()
        return result


def _candidate_tree(gepa_result: GEPAResult[Any, Any], *, str_mode: bool) -> list[dict[str, Any]]:
    """Flatten GEPA's lineage into JSON-safe nodes for the run result.

    Args:
        gepa_result: The finished (or state-recovered) result.
        str_mode: Whether candidates unwrap to plain text.

    Returns:
        One node per candidate, in discovery order: the candidate, the
        indices of the parents it was mutated from (``None`` for the seed),
        its mean validation score and the metric-call count at discovery.
    """
    nodes: list[dict[str, Any]] = []
    for index, candidate in enumerate(gepa_result.candidates):
        unwrapped: Any = candidate
        if str_mode and isinstance(unwrapped, dict):
            unwrapped = next(iter(unwrapped.values()), "")
        score = gepa_result.val_aggregate_scores[index]
        nodes.append(
            {
                "candidate": unwrapped,
                "parents": [None if parent is None else int(parent) for parent in gepa_result.parents[index]],
                "val_score": None if score is None else float(score),
                "discovery_evals": int(gepa_result.discovery_eval_counts[index]),
            }
        )
    return nodes


def _load_result_from_state(run_dir: str, *, seed: int, str_mode: bool) -> GEPAResult[Any, Any] | None:
    """Rebuild GEPA's result from the state it checkpointed before the budget ran out.

    Args:
        run_dir: Workspace holding ``gepa_state.bin``.
        seed: RNG seed the run used.
        str_mode: Whether candidates were plain text.

    Returns:
        The reconstructed result, or ``None`` when no usable state exists.
    """
    try:
        state = GEPAState.load(run_dir)
        return GEPAResult.from_state(
            state,
            run_dir=run_dir,
            seed=seed,
            str_candidate_key=STR_CANDIDATE_KEY if str_mode else None,
        )
    except Exception as exc:
        logger.info("no GEPA state to recover after budget exhaustion: %s", exc)
        return None
