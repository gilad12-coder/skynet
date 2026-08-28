"""Strategy layer: ``single`` runs one engine; ``auto`` explores, then continues.

Auto mirrors GEPA's *omni* recipe: every available engine gets an equal
slice of the explore budget, the best explore result is handed to GEPA,
and GEPA spends what remains continuing from it. Each lane emits
``lane_started`` / ``lane_completed`` events and the hand-off emits
``lane_handoff`` so the run page can render the lane table.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from ....constants import PROGRESS_LANE_COMPLETED, PROGRESS_LANE_HANDOFF, PROGRESS_LANE_STARTED
from ....exceptions import ServiceError
from ....models.blackbox import BLACKBOX_ENGINE_GEPA, BlackboxStrategy
from ..cost_ceiling import CostCeilingExceededError
from .protocol import BudgetExhaustedError, Candidate, EngineContext, EvalServer, Result, Task
from .registry import available_engine_ids, get_engine

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[str, dict[str, Any]], None]

# Share of the budget spent exploring; the rest continues from the winner.
_EXPLORE_SHARE = 0.75


@dataclass
class LaneOutcome:
    """What one engine lane produced, in the shape the result persists."""

    engine: str
    phase: str
    status: str
    best_score: float | None = None
    scorer_runs: int = 0
    error: str | None = None
    best_candidate: Candidate | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


def _emit(progress_callback: ProgressCallback | None, event: str, metrics: dict[str, Any]) -> None:
    """Send one progress event when a callback is attached.

    Args:
        progress_callback: The job's progress sink, if any.
        event: Event name.
        metrics: Event payload.
    """
    if progress_callback is not None:
        progress_callback(event, metrics)


def run_lane(
    engine_id: str,
    phase: str,
    task: Task,
    server: EvalServer,
    ctx: EngineContext,
    progress_callback: ProgressCallback | None = None,
) -> LaneOutcome:
    """Run one engine on its own budget slice, never letting it kill the run.

    Args:
        engine_id: Catalog id of the engine.
        phase: ``explore``, ``continue`` or ``single``.
        task: The task for this lane (the continue lane seeds from the winner).
        server: The lane's budget slice.
        ctx: Run context; the lane gets its own workspace under ``ctx.run_dir``.
        progress_callback: The job's progress sink, if any.

    Returns:
        The lane's outcome, with ``status`` describing how it ended.
    """
    _emit(progress_callback, PROGRESS_LANE_STARTED, {"engine": engine_id, "phase": phase, "budget": server.max_evals})
    outcome = LaneOutcome(engine=engine_id, phase=phase, status="completed")
    try:
        engine = get_engine(engine_id)
    except ServiceError as exc:
        outcome.status, outcome.error = "unavailable", str(exc)
    else:
        lane_ctx = replace(ctx, run_dir=str(Path(ctx.run_dir) / f"{phase}-{engine_id}"))
        try:
            result: Result = engine.run(task, server, lane_ctx)
        except BudgetExhaustedError as exc:
            outcome.status, outcome.error = "budget_exhausted", str(exc)
            outcome.best_candidate, outcome.best_score = server.best_candidate, server.best_score
        except CostCeilingExceededError:
            # The credit ceiling is a run-level stop, not a lane failure.
            raise
        except Exception as exc:
            logger.exception("%s lane '%s' failed", phase, engine_id)
            outcome.status, outcome.error = "failed", f"{type(exc).__name__}: {exc}"
            outcome.best_candidate, outcome.best_score = server.best_candidate, server.best_score
        else:
            outcome.best_candidate, outcome.best_score = result.best_candidate, result.best_score
            outcome.metadata = dict(result.metadata)
    outcome.scorer_runs = server.used
    _emit(
        progress_callback,
        PROGRESS_LANE_COMPLETED,
        {
            "engine": engine_id,
            "phase": phase,
            "status": outcome.status,
            "best_score": outcome.best_score,
            "scorer_runs": outcome.scorer_runs,
            "error": outcome.error,
        },
    )
    return outcome


def _winner(outcomes: list[LaneOutcome]) -> LaneOutcome | None:
    """Pick the lane with the best score among those that produced a version.

    Args:
        outcomes: Finished lanes.

    Returns:
        The winning lane, or ``None`` when no lane scored anything.
    """
    scored = [o for o in outcomes if o.best_candidate is not None and o.best_score is not None]
    if not scored:
        return None
    return max(scored, key=lambda o: o.best_score or float("-inf"))


def run_strategy(
    strategy: BlackboxStrategy,
    task: Task,
    server: EvalServer,
    ctx: EngineContext,
    progress_callback: ProgressCallback | None = None,
) -> tuple[Result, list[LaneOutcome]]:
    """Run the requested strategy and return the best version plus every lane.

    Args:
        strategy: ``single`` with an engine id, or ``auto``.
        task: The starting point, goal and cases.
        server: The run's full scorer budget.
        ctx: Reflection LM, workspace and stop settings.
        progress_callback: The job's progress sink, if any.

    Returns:
        The winning result and the lane outcomes in execution order.

    Raises:
        ServiceError: When no lane produced a version and there is no
            starting point to fall back to.
    """
    if strategy.mode == "single":
        lane = run_lane(str(strategy.engine), "single", task, server.lane(server.remaining), ctx, progress_callback)
        return _finalize(task, server, [lane], lane), [lane]

    engine_ids = available_engine_ids() if task.str_mode else [BLACKBOX_ENGINE_GEPA]
    if len(engine_ids) == 1:
        lane = run_lane(engine_ids[0], "single", task, server.lane(server.remaining), ctx, progress_callback)
        return _finalize(task, server, [lane], lane), [lane]

    per_lane = max(1, int(server.max_evals * _EXPLORE_SHARE) // len(engine_ids))
    lanes = [
        run_lane(engine_id, "explore", task, server.lane(per_lane), ctx, progress_callback) for engine_id in engine_ids
    ]
    winner = _winner(lanes)
    if winner is None or winner.best_candidate is None or server.remaining <= 0:
        return _finalize(task, server, lanes, winner), lanes

    _emit(
        progress_callback,
        PROGRESS_LANE_HANDOFF,
        {"from_engine": winner.engine, "to_engine": BLACKBOX_ENGINE_GEPA, "best_score": winner.best_score},
    )
    continued = run_lane(
        BLACKBOX_ENGINE_GEPA,
        "continue",
        replace(task, seed_candidate=winner.best_candidate),
        server.lane(server.remaining),
        ctx,
        progress_callback,
    )
    lanes.append(continued)
    final = continued if (continued.best_score or float("-inf")) >= (winner.best_score or float("-inf")) else winner
    return _finalize(task, server, lanes, final), lanes


def _finalize(task: Task, server: EvalServer, lanes: list[LaneOutcome], chosen: LaneOutcome | None) -> Result:
    """Turn the chosen lane into the run's result, falling back to the seed.

    Args:
        task: The original task (for the seed fallback).
        server: The run's budget, for the total count.
        lanes: Every lane that ran, for the error summary.
        chosen: The lane whose version wins, if any produced one.

    Returns:
        The run's best version.

    Raises:
        ServiceError: When nothing was produced and there is no seed.
    """
    if chosen is not None and chosen.best_candidate is not None:
        return Result(
            best_candidate=chosen.best_candidate,
            best_score=chosen.best_score,
            total_evals=server.used,
            metadata={**chosen.metadata, "engine": chosen.engine, "phase": chosen.phase},
        )
    if task.seed_candidate is None:
        errors = "; ".join(f"{lane.engine}: {lane.error}" for lane in lanes if lane.error)
        raise ServiceError(f"No engine produced a version. {errors}".strip())
    return Result(
        best_candidate=task.seed_candidate, best_score=None, total_evals=server.used, metadata={"engine": None}
    )
