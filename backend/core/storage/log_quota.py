"""Stop storing a run's log once its owner's storage budget is full.

A run's log is never trimmed, so the owner's storage budget is its only
ceiling. Summing a user's whole footprint on every batch would cost a full
storage scan per insert, so the gate keeps a running estimate per run: it reads
the real usage once, adds each admitted batch's bytes, and rereads the real
figure every :data:`RESYNC_SECONDS` to pick up other runs and deletions.

Once a run crosses the budget it stores one final notice and nothing after it,
for the rest of the run, even if the owner frees space meanwhile.
"""

from __future__ import annotations

import json
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

RESYNC_SECONDS = 60.0
QUOTA_FULL_EVENT = "log.quota_full"
QUOTA_FULL_MESSAGE = "Run logging stopped: your storage is full. Free up space to keep logs for future runs."
# Runs a long-lived worker process remembers; the oldest is forgotten first.
_MAX_TRACKED_RUNS = 1024


@dataclass
class _RunState:
    used: int
    quota: int
    synced_at: float
    stopped: bool = False


def entry_bytes(entry: dict[str, Any]) -> int:
    """Return the bytes ``entry`` adds to its owner's storage, as the usage meter counts them.

    Args:
        entry: One log entry in the shape ``append_logs`` takes.

    Returns:
        The UTF-8 size of its message plus its JSON-encoded fields.
    """
    size = len(str(entry.get("message") or "").encode("utf-8"))
    fields = entry.get("fields")
    if fields is not None:
        size += len(json.dumps(fields, default=str).encode("utf-8"))
    return size


def quota_full_entry() -> dict[str, Any]:
    """Return the final entry a run stores when its owner's storage fills.

    Returns:
        A host-sourced WARNING entry carrying :data:`QUOTA_FULL_EVENT`.
    """
    return {
        "level": "WARNING",
        "logger": "skynet.storage",
        "message": QUOTA_FULL_MESSAGE,
        "source": "host",
        "event": QUOTA_FULL_EVENT,
    }


class LogQuotaGate:
    """Decide which of a run's log entries still fit in its owner's storage budget."""

    def __init__(
        self,
        usage_of: Callable[[str], int],
        quota_of: Callable[[str], int],
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Bind the gate to the store's usage and budget lookups.

        Args:
            usage_of: Returns a user's current total storage in bytes.
            quota_of: Returns a user's storage budget in bytes.
            clock: Monotonic seconds, replaceable in tests.
        """
        self._usage_of = usage_of
        self._quota_of = quota_of
        self._clock = clock
        self._runs: OrderedDict[str, _RunState] = OrderedDict()
        self._lock = threading.Lock()

    def admit(self, optimization_id: str, username: str, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Return the entries to store, ending with the quota notice when this batch fills the budget.

        Args:
            optimization_id: The run the entries belong to.
            username: The run's owner, whose budget they count against.
            entries: The batch, oldest first.

        Returns:
            The entries that fit, plus :func:`quota_full_entry` if the budget
            filled during this batch; an empty list once the run has stopped.
        """
        with self._lock:
            state = self._runs.get(optimization_id)
            if state is not None and state.stopped:
                return []
        now = self._clock()
        if state is None or now - state.synced_at >= RESYNC_SECONDS:
            # Outside the lock: a storage scan must not stall every other run's logging.
            synced = _RunState(used=self._usage_of(username), quota=self._quota_of(username), synced_at=now)
            with self._lock:
                current = self._runs.get(optimization_id)
                if current is not None and current.stopped:
                    return []
                state = synced
                self._runs[optimization_id] = state
                self._runs.move_to_end(optimization_id)
                while len(self._runs) > _MAX_TRACKED_RUNS:
                    self._runs.popitem(last=False)
        with self._lock:
            admitted: list[dict[str, Any]] = []
            for entry in entries:
                size = entry_bytes(entry)
                if state.used + size > state.quota:
                    state.stopped = True
                    admitted.append(quota_full_entry())
                    break
                state.used += size
                admitted.append(entry)
            return admitted
