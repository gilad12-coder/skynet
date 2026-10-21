"""Move one finished run from the Mac app to the hosted account.

The sync is one-way and manual. The local app exports a run as a JSON bundle;
the hosted app imports that bundle as a new, read-only run owned by the caller.
The import trusts nothing in the bundle that names an owner, a budget or a
database row: it mints a fresh id, writes the caller as the owner, drops the
training payload (so the run can never be queued again), and writes no wallet,
ledger or budget rows.
"""

from __future__ import annotations

import base64
import binascii
import json
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from ..config import settings
from ..constants import (
    OPTIMIZATION_TYPE_BLACKBOX,
    OPTIMIZATION_TYPE_RUN,
    PAYLOAD_OVERVIEW_COMPOSITION,
    PAYLOAD_OVERVIEW_DESCRIPTION,
    PAYLOAD_OVERVIEW_ESTIMATED_HIGH,
    PAYLOAD_OVERVIEW_ESTIMATED_LOW,
    PAYLOAD_OVERVIEW_MAX_COST_CENTS,
    PAYLOAD_OVERVIEW_NAME,
    PAYLOAD_OVERVIEW_OPTIMIZATION_TYPE,
    PAYLOAD_OVERVIEW_SOURCE_DATASET_ID,
    PAYLOAD_OVERVIEW_USERNAME,
)
from ..models import BlackboxRunResponse, RunResponse
from ..storage.models import JobModel, ProgressEventModel
from ..storage.usage import json_byte_size

SCHEMA_VERSION = "skynet.run-export/v1"
MAX_BUNDLE_BYTES = 50 * 1024 * 1024
IMPORT_LABEL = "imported from desktop"
IMPORTED_FROM_KEY = "imported_from"
IMPORTED_FROM_DESKTOP = "desktop"
PROGRAM_ARTIFACT_NAME = "program_artifact.json"

_SYNCABLE_STATUSES = frozenset({"success", "failed", "cancelled", "stopped"})
_SYNCABLE_TYPES = frozenset({OPTIMIZATION_TYPE_RUN, OPTIMIZATION_TYPE_BLACKBOX})
_RESULT_STATUSES = frozenset({"success", "stopped"})
# Keys that point at rows or money on the exporting machine. Kept off the hosted
# copy so an import can never claim another user's dataset, a stale spending
# ceiling, or an owner other than the caller.
_DROPPED_OVERVIEW_KEYS = frozenset(
    {
        PAYLOAD_OVERVIEW_USERNAME,
        PAYLOAD_OVERVIEW_SOURCE_DATASET_ID,
        PAYLOAD_OVERVIEW_MAX_COST_CENTS,
        PAYLOAD_OVERVIEW_ESTIMATED_LOW,
        PAYLOAD_OVERVIEW_ESTIMATED_HIGH,
        "pinned",
        IMPORTED_FROM_KEY,
    }
)
# A pickle in an uploaded bundle is attacker-chosen bytes, and ``path`` names a
# file on the exporting machine; neither belongs in a hosted artifact.
_DROPPED_ARTIFACT_KEYS = frozenset({"program_pickle_base64", "path"})
_MAX_MESSAGE_CHARS = 10_000


class RunSyncError(Exception):
    """A sync request the caller can fix, carrying the i18n key and HTTP status."""

    def __init__(self, code: str, http_status: int, /, **params: Any) -> None:
        """Build the error.

        Args:
            code: The ``sync.*`` or ``optimization.*`` i18n key.
            http_status: HTTP status the router answers with.
            **params: Substitution params for the message.
        """
        super().__init__(code)
        self.code = code
        self.http_status = http_status
        self.params = params


# Internal bundle validation only; never used as a FastAPI body, so no OpenAPI impact.
class _BundleEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    timestamp: str | None = None
    event: str | None = Field(default=None, max_length=255)
    metrics: dict[str, Any] = Field(default_factory=dict)


class _BundleJob(BaseModel):
    model_config = ConfigDict(extra="ignore")

    status: Literal["success", "failed", "cancelled", "stopped"]
    created_at: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    message: str | None = None
    latest_metrics: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] | None = None
    stop_reason: str | None = Field(default=None, max_length=32)
    result_availability: str | None = Field(default=None, max_length=16)
    terminal_evidence: dict[str, Any] | None = None
    accumulated_runtime_seconds: float = Field(default=0.0, ge=0)


class _BundleOptimization(BaseModel):
    model_config = ConfigDict(extra="ignore")

    optimization_type: Literal["run", "blackbox"]
    payload_overview: dict[str, Any] = Field(default_factory=dict)


