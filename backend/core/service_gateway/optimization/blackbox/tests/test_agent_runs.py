"""Tests for the agent run recorder: scope, rows, live deltas, redaction and caps."""

from __future__ import annotations

from typing import Any

import pytest

from .. import agent_runs as agent_runs_mod
from ..agent_runs import (
    PHASE_BASELINE,
    PHASE_VERSION,
    STATUS_FAILED,
    STATUS_FINISHED,
    STATUS_RUNNING,
    AgentRunRecorder,
    current_run_scope,
    run_scope,
)


def _recorder(**kwargs: Any) -> tuple[AgentRunRecorder, list[dict[str, Any]], list[tuple[str, dict[str, Any]]]]:
    """Build a recorder that collects sink payloads and progress events.

    Args:
        **kwargs: Extra recorder arguments.

    Returns:
        The recorder, its sink payloads and its progress events.
    """
    rows: list[dict[str, Any]] = []
    progress: list[tuple[str, dict[str, Any]]] = []
    recorder = AgentRunRecorder(
        progress_callback=lambda event, metrics: progress.append((event, metrics)), run_sink=rows.append, **kwargs
    )
    return recorder, rows, progress


def test_run_scope_marks_the_calling_context_and_resets_after() -> None:
    """The scope is visible inside the block and gone after it."""
    assert current_run_scope() is None
    with run_scope(PHASE_BASELINE, "3", trial=None):
        scope = current_run_scope()
        assert scope is not None
        assert (scope.phase, scope.example_id, scope.trial) == (PHASE_BASELINE, "3", None)
    assert current_run_scope() is None


def test_begin_reads_the_scope_and_defaults_to_an_unplaced_version_run() -> None:
    """A run begun inside a scope carries it; one begun outside is a version run with no place."""
    recorder, _rows, _progress = _recorder()

    with run_scope(PHASE_VERSION, "1", trial=4):
        scoped = recorder.begin(run_id=1, label="v1", case_id="c")
    bare = recorder.begin(run_id=2, label="v2", case_id=None)

    assert (scoped.phase, scoped.example_id, scoped.trial) == (PHASE_VERSION, "1", 4)
    assert (bare.phase, bare.example_id, bare.trial) == (PHASE_VERSION, None, None)


def test_recorder_without_a_sink_is_inert() -> None:
    """With no sink nothing is announced and writes are dropped."""
    recorder = AgentRunRecorder()
    run = recorder.begin(run_id=1, label="v1", case_id=None)

    run.write("hello")
    run.finish({"exit_code": 0})

    assert recorder.active is False
    assert run.transcript() == ""
    assert run.status == STATUS_FINISHED


def test_begin_and_finish_announce_summaries_and_rows() -> None:
    """Start and end each send a progress summary and a full row to the sink."""
    recorder, rows, progress = _recorder()

    run = recorder.begin(run_id=7, label="v3 · case 2", case_id="two", model="openai/gpt-5")
    run.output = "answer"
    run.finish({"exit_code": 0, "timed_out": False, "elapsed_seconds": 1.5, "usage": {"total_tokens": 9}})

    assert [event for event, _ in progress] == ["agent_run", "agent_run"]
    assert progress[0][1]["status"] == STATUS_RUNNING
    assert progress[1][1]["status"] == STATUS_FINISHED
    assert progress[1][1]["run_id"] == 7
    assert progress[1][1]["elapsed_seconds"] == 1.5
    assert rows[0]["status"] == STATUS_RUNNING
    assert rows[0]["started_at"] is not None
    assert rows[-1]["status"] == STATUS_FINISHED
    assert rows[-1]["output"] == "answer"
    assert rows[-1]["usage"] == {"total_tokens": 9}
    assert rows[-1]["model"] == "openai/gpt-5"
    assert rows[-1]["finished_at"] is not None


def test_write_streams_deltas_when_the_flush_interval_passes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Writes accumulate until the flush interval elapses, then go out as one delta."""
    monkeypatch.setattr(agent_runs_mod, "_FLUSH_SECONDS", 0.0)
    recorder, rows, _progress = _recorder()
    run = recorder.begin(run_id=1, label="v1", case_id=None)

    run.write("hel")
    run.write("lo\n")

    deltas = [row["transcript_delta"] for row in rows if "transcript_delta" in row]
    assert deltas == ["hel", "lo\n"]
    assert run.transcript() == "hello\n"


def test_finish_flushes_what_was_not_yet_streamed() -> None:
    """Text written inside the flush interval still reaches the sink when the run ends."""
    recorder, rows, _progress = _recorder()
    run = recorder.begin(run_id=1, label="v1", case_id=None)

    run.write("late\n")
    run.finish({"exit_code": 0})

    assert [row["transcript_delta"] for row in rows if "transcript_delta" in row] == ["late\n"]
    assert rows[-1]["transcript"] == "late\n"


def test_secrets_are_masked_in_deltas_and_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    """The gateway key never leaves the recorder, live or in the final row."""
    monkeypatch.setattr(agent_runs_mod, "_FLUSH_SECONDS", 0.0)
    recorder, rows, _progress = _recorder(secrets=("sk-live",))
    run = recorder.begin(run_id=1, label="v1", case_id=None)

    run.write("using sk-live now\n")
    run.output = "key=sk-live"
    run.finish({"exit_code": 0})

    assert [row["transcript_delta"] for row in rows if "transcript_delta" in row] == ["using *** now\n"]
    assert rows[-1]["transcript"] == "using *** now\n"
    assert rows[-1]["output"] == "key=***"


def test_transcript_keeps_its_tail_and_the_live_stream_stops_at_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    """Past the cap the record keeps the tail, and the sink stops receiving deltas after a note."""
    monkeypatch.setattr(agent_runs_mod, "FULL_TEXT_CHARS", 10)
    monkeypatch.setattr(agent_runs_mod, "_FLUSH_SECONDS", 0.0)
    recorder, rows, _progress = _recorder()
    run = recorder.begin(run_id=1, label="v1", case_id=None)

    for chunk in ("abcde", "fghij", "klmno", "pqrst", "uvwxy"):
        run.write(chunk)
    run.finish({"exit_code": 0})

    assert run.transcript() == "…" + "pqrstuvwxy"
    deltas = [row["transcript_delta"] for row in rows if "transcript_delta" in row]
    assert deltas == ["abcde", "fghij" + agent_runs_mod._STREAM_CAPPED_NOTE]
    assert rows[-1]["transcript"] == "…pqrstuvwxy"


def test_abort_closes_the_run_as_failed() -> None:
    """An aborted run ends with the failed status and its error, and is still announced."""
    recorder, rows, progress = _recorder()
    run = recorder.begin(run_id=1, label="v1", case_id=None)

    run.abort("sandbox died")

    assert run.status == STATUS_FAILED
    assert rows[-1]["status"] == STATUS_FAILED
    assert rows[-1]["error"] == "sandbox died"
    assert progress[-1][1]["status"] == STATUS_FAILED
