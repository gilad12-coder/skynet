"""Records of every sandboxed agent run, streamed out of the run as they happen.

Each ``(version, case)`` evaluation of an agent target is one sandbox run.
The scorer wrapper opens a record when a run starts, feeds it the agent's
output as the box produces it, and closes it with the answer and outcome.
Every change goes to a sink, so the worker can persist the record and the
run view can show the box live: the run's row in the ``agent_run`` progress
events names it, the sink carries its full transcript and answer.

The record needs to know which trial and case a run belongs to, but the
scorer is called from deep inside the engines. :func:`run_scope` marks that
on the calling thread's context; the recorder reads it when a run begins.
"""

from __future__ import annotations

import contextlib
import contextvars
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ....constants import PROGRESS_AGENT_RUN

# A run's ``phase``: one of the optimizer's trials, the held-out baseline
# pass over the starting point, or the held-out pass over the winner.
PHASE_VERSION = "version"
PHASE_BASELINE = "baseline"
PHASE_FINAL = "final"
STATUS_RUNNING = "running"
STATUS_FINISHED = "finished"
# The sandbox could not be driven to an outcome; ``error`` says why.
STATUS_FAILED = "failed"
# The full transcript and answer are kept whole up to this size; past it the
# transcript keeps its tail and the answer its head.
FULL_TEXT_CHARS = 1_000_000
# Live transcript deltas are batched so a chatty agent costs one queue
# event every couple of seconds rather than one per line.
_FLUSH_SECONDS = 2.0
_REDACTED = "***"
# The live stream stops at the cap so a runaway agent cannot flood the event
# queue; the tail still arrives with the final row.
_STREAM_CAPPED_NOTE = "\n[transcript] live stream capped; the rest arrives when the run ends\n"

AgentRunSink = Callable[[dict[str, Any]], None]
ProgressCallback = Callable[[str, dict[str, Any]], None]


@dataclass(frozen=True)
class RunScope:
    """Where a run sits in the optimization: its phase, case and trial."""

    phase: str
    example_id: str
    trial: int | None = None


_current_scope: contextvars.ContextVar[RunScope | None] = contextvars.ContextVar("_current_scope", default=None)


@contextlib.contextmanager
def run_scope(phase: str, example_id: str, *, trial: int | None = None) -> Iterator[None]:
    """Mark the scorer calls made inside the block with their phase, case and trial.

    Args:
        phase: One of the ``PHASE_*`` constants.
        example_id: The case's id as the progress events name it.
        trial: The trial's index, for ``PHASE_VERSION`` runs.
    """
    token = _current_scope.set(RunScope(phase=phase, example_id=example_id, trial=trial))
    try:
        yield
    finally:
        _current_scope.reset(token)


def current_run_scope() -> RunScope | None:
    """Return the scope marked on this thread, or ``None`` outside any."""
    return _current_scope.get()


