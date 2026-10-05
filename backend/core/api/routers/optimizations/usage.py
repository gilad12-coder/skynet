"""Route for the per-run usage and cost breakdown behind the run page's Usage tab."""

from __future__ import annotations

import asyncio
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from ....billing.run_usage import aggregate, load_records, serialize
from ....constants import OPTIMIZATION_TYPE_BLACKBOX, PAYLOAD_OVERVIEW_OPTIMIZATION_TYPE
from ...auth import AuthenticatedUser, get_authenticated_user
from ...converters import parse_overview
from .._helpers import load_job_for_user
from ..constants import TERMINAL_STATUSES

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]


def run_usage(job_store: Any, job_data: dict[str, Any], pair_index: int | None) -> dict[str, Any]:
    """Build the usage breakdown of one run.

    Args:
        job_store: Job store whose ``engine`` holds the billing tables.
        job_data: The run's job row.
        pair_index: Grid pair to narrow to, or ``None`` for the whole run.

    Returns:
        ``{"rows", "settling", "proposer"}``; ``rows`` is empty when the run has no budget.
    """
    blackbox = parse_overview(job_data).get(PAYLOAD_OVERVIEW_OPTIMIZATION_TYPE) == OPTIMIZATION_TYPE_BLACKBOX
    budget_id = job_data.get("execution_budget_id")
    engine = getattr(job_store, "engine", None)
    records = load_records(engine, budget_id) if budget_id and engine is not None else []
    result = job_data.get("result") if isinstance(job_data.get("result"), dict) else {}
    metadata = result.get("optimization_metadata") if isinstance(result.get("optimization_metadata"), dict) else {}
    direct = metadata.get("direct_proposer_usage")
    rows = aggregate(
        records,
        proposer=blackbox,
        direct_usage=direct if isinstance(direct, list) else (),
        pair=None if pair_index is None else str(pair_index),
    )
    return {
        "rows": serialize(rows),
        "settling": job_data.get("status") in TERMINAL_STATUSES and any(row.pending_calls for row in rows),
        "proposer": blackbox,
    }


def register_usage_routes(router: APIRouter, *, job_store) -> None:
    """Register ``GET /optimizations/{id}/usage``.

    Args:
        router: The router to attach the route to.
        job_store: Job store the run and its billing records are read from.
    """

    @router.get(
        "/optimizations/{optimization_id}/usage",
        summary="Usage and cost breakdown of one optimization",
        tags=["agent"],
    )
    async def get_usage(
        optimization_id: str,
        current_user: AuthenticatedUserDep,
        pair_index: int | None = Query(default=None, ge=0, description="Narrow to one grid pair."),
    ) -> dict:
        """Return a run's charges and model activity, pre-aggregated per role, model, stage, pair and candidate.

        The rows add up to what the run charged. Open to anyone the run is shared with.

        Args:
            optimization_id: Optimization id.
            current_user: Authenticated caller resolved from the bearer token.
            pair_index: Grid pair to narrow to.

        Returns:
            ``{"rows": [...], "settling": bool, "proposer": bool}``.

        Raises:
            DomainError: 404 when the run is unknown or not shared with the caller.
        """
        loop = asyncio.get_running_loop()
        job_data = await loop.run_in_executor(None, load_job_for_user, job_store, optimization_id, current_user)
        return await loop.run_in_executor(None, run_usage, job_store, job_data, pair_index)
