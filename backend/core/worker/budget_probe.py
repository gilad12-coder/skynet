"""Measure a run's real spend per evaluation and decide when the budget cannot fund another round.

A run has no upfront cost estimate: its spending limit is the budget it may
use. After a short calibration the cents settled so far, divided by the
scorer runs that produced them, give the run's pace. The pace prices the next
iteration; once the budget left cannot cover it with a margin, the worker
closes admission with ``budget_reached`` so the optimizer stops on its next
paid call and keeps the best version found, instead of starting work the
budget would cut off. The same pace feeds the live "about N more" estimate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from ..billing.budgets import BudgetSnapshot
from ..constants import TQDM_N_KEY, TQDM_TOTAL_KEY

# Paused runs from before budget-first runs carry this reason; resume still explains them.
STOP_REASON_BUDGET_PROJECTED = "budget_projected"
STOP_REASON_BUDGET_REACHED = "budget_reached"

# Fewer settled evaluations than this make the per-call cost too noisy to
# trust: early GEPA rollouts run short prompts before candidates grow.
CALIBRATION_CALLS = 10
# Later iterations cost more than the average so far (prompts grow as the
# optimizer learns), so the next round is priced at half again its average.
STOP_MARGIN = Decimal("1.5")

# The ``tqdm_`` prefix keeps these on the job's latest metrics between
# optimizer bar ticks (see ``RemoteJobStore._latest_metrics_with_sticky_tqdm``).
PACE_CALIBRATING_KEY = "tqdm_budget_calibrating"
PACE_EVALS_LEFT_KEY = "tqdm_budget_evals_left"
PACE_ITERATIONS_LEFT_KEY = "tqdm_budget_iterations_left"


@dataclass(frozen=True)
class BudgetPace:
    """What the run's measured spend says about the budget left."""

    calibrating: bool
    cents_per_call: Decimal | None
    calls_per_iteration: int
    evals_left: int | None
    iterations_left: int | None
    stop: bool


def _count(value: Any) -> int | None:
    """Return a non-negative integer progress count, rejecting every other shape.

    Args:
        value: A raw progress field.

    Returns:
        The count, or ``None``.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def planned_calls_from_progress(metrics: dict[str, Any]) -> int | None:
    """Return the optimizer's scorer-run cap carried by a progress event.

    Args:
        metrics: Progress metrics; the top-level optimizer bar's total is the
            metric-call budget (GEPA ``max_metric_calls`` or the blackbox
            scorer-run budget).

    Returns:
        The positive planned count, or ``None`` when the event carries none.
    """
    total = _count(metrics.get(TQDM_TOTAL_KEY))
    return total or None


def done_calls_from_progress(metrics: dict[str, Any]) -> int | None:
    """Return the scorer runs completed so far, as the optimizer bar reports them.

    Args:
        metrics: Progress metrics of one event.

    Returns:
        The count, or ``None`` when the event is not an optimizer bar tick.
    """
    if planned_calls_from_progress(metrics) is None:
        return None
    return _count(metrics.get(TQDM_N_KEY))


def calls_per_iteration(checkpoint: dict[str, Any] | None) -> int | None:
    """Average the scorer runs one optimizer iteration took, from the last saved state.

    Args:
        checkpoint: The tracker's ``{"n", "metric_calls"}`` cursor for the run's state.

    Returns:
        Whole scorer runs per iteration, rounded up, or ``None`` before the
        first iteration was saved.
    """
    if not checkpoint:
        return None
    iterations = _count(checkpoint.get("n"))
    calls = _count(checkpoint.get("metric_calls"))
    if not iterations or not calls:
        return None
    return math.ceil(calls / iterations)


def budget_pace(
    snapshot: BudgetSnapshot,
    *,
    done_calls: int,
    planned_calls: int | None,
    iteration_calls: int | None,
) -> BudgetPace:
    """Price the next round from the run's own spend and say whether the budget still covers it.

    Setup spend (environment build, seed evaluation) is a one-off, so only
    run-phase spend is divided by the scorer runs. Without a saved iteration
    the calibration sample size stands in for one round.

    Args:
        snapshot: The budget now.
        done_calls: Scorer runs completed so far, cumulative across resumes.
        planned_calls: The run's scorer-run cap, if reported.
        iteration_calls: Scorer runs per optimizer iteration, if known.

    Returns:
        The pace, how many evaluations and iterations the budget left can fund,
        and whether the run should stop now.
    """
    round_calls = iteration_calls or CALIBRATION_CALLS
    cap_left = None if planned_calls is None else max(0, planned_calls - done_calls)
    if done_calls < CALIBRATION_CALLS:
        return BudgetPace(True, None, round_calls, None, None, False)
    per_call = Decimal(snapshot.run_spent_cents) / Decimal(done_calls)
    left = max(Decimal(0), Decimal(snapshot.available_cents))
    if per_call <= 0:
        evals_left = cap_left
    else:
        affordable = int(left / per_call)
        evals_left = affordable if cap_left is None else min(affordable, cap_left)
    iterations_left = None if iteration_calls is None or evals_left is None else evals_left // iteration_calls
    stop = not snapshot.uncapped and per_call > 0 and left < per_call * round_calls * STOP_MARGIN
    return BudgetPace(False, per_call, round_calls, evals_left, iterations_left, stop)


def pace_metrics(pace: BudgetPace) -> dict[str, Any]:
    """Render a pace as the progress fields the run page reads.

    Args:
        pace: Result of :func:`budget_pace`.

    Returns:
        Fields merged into the optimizer bar's progress event.
    """
    return {
        PACE_CALIBRATING_KEY: pace.calibrating,
        PACE_EVALS_LEFT_KEY: pace.evals_left,
        PACE_ITERATIONS_LEFT_KEY: pace.iterations_left,
    }