class AgentRun:
    """One sandbox run's record, filled in as the run progresses.

    Writes are thread-safe: a local sandbox feeds stdout and stderr from two
    reader threads.
    """

    def __init__(
        self,
        recorder: AgentRunRecorder,
        *,
        run_id: int,
        label: str,
        case_id: str | None,
        model: str | None = None,
    ) -> None:
        """Open the record.

        Args:
            recorder: Where the record's changes go.
            run_id: The run's ordinal within the job.
            label: The run's log label.
            case_id: The case's own id or name, when it has one.
            model: The model the harness drives in this run.
        """
        scope = current_run_scope()
        self.run_id = run_id
        self.label = label
        self.case_id = case_id
        self.model = model
        self.phase = PHASE_VERSION if scope is None else scope.phase
        self.example_id = None if scope is None else scope.example_id
        self.trial = None if scope is None else scope.trial
        self.status = STATUS_RUNNING
        self.started_at = datetime.now(UTC)
        self.finished_at: datetime | None = None
        self.exit_code: int | None = None
        self.timed_out = False
        self.elapsed_seconds: float | None = None
        self.error: str | None = None
        self.usage: dict[str, Any] = {}
        self.check: dict[str, Any] | None = None
        self.output: str | None = None
        self._recorder = recorder
        self._lock = threading.Lock()
        self._transcript: list[str] = []
        self._transcript_chars = 0
        self._pending: list[str] = []
        self._streamed_chars = 0
        self._truncated = False
        self._last_flush = time.monotonic()

    def write(self, text: str) -> None:
        """Append ``text`` to the transcript and stream it out.

        Args:
            text: New output from the box, or a note from the runner.
        """
        if not text or not self._recorder.active:
            return
        with self._lock:
            self._transcript.append(text)
            self._transcript_chars += len(text)
            if self._transcript_chars > 2 * FULL_TEXT_CHARS:
                tail = "".join(self._transcript)[-FULL_TEXT_CHARS:]
                self._transcript, self._transcript_chars, self._truncated = [tail], len(tail), True
            if self._streamed_chars < FULL_TEXT_CHARS:
                self._pending.append(text)
                self._streamed_chars += len(text)
                if self._streamed_chars >= FULL_TEXT_CHARS:
                    self._pending.append(_STREAM_CAPPED_NOTE)
            due = time.monotonic() - self._last_flush >= _FLUSH_SECONDS
        if due:
            self.flush()

    def flush(self) -> None:
        """Send whatever was written since the last flush to the sink."""
        with self._lock:
            if not self._pending:
                return
            delta, self._pending = "".join(self._pending), []
            self._last_flush = time.monotonic()
        self._recorder.emit({"run_id": self.run_id, "transcript_delta": self._recorder.redact(delta)})

    def transcript(self) -> str:
        """Return the transcript so far, keeping the tail once it outgrows the cap."""
        with self._lock:
            text = "".join(self._transcript)
            truncated = self._truncated
        if len(text) > FULL_TEXT_CHARS:
            text, truncated = text[-FULL_TEXT_CHARS:], True
        return "…" + text if truncated else text

    def finish(self, record: dict[str, Any]) -> None:
        """Close the record with the run's outcome.

        Args:
            record: The scorer wrapper's run record: exit code, usage, check, error.
        """
        self.exit_code = record.get("exit_code")
        self.timed_out = bool(record.get("timed_out"))
        self.elapsed_seconds = record.get("elapsed_seconds")
        self.error = record.get("error")
        self.usage = dict(record.get("usage") or {})
        self.check = record.get("check")
        self.status = STATUS_FINISHED
        self.finished_at = datetime.now(UTC)
        self._recorder.ended(self)

    def abort(self, error: str) -> None:
        """Close the record for a run that never reached an outcome.

        Args:
            error: Why the sandbox could not be driven.
        """
        self.error = error
        self.status = STATUS_FAILED
        self.finished_at = datetime.now(UTC)
        self._recorder.ended(self)

    def summary(self) -> dict[str, Any]:
        """Return the fields the ``agent_run`` progress event carries."""
        return {
            "run_id": self.run_id,
            "phase": self.phase,
            "trial": self.trial,
            "example_id": self.example_id,
            "case_id": self.case_id,
            "label": self.label,
            "status": self.status,
            "exit_code": self.exit_code,
            "timed_out": self.timed_out,
            "error": self.error,
            "elapsed_seconds": self.elapsed_seconds,
        }

    def row(self) -> dict[str, Any]:
        """Return the full record the sink persists."""
        output = self.output
        if output is not None and len(output) > FULL_TEXT_CHARS:
            output = output[:FULL_TEXT_CHARS] + "…"
        return {
            **self.summary(),
            "started_at": self.started_at.isoformat(),
            "finished_at": None if self.finished_at is None else self.finished_at.isoformat(),
            "model": self.model,
            "usage": self.usage,
            "check": self.check,
            "output": None if output is None else self._recorder.redact(output),
            "transcript": self._recorder.redact(self.transcript()),
        }


class AgentRunRecorder:
    """Opens run records and forwards their changes to the job's sinks.

    Without a sink the recorder is inert: runs are opened and closed but
    nothing is buffered or sent.
    """

    def __init__(
        self,
        *,
        progress_callback: ProgressCallback | None = None,
        run_sink: AgentRunSink | None = None,
        secrets: tuple[str, ...] = (),
    ) -> None:
        """Bind the recorder to the job's sinks.

        Args:
            progress_callback: Receives an ``agent_run`` event when a run starts and ends.
            run_sink: Receives each run's full record and the live transcript deltas.
            secrets: Values masked out of everything sent, such as the gateway key
                the box holds in its environment.
        """
        self._progress_callback = progress_callback
        self._run_sink = run_sink
        self._secrets = tuple(secret for secret in secrets if secret)

    @property
    def active(self) -> bool:
        """Whether anything consumes the records."""
        return self._run_sink is not None

    def begin(self, *, run_id: int, label: str, case_id: str | None, model: str | None = None) -> AgentRun:
        """Open a record for a run that is about to start.

        Args:
            run_id: The run's ordinal within the job.
            label: The run's log label.
            case_id: The case's own id or name, when it has one.
            model: The model the harness drives in this run.

        Returns:
            The open record.
        """
        run = AgentRun(self, run_id=run_id, label=label, case_id=case_id, model=model)
        self._announce(run)
        return run

    def ended(self, run: AgentRun) -> None:
        """Send a closed record's final state.

        Args:
            run: The record just closed.
        """
        run.flush()
        self._announce(run)

    def emit(self, payload: dict[str, Any]) -> None:
        """Hand one record or delta to the run sink.

        Args:
            payload: A full record from :meth:`AgentRun.row`, or a transcript delta.
        """
        if self._run_sink is not None:
            self._run_sink(payload)

    def redact(self, text: str) -> str:
        """Mask the recorder's secrets in ``text``.

        A live delta may split a secret across two chunks, so the mask is
        best-effort there; the final record is redacted whole.

        Args:
            text: Transcript or answer text.

        Returns:
            The text with every secret replaced.
        """
        for secret in self._secrets:
            text = text.replace(secret, _REDACTED)
        return text

    def _announce(self, run: AgentRun) -> None:
        """Send the run's summary as a progress event and its full record to the sink.

        Args:
            run: The record.
        """
        if not self.active:
            return
        if self._progress_callback is not None:
            self._progress_callback(PROGRESS_AGENT_RUN, run.summary())
        self.emit(run.row())
