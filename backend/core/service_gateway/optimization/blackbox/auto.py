"""Compose pinned upstream engines with the published omni and relay helpers."""

from __future__ import annotations

import itertools
import math
import threading
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import dspy
from gepa.oa.config import OptimizeAnythingConfig
from gepa.oa.engine import Result as UpstreamResult
from gepa.oa.ensemble import optimize_adaptive_sequential, optimize_best_of
from gepa.oa.eval_server import EvalServer as UpstreamEvalServer
from gepa.oa.task import Task as UpstreamTask

from ....constants import PROGRESS_LANE_COMPLETED, PROGRESS_LANE_HANDOFF, PROGRESS_LANE_STARTED
from ....exceptions import ServiceError
from ....models.blackbox import BlackboxStrategy
from ..cost_ceiling import CostCeilingExceededError
from .protocol import EngineContext, EvalServer, Result, Task
from .registry import NO_CAPABILITIES, EngineCapabilities, get_engine
from .upstream import AUTO_ENGINES, GEPA_SOURCE, local_result


@dataclass
class LaneOutcome:
    """Persist the outcome of one actual upstream invocation."""

    engine: str
    phase: str
    status: str
    best_score: float | None = None
    scorer_runs: int = 0
    error: str | None = None
    best_candidate: Any = None
    metadata: dict[str, Any] = field(default_factory=dict)


def _admit_context(ctx: EngineContext) -> EngineContext:
    """Bound a fresh invocation by cumulative spend already known to the worker.

    Args:
        ctx: Configured lane allowance and shared run accounting.

    Returns:
        A context with its proposer allowance clamped to the remaining run cap.

    Raises:
        CostCeilingExceededError: When another engine already spent the allowance.
    """
    if ctx.check_budget is not None:
        ctx.check_budget()
    if ctx.remaining_cost_usd is None:
        return ctx
    remaining = ctx.remaining_cost_usd()
    if remaining <= 0:
        raise CostCeilingExceededError("The run's total credit budget has been reached.")
    budget = min(ctx.proposer_token_budget_usd or remaining, remaining)
    native = (
        None
        if ctx.native_options is None
        else replace(ctx.native_options, max_token_cost=min(ctx.native_options.max_token_cost, remaining))
    )
    return replace(ctx, native_options=native, proposer_token_budget_usd=budget)


class _LaneEngine:
    """Adapt only scorer transport, execution location and progress for an engine."""

    def __init__(
        self,
        name: str,
        phase: str,
        ctx: EngineContext,
        caps: EngineCapabilities,
        lanes: list[LaneOutcome],
        progress_callback: Any,
        lane_ids: Any,
    ) -> None:
        """Bind platform resources before upstream schedules this engine.

        Args:
            name: Upstream engine identifier.
            phase: Product progress phase.
            ctx: Models, runtime and workspace.
            caps: Validated deployment capabilities.
            lanes: Shared result collector.
            progress_callback: Optional event sink.
            lane_ids: Run-wide sequence for trajectory identifiers.
        """
        self.name, self.phase, self.ctx = name, phase, ctx
        self.caps, self.lanes, self.progress_callback = caps, lanes, progress_callback
        self.model_context = dict(dspy.settings.copy())
        self.invocations = 0
        self.lane_ids = lane_ids
        self.lock = threading.Lock()

    def run(self, task: UpstreamTask, upstream: UpstreamEvalServer) -> UpstreamResult:
        """Invoke the selected upstream implementation under its assigned allowance.

        Args:
            task: Task supplied by the upstream composition, including its chosen seed.
            upstream: Upstream composition's evaluation server.

        Returns:
            An upstream result retaining the engine's aggregate score.
        """
        with self.lock:
            invocation = self.invocations
            self.invocations += 1
        lane_id = f"{self.phase}-{self.name}-{invocation}"
        lane_index = next(self.lane_ids)
        lane = LaneOutcome(self.name, self.phase, "completed")
        self.lanes.append(lane)
        callback = self.progress_callback
        if callback is not None:
            callback(
                PROGRESS_LANE_STARTED, {"engine": self.name, "phase": self.phase, "budget": upstream.budget.remaining}
            )

        def progress(event: str, metrics: dict[str, Any]) -> None:
            """Keep candidate identifiers distinct across parallel engines and relay slices.

            Args:
                event: Upstream/platform event name.
                metrics: Event payload.
            """
            if callback is not None:
                callback(event, {**metrics, "lane_index": lane_index})

        context = replace(self.ctx, run_dir=str(Path(self.ctx.run_dir) / lane_id), progress_callback=progress)
        server = EvalServer(upstream.evaluate, max_evals=upstream.budget.remaining or 0)
        local_task = Task(
            task.seed_candidate, task.objective, task.background, task.train_set or [], task.val_set or []
        )
        try:
            with dspy.context(**self.model_context):
                result = get_engine(self.name, self.caps).run(local_task, server, _admit_context(context))
                if context.check_budget is not None:
                    context.check_budget()
            lane.best_candidate, lane.best_score = result.best_candidate, result.best_score
            lane.metadata = result.metadata
            return UpstreamResult(
                best_candidate=result.best_candidate,
                best_score=result.best_score if result.best_score is not None else -math.inf,
                total_evals=server.used,
                metadata={**result.metadata, "engine": self.name, "phase": self.phase},
            )
        except Exception as exc:
            lane.status, lane.error = "failed", str(exc)
            raise
        finally:
            lane.scorer_runs = server.used
            if callback is not None:
                callback(
                    PROGRESS_LANE_COMPLETED,
                    {
                        "engine": self.name,
                        "phase": self.phase,
                        "status": lane.status,
                        "best_score": lane.best_score,
                        "scorer_runs": lane.scorer_runs,
                        "error": lane.error,
                    },
                )

    def process_result(self, result: UpstreamResult, output_dir: Path | None) -> None:
        """Leave artifact persistence to the engine's execution adapter.

        Args:
            result: Completed engine result.
            output_dir: Upstream composition artifact directory.
        """