class _Bundle(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema_: Literal["skynet.run-export/v1"] = Field(alias="schema")
    optimization: _BundleOptimization
    job: _BundleJob
    events: list[_BundleEvent] = Field(default_factory=list)
    artifacts: dict[str, str] = Field(default_factory=dict)


def _iso(value: Any) -> str | None:
    """Render a stored timestamp as ISO-8601 text.

    Args:
        value: A ``datetime``, an ISO string, or ``None``.

    Returns:
        The ISO string, or ``None``.
    """
    if isinstance(value, datetime):
        return value.isoformat()
    return value if isinstance(value, str) else None


def export_run(job_store, username: str, optimization_id: str) -> dict[str, Any]:
    """Build the export bundle for one finished run the caller owns.

    Args:
        job_store: The local job store.
        username: The signed-in local user.
        optimization_id: The run to export.

    Returns:
        The ``skynet.run-export/v1`` bundle as a JSON-safe dict.

    Raises:
        RunSyncError: 404 when the run is missing or not the caller's, 409 when
            it is still active or of a type the sync does not carry.
    """
    try:
        job = job_store.get_job(optimization_id)
    except KeyError:
        raise RunSyncError("optimization.not_found", 404, optimization_id=optimization_id) from None
    overview = dict(job.get("payload_overview") or {})
    owner = str(overview.get(PAYLOAD_OVERVIEW_USERNAME) or job.get("username") or "").strip().lower()
    if job.get("parent_optimization_id") or owner != username.strip().lower():
        raise RunSyncError("optimization.not_found", 404, optimization_id=optimization_id)

    status = str(job.get("status") or "")
    if status not in _SYNCABLE_STATUSES:
        raise RunSyncError("sync.export_not_finished", 409, status=status)
    optimization_type = overview.get(PAYLOAD_OVERVIEW_OPTIMIZATION_TYPE) or job.get("optimization_type")
    optimization_type = optimization_type or OPTIMIZATION_TYPE_RUN
    if optimization_type not in _SYNCABLE_TYPES:
        raise RunSyncError("sync.unsupported_run_type", 409, optimization_type=str(optimization_type))

    result = dict(job["result"]) if isinstance(job.get("result"), dict) else None
    artifacts: dict[str, str] = {}
    if result is not None and result.get("program_artifact") is not None:
        encoded = json.dumps(result.pop("program_artifact"), separators=(",", ":"), default=str).encode("utf-8")
        artifacts[PROGRAM_ARTIFACT_NAME] = base64.b64encode(encoded).decode("ascii")
    overview.pop(PAYLOAD_OVERVIEW_USERNAME, None)

    return {
        "schema": SCHEMA_VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "source": {"local_mode": bool(settings.local_mode), "app_version": settings.code_version},
        "optimization": {
            "source_optimization_id": optimization_id,
            "optimization_type": optimization_type,
            "payload_overview": overview,
        },
        "job": {
            "status": status,
            "created_at": _iso(job.get("created_at")),
            "started_at": _iso(job.get("started_at")),
            "completed_at": _iso(job.get("completed_at")),
            "message": job.get("message"),
            "latest_metrics": job.get("latest_metrics") or {},
            "result": result,
            "stop_reason": job.get("stop_reason"),
            "result_availability": job.get("result_availability"),
            "terminal_evidence": job.get("terminal_evidence"),
            "accumulated_runtime_seconds": float(job.get("accumulated_runtime_seconds") or 0.0),
        },
        "events": [dict(event) for event in job_store.get_progress_events(optimization_id)],
        "artifacts": artifacts,
    }


def _parse_time(value: str | None, *, default: datetime | None) -> datetime | None:
    """Parse a bundle timestamp, reading a naive value as UTC.

    Args:
        value: ISO-8601 text from the bundle, or ``None``.
        default: Value used when ``value`` is ``None``.

    Returns:
        An aware ``datetime``, or ``default``.

    Raises:
        RunSyncError: 422 ``sync.invalid_bundle`` for text that is not ISO-8601.
    """
    if value is None:
        return default
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise RunSyncError("sync.invalid_bundle", 422) from None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _decode_program_artifact(artifacts: dict[str, str]) -> dict[str, Any] | None:
    """Decode the program artifact and drop the fields a hosted copy must not keep.

    Args:
        artifacts: The bundle's ``{name: base64}`` map.

    Returns:
        The cleaned artifact mapping, or ``None`` when the bundle has none.

    Raises:
        RunSyncError: 422 ``sync.invalid_bundle`` for bad base64 or JSON.
    """
    encoded = artifacts.get(PROGRAM_ARTIFACT_NAME)
    if encoded is None:
        return None
    try:
        artifact = json.loads(base64.b64decode(encoded, validate=True))
    except (binascii.Error, ValueError):
        raise RunSyncError("sync.invalid_bundle", 422) from None
    if not isinstance(artifact, dict):
        raise RunSyncError("sync.invalid_bundle", 422)
    return {key: value for key, value in artifact.items() if key not in _DROPPED_ARTIFACT_KEYS}


def _imported_overview(overview: dict[str, Any], optimization_type: str, username: str) -> dict[str, Any]:
    """Rebuild the payload overview for the caller's read-only copy.

    Args:
        overview: The exported overview.
        optimization_type: The validated run type.
        username: The hosted caller who will own the copy.

    Returns:
        The overview to store, labelled as imported and owned by ``username``.
    """
    cleaned = {key: value for key, value in overview.items() if key not in _DROPPED_OVERVIEW_KEYS}
    description = cleaned.get(PAYLOAD_OVERVIEW_DESCRIPTION)
    if isinstance(description, str) and description.strip():
        cleaned[PAYLOAD_OVERVIEW_DESCRIPTION] = f"{description.strip()} ({IMPORT_LABEL})"
    else:
        cleaned[PAYLOAD_OVERVIEW_DESCRIPTION] = IMPORT_LABEL
    if not isinstance(cleaned.get(PAYLOAD_OVERVIEW_NAME), str):
        cleaned.pop(PAYLOAD_OVERVIEW_NAME, None)
    cleaned[PAYLOAD_OVERVIEW_USERNAME] = username
    cleaned[PAYLOAD_OVERVIEW_OPTIMIZATION_TYPE] = optimization_type
    cleaned[IMPORTED_FROM_KEY] = IMPORTED_FROM_DESKTOP
    return cleaned


def _validated_result(bundle: _Bundle) -> dict[str, Any] | None:
    """Return the result to store, checked against the response model the detail page reads.

    Args:
        bundle: The validated bundle.

    Returns:
        The result mapping with its cleaned program artifact, or ``None``.

    Raises:
        RunSyncError: 422 ``sync.invalid_bundle`` when the result does not parse.
    """
    result = dict(bundle.job.result) if bundle.job.result is not None else None
    if result is not None:
        result.pop("program_artifact_path", None)
    artifact = _decode_program_artifact(bundle.artifacts)
    if artifact is not None:
        if result is None:
            raise RunSyncError("sync.invalid_bundle", 422)
        result["program_artifact"] = artifact
    if result is not None and bundle.job.status in _RESULT_STATUSES:
        model = (
            BlackboxRunResponse if bundle.optimization.optimization_type == OPTIMIZATION_TYPE_BLACKBOX else RunResponse
        )
        try:
            model.model_validate(result)
        except ValidationError:
            raise RunSyncError("sync.invalid_bundle", 422) from None
    return result


def import_run(job_store, username: str, bundle: dict) -> str:
    """Create a read-only copy of an exported run under the caller.

    The job row and its progress events are written in one transaction, already
    terminal and with no payload, so no worker can ever claim the copy and no
    budget, wallet or ledger row is touched.

    Args:
        job_store: The hosted job store; it must expose its SQLAlchemy ``engine``.
        username: The authenticated hosted caller.
        bundle: The decoded export bundle.

    Returns:
        The new optimization id.

    Raises:
        RunSyncError: 422 ``sync.unsupported_schema`` for another schema version
            and 422 ``sync.invalid_bundle`` for a malformed bundle.
    """
    if not isinstance(bundle, dict):
        raise RunSyncError("sync.invalid_bundle", 422)
    if bundle.get("schema") != SCHEMA_VERSION:
        raise RunSyncError("sync.unsupported_schema", 422, schema=str(bundle.get("schema"))[:64])
    try:
        parsed = _Bundle.model_validate(bundle)
    except ValidationError:
        raise RunSyncError("sync.invalid_bundle", 422) from None

    now = datetime.now(UTC)
    optimization_type = parsed.optimization.optimization_type
    overview = _imported_overview(parsed.optimization.payload_overview, optimization_type, username)
    result = _validated_result(parsed)
    created_at = _parse_time(parsed.job.created_at, default=now) or now
    started_at = _parse_time(parsed.job.started_at, default=None)
    completed_at = _parse_time(parsed.job.completed_at, default=created_at)
    message = parsed.job.message[:_MAX_MESSAGE_CHARS] if parsed.job.message else None
    composition = overview.get(PAYLOAD_OVERVIEW_COMPOSITION)

    events = parsed.events[-settings.progress_events_per_job_cap :] if settings.progress_events_per_job_cap else []
    event_rows = [
        (_parse_time(event.timestamp, default=completed_at) or now, event.event, event.metrics) for event in events
    ]

    optimization_id = str(uuid4())
    job = JobModel(
        optimization_id=optimization_id,
        status=parsed.job.status,
        created_at=created_at,
        started_at=started_at,
        completed_at=completed_at,
        message=message,
        latest_metrics=parsed.job.latest_metrics,
        result=result,
        payload_overview=overview,
        payload=None,
        username=username,
        optimization_type=optimization_type,
        composition=composition if isinstance(composition, str) and len(composition) <= 32 else None,
        attempts=0,
        # The run finished on the desktop; mark it notified so no completion email fires for the copy.
        notified_at=now,
        stop_reason=parsed.job.stop_reason,
        result_availability=parsed.job.result_availability,
        terminal_evidence=parsed.job.terminal_evidence,
        accumulated_runtime_seconds=parsed.job.accumulated_runtime_seconds,
        stored_bytes=json_byte_size(result) + json_byte_size(overview),
    )
    with Session(job_store.engine) as session:
        session.add(job)
        session.flush()
        session.add_all(
            ProgressEventModel(optimization_id=optimization_id, timestamp=timestamp, event=event, metrics=metrics)
            for timestamp, event, metrics in event_rows
        )
        session.commit()
    return optimization_id
