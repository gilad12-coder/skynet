"""Resumable server-side turns for the wizard's long-running agent streams.

The hosting edge (Railway) closes every HTTP request after 15 minutes, data
flowing or not, and that cap is not configurable. A code-agent turn over a
large code base can run longer, so a turn must not live inside the request
that started it:

* :meth:`AgentTurnRegistry.start` runs the turn's (already metered) event
  stream as a background task on this replica and numbers every event with a
  monotonic ``seq`` (the SSE ``id``). The first event is ``turn_started``
  (carrying the ``turn_id``); the last is always ``turn_end``.
* Events are kept in memory for readers on this replica and batch-flushed to
  ``agent_turn_events`` for readers on any other replica — production runs
  several backend replicas and the edge does not pin a reconnect to the one
  that owns the turn.
* :meth:`AgentTurnRegistry.stream` replays everything after a given ``seq``
  and then tails the live turn, ending the response after
  :data:`RESPONSE_WINDOW_SECONDS` so the client reconnects before the edge
  cuts it.
* :meth:`AgentTurnRegistry.cancel` stops the task (directly on the owning
  replica, through ``agent_turns.cancel_requested`` from any other). A turn
  nobody has read for :data:`_ABANDON_SECONDS` is cancelled too, which keeps
  the old "closing the tab stops the turn" behavior without tying the turn to
  a single connection.

Usage metering stays in the wrapped source (``stream_with_llm_metering``),
whose ``finally`` runs exactly once when the task finishes, fails or is
cancelled — never per connection.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterable, AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from ..storage.models import AgentTurnEventModel, AgentTurnModel
from .errors import DomainError

logger = logging.getLogger(__name__)

TURN_STARTED_EVENT = "turn_started"
TURN_END_EVENT = "turn_end"

# Each response ends this long after it opens and the client reconnects;
# comfortably under the edge's hard 15-minute request cap.
RESPONSE_WINDOW_SECONDS = 600.0

_FLUSH_SECONDS = 0.25
_REMOTE_POLL_SECONDS = 0.5
_HEARTBEAT_SECONDS = 2.0
# An owner whose heartbeat is this old is gone (replica restarted or
# crashed); its turn can never finish, so remote readers stop waiting.
_STALE_OWNER_SECONDS = 60.0
# Long enough to ride out reconnect backoff and a brief network outage.
_ABANDON_SECONDS = 180.0
_RETENTION_SECONDS = 3600.0
_LOCAL_RETENTION_SECONDS = 600.0
_REMOTE_BATCH = 500

STATUS_RUNNING = "running"
STATUS_FINISHED = "finished"
STATUS_CANCELLED = "cancelled"

_FAILED_DATA = {"error": "The agent stopped unexpectedly. Please try again."}
_CANCELLED_DATA = {"error": "The agent turn was stopped."}
_LOST_DATA = {"error": "The agent turn was interrupted on the server. Please try again."}


@dataclass(eq=False)
class _LocalTurn:
    """In-process state of a turn owned by this replica."""

    turn_id: str
    owner: str
    durable: bool
    events: list[dict[str, Any]] = field(default_factory=list)
    unflushed: list[dict[str, Any]] = field(default_factory=list)
    ending: bool = False
    finished: bool = False
    readers: int = 0
    last_read: float = field(default_factory=time.time)
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    stop_sync: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None


def _as_utc_timestamp(value: datetime | None) -> float:
    """Convert a DB timestamp (naive on SQLite) to POSIX seconds.

    Args:
        value: Timestamp read from the turn row, or ``None``.

    Returns:
        Seconds since the epoch; ``0.0`` for ``None``.
    """
    if value is None:
        return 0.0
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.timestamp()


class AgentTurnRegistry:
    """Registry of the resumable agent turns served by one router (one per process)."""

    def __init__(self) -> None:
        """Start with no engine bound and no local turns."""
        self._engine: Any = None
        self._turns: dict[str, _LocalTurn] = {}

    def bind_engine(self, engine: Any) -> None:
        """Attach the shared database engine that backs cross-replica resume.

        Args:
            engine: SQLAlchemy engine for the application database.
        """
        self._engine = engine

    async def start(self, source: AsyncIterable[dict[str, Any]], *, owner: str) -> str:
        """Run ``source`` as a background turn and return its id.

        Args:
            source: The turn's ``{"event", "data"}`` stream, already wrapped
                in usage metering.
            owner: Username the turn belongs to; only they may read or cancel it.

        Returns:
            The new turn's id.
        """
        turn_id = uuid.uuid4().hex
        durable = False
        if self._engine is not None:
            try:
                await asyncio.to_thread(self._insert_turn, turn_id, owner)
                durable = True
            except Exception:
                # Degrade to a same-replica-only turn rather than refusing it.
                logger.exception("Failed to persist agent turn %s", turn_id)
        turn = _LocalTurn(turn_id=turn_id, owner=owner, durable=durable)
        self._turns[turn_id] = turn
        self._append(turn, TURN_STARTED_EVENT, {"turn_id": turn_id})
        turn.task = asyncio.create_task(self._run(turn, source), name=f"agent-turn-{turn_id}")
        return turn_id

    async def authorize(self, turn_id: str, owner: str) -> None:
        """Ensure ``turn_id`` exists and belongs to ``owner``.

        Args:
            turn_id: Turn to look up.
            owner: Username of the caller.

        Raises:
            DomainError: 404 when the turn is unknown or owned by someone else.
        """
        turn = self._turns.get(turn_id)
        if turn is not None:
            if turn.owner == owner:
                return
            raise DomainError("agent.turn.not_found", status=404)
        if self._engine is not None and await asyncio.to_thread(self._owner_of, turn_id) == owner:
            return
        raise DomainError("agent.turn.not_found", status=404)

    async def stream(
        self,
        turn_id: str,
        *,
        after_seq: int = 0,
        window_seconds: float = RESPONSE_WINDOW_SECONDS,
    ) -> AsyncIterator[dict[str, Any]]:
        """Replay a turn's events after ``after_seq``, then tail it live.

        Callers must :meth:`authorize` first. The iterator ends after the
        ``turn_end`` event, or — with the turn still running — once
        ``window_seconds`` elapse, which the client answers by reconnecting.

        Args:
            turn_id: Turn to read.
            after_seq: Last ``seq`` the client already holds (0 for none).
            window_seconds: Maximum lifetime of this read.

        Yields:
            ``{"id": seq, "event", "data"}`` mappings; a synthetic error for a
            turn whose owner vanished carries no ``id``.
        """
        deadline = time.monotonic() + window_seconds
        turn = self._turns.get(turn_id)
        if turn is not None:
            source = self._stream_local(turn, after_seq, deadline)
        elif self._engine is not None:
            source = self._stream_remote(turn_id, after_seq, deadline)
        else:
            return
        async for event in source:
            yield event

    async def cancel(self, turn_id: str, owner: str) -> bool:
        """Stop a running turn on behalf of its owner.

        Args:
            turn_id: Turn to stop.
            owner: Username of the caller.

        Returns:
            True when the turn was running and a stop was delivered or
            requested; False when it is unknown, not the caller's, or done.
        """
        turn = self._turns.get(turn_id)
        if turn is not None:
            if turn.owner != owner:
                return False
            return self._cancel_task(turn)
        if self._engine is None:
            return False
        return await asyncio.to_thread(self._request_cancel, turn_id, owner)

    def _append(self, turn: _LocalTurn, name: str, data: dict[str, Any]) -> None:
        """Number an event, buffer it and wake every local reader.

        Args:
            turn: Turn the event belongs to.
            name: SSE event name.
            data: Event payload.
        """
        event = {"id": len(turn.events) + 1, "event": name, "data": data}
        turn.events.append(event)
        if turn.durable:
            turn.unflushed.append(event)
        self._notify(turn)

    @staticmethod
    def _notify(turn: _LocalTurn) -> None:
        """Wake readers waiting on ``turn`` and arm a fresh wait event.

        Args:
            turn: Turn whose readers to wake.
        """
        turn.changed.set()
        turn.changed = asyncio.Event()

    async def _run(self, turn: _LocalTurn, source: AsyncIterable[dict[str, Any]]) -> None:
        """Drive the turn's source to completion and record its outcome.

        Args:
            turn: Turn being run.
            source: The metered event stream.
        """
        sync = asyncio.create_task(self._sync_loop(turn))
        status = STATUS_FINISHED
        try:
            async for event in source:
                self._append(turn, event["event"], event["data"])
        except asyncio.CancelledError:
            status = STATUS_CANCELLED
            self._append(turn, "error", dict(_CANCELLED_DATA))
        except Exception:
            logger.exception("Agent turn %s failed", turn.turn_id)
            self._append(turn, "error", dict(_FAILED_DATA))
        finally:
            turn.ending = True
            self._append(turn, TURN_END_EVENT, {"status": status})
            turn.stop_sync.set()
            await sync
            if turn.durable:
                try:
                    await asyncio.to_thread(self._mark_done, turn.turn_id, status)
                except Exception:
                    logger.exception("Failed to close agent turn %s", turn.turn_id)
            turn.finished = True
            self._notify(turn)
            asyncio.get_running_loop().call_later(_LOCAL_RETENTION_SECONDS, self._turns.pop, turn.turn_id, None)

    async def _sync_loop(self, turn: _LocalTurn) -> None:
        """Flush events, beat the heartbeat and act on stop requests until told to stop.

        Args:
            turn: Turn to keep in sync with the shared store.
        """
        last_beat = 0.0
        while True:
            try:
                await asyncio.wait_for(turn.stop_sync.wait(), timeout=_FLUSH_SECONDS)
                stopping = True
            except TimeoutError:
                stopping = False
            await self._flush(turn)
            if stopping:
                return
            if time.monotonic() - last_beat < _HEARTBEAT_SECONDS:
                continue
            last_beat = time.monotonic()
            remote_read = 0.0
            if turn.durable:
                try:
                    cancel_requested, remote_read = await asyncio.to_thread(self._heartbeat, turn.turn_id)
                except Exception:
                    logger.exception("Agent turn %s heartbeat failed", turn.turn_id)
                    continue
                if cancel_requested:
                    self._cancel_task(turn)
                    continue
            if turn.readers == 0 and time.time() - max(turn.last_read, remote_read) > _ABANDON_SECONDS:
                logger.info("Cancelling abandoned agent turn %s", turn.turn_id)
                self._cancel_task(turn)

    @staticmethod
    def _cancel_task(turn: _LocalTurn) -> bool:
        """Cancel the turn's run task if it is still producing events.

        A turn already writing its ending is left alone: cancelling it there
        would interrupt the final flush and leave its readers waiting.

        Args:
            turn: Turn to stop.

        Returns:
            True when a cancellation was delivered.
        """
        if turn.ending or turn.task is None or turn.task.done():
            return False
        turn.task.cancel()
        return True

    async def _flush(self, turn: _LocalTurn) -> None:
        """Persist buffered events in order; keep them buffered on failure.

        Only the turn's sync loop calls this, so batches never commit out of
        order — a remote reader's ``seq > after`` query can never skip a gap.

        Args:
            turn: Turn whose buffered events to write.
        """
        if not turn.unflushed:
            return
        batch = list(turn.unflushed)
        try:
            await asyncio.to_thread(self._insert_events, turn.turn_id, batch)
        except Exception:
            logger.exception("Failed to persist events of agent turn %s", turn.turn_id)
            return
        del turn.unflushed[: len(batch)]

    async def _stream_local(self, turn: _LocalTurn, after_seq: int, deadline: float) -> AsyncIterator[dict[str, Any]]:
        """Read a turn owned by this replica straight from memory.

        Args:
            turn: The local turn.
            after_seq: Last ``seq`` the client holds.
            deadline: ``time.monotonic()`` at which to end the response.

        Yields:
            The turn's events after ``after_seq``.
        """
        index = max(0, after_seq)
        turn.readers += 1
        try:
            while True:
                while index < len(turn.events):
                    event = turn.events[index]
                    index += 1
                    yield event
                if turn.finished:
                    return
                # No await between the length check and capturing the event,
                # so an append cannot slip in unnoticed.
                waiter = turn.changed
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                try:
                    await asyncio.wait_for(waiter.wait(), timeout=remaining)
                except TimeoutError:
                    return
        finally:
            turn.readers -= 1
            turn.last_read = time.time()

    async def _stream_remote(self, turn_id: str, after_seq: int, deadline: float) -> AsyncIterator[dict[str, Any]]:
        """Read a turn owned by another replica by polling the shared store.

        Args:
            turn_id: Turn to read.
            after_seq: Last ``seq`` the client holds.
            deadline: ``time.monotonic()`` at which to end the response.

        Yields:
            The turn's events after ``after_seq``, or a synthetic error plus
            ``turn_end`` when the owning replica is gone.
        """
        last_touch = 0.0
        while True:
            touch = time.monotonic() - last_touch >= _HEARTBEAT_SECONDS
            if touch:
                last_touch = time.monotonic()
            status, heartbeat, rows = await asyncio.to_thread(self._read_remote, turn_id, after_seq, touch)
            for seq, name, data in rows:
                after_seq = seq
                yield {"id": seq, "event": name, "data": json.loads(data)}
                if name == TURN_END_EVENT:
                    return
            if not rows:
                owner_gone = time.time() - _as_utc_timestamp(heartbeat) > _STALE_OWNER_SECONDS
                if status is None or status != STATUS_RUNNING or owner_gone:
                    yield {"event": "error", "data": dict(_LOST_DATA)}
                    yield {"event": TURN_END_EVENT, "data": {"status": STATUS_CANCELLED}}
                    return
            if time.monotonic() >= deadline:
                return
            if len(rows) < _REMOTE_BATCH:
                await asyncio.sleep(_REMOTE_POLL_SECONDS)

    def _insert_turn(self, turn_id: str, owner: str) -> None:
        """Create the turn row and purge turns idle past the retention window.

        Args:
            turn_id: New turn's id.
            owner: Username the turn belongs to.
        """
        now = datetime.now(UTC)
        cutoff = now - timedelta(seconds=_RETENTION_SECONDS)
        with Session(self._engine) as session:
            stale = select(AgentTurnModel.turn_id).where(AgentTurnModel.heartbeat_at < cutoff)
            session.execute(delete(AgentTurnEventModel).where(AgentTurnEventModel.turn_id.in_(stale)))
            session.execute(delete(AgentTurnModel).where(AgentTurnModel.heartbeat_at < cutoff))
            session.add(
                AgentTurnModel(
                    turn_id=turn_id,
                    owner=owner,
                    status=STATUS_RUNNING,
                    cancel_requested=False,
                    created_at=now,
                    heartbeat_at=now,
                    last_read_at=now,
                )
            )
            session.commit()

    def _insert_events(self, turn_id: str, events: list[dict[str, Any]]) -> None:
        """Write a batch of numbered events.

        Args:
            turn_id: Turn the events belong to.
            events: ``{"id", "event", "data"}`` mappings in ``seq`` order.
        """
        with Session(self._engine) as session:
            session.add_all(
                AgentTurnEventModel(
                    turn_id=turn_id,
                    seq=event["id"],
                    event=event["event"],
                    data=json.dumps(event["data"], ensure_ascii=False, default=str),
                )
                for event in events
            )
            session.commit()

    def _heartbeat(self, turn_id: str) -> tuple[bool, float]:
        """Refresh the owner heartbeat and read the cross-replica signals.

        Args:
            turn_id: Turn owned by this replica.

        Returns:
            ``(cancel_requested, last_read_at)`` with the read time in POSIX
            seconds; ``(False, 0.0)`` when the row is gone.
        """
        with Session(self._engine) as session:
            row = session.get(AgentTurnModel, turn_id)
            if row is None:
                return False, 0.0
            row.heartbeat_at = datetime.now(UTC)
            cancel_requested, last_read = bool(row.cancel_requested), _as_utc_timestamp(row.last_read_at)
            session.commit()
            return cancel_requested, last_read

    def _mark_done(self, turn_id: str, status: str) -> None:
        """Record a turn's final status once all its events are written.

        Args:
            turn_id: Finished turn.
            status: ``finished`` or ``cancelled``.
        """
        with Session(self._engine) as session:
            session.execute(
                update(AgentTurnModel)
                .where(AgentTurnModel.turn_id == turn_id)
                .values(status=status, heartbeat_at=datetime.now(UTC))
            )
            session.commit()

    def _owner_of(self, turn_id: str) -> str | None:
        """Look up a turn's owner in the shared store.

        Args:
            turn_id: Turn to look up.

        Returns:
            The owner's username, or ``None`` when the turn is unknown.
        """
        with Session(self._engine) as session:
            return session.scalar(select(AgentTurnModel.owner).where(AgentTurnModel.turn_id == turn_id))

    def _request_cancel(self, turn_id: str, owner: str) -> bool:
        """Flag a running turn for its owning replica to cancel.

        Args:
            turn_id: Turn to stop.
            owner: Username of the caller.

        Returns:
            True when a running turn of ``owner`` was flagged.
        """
        with Session(self._engine) as session:
            result = session.execute(
                update(AgentTurnModel)
                .where(
                    AgentTurnModel.turn_id == turn_id,
                    AgentTurnModel.owner == owner,
                    AgentTurnModel.status == STATUS_RUNNING,
                )
                .values(cancel_requested=True)
            )
            session.commit()
            return bool(result.rowcount)

    def _read_remote(
        self, turn_id: str, after_seq: int, touch: bool
    ) -> tuple[str | None, datetime | None, list[tuple[int, str, str]]]:
        """Read a remote turn's status, heartbeat and next events.

        The status is read before the events: the owner writes its final
        status only after its last event, so a non-running status paired
        with an empty batch means nothing more will arrive.

        Args:
            turn_id: Turn to read.
            after_seq: Return only events with a larger ``seq``.
            touch: Whether to record this read as reader activity.

        Returns:
            ``(status, heartbeat_at, rows)``; ``status`` is ``None`` when the
            turn row no longer exists.
        """
        with Session(self._engine) as session:
            row = session.get(AgentTurnModel, turn_id)
            if row is None:
                return None, None, []
            status, heartbeat = row.status, row.heartbeat_at
            if touch:
                row.last_read_at = datetime.now(UTC)
            rows = session.execute(
                select(AgentTurnEventModel.seq, AgentTurnEventModel.event, AgentTurnEventModel.data)
                .where(AgentTurnEventModel.turn_id == turn_id, AgentTurnEventModel.seq > after_seq)
                .order_by(AgentTurnEventModel.seq)
                .limit(_REMOTE_BATCH)
            ).all()
            session.commit()
            return status, heartbeat, [(int(seq), str(name), str(data)) for seq, name, data in rows]
