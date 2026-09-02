"""Tests for the agent run store: save, append, read back and byte accounting."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from core.storage.agent_run_store import PostgresAgentRunStore
from core.storage.models import Base


@pytest.fixture
def store() -> PostgresAgentRunStore:
    """Return a store over a fresh in-memory SQLite schema."""
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return PostgresAgentRunStore(engine)


def _row(**overrides: object) -> dict[str, object]:
    """Build a run record as the recorder sends it.

    Args:
        **overrides: Field overrides.

    Returns:
        The record.
    """
    row: dict[str, object] = {
        "run_id": 1,
        "phase": "version",
        "trial": 2,
        "example_id": "0",
        "case_id": "case-a",
        "label": "v2 · case 1",
        "status": "running",
        "started_at": "2026-09-01T10:00:00+00:00",
        "finished_at": None,
        "model": "openai/gpt-5",
        "exit_code": None,
        "timed_out": False,
        "elapsed_seconds": None,
        "error": None,
        "usage": {},
        "check": None,
        "output": None,
        "transcript": "",
    }
    row.update(overrides)
    return row


def test_save_then_get_round_trips_the_record(store: PostgresAgentRunStore) -> None:
    """A saved record reads back whole, with ISO timestamps and the check under ``check``."""
    store.save("job-1", _row(status="finished", exit_code=0, output="answer", check={"exit_code": 0}))

    record = store.get("job-1", 1)

    assert record is not None
    assert record["run_id"] == 1
    assert record["phase"] == "version"
    assert record["trial"] == 2
    assert record["example_id"] == "0"
    assert record["case_id"] == "case-a"
    assert record["status"] == "finished"
    assert record["started_at"] == "2026-09-01T10:00:00+00:00"
    assert record["finished_at"] is None
    assert record["model"] == "openai/gpt-5"
    assert record["output"] == "answer"
    assert record["check"] == {"exit_code": 0}
    assert record["transcript"] == ""


def test_get_returns_none_for_an_unknown_run(store: PostgresAgentRunStore) -> None:
    """Missing rows read as ``None``."""
    assert store.get("job-1", 99) is None


def test_save_replaces_an_existing_row(store: PostgresAgentRunStore) -> None:
    """Saving the same run again overwrites the row instead of duplicating it."""
    store.save("job-1", _row())
    store.save("job-1", _row(status="finished", transcript="all of it\n", output="done"))

    record = store.get("job-1", 1)

    assert record is not None
    assert record["status"] == "finished"
    assert record["transcript"] == "all of it\n"
    assert record["output"] == "done"


def test_append_transcript_extends_the_row_and_its_footprint(store: PostgresAgentRunStore) -> None:
    """Deltas append in order and grow the stored byte count; unknown runs are ignored."""
    store.save("job-1", _row())

    store.append_transcript("job-1", 1, "one\n")
    store.append_transcript("job-1", 1, "two\n")
    store.append_transcript("job-1", 1, "")
    store.append_transcript("job-1", 5, "nowhere\n")

    record = store.get("job-1", 1)
    assert record is not None
    assert record["transcript"] == "one\ntwo\n"
    assert store.get("job-1", 5) is None


def test_records_are_scoped_to_their_job(store: PostgresAgentRunStore) -> None:
    """Two jobs may both have run 1."""
    store.save("job-1", _row(output="a"))
    store.save("job-2", _row(output="b"))

    first = store.get("job-1", 1)
    second = store.get("job-2", 1)

    assert first is not None
    assert first["output"] == "a"
    assert second is not None
    assert second["output"] == "b"
