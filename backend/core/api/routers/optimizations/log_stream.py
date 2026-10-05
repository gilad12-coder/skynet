"""Live tail of one optimization's run log, served as server-sent events.

The stream resumes from the last row id the client holds, so a reconnect
backfills exactly what it missed. Row ids come from one sequence shared by
concurrent writers, so a lower id can commit after a higher one was already
sent; each poll therefore rereads a window behind the cursor and skips the ids
it has already sent, instead of trusting ``id > cursor`` alone.
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator
from typing import Any

from ..constants import TERMINAL_STATUSES

LOG_STREAM_POLL_SECONDS = 0.5
LOG_STREAM_BATCH = 500
# How far behind the cursor each poll rereads to catch late-committed rows.
LOG_STREAM_LOOKBACK_IDS = 300
_SENT_IDS_KEPT = 10_000


async def stream_job_logs(job_store, optimization_id: str, after_id: int | None) -> AsyncIterator[dict[str, Any]]:
    """Yield a run's new log rows as they are written, ending once the run is over and drained.

    Args:
        job_store: Job-store the rows are read from.
        optimization_id: The run to tail.
        after_id: Last row id the client already holds; ``None`` streams from the start.

    Yields:
        ``{"event": "logs", "id": <last id>, "data": {"entries": [...]}}`` per
        batch, then ``{"event": "done", ...}``, or ``error`` if the run vanishes.
    """
    loop = asyncio.get_running_loop()
    cursor = after_id or 0
    sent: set[int] = set()
    sent_order: deque[int] = deque()
    while True:
        try:
            raw = await loop.run_in_executor(None, job_store.get_job_status_fields, optimization_id)
        except KeyError:
            yield {"event": "error", "data": {"error": "Optimization not found"}}
            return
        # Read the status before the rows: a run seen as finished here has
        # written its last row already, so the drain below cannot miss one.
        finished = raw.get("status") in TERMINAL_STATUSES
        while True:
            since = max(0, cursor - LOG_STREAM_LOOKBACK_IDS) if cursor else None
            rows = await loop.run_in_executor(
                None,
                lambda since=since: job_store.get_logs(
                    optimization_id, after_id=since, limit=LOG_STREAM_BATCH + LOG_STREAM_LOOKBACK_IDS
                ),
            )
            fresh = [row for row in rows if row["id"] not in sent and (after_id is None or row["id"] > after_id)]
            fresh = fresh[:LOG_STREAM_BATCH]
            if not fresh:
                break
            for row in fresh:
                sent.add(row["id"])
                sent_order.append(row["id"])
            while len(sent_order) > _SENT_IDS_KEPT:
                sent.discard(sent_order.popleft())
            cursor = max(cursor, *(row["id"] for row in fresh))
            yield {"event": "logs", "id": cursor, "data": {"entries": fresh}}
            if len(fresh) < LOG_STREAM_BATCH:
                break
        if finished:
            yield {"event": "done", "data": {"status": raw.get("status")}}
            return
        await asyncio.sleep(LOG_STREAM_POLL_SECONDS)
