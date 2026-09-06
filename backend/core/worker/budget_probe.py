"""Measure a run's real credit burn and decide whether it outgrows its limit.

The wizard's spending limit is an estimate made before any model call. The
run itself is the accurate sample: once enough evaluations have settled, the
credits they cost are scaled to the optimizer's planned evaluation count. A
projection above the limit pauses the run at its last checkpoint so the user
can raise the limit and continue, instead of the hard stop at the limit
discarding the remaining work.
"""

from __future__ import annotations

import math
from decimal import Decimal
from typing import Any

from ..billing.budgets import BudgetSnapshot
from ..constants import TQDM_TOTAL_KEY

STOP_REASON_BUDGET_PROJECTED = "budget_projected"

# Fewer settled evaluations than this make the per-call cost too noisy to
# project: early GEPA rollouts run short prompts before candidates grow.
PROBE_MIN_CALLS = 10
PROBE_MIN_FRACTION = 0.05


def planned_calls_from_progress(metrics: dict[str, Any]) -> int | None:
    """Return the optimizer's planned evaluation count carried by a progress event.

    Args:
        metrics: Progress metrics; the top-level optimizer bar's total is the
            metric-call budget (GEPA ``max_metric_calls`` or the blackbox
            scorer-run budget).

    Returns:
        The positive planned count, or ``None`` when the event carries none.
    """
    total = metrics.get(TQDM_TOTAL_KEY)
    if isinstance(total, bool) or not isinstance(total, int) or total <= 0:
        return None
    return total


def probe_ready(done_calls: int, planned_calls: int) -> bool:
    """Return whether enough evaluations settled for the burn rate to be trusted.

    Args:
        done_calls: Metric calls completed so far, cumulative across resumes.
        planned_calls: Metric calls the optimizer intends to make in total.

    Returns:
        ``True`` once ``done_calls`` covers the larger of the absolute floor and
        the fractional floor of ``planned_calls``.
    """
    return done_calls >= max(PROBE_MIN_CALLS, math.ceil(planned_calls * PROBE_MIN_FRACTION))


def project_total_credits(setup_spent: Decimal, run_spent: Decimal, done_calls: int, planned_calls: int) -> int:
    """Scale the credits spent so far to the planned evaluation count.

    Setup spend (environment build, seed evaluation) is a one-off carried over
    unscaled; only the per-evaluation run spend grows with the plan.

    Args:
        setup_spent: Credits settled during the setup phase.
        run_spent: Credits settled during the run phase over ``done_calls``.
        done_calls: Metric calls completed so far; must be positive.
        planned_calls: Metric calls the optimizer intends to make in total.

    Returns:
        The projected whole-credit total, rounded up.
    """
    projected = Decimal(setup_spent) + Decimal(run_spent) * Decimal(planned_calls) / Decimal(done_calls)
    return math.ceil(projected)


def projection_evidence(
    snapshot: BudgetSnapshot, *, done_calls: int, planned_calls: int, projected_credits: int
) -> dict[str, Any]:
    """Build the ``terminal_evidence.budget_projection`` record for a paused run.

    Args:
        snapshot: The budget at the moment of the decision.
        done_calls: Metric calls completed so far.
        planned_calls: Metric calls the optimizer intends to make in total.
        projected_credits: Result of :func:`project_total_credits`.

    Returns:
        A JSON-serializable record the API surfaces to the client.
    """
    return {
        "planned_calls": planned_calls,
        "done_calls": done_calls,
        "spent_credits": str(snapshot.setup_spent_credits + snapshot.run_spent_credits),
        "projected_credits": projected_credits,
        "limit_credits": snapshot.total_credits,
    }
