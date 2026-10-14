"""Tests for stopping a run's log once its owner's storage is full."""

from __future__ import annotations

from typing import Any

from core.storage.log_quota import (
    QUOTA_FULL_EVENT,
    RESYNC_SECONDS,
    LogQuotaGate,
    entry_bytes,
)
from core.storage.tests.test_remote_jobstore import SQLiteJobStore


class _Clock:
    """A settable monotonic clock."""

    def __init__(self) -> None:
        """Start at zero."""
        self.now = 0.0

    def __call__(self) -> float:
        """Return the current time."""
        return self.now


def _entry(message: str, fields: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build an INFO log entry."""
    return {"level": "INFO", "logger": "lg", "message": message, "fields": fields}


def _gate(usage: list[int], quota: int, clock: _Clock | None = None) -> LogQuotaGate:
    """Build a gate whose usage lookup returns ``usage[0]`` and counts its calls in ``usage``."""

    def usage_of(_username: str) -> int:
        usage.append(usage[0])
        return usage[0]

    return LogQuotaGate(usage_of, lambda _username: quota, clock=clock or _Clock())


def test_entry_bytes_counts_message_and_fields() -> None:
    """An entry's size is its UTF-8 message plus its JSON fields."""
    assert entry_bytes(_entry("שלום")) == 8
    assert entry_bytes(_entry("ab", {"k": 1})) == 2 + len('{"k": 1}')


def test_entries_under_budget_pass_through() -> None:
    """Entries that fit are stored unchanged."""
    gate = _gate([0], quota=100)
    batch = [_entry("a" * 10), _entry("b" * 10)]

    assert gate.admit("run", "alice", batch) == batch


def test_filling_batch_ends_with_one_notice_then_drops_everything() -> None:
    """The batch that crosses the budget keeps what fits, ends with the notice, and later batches store nothing."""
    gate = _gate([85], quota=100)

    admitted = gate.admit("run", "alice", [_entry("a" * 10), _entry("b" * 10), _entry("c" * 10)])

    assert [e.get("event") for e in admitted] == [None, QUOTA_FULL_EVENT]
    assert admitted[-1]["level"] == "WARNING"
    assert admitted[-1]["source"] == "host"
    assert gate.admit("run", "alice", [_entry("d")]) == []


def test_full_storage_at_start_stores_only_the_notice() -> None:
    """A run that starts with storage already full stores just the notice."""
    gate = _gate([100], quota=100)

    admitted = gate.admit("run", "alice", [_entry("a")])

    assert [e["event"] for e in admitted] == [QUOTA_FULL_EVENT]


def test_stopped_run_stays_stopped_after_space_is_freed() -> None:
    """Freeing space mid-run does not resume a stopped run's log."""
    clock = _Clock()
    usage = [100]
    gate = _gate(usage, quota=100, clock=clock)
    gate.admit("run", "alice", [_entry("a")])

    usage[0] = 0
    clock.now += RESYNC_SECONDS
    assert gate.admit("run", "alice", [_entry("a")]) == []


def test_usage_is_read_once_then_resynced() -> None:
    """The real usage is read on the first batch and again only after the resync interval."""
    clock = _Clock()
    usage = [0]
    gate = _gate(usage, quota=10_000, clock=clock)

    for _ in range(5):
        gate.admit("run", "alice", [_entry("a")])
    assert len(usage) == 2

    clock.now += RESYNC_SECONDS
    gate.admit("run", "alice", [_entry("a")])
    assert len(usage) == 3


def test_resync_picks_up_other_runs_usage() -> None:
    """Usage grown by other runs is seen at the next resync and stops this run."""
    clock = _Clock()
    usage = [0]
    gate = _gate(usage, quota=100, clock=clock)
    gate.admit("run", "alice", [_entry("a")])

    usage[0] = 100
    clock.now += RESYNC_SECONDS
    assert [e["event"] for e in gate.admit("run", "alice", [_entry("a")])] == [QUOTA_FULL_EVENT]


def test_store_stops_logging_when_owner_storage_is_full() -> None:
    """The store keeps the notice as the run's last line once the owner's budget fills."""
    store = SQLiteJobStore()
    store.create_job("full", username="alice")
    store._log_quota = LogQuotaGate(lambda username: store.compute_user_storage(username).total, lambda _username: 50)

    store.append_logs("full", [_entry("a" * 20)])
    store.append_logs("full", [_entry("b" * 20), _entry("c" * 20)])
    store.append_logs("full", [_entry("d")])

    logs = store.get_logs("full")
    assert [log["message"][:1] for log in logs[:2]] == ["a", "b"]
    assert logs[-1]["event"] == QUOTA_FULL_EVENT
    assert len(logs) == 3


def test_store_fails_open_when_usage_lookup_errors() -> None:
    """A failing usage lookup keeps the log instead of dropping it."""
    store = SQLiteJobStore()
    store.create_job("broken", username="alice")

    def broken(_username: str) -> int:
        raise RuntimeError("db down")

    store._log_quota = LogQuotaGate(broken, lambda _username: 0)
    store.append_logs("broken", [_entry("kept")])

    assert [log["message"] for log in store.get_logs("broken")] == ["kept"]
