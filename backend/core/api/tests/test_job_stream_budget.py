"""Tests that the per-job SSE stream carries the execution budget."""

import asyncio

from core.api.routers.optimizations._local import stream_job_updates


class _StubJobStore:
    """Job store serving one fixed status projection, with no database engine."""

    def __init__(self, fields: dict) -> None:
        """Store the projection returned on every poll.

        Args:
            fields: Status fields for the single job.
        """
        self._fields = fields

    def get_job_status_fields(self, optimization_id: str) -> dict:
        """Return the stored projection."""
        return dict(self._fields)

    def get_log_count(self, optimization_id: str) -> int:
        """Return a fixed log count."""
        return 3

    def get_progress_count(self, optimization_id: str) -> int:
        """Return a fixed progress count."""
        return 1


async def _first_event(store: _StubJobStore) -> dict:
    """Return the first event the stream yields for ``store``."""
    stream = stream_job_updates(store, "job-1")
    try:
        return await anext(stream)
    finally:
        await stream.aclose()


def test_stream_includes_frozen_budget_without_engine():
    """A store without an engine streams the budget frozen in terminal evidence."""
    budget = {"total_cents": 500, "run_spent_cents": 120}
    store = _StubJobStore(
        {
            "status": "running",
            "latest_metrics": {},
            "terminal_evidence": {"execution_budget": budget},
            "execution_budget_id": "b-1",
            "username": "alice",
        }
    )
    event = asyncio.run(_first_event(store))
    assert event["event"] == "message"
    assert event["data"]["execution_budget"] == budget


def test_stream_budget_is_none_when_job_has_none():
    """A job without a budget streams ``None`` so the client keeps its copy."""
    store = _StubJobStore({"status": "running", "latest_metrics": {}})
    event = asyncio.run(_first_event(store))
    assert event["data"]["execution_budget"] is None