def run_strategy(
    strategy: BlackboxStrategy,
    task: Task,
    server: EvalServer,
    ctx: EngineContext,
    progress_callback: Any = None,
    *,
    caps: EngineCapabilities = NO_CAPABILITIES,
) -> tuple[Result, list[LaneOutcome]]:
    """Invoke a single engine or the pinned upstream composition helpers.

    Args:
        strategy: Selected engine or composition.
        task: Optimization inputs without held-out test data.
        server: Run-wide scoring allowance and evidence collector.
        ctx: Model routing, runtime and artifact directory.
        progress_callback: Optional job event sink.
        caps: Validated runtime capabilities.

    Returns:
        The upstream-selected incumbent and observed engine invocations.

    Raises:
        ServiceError: If the exact recipe cannot run; never substitutes an engine.
    """
    lanes: list[LaneOutcome] = []
    lane_ids = itertools.count()
    if strategy.mode == "single":
        engine = get_engine(str(strategy.engine), caps)
        if progress_callback is not None:
            progress_callback(
                PROGRESS_LANE_STARTED, {"engine": engine.name, "phase": "single", "budget": server.remaining}
            )
        result = engine.run(task, server, _admit_context(ctx))
        if ctx.check_budget is not None:
            ctx.check_budget()
        result.metadata.update(engine=engine.name, upstream_source=GEPA_SOURCE)
        lanes.append(
            LaneOutcome(
                engine.name,
                "single",
                "completed",
                result.best_score,
                server.used,
                best_candidate=result.best_candidate,
                metadata=dict(result.metadata),
            )
        )
        if progress_callback is not None:
            progress_callback(
                PROGRESS_LANE_COMPLETED,
                {
                    "engine": engine.name,
                    "phase": "single",
                    "status": "completed",
                    "best_score": result.best_score,
                    "scorer_runs": server.used,
                },
            )
        return result, lanes

    if not task.str_mode:
        raise ServiceError(
            "The upstream Auto and Plateau recipes require a text starting point; use GEPA for named parts."
        )
    for name in AUTO_ENGINES:
        get_engine(name, caps)
    if strategy.mode == "auto" and server.remaining < 4:
        raise ServiceError("Auto needs at least four scorer runs: three exploration lanes and one continuation.")

    def configuration(name: str, phase: str, allowance: int, fraction: float) -> OptimizeAnythingConfig:
        """Partition resources while leaving scheduling and winner selection upstream.

        Args:
            name: Engine identifier.
            phase: Progress phase.
            allowance: Assigned evaluation calls.
            fraction: Share of the proposer cost ceiling.

        Returns:
            The upstream config with an execution adapter.
        """
        token_budget = None if ctx.proposer_token_budget_usd is None else ctx.proposer_token_budget_usd * fraction
        native = None if ctx.native_options is None else replace(ctx.native_options, max_token_cost=token_budget)
        context = replace(ctx, native_options=native, proposer_token_budget_usd=token_budget)
        return OptimizeAnythingConfig(
            engine=_LaneEngine(name, phase, context, caps, lanes, progress_callback, lane_ids),
            max_evals=allowance,
            max_token_cost=token_budget,
            max_concurrency=ctx.concurrency,
            output_dir=str(Path(ctx.run_dir) / f"{phase}-{name}-evals"),
        )

    kwargs = {
        "seed_candidate": task.seed_candidate,
        "evaluator": server.evaluate,
        "dataset": task.train_set or None,
        "valset": task.val_set or None,
        "objective": task.objective,
        "background": task.background,
        "name": Path(ctx.run_dir).name,
    }
    if strategy.mode == "plateau":
        result = optimize_adaptive_sequential(
            **kwargs,
            configs=[configuration(name, "relay", server.remaining, 1 / 3) for name in AUTO_ENGINES],
            plateau_evals=strategy.patience,
            max_evals=server.remaining,
            max_concurrency=ctx.concurrency,
            output_dir=str(Path(ctx.run_dir) / "relay-evals"),
        )
        return local_result(result, server), lanes

    per_lane = server.remaining // 4
    continuation_allowance = server.remaining - 3 * per_lane
    winner = optimize_best_of(
        **kwargs,
        configs=[configuration(name, "explore", per_lane, 0.25) for name in AUTO_ENGINES],
        max_workers=3,
    )
    if progress_callback is not None:
        progress_callback(
            PROGRESS_LANE_HANDOFF,
            {
                "from_engine": winner.metadata.get("engine"),
                "to_engine": "gepa",
                "best_score": winner.best_score,
            },
        )
    continuation_index = next(lane_ids)

    def continuation_progress(event: str, metrics: dict[str, Any]) -> None:
        """Scope GEPA's continuation trajectory separately from exploration.

        Args:
            event: Progress event name.
            metrics: Event payload.
        """
        if progress_callback is not None:
            progress_callback(event, {**metrics, "lane_index": continuation_index})

    continuation_ctx = replace(
        ctx,
        run_dir=str(Path(ctx.run_dir) / "continue-gepa"),
        progress_callback=continuation_progress,
        proposer_token_budget_usd=None
        if ctx.proposer_token_budget_usd is None
        else ctx.proposer_token_budget_usd * 0.25,
    )
    continuation_server = server.lane(min(continuation_allowance, server.remaining))
    if progress_callback is not None:
        progress_callback(
            PROGRESS_LANE_STARTED, {"engine": "gepa", "phase": "continue", "budget": continuation_server.remaining}
        )
    continued = get_engine("gepa", caps).run(
        replace(task, seed_candidate=winner.best_candidate), continuation_server, _admit_context(continuation_ctx)
    )
    if ctx.check_budget is not None:
        ctx.check_budget()
    lanes.append(
        LaneOutcome(
            "gepa",
            "continue",
            "completed",
            continued.best_score,
            continuation_server.used,
            best_candidate=continued.best_candidate,
            metadata=dict(continued.metadata),
        )
    )
    if progress_callback is not None:
        progress_callback(
            PROGRESS_LANE_COMPLETED,
            {
                "engine": "gepa",
                "phase": "continue",
                "status": "completed",
                "best_score": continued.best_score,
                "scorer_runs": continuation_server.used,
            },
        )
    continued.metadata.update(
        engine="gepa",
        phase="continue",
        upstream_source=GEPA_SOURCE,
        upstream_recipe="omni-gepa",
        explore_engine=winner.metadata.get("engine"),
    )
    continued.total_evals = server.used
    return continued, lanes
