"""Tests for desktop run sync: export a local run, import it into the hosted account.

Both sides run on a real ``RemoteDBJobStore`` over in-memory SQLite, so the
import writes real job and progress rows and the hosted listing, detail and
artifact routes read them back through their normal code paths.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

import core.storage.remote as remote_mod

from ...config import settings
from ...i18n_en import t_en
from ...service_gateway import run_sync
from ...storage.models import Base, ExecutionBudgetModel, JobModel, ProgressEventModel, WalletLedgerModel
from ...storage.remote import RemoteDBJobStore
from ..auth import AuthenticatedUser
from ..routers.optimizations import create_optimizations_router
from .conftest import bypass_auth

DESK_USER = AuthenticatedUser(username="desk-user", role="user", groups=())
HOSTED_USER = AuthenticatedUser(username="bob", role="user", groups=())
_PROGRAM_STATE = {"predict": {"signature": {"instructions": "Answer briefly."}, "demos": []}}


class _SQLiteJobStore(RemoteDBJobStore):
    """RemoteDBJobStore on an in-memory SQLite engine, skipping PostgreSQL-only setup."""

    def __init__(self) -> None:
        """Create the engine and every ORM table."""
        self._engine = create_engine(
            "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(self._engine)
        self._session_factory = sessionmaker(bind=self._engine)
        self._checkpoints = remote_mod.PostgresCheckpointBlobStore(self._engine)
        self._grid_pair_results = remote_mod.PostgresGridPairResultStore(self._engine)
        self._agent_runs = remote_mod.PostgresAgentRunStore(self._engine)


def _client(store: _SQLiteJobStore, user: AuthenticatedUser) -> TestClient:
    """Build a client over the optimizations router for ``user``.

    Args:
        store: Job store the router reads and writes.
        user: Identity every request authenticates as.

    Returns:
        A ``TestClient`` that returns error responses instead of raising.
    """
    app = FastAPI()
    app.include_router(create_optimizations_router(job_store=store, get_worker_ref=lambda: None))
    bypass_auth(app, user=user)
    return TestClient(app, raise_server_exceptions=False)


def _seed_finished_run(store: _SQLiteJobStore, optimization_id: str = "local-run-1", status: str = "success") -> None:
    """Write a finished local run with a result, artifact and progress events.

    Args:
        store: The local job store.
        optimization_id: Id of the run to create.
        status: Terminal or active status to leave the run in.
    """
    store.create_job(optimization_id, username=DESK_USER.username)
    store.set_payload_overview(
        optimization_id,
        {
            "name": "Desk run",
            "description": "Support triage",
            "username": DESK_USER.username,
            "optimization_type": "run",
            "module_name": "predict",
            "optimizer_name": "gepa",
            "model_name": "openai/gpt-4o-mini",
            "max_cost_cents": 500,
            "estimated_cents_low": 10,
            "estimated_cents_high": 40,
            "source_dataset_id": "local-dataset-9",
        },
    )
    store.record_progress(optimization_id, "baseline", {"baseline_test_metric": 0.41})
    store.record_progress(optimization_id, "done", {"optimized_test_metric": 0.82})
    store.update_job(
        optimization_id,
        status=status,
        message="Finished",
        latest_metrics={"baseline_test_metric": 0.41, "optimized_test_metric": 0.82},
        result={
            "module_name": "predict",
            "optimizer_name": "gepa",
            "metric_name": "accuracy",
            "split_counts": {"train": 6, "val": 2, "test": 2},
            "baseline_test_metric": 0.41,
            "optimized_test_metric": 0.82,
            "metric_improvement": 0.41,
            "program_artifact_path": "/Users/desk/runs/local-run-1",
            "program_artifact": {
                "path": "/Users/desk/runs/local-run-1/program.json",
                "program_state_json": _PROGRAM_STATE,
                "program_pickle_base64": base64.b64encode(b"not-a-real-pickle").decode(),
            },
        },
    )


@pytest.fixture
def local_store() -> _SQLiteJobStore:
    """Provide the local (Mac app) job store with one finished run."""
    store = _SQLiteJobStore()
    _seed_finished_run(store)
    return store


@pytest.fixture
def hosted_store() -> _SQLiteJobStore:
    """Provide an empty hosted job store."""
    return _SQLiteJobStore()


@pytest.fixture
def bundle(local_store: _SQLiteJobStore, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Export the seeded run through the local-mode route.

    Args:
        local_store: The local job store with the seeded run.
        monkeypatch: Pytest fixture used to switch local mode on for the export.

    Returns:
        The exported bundle.
    """
    monkeypatch.setattr(settings, "local_mode", True)
    resp = _client(local_store, DESK_USER).get("/optimizations/local-run-1/export")
    assert resp.status_code == 200, resp.text
    monkeypatch.setattr(settings, "local_mode", False)
    return resp.json()


