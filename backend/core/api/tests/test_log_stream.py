"""Tests for the live run-log stream."""

from __future__ import annotations

from typing import Any

import pytest

from core.api.routers.optimizations import log_stream
from core.api.routers.optimizations.log_stream import stream_job_logs


class _Store:
    """A job store whose rows and status the test controls between polls."""

    def __init__(self, statuses: list[str]) -> None:
        """Start with no rows and a status per poll."""
        self.rows: list[dict[str, Any]] = []
        self.statuses = statuses
        self.on_poll: list[Any] = []

    def get_job_status_fields(self, optimization_id: str) -> dict[str, Any]:
        """Return the next status, running any rows queued to appear at this poll."""
        if self.on_poll:
            self.on_poll.pop(0)()
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        return {"status": status}

    def get_logs(self, optimization_id: str, *, after_id: int | None = None, limit: int | None = None):
        """Return rows past ``after_id`` in id order."""
        rows = sorted((r for r in self.rows if after_id is None or r["id"] > after_id), key=lambda r: r["id"])
        return rows[:limit] if limit is not None else rows

    def add(self, *ids: int) -> None:
        """Commit rows with these ids."""
        self.rows.extend({"id": i, "message": f"m{i}"} for i in ids)


async def _collect(store: _Store, after_id: int | None = None) -> list[dict[str, Any]]:
    """Run the stream to completion and return its events."""
    return [event async for event in stream_job_logs(store, "job", after_id)]


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """Poll without waiting."""
    monkeypatch.setattr(log_stream, "LOG_STREAM_POLL_SECONDS", 0)


def _ids(events: list[dict[str, Any]]) -> list[int]:
    """Return every streamed row id, in order."""
    return [row["id"] for e in events if e["event"] == "logs" for row in e["data"]["entries"]]


async def test_streams_new_rows_then_ends_after_the_run_finishes() -> None:
    """Rows written while running arrive in order, and done follows the last row."""
    store = _Store(["running", "running", "success"])
    store.add(1, 2)
    store.on_poll = [lambda: None, lambda: store.add(3), lambda: store.add(4)]

    events = await _collect(store)

    assert _ids(events) == [1, 2, 3, 4]
    assert events[-1] == {"event": "done", "data": {"status": "success"}}


async def test_event_id_is_the_batch_last_row_id() -> None:
    """Each batch's SSE id is its last row id, the client's resume cursor."""
    store = _Store(["success"])
    store.add(5, 9)

    events = await _collect(store)

    assert events[0]["id"] == 9


async def test_resumes_after_the_given_id() -> None:
    """A reconnect with after_id gets only newer rows."""
    store = _Store(["success"])
    store.add(1, 2, 3)

    assert _ids(await _collect(store, after_id=2)) == [3]


async def test_late_committed_lower_id_is_still_sent_once() -> None:
    """A row whose id is below the cursor but committed later is sent, and nothing repeats."""
    store = _Store(["running", "running", "success"])
    store.add(1, 3)
    store.on_poll = [lambda: None, lambda: store.add(2)]

    assert _ids(await _collect(store)) == [1, 3, 2]


async def test_large_backlog_is_sent_in_batches() -> None:
    """A backlog larger than one batch drains in several events before done."""
    store = _Store(["success"])
    store.add(*range(1, log_stream.LOG_STREAM_BATCH * 2 + 2))

    events = await _collect(store)

    assert [len(e["data"]["entries"]) for e in events if e["event"] == "logs"] == [
        log_stream.LOG_STREAM_BATCH,
        log_stream.LOG_STREAM_BATCH,
        1,
    ]
    assert _ids(events) == list(range(1, log_stream.LOG_STREAM_BATCH * 2 + 2))


async def test_missing_run_ends_with_error() -> None:
    """A run deleted mid-stream ends the stream with an error event."""

    class _Gone(_Store):
        def get_job_status_fields(self, optimization_id: str) -> dict[str, Any]:
            raise KeyError(optimization_id)

    assert (await _collect(_Gone(["running"])))[0]["event"] == "error"
