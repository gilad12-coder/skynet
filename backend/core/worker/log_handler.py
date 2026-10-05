"""Log handler that routes DSPy log records into the job store.

Captures optimizer iteration scores and average-metric snapshots from
log lines and converts them into structured progress events.
"""

from __future__ import annotations

import contextlib
import logging
import os
import re
import threading
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime
from typing import Any

from .. import run_log
from ..service_gateway.optimization.blackbox import sandbox_log
from ..storage import JobStore

_ITERATION_SCORE_RE = re.compile(
    r"Iteration (?P<iteration>\d+): Selected program (?P<program>\d+) score: (?P<score>[0-9.]+)"
)
_AVERAGE_METRIC_RE = re.compile(
    r"Average Metric: (?P<numerator>[0-9.]+) / (?P<denominator>[0-9.]+) \((?P<percent>[0-9.]+)%\)"
)
_PERFECT_SUBSAMPLE_RE = re.compile(r"Iteration (?P<iteration>\d+): All subsample scores perfect")
_NO_MUTATION_RE = re.compile(r"Iteration (?P<iteration>\d+): Reflective mutation did not propose a new candidate")


_thread_pair_index = threading.local()


def set_current_pair_index(pair_index: int | None) -> None:
    """Set the grid-search pair index for the calling thread (or clear with None).

    Args:
        pair_index: The current grid-search pair index, or ``None`` to clear.
    """
    _thread_pair_index.value = pair_index


def get_current_pair_index() -> int | None:
    """Return the grid-search pair index set on this thread, or None if unset.

    Returns:
        The pair index previously set on this thread, or ``None``.
    """
    return getattr(_thread_pair_index, "value", None)


class JobLogHandler(logging.Handler):
    """Route DSPy log records into the job manager for later inspection."""

    def __init__(self, optimization_id: str, jobs: JobStore) -> None:
        """Bind the handler to a job + store and seed the allowed-thread set with the caller.

        Args:
            optimization_id: ID of the job whose logs this handler captures.
            jobs: Storage backend used to persist log entries.
        """
        super().__init__()
        self._optimization_id = optimization_id
        self._jobs = jobs
        self._thread_ids = {threading.get_ident()}
        self._thread_lock = threading.Lock()

    def register_current_thread(self) -> None:
        """Allow log records emitted by the calling thread for this job."""
        with self._thread_lock:
            self._thread_ids.add(threading.get_ident())

    def emit(self, record: logging.LogRecord) -> None:
        """Persist log records on the associated job.

        Only processes records from threads explicitly registered for this
        job handler, preventing log mixing when multiple jobs run concurrently.

        Args:
            record: The log record produced by the underlying logger.
        """

        with self._thread_lock:
            if record.thread not in self._thread_ids:
                return
        try:
            message = self.format(record)
        except Exception:
            message = record.getMessage()
        timestamp = datetime.fromtimestamp(record.created, tz=UTC)
        # A DB hiccup must not propagate out of emit() — that would crash the
        # worker thread that produced the log line.
        try:
            self._jobs.append_log(
                self._optimization_id,
                level=record.levelname,
                logger_name=record.name,
                message=message,
                timestamp=timestamp,
                pair_index=get_current_pair_index(),
                **run_log.entry_fields(record),
            )
            for event_name, metrics in _extract_progress_from_log(message):
                self._jobs.record_progress(
                    self._optimization_id,
                    event_name,
                    metrics,
                )
        except Exception:
            self.handleError(record)


class SandboxLogRouter(logging.Handler):
    """Persist one job's sandbox output records, whichever thread produced them.

    Sandboxes a protected run opens on the worker's own broker and scorer
    threads would otherwise never reach the run log: those threads are not the
    job's, and nothing in the worker process forwards their records.
    """

    def __init__(self, optimization_id: str, jobs: JobStore) -> None:
        """Bind the router to one job in the current process.

        Args:
            optimization_id: Job whose sandboxes' records this router persists.
            jobs: Storage backend used to persist log entries.
        """
        super().__init__(logging.DEBUG)
        self._optimization_id = optimization_id
        self._jobs = jobs
        # A forked optimization child inherits this handler; it forwards its own
        # records through log events, so persisting them here would double them.
        self._pid = os.getpid()

    def emit(self, record: logging.LogRecord) -> None:
        """Persist ``record`` when it comes from this job's sandbox in this process.

        Args:
            record: A sandbox output record.
        """
        if os.getpid() != self._pid or getattr(record, "sandbox_owner", None) != self._optimization_id:
            return
        try:
            self._jobs.append_log(
                self._optimization_id,
                level=record.levelname,
                logger_name=record.name,
                message=record.getMessage(),
                timestamp=datetime.fromtimestamp(record.created, tz=UTC),
                pair_index=None,
                **run_log.entry_fields(record),
            )
        except Exception:
            self.handleError(record)


@contextlib.contextmanager
def route_sandbox_logs(optimization_id: str, jobs: JobStore) -> Iterator[None]:
    """Persist the job's sandbox output records into its run log while the block runs.

    Args:
        optimization_id: Job being processed.
        jobs: Storage backend used to persist log entries.

    Yields:
        Nothing; the router is detached on exit.
    """
    router = SandboxLogRouter(optimization_id, jobs)
    targets = (sandbox_log.logger, sandbox_log.stream_logger)
    for target in targets:
        target.addHandler(router)
    try:
        yield
    finally:
        for target in targets:
            target.removeHandler(router)


def _extract_progress_from_log(message: str) -> Iterable[tuple[str, dict[str, Any]]]:
    """Parse well-known DSPy log patterns into (event_name, metrics) tuples.

    Args:
        message: A formatted DSPy log line.

    Returns:
        ``(event_name, metrics)`` tuples for each pattern matched.
    """

    events: list[tuple[str, dict[str, Any]]] = []
    if match := _ITERATION_SCORE_RE.search(message):
        events.append(
            (
                "optimizer_iteration",
                {
                    "iteration": int(match.group("iteration")),
                    "program": int(match.group("program")),
                    "score": float(match.group("score")),
                },
            )
        )
    if match := _AVERAGE_METRIC_RE.search(message):
        numerator = float(match.group("numerator"))
        denominator = float(match.group("denominator"))
        percent = float(match.group("percent"))
        events.append(
            (
                "average_metric_snapshot",
                {
                    "value": numerator,
                    "maximum": denominator,
                    "percent": percent,
                },
            )
        )
    if match := _PERFECT_SUBSAMPLE_RE.search(message):
        events.append(
            (
                "optimizer_iteration_perfect",
                {
                    "iteration": int(match.group("iteration")),
                    "perfect_subsamples": True,
                },
            )
        )
    if match := _NO_MUTATION_RE.search(message):
        events.append(
            (
                "optimizer_reflection_idle",
                {
                    "iteration": int(match.group("iteration")),
                    "mutation_proposed": False,
                },
            )
        )
    return events