def _import(store: _SQLiteJobStore, payload: Any, user: AuthenticatedUser = HOSTED_USER) -> Any:
    """Post ``payload`` to the hosted import route.

    Args:
        store: The hosted job store.
        payload: Bundle to send as JSON.
        user: The hosted caller.

    Returns:
        The HTTP response.
    """
    return _client(store, user).post("/optimizations/import", content=json.dumps(payload))


def _count(store: _SQLiteJobStore, model: type) -> int:
    """Count the rows of ``model`` in ``store``.

    Args:
        store: The job store to query.
        model: ORM model whose table is counted.

    Returns:
        The row count.
    """
    with Session(store.engine) as session:
        return session.scalar(select(func.count()).select_from(model)) or 0


def test_export_bundle_shape(bundle: dict[str, Any]) -> None:
    """The bundle follows the v1 contract and leaves owner and cost data behind."""
    assert bundle["schema"] == run_sync.SCHEMA_VERSION
    assert bundle["source"]["local_mode"] is True
    assert bundle["job"]["status"] == "success"
    assert "username" not in bundle["optimization"]["payload_overview"]
    assert "program_artifact" not in bundle["job"]["result"]
    assert [event["event"] for event in bundle["events"]] == ["baseline", "done"]
    artifact = json.loads(base64.b64decode(bundle["artifacts"][run_sync.PROGRAM_ARTIFACT_NAME]))
    assert artifact["program_state_json"] == _PROGRAM_STATE


