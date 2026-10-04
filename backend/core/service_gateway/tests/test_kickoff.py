"""Tests for the shared size gate on an agent chat's automatic opening."""

from __future__ import annotations

import asyncio

from ..agents.kickoff import (
    KICKOFF_CONTEXT_BUDGET_BYTES,
    KICKOFF_OVERSIZED_EVENT,
    fits_kickoff_budget,
    measured_bytes,
    oversized_kickoff,
)


def test_measured_bytes_counts_utf8_and_json() -> None:
    """Strings count by their UTF-8 bytes; other values by their JSON."""
    assert measured_bytes("שלום") == 8
    assert measured_bytes(["a"], {"k": 1}) == len('["a"]') + len('{"k": 1}')


def test_budget_edge_is_inclusive() -> None:
    """Exactly the budget fits; one byte more does not."""
    assert fits_kickoff_budget(KICKOFF_CONTEXT_BUDGET_BYTES) is True
    assert fits_kickoff_budget(KICKOFF_CONTEXT_BUDGET_BYTES + 1) is False


def test_oversized_kickoff_is_one_event() -> None:
    """The fixed opening is a single event naming the subject."""

    async def collect() -> list[dict]:
        """Drain the stream."""
        return [event async for event in oversized_kickoff("repo", "acme/app")]

    events = asyncio.run(collect())
    assert events == [{"event": KICKOFF_OVERSIZED_EVENT, "data": {"subject": "repo", "name": "acme/app"}}]
