"""Persistence seam for the sandboxed agent runs of black-box jobs.

The worker receives each run's record from the job subprocess: a full row
when the run starts and ends, transcript deltas in between. This store keeps
the rows in ``blackbox_agent_runs``, keyed by ``(optimization_id, run_id)``,
and serves them to the run view.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from .models import BlackboxAgentRunModel

_TEXT_FIELDS = ("output", "transcript")


def _json_bytes(value: Any) -> int:
    """Return the compact-JSON UTF-8 byte length used for storage accounting."""
    return len(json.dumps(value, separators=(",", ":"), default=str).encode("utf-8"))


def _parse_timestamp(value: Any) -> datetime | None:
    """Return an ISO timestamp as an aware datetime, or ``None`` when absent or unreadable."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _iso(value: datetime | None) -> str | None:
    """Return a stored timestamp as an aware ISO string; SQLite hands back naive UTC."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


def _row_bytes(run: dict[str, Any]) -> int:
    """Return the storage footprint of one run record.

    Args:
        run: The record as the recorder sends it.

    Returns:
        The byte length of its texts plus its usage and check JSON.
    """
    texts = sum(len(str(run.get(field) or "").encode("utf-8")) for field in _TEXT_FIELDS)
    return texts + _json_bytes(run.get("usage") or {}) + _json_bytes(run.get("check"))


class PostgresAgentRunStore:
    """Agent run records in ``blackbox_agent_runs``, keyed by ``(optimization_id, run_id)``."""

    def __init__(self, engine: Engine) -> None:
        """Bind the store to a SQLAlchemy engine.

        Args:
            engine: Engine whose schema carries ``blackbox_agent_runs``.
        """
        self._engine = engine

    def save(self, optimization_id: str, run: dict[str, Any]) -> None:
        """Insert or replace one run's record.

        Args:
            optimization_id: Owning job id.
            run: The record as the recorder sends it, keyed by ``run_id``.
        """
        run_id = int(run["run_id"])
        fields = {
            "phase": str(run.get("phase") or ""),
            "trial": run.get("trial"),
            "example_id": None if run.get("example_id") is None else str(run["example_id"]),
            "case_id": None if run.get("case_id") is None else str(run["case_id"])[:255],
            "label": str(run.get("label") or "")[:255],
            "status": str(run.get("status") or ""),
            "started_at": _parse_timestamp(run.get("started_at")),
            "finished_at": _parse_timestamp(run.get("finished_at")),
            "model": None if run.get("model") is None else str(run["model"])[:255],
            "exit_code": run.get("exit_code"),
            "timed_out": bool(run.get("timed_out")),
            "elapsed_seconds": run.get("elapsed_seconds"),
            "error": run.get("error"),
            "usage": dict(run.get("usage") or {}),
            "check_result": run.get("check"),
            "output": run.get("output"),
            "transcript": str(run.get("transcript") or ""),
            "stored_bytes": _row_bytes(run),
            "updated_at": datetime.now(UTC),
        }
        with Session(self._engine) as session:
            existing = session.get(BlackboxAgentRunModel, (optimization_id, run_id))
            if existing is None:
                session.add(BlackboxAgentRunModel(optimization_id=optimization_id, run_id=run_id, **fields))
            else:
                for name, value in fields.items():
                    setattr(existing, name, value)
            session.commit()

    def append_transcript(self, optimization_id: str, run_id: int, text: str) -> None:
        """Add a piece of live transcript to a run that is still going.

        Args:
            optimization_id: Owning job id.
            run_id: The run's ordinal within the job.
            text: The new transcript text.
        """
        if not text:
            return
        with Session(self._engine) as session:
            session.execute(
                update(BlackboxAgentRunModel)
                .where(
                    BlackboxAgentRunModel.optimization_id == optimization_id,
                    BlackboxAgentRunModel.run_id == run_id,
                )
                .values(
                    transcript=BlackboxAgentRunModel.transcript + text,
                    stored_bytes=BlackboxAgentRunModel.stored_bytes + len(text.encode("utf-8")),
                    updated_at=datetime.now(UTC),
                )
            )
            session.commit()

    def get(self, optimization_id: str, run_id: int) -> dict[str, Any] | None:
        """Return one run's record, or ``None``.

        Args:
            optimization_id: Owning job id.
            run_id: The run's ordinal within the job.

        Returns:
            The record with ISO timestamps, or ``None`` when no row exists.
        """
        with Session(self._engine) as session:
            row = session.get(BlackboxAgentRunModel, (optimization_id, run_id))
            return None if row is None else self._to_record(row)

    @staticmethod
    def _to_record(row: BlackboxAgentRunModel) -> dict[str, Any]:
        """Project an ORM row onto the record shape the recorder sends."""
        return {
            "run_id": row.run_id,
            "phase": row.phase,
            "trial": row.trial,
            "example_id": row.example_id,
            "case_id": row.case_id,
            "label": row.label,
            "status": row.status,
            "started_at": _iso(row.started_at),
            "finished_at": _iso(row.finished_at),
            "model": row.model,
            "exit_code": row.exit_code,
            "timed_out": row.timed_out,
            "elapsed_seconds": row.elapsed_seconds,
            "error": row.error,
            "usage": dict(row.usage or {}),
            "check": row.check_result,
            "output": row.output,
            "transcript": row.transcript or "",
        }