def test_round_trip_shows_same_scores_and_artifact(hosted_store: _SQLiteJobStore, bundle: dict[str, Any]) -> None:
    """An imported run appears in the hosted listing and detail with the same scores and program."""
    resp = _import(hosted_store, bundle)
    assert resp.status_code == 201, resp.text
    new_id = resp.json()["optimization_id"]
    assert new_id != "local-run-1"

    client = _client(hosted_store, HOSTED_USER)
    listing = client.get("/optimizations")
    assert listing.status_code == 200, listing.text
    assert [item["optimization_id"] for item in listing.json()["items"]] == [new_id]

    detail = client.get(f"/optimizations/{new_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["status"] == "success"
    assert body["result"]["baseline_test_metric"] == 0.41
    assert body["result"]["optimized_test_metric"] == 0.82
    assert body["description"] == f"Support triage ({run_sync.IMPORT_LABEL})"
    assert len(body["progress_events"]) == 2

    artifact = client.get(f"/optimizations/{new_id}/artifact")
    assert artifact.status_code == 200, artifact.text
    program = artifact.json()["program_artifact"]
    assert program["program_state_json"] == _PROGRAM_STATE
    assert program["program_pickle_base64"] is None
    assert program["path"] is None


def test_import_lands_under_caller_and_ignores_bundle_identity(
    hosted_store: _SQLiteJobStore, bundle: dict[str, Any]
) -> None:
    """Owner, ids, dataset links and cost ceilings in the bundle never reach the hosted row."""
    bundle["optimization"]["payload_overview"].update(username="mallory", optimization_id="victim-run")
    bundle["optimization"]["source_optimization_id"] = "victim-run"
    bundle["job"]["username"] = "mallory"
    bundle["job"]["execution_budget_id"] = "budget-123"
    resp = _import(hosted_store, bundle)
    assert resp.status_code == 201, resp.text
    job = hosted_store.get_job(resp.json()["optimization_id"])
    overview = job["payload_overview"]
    assert job["username"] == HOSTED_USER.username
    assert overview["username"] == HOSTED_USER.username
    assert overview[run_sync.IMPORTED_FROM_KEY] == run_sync.IMPORTED_FROM_DESKTOP
    for dropped in ("max_cost_cents", "estimated_cents_low", "estimated_cents_high", "source_dataset_id"):
        assert dropped not in overview
    assert job["payload"] is None
    assert job["execution_budget_id"] is None
    assert job["result"].get("program_artifact_path") is None
    with pytest.raises(KeyError):
        hosted_store.get_job("victim-run")


def test_import_makes_no_wallet_or_budget_rows(hosted_store: _SQLiteJobStore, bundle: dict[str, Any]) -> None:
    """Importing writes job and progress rows only, never money rows."""
    assert _import(hosted_store, bundle).status_code == 201
    assert _count(hosted_store, WalletLedgerModel) == 0
    assert _count(hosted_store, ExecutionBudgetModel) == 0
    assert _count(hosted_store, JobModel) == 1
    assert _count(hosted_store, ProgressEventModel) == 2


def test_imported_run_cannot_be_requeued(hosted_store: _SQLiteJobStore, bundle: dict[str, Any]) -> None:
    """Restart of an imported failed run is refused, so its stored result survives."""
    bundle["job"]["status"] = "failed"
    resp = _import(hosted_store, bundle)
    assert resp.status_code == 201, resp.text
    new_id = resp.json()["optimization_id"]
    restart = _client(hosted_store, HOSTED_USER).post(f"/optimizations/{new_id}/restart")
    assert restart.status_code == 409
    assert restart.json()["detail"] == t_en("optimization.retry_no_payload")
    assert hosted_store.get_job(new_id)["status"] == "failed"


def test_import_in_local_mode_is_422(
    hosted_store: _SQLiteJobStore, bundle: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The Mac app refuses imports; they run only on hosted."""
    monkeypatch.setattr(settings, "local_mode", True)
    resp = _import(hosted_store, bundle)
    assert resp.status_code == 422
    assert resp.json()["detail"] == t_en("sync.import_local_only_disabled")
    assert _count(hosted_store, JobModel) == 0


def test_export_outside_local_mode_is_404(local_store: _SQLiteJobStore) -> None:
    """Hosted deployments hide the export route."""
    resp = _client(local_store, DESK_USER).get("/optimizations/local-run-1/export")
    assert resp.status_code == 404
    assert resp.json()["detail"] == t_en("local.not_available")


def test_export_refuses_other_users_and_active_runs(
    local_store: _SQLiteJobStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Export answers 404 for another user's run and 409 for a run still in progress."""
    monkeypatch.setattr(settings, "local_mode", True)
    assert _client(local_store, HOSTED_USER).get("/optimizations/local-run-1/export").status_code == 404
    _seed_finished_run(local_store, "local-run-2", status="running")
    resp = _client(local_store, DESK_USER).get("/optimizations/local-run-2/export")
    assert resp.status_code == 409
    assert resp.json()["detail"] == t_en("sync.export_not_finished", status="running")


def test_unknown_schema_is_422(hosted_store: _SQLiteJobStore, bundle: dict[str, Any]) -> None:
    """A bundle from another schema version is refused before anything is written."""
    bundle["schema"] = "skynet.run-export/v2"
    resp = _import(hosted_store, bundle)
    assert resp.status_code == 422
    assert resp.json()["detail"] == t_en("sync.unsupported_schema", schema="skynet.run-export/v2")
    assert _count(hosted_store, JobModel) == 0


@pytest.mark.parametrize(
    "mutate",
    [
        lambda b: b["job"].update(status="running"),
        lambda b: b["optimization"].update(optimization_type="grid_search"),
        lambda b: b["artifacts"].update({run_sync.PROGRAM_ARTIFACT_NAME: "%%%not-base64"}),
        lambda b: b["job"]["result"].pop("split_counts"),
        lambda b: b["events"].append({"timestamp": "yesterday", "event": "x", "metrics": {}}),
    ],
    ids=["active-status", "grid-type", "bad-artifact", "bad-result", "bad-timestamp"],
)
def test_malformed_bundle_is_422(hosted_store: _SQLiteJobStore, bundle: dict[str, Any], mutate: Any) -> None:
    """Bundles that do not match the contract are refused with no rows written."""
    mutate(bundle)
    resp = _import(hosted_store, bundle)
    assert resp.status_code == 422
    assert resp.json()["detail"] == t_en("sync.invalid_bundle")
    assert _count(hosted_store, JobModel) == 0


def test_non_json_body_is_422(hosted_store: _SQLiteJobStore) -> None:
    """A body that is not JSON is refused as an invalid bundle."""
    resp = _client(hosted_store, HOSTED_USER).post("/optimizations/import", content=b"\xff not json")
    assert resp.status_code == 422
    assert resp.json()["detail"] == t_en("sync.invalid_bundle")


def test_oversized_bundle_is_413_before_parsing(hosted_store: _SQLiteJobStore, monkeypatch: pytest.MonkeyPatch) -> None:
    """A body over the cap is refused on its size; parsing it would have given 422 instead."""
    monkeypatch.setattr("core.api.routers.optimizations.sync.MAX_BUNDLE_BYTES", 64)
    resp = _client(hosted_store, HOSTED_USER).post("/optimizations/import", content=b"not json " * 20)
    assert resp.status_code == 413
    assert resp.json()["detail"] == t_en("sync.bundle_too_large", max_mb=50)
    assert _count(hosted_store, JobModel) == 0


def test_default_cap_is_50_mb() -> None:
    """The bundle cap is the 50 MB the contract names."""
    assert run_sync.MAX_BUNDLE_BYTES == 50 * 1024 * 1024
