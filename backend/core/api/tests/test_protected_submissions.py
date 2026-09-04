"""Verify public submissions against real job, setup, and wallet transactions."""

from __future__ import annotations

import json
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any
from uuid import uuid4

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker

from core.api import preflight_execution
from core.api.auth import AuthenticatedUser, get_authenticated_user
from core.api.model_billing import normalize_model_token_sources
from core.api.routers import submissions
from core.api.routers.execution_budgets import create_execution_budgets_router
from core.api.routers.optimizations_meta import create_optimizations_meta_router
from core.api.routers.wizard_preflight import create_wizard_preflight_router
from core.billing.budgets import BudgetConflictError, BudgetFencedError, BudgetService
from core.billing.operation_pricing import ChargePolicy, operation_quote
from core.billing.protected_credentials import scrub_execution_credentials
from core.billing.runtime import BudgetRuntime, PaidResult
from core.billing.service import StripeBillingService
from core.billing.signals import BudgetReached
from core.models import BlackboxRunRequest
from core.storage.models import (
    Base,
    BillingCustomerModel,
    CreditLedgerModel,
    ExecutionBudgetModel,
    ExecutionOperationModel,
    ExecutionUsageEvidenceModel,
    JobModel,
    OptimizationShareGrantModel,
    ProtectedCredentialModel,
)
from core.storage.preflights import PreflightStore, WizardPreflightModel
from core.storage.remote import RemoteDBJobStore

ROUTES = ("/run", "/grid-search", "/blackbox/run")


class _SQLiteJobStore(RemoteDBJobStore):
    """Exercise production store methods with a disposable file database."""

    def __init__(self, path: Path) -> None:
        """Replace only PostgreSQL bootstrap with SQLite schema creation.

        Args:
            path: Private database file belonging to this test.
        """
        self._engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False, "timeout": 10})
        Base.metadata.create_all(self._engine)
        self._session_factory = sessionmaker(bind=self._engine)


class _Gateway:
    """Replace external transports while retaining production spending admission."""

    def __init__(self, runtime: BudgetRuntime) -> None:
        """Retain the real setup authority created by the API."""
        self.runtime = runtime

    def protect_payload(self, payload: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        """Give the fixture runtime adapter access to the actual setup authority."""
        return {**scrub_execution_credentials(payload), "_fixture_runtime": self.runtime}

    def close(self) -> None:
        """Complete the deterministic transport without external resources."""

    def model_routes(self) -> list[dict[str, str]]:
        """Return no external model capabilities from the deterministic fixture adapter."""
        return []


@dataclass
class _Harness:
    """Retain real persistence and the single replaceable provider adapter."""

    store: _SQLiteJobStore
    client: TestClient | None = None
    username: str = "alice"
    role: str = "user"
    calls: list[dict[str, Any]] = field(default_factory=list)
    result_status: str = "succeeded"
    usage_final: bool = True

    @property
    def budgets(self) -> BudgetService:
        """Read and mutate the same authoritative ledger as the API."""
        return BudgetService(engine=self.store.engine)

    def verify(self, runtime: BudgetRuntime, payload: dict[str, Any], identity: str) -> dict[str, Any]:
        """Charge one measured setup operation through real reserve, dispatch, and settlement.

        Args:
            runtime: Setup authority created by the production preflight flow.
            payload: Materialized user inputs sent to the isolated adapter.
            identity: Durable preflight identity used for the physical operation key.

        Returns:
            Actual deterministic readiness outcome from this fixture adapter.
        """
        policy = ChargePolicy("managed_model")
        quote = operation_quote({"setup": identity}, Decimal("0.02"), policy, {"provider": "fixture"})

        def dispatch() -> PaidResult[None]:
            """Assert real coverage exists before reporting one synthetic provider receipt."""
            snapshot = runtime.service.get(runtime.budget_id, runtime.username)
            assert snapshot.reserved_credits == 3
            assert snapshot.pending_operations == 1
            self.calls.append({"budget_id": runtime.budget_id, "identity": identity, "payload": payload})
            return PaidResult(
                None,
                Decimal("0.01") if self.usage_final else None,
                {"provider": "fixture", "cost": "0.01"},
                provider_request_id=f"fixture-{identity}",
                final=self.usage_final,
            )

        runtime.execute(quote, policy, dispatch, operation_key=f"setup:{identity}", cost_kind="model")
        return {"checks": [{"key": "execution", "status": self.result_status}]}

    def count(self, model: Any) -> int:
        """Count durable rows independently of HTTP responses."""
        with Session(self.store.engine) as session:
            return session.scalar(select(func.count()).select_from(model))


@pytest.fixture
def harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[_Harness]:
    """Serve public routes with real persistence and no worker or paid provider traffic.

    Args:
        tmp_path: Disposable database directory.
        monkeypatch: Isolate provider adapters, authentication, and deployment settings.

    Yields:
        API client backed by the production job, preflight, and billing services.
    """
    store = _SQLiteJobStore(tmp_path / "submissions.db")
    fixture = _Harness(store)
    with Session(store.engine) as session:
        session.add_all(
            BillingCustomerModel(
                username=name, stripe_customer_id=f"fixture-{name}", credit_balance=100, grant_remaining=0
            )
            for name in ("alice", "bob")
        )
        session.commit()

    def verify_anything(gateway: _Gateway, payload: dict[str, Any], *, scope: str, identity: str) -> dict:
        """Substitute the physical scorer/runtime adapter with measured fixture execution."""
        return fixture.verify(gateway.runtime, payload, identity)

    def verify_dspy(payload: dict[str, Any], *, scope: str, identity: str) -> dict:
        """Substitute the physical DSPy runtime adapter with measured fixture execution."""
        return fixture.verify(payload["_fixture_runtime"], payload, identity)

    monkeypatch.setattr(preflight_execution, "ModelGateway", _Gateway)
    monkeypatch.setattr(preflight_execution, "bind_protected_sandbox", lambda *args, **kwargs: None)
    monkeypatch.setattr(preflight_execution, "_verify_anything", verify_anything)
    monkeypatch.setattr(preflight_execution, "_verify_dspy", verify_dspy)
    monkeypatch.setattr(submissions, "notify_job_started", lambda **kwargs: None)
    monkeypatch.setattr(submissions.settings, "worker_enabled", False)
    monkeypatch.setattr(submissions.settings, "submissions_paused", False)
    monkeypatch.setattr(submissions.settings, "max_concurrent_jobs_per_user", 0)
    monkeypatch.setattr(submissions.settings, "global_daily_spend_ceiling_credits", 0)
    monkeypatch.setattr(submissions.settings, "rate_limit_submissions_per_minute", 0)
    monkeypatch.setattr(submissions.settings, "openrouter_api_key", SecretStr("fixture-only"))
    monkeypatch.setattr(submissions.settings, "byok_vault_key", SecretStr(Fernet.generate_key().decode()))
    app = FastAPI()
    app.include_router(submissions.create_submissions_router(service=object(), job_store=store))
    app.include_router(create_execution_budgets_router(job_store=store))
    app.include_router(create_wizard_preflight_router(job_store=store))
    app.include_router(create_optimizations_meta_router(job_store=store))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(fixture.username, fixture.role, ())
    with TestClient(app) as client:
        fixture.client = client
        yield fixture
    store.engine.dispose()


def _payload(route: str, *, total: int = 20) -> dict[str, Any]:
    """Build valid legacy request bodies with no budget or verification metadata.

    Args:
        route: Public submission endpoint.
        total: Approved total setup and run allowance.

    Returns:
        Request exercising the production schema and canonicalization.
    """
    if route == "/blackbox/run":
        return {
            "username": "spoofed-owner",
            "seed_candidate": "A real starting candidate",
            "scorer": {"kind": "python", "metric_code": "def score(candidate): return 1.0"},
            "reflection_model_config": {"name": "fixture/text"},
            "strategy": {"mode": "single", "engine": "gepa"},
            "max_cost_credits": total,
        }
    payload = {
        "username": "spoofed-owner",
        "module_name": "predict",
        "signature_code": "class Sig(dspy.Signature): q: str = dspy.InputField(); a: str = dspy.OutputField()",
        "metric_code": "def metric(example, pred, trace=None): return 1.0",
        "optimizer_name": "gepa",
        "dataset": [{"question": f"Q{index}?", "answer": "A"} for index in range(10)],
        "column_mapping": {"inputs": {"q": "question"}, "outputs": {"a": "answer"}},
        "max_cost_credits": total,
    }
    if route == "/grid-search":
        payload.update(generation_models=[{"name": "fixture/task"}], reflection_models=[{"name": "fixture/text"}])
    else:
        payload.update(model_config={"name": "fixture/task"}, reflection_model_config={"name": "fixture/text"})
    return payload


def _prepare(harness: _Harness, route: str = "/blackbox/run") -> tuple[dict, dict]:
    """Run actual paid Continue and return its submission evidence.

    Args:
        harness: Funded real API fixture.
        route: Submission family whose inputs are verified.

    Returns:
        Protected submission body and completed preflight response.
    """
    budget = harness.budgets.create(harness.username, 20, idempotency_key="wizard")
    payload = {
        **_payload(route),
        "execution_budget_id": budget.id,
        "execution_budget_revision": budget.revision,
    }
    response = harness.client.post(
        "/wizard/preflight",
        json={
            "scope": "execution",
            "workflow": "anything" if route == "/blackbox/run" else "dspy",
            "payload": payload,
            "execution_budget_id": budget.id,
            "execution_budget_revision": budget.revision,
        },
    )
    assert response.status_code == 200, response.text
    checked = response.json()
    assert checked["status"] == "succeeded", checked
    return {
        **payload,
        "execution_budget_revision": checked["budget"]["revision"],
        "preflight_id": checked["id"],
        "preflight_fingerprint": checked["fingerprint"],
    }, checked


@pytest.mark.parametrize("route", ROUTES)
def test_legacy_submission_attaches_paid_setup_once(harness: _Harness, route: str) -> None:
    """Persist a single account-owned budget, setup receipt, and atomically attached root job.

    Args:
        harness: Real persistence with a measured provider stub.
        route: Each legacy public submission endpoint.
    """
    first = harness.client.post(route, json=_payload(route), headers={"Idempotency-Key": "legacy-submit"})
    assert first.status_code == 201, first.text
    identity = first.json()["optimization_id"]
    job = harness.store.get_job(identity, include_payload=True)
    budget = harness.budgets.get(job["execution_budget_id"], "alice")
    assert budget.state == "attached"
    assert budget.job_id == identity
    assert budget.generation == job["execution_budget_generation"] == job["payload"]["execution_budget_generation"]
    assert budget.id == job["payload"]["execution_budget_id"] == harness.calls[0]["budget_id"]
    assert budget.setup_spent_credits == Decimal("1.5")
    assert budget.run_spent_credits == budget.reserved_credits == 0
    assert budget.available_credits == Decimal("18.5")
    assert budget.billed_credits == 2
    assert job["username"] == job["payload"]["username"] == "alice"
    assert job["status"] == "pending"
    assert harness.count(JobModel) == harness.count(ExecutionBudgetModel) == harness.count(WizardPreflightModel) == 1
    assert harness.count(ExecutionOperationModel) == harness.count(CreditLedgerModel) == 1
    assert harness.count(ExecutionUsageEvidenceModel) >= 1
    replay = harness.client.post(route, json=_payload(route), headers={"Idempotency-Key": "legacy-submit"})
    assert replay.status_code == 201, replay.text
    assert replay.json()["optimization_id"] == identity
    assert len(harness.calls) == harness.count(JobModel) == harness.count(ExecutionOperationModel) == 1
    with pytest.raises(BudgetConflictError):
        harness.budgets.reserve(
            budget.id,
            "alice",
            generation=budget.generation,
            phase="setup",
            cost_kind="model",
            operation_key="late-setup",
            request_fingerprint="late",
            price_snapshot={"version": "fixture-v1"},
            max_credits=1,
        )


@pytest.mark.parametrize("route", ROUTES)
def test_keyless_legacy_submission_replays_one_paid_job(harness: _Harness, route: str) -> None:
    """Reuse one synthesized key across lookup, setup authority, and root persistence.

    Args:
        harness: Real persistence with measured setup execution.
        route: Run, grid search, or Anything public submission endpoint.
    """
    first = harness.client.post(route, json=_payload(route))
    repeated = harness.client.post(route, json=_payload(route))

    assert first.status_code == 201, first.text
    assert repeated.status_code == 201, repeated.text
    identity = first.json()["optimization_id"]
    assert repeated.json()["optimization_id"] == identity
    with Session(harness.store.engine) as session:
        job = session.get(JobModel, identity)
        assert job is not None
        budget = session.get(ExecutionBudgetModel, job.execution_budget_id)
        assert budget is not None
        assert job.idempotency_key == budget.creation_key
        assert job.idempotency_key.startswith("legacy-paid-v1:")
    assert len(harness.calls) == 1
    assert harness.count(JobModel) == 1
    assert harness.count(ExecutionBudgetModel) == 1
    assert harness.count(WizardPreflightModel) == 1
    assert harness.count(ExecutionOperationModel) == 1


def test_keyless_legacy_secret_is_absent_from_replay_key_and_logs(
    harness: _Harness,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Hash remote credentials without persisting or logging their plaintext.

    Args:
        harness: Real protected legacy submission boundary.
        caplog: Captured server logs inspected for credential leakage.
    """
    secret = "remote-evaluator-private-value"
    payload = _payload("/blackbox/run")
    payload["scorer"] = {
        "kind": "remote",
        "url": "https://evaluator.example/score",
        "secret": secret,
    }

    response = harness.client.post("/blackbox/run", json=payload)

    assert response.status_code == 201, response.text
    with Session(harness.store.engine) as session:
        job = session.get(JobModel, response.json()["optimization_id"])
        assert job is not None
        budget = session.get(ExecutionBudgetModel, job.execution_budget_id)
        assert budget is not None
        assert secret not in job.idempotency_key
        assert secret not in budget.creation_key
    assert secret not in caplog.text


@pytest.mark.parametrize("route", ROUTES)
def test_keyless_uncertain_retry_does_not_repeat_paid_preflight(harness: _Harness, route: str) -> None:
    """Recover the same budget and pending evidence after a lost final usage receipt.

    Args:
        harness: Real ledger configured to retain uncertain setup coverage.
        route: Run, grid search, or Anything public submission endpoint.
    """
    harness.usage_final = False
    payload = _payload(route)
    payload.pop("max_cost_credits")

    first = harness.client.post(route, json=payload)
    repeated = harness.client.post(route, json=payload)

    assert first.status_code == 409, first.text
    assert repeated.status_code == 409, repeated.text
    assert len(harness.calls) == 1
    assert harness.count(JobModel) == 0
    assert harness.count(ExecutionBudgetModel) == 1
    assert harness.count(WizardPreflightModel) == 1
    assert harness.count(ExecutionOperationModel) == 1
    budget = harness.budgets.get(harness.calls[0]["budget_id"], "alice")
    assert budget.total_credits == 100
    assert budget.pending_operations == 1
    assert budget.reserved_credits == 3


@pytest.mark.parametrize("route", ROUTES)
def test_wizard_submission_reuses_actual_continue_evidence(harness: _Harness, route: str) -> None:
    """Attach paid wizard evidence without rerunning its physical checks.

    Args:
        harness: Real setup, wallet, and job services.
        route: Each protected public submission endpoint.
    """
    payload, checked = _prepare(harness, route)
    response = harness.client.post(route, json=payload)
    assert response.status_code == 201, response.text
    job = harness.store.get_job(response.json()["optimization_id"], include_payload=True)
    assert job["payload"]["preflight_id"] == checked["id"]
    assert job["execution_budget_id"] == payload["execution_budget_id"]
    assert len(harness.calls) == 1


@pytest.mark.parametrize(
    ("route", "credential", "reference_field", "url_reference_field"),
    [
        ("/run", "Bearer mcp-payload-secret", "_mcp_credential_ref", "_mcp_url_ref"),
        (
            "/blackbox/run",
            "remote-evaluator-secret",
            "_scorer_credential_ref",
            "_scorer_url_ref",
        ),
    ],
)
def test_protected_submission_vaults_relay_credentials_before_every_payload_boundary(
    harness: _Harness,
    route: str,
    credential: str,
    reference_field: str,
    url_reference_field: str,
) -> None:
    """Keep relay secrets encrypted while every authorized payload view remains scrubbed.

    Args:
        harness: Real encrypted persistence, preflight, and payload-read routes.
        route: DSPy ReAct or Anything submission endpoint.
        credential: Distinct plaintext whose absence is asserted at every boundary.
        reference_field: Opaque field expected only in internal job persistence.
        url_reference_field: Opaque reference replacing private endpoint query parameters.
    """
    budget = harness.budgets.create("alice", 20, idempotency_key=f"credential-{route}")
    payload = {
        **_payload(route),
        "execution_budget_id": budget.id,
        "execution_budget_revision": budget.revision,
    }
    model_field = "model_config" if route == "/run" else "reflection_model_config"
    payload[model_field]["extra"] = {
        "nested": {
            "clientSecret": f"{credential}-model-client-secret",
            "Authorization": f"Bearer {credential}-model-authorization",
        }
    }
    endpoint_credential = f"{credential}-endpoint-query"
    if route == "/run":
        payload["module_name"] = "react"
        payload["tool_source"] = {
            "kind": "live_mcp",
            "mcp_url": f"https://tools.example/mcp?access_token={endpoint_credential}",
            "mcp_auth_header": credential,
            "tool_filter": ["lookup"],
        }
    else:
        payload["scorer"] = {
            "kind": "remote",
            "url": f"https://evaluator.example/score?api_key={endpoint_credential}",
            "secret": credential,
        }
    checked = harness.client.post(
        "/wizard/preflight",
        json={
            "scope": "execution",
            "workflow": "dspy" if route == "/run" else "anything",
            "payload": payload,
            "execution_budget_id": budget.id,
            "execution_budget_revision": budget.revision,
        },
    )
    assert checked.status_code == 200, checked.text
    submitted = harness.client.post(
        route,
        json={
            **payload,
            "execution_budget_revision": checked.json()["budget"]["revision"],
            "preflight_id": checked.json()["id"],
            "preflight_fingerprint": checked.json()["fingerprint"],
        },
    )
    assert submitted.status_code == 201, submitted.text
    optimization_id = submitted.json()["optimization_id"]
    job = harness.store.get_job(optimization_id, include_payload=True)
    stored = json.dumps(job["payload"], sort_keys=True)
    assert credential not in stored
    assert endpoint_credential not in stored
    assert f"{credential}-model-client-secret" not in stored
    assert f"{credential}-model-authorization" not in stored
    assert reference_field in stored
    assert url_reference_field in stored
    assert credential not in json.dumps(harness.calls[0]["payload"], default=str)
    assert reference_field not in json.dumps(harness.calls[0]["payload"], default=str)
    assert url_reference_field not in json.dumps(harness.calls[0]["payload"], default=str)
    with Session(harness.store.engine) as session:
        rows = list(session.scalars(select(ProtectedCredentialModel)))
        assert rows
        assert all(
            secret.encode() not in row.secret_ciphertext for row in rows for secret in (credential, endpoint_credential)
        )
        session.add(
            OptimizationShareGrantModel(
                optimization_id=optimization_id,
                grantee_username="bob",
                role="viewer",
                created_by="alice",
            )
        )
        session.commit()

    legacy_payload = json.loads(stored)
    legacy_payload[model_field]["extra"] = payload[model_field]["extra"]
    if route == "/run":
        legacy_payload["tool_source"].update(
            mcp_url=payload["tool_source"]["mcp_url"],
            mcp_auth_header=credential,
        )
    else:
        legacy_payload["scorer"].update(
            url=payload["scorer"]["url"],
            secret=credential,
        )
    harness.store.update_job(optimization_id, payload=legacy_payload)

    for username, role in (("alice", "user"), ("root", "admin"), ("bob", "user")):
        harness.username = username
        harness.role = role
        response = harness.client.get(f"/optimizations/{optimization_id}/payload")
        assert response.status_code == 200, response.text
        exposed = json.dumps(response.json(), sort_keys=True)
        assert credential not in exposed
        assert endpoint_credential not in exposed
        assert f"{credential}-model-client-secret" not in exposed
        assert f"{credential}-model-authorization" not in exposed
        assert reference_field not in exposed
        assert url_reference_field not in exposed


def test_protected_dspy_submission_keeps_authored_modules_out_of_api_parent(
    harness: _Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep module-scope file, environment, and network access behind protected setup.

    Args:
        harness: Real setup evidence and submission persistence with a sandbox adapter.
        tmp_path: Host-only marker paths authored modules must never reach.
        monkeypatch: Parent-only environment fixture.
    """
    requests: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        """Record any authored connection that escapes into the API host network."""

        def log_message(self, format: str, *args: Any) -> None:
            """Suppress fixture server logs."""

        def do_GET(self) -> None:
            """Record an unexpected module-scope request and return an empty response."""
            requests.append(self.path)
            self.send_response(204)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("SKYNET_PARENT_ONLY_SECRET", "must-stay-in-parent")

    def authored_source(marker: Path, path: str, definition: str) -> str:
        """Build a module whose import would expose every trusted-parent capability."""
        return (
            "import os\n"
            "import pathlib\n"
            "import urllib.request\n"
            f"pathlib.Path({str(marker)!r}).write_text(os.environ['SKYNET_PARENT_ONLY_SECRET'])\n"
            f"with urllib.request.urlopen('http://127.0.0.1:{server.server_port}/{path}', timeout=1): pass\n"
            f"{definition}\n"
        )

    markers = {
        "metric": tmp_path / "metric-parent-side-effect",
        "signature": tmp_path / "signature-parent-side-effect",
        "transform": tmp_path / "transform-parent-side-effect",
    }
    payload = {
        "username": "spoofed-owner",
        "module_name": "workflow",
        "workflow": {
            "nodes": [
                {"id": "input", "kind": "input", "fields": [{"name": "question"}]},
                {
                    "id": "predict",
                    "kind": "signature",
                    "signature_code": authored_source(
                        markers["signature"],
                        "signature",
                        "class Sig(dspy.Signature):\n"
                        "    question: str = dspy.InputField()\n"
                        "    draft: str = dspy.OutputField()",
                    ),
                },
                {
                    "id": "reshape",
                    "kind": "transform",
                    "transform_code": authored_source(
                        markers["transform"],
                        "transform",
                        "def transform(draft):\n    return {'answer': draft}",
                    ),
                    "input_fields": [{"name": "draft"}],
                    "output_fields": [{"name": "answer"}],
                },
                {"id": "output", "kind": "output", "fields": [{"name": "answer"}]},
            ],
            "edges": [
                {"source": "input", "source_port": "question", "target": "predict", "target_port": "question"},
                {"source": "predict", "source_port": "draft", "target": "reshape", "target_port": "draft"},
                {"source": "reshape", "source_port": "answer", "target": "output", "target_port": "answer"},
            ],
        },
        "metric_code": authored_source(
            markers["metric"],
            "metric",
            "def metric(gold, pred, trace=None, pred_name=None, pred_trace=None): return 1.0",
        ),
        "optimizer_name": "gepa",
        "dataset": [{"question": f"Q{index}?", "answer": "A"} for index in range(10)],
        "column_mapping": {"inputs": {"question": "question"}, "outputs": {"answer": "answer"}},
        "model_config": {"name": "fixture/task"},
        "reflection_model_config": {"name": "fixture/text"},
        "max_cost_credits": 20,
    }
    try:
        response = harness.client.post("/run", json=payload)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert response.status_code == 201, response.text
    assert requests == []
    assert all(not marker.exists() for marker in markers.values())


@pytest.mark.parametrize("attack", ["missing", "forged", "fingerprint", "changed", "foreign", "revision"])
def test_invalid_evidence_cannot_queue(harness: _Harness, attack: str) -> None:
    """Reject untrusted or obsolete approval metadata before persisting any runnable job.

    Args:
        harness: Real setup and submission routes.
        attack: Missing, forged, modified, foreign, or stale request evidence.
    """
    payload, _checked = _prepare(harness)
    if attack == "missing":
        payload.pop("preflight_id")
        payload.pop("preflight_fingerprint")
    elif attack == "forged":
        payload["preflight_id"] = str(uuid4())
    elif attack == "fingerprint":
        payload["preflight_fingerprint"] = "0" * 64
    elif attack == "changed":
        payload["seed_candidate"] = "Different executable input"
    elif attack == "foreign":
        harness.username = "bob"
    else:
        harness.budgets.update_total(payload["execution_budget_id"], "alice", 21, expected_revision=1)
    response = harness.client.post("/blackbox/run", json=payload)
    assert response.status_code in {404, 409}, response.text
    assert harness.count(JobModel) == 0
    assert harness.budgets.get(payload["execution_budget_id"], "alice").job_id is None
    assert len(harness.calls) == 1


@pytest.mark.parametrize("pending_usage", [False, True])
def test_failed_or_uncertain_paid_setup_never_queues(harness: _Harness, pending_usage: bool) -> None:
    """Retain actual setup charges or uncertain holds without fabricating successful readiness.

    Args:
        harness: Real legacy submission routes and spending authority.
        pending_usage: Whether the provider has not confirmed its final charge.
    """
    harness.result_status = "failed"
    harness.usage_final = not pending_usage
    response = harness.client.post("/blackbox/run", json=_payload("/blackbox/run"))
    assert response.status_code == 409, response.text
    assert harness.count(JobModel) == 0
    budget = harness.budgets.get(harness.calls[0]["budget_id"], "alice")
    assert budget.job_id is None
    assert budget.reserved_credits == (3 if pending_usage else 0)
    assert budget.setup_spent_credits == (0 if pending_usage else Decimal("1.5"))


def test_attachment_rolls_back_job_when_budget_already_attached(harness: _Harness) -> None:
    """Reject a second root and roll its inserted job back in the attachment transaction.

    Args:
        harness: Real job store and budget authority.
    """
    payload, _checked = _prepare(harness)
    first = harness.client.post("/blackbox/run", json=payload)
    assert first.status_code == 201, first.text
    existing = harness.store.get_job(first.json()["optimization_id"], include_payload=True)
    second_id = str(uuid4())
    with pytest.raises(BudgetConflictError):
        harness.store.create_job(
            second_id,
            username="alice",
            budget_service=harness.budgets,
            preflight_store=PreflightStore(harness.store.engine),
            execution_budget_id=payload["execution_budget_id"],
            execution_budget_revision=payload["execution_budget_revision"],
            preflight_id=payload["preflight_id"],
            preflight_fingerprint=payload["preflight_fingerprint"],
            preflight_payload=existing["payload"],
            preflight_workflow="anything",
        )
    assert harness.count(JobModel) == 1
    with pytest.raises(KeyError):
        harness.store.get_job(second_id)
    assert harness.budgets.get(payload["execution_budget_id"], "alice").job_id == existing["optimization_id"]


@pytest.mark.parametrize("limit", ["total", "wallet"])
def test_run_admission_cannot_dispatch_beyond_remaining_coverage(harness: _Harness, limit: str) -> None:
    """Apply setup spend, cumulative rounding, and shared-wallet holds to the attached run.

    Args:
        harness: Real submission and billing transactions.
        limit: Total-budget exhaustion or another operation's wallet commitment.
    """
    response = harness.client.post("/run", json=_payload("/run"))
    assert response.status_code == 201, response.text
    job = harness.store.get_job(response.json()["optimization_id"])
    runtime = BudgetRuntime(
        harness.budgets,
        username="alice",
        budget_id=job["execution_budget_id"],
        generation=job["execution_budget_generation"],
        phase="run",
        wait_timeout=0,
    )
    policy = ChargePolicy("sandbox")
    quote = operation_quote({"run": "bounded"}, Decimal("0.18"), policy, {"provider": "fixture"})
    dispatched = []

    def dispatch() -> PaidResult[str]:
        """Record the physical request only after the real ledger admits it."""
        dispatched.append(True)
        return PaidResult("actual result", Decimal("0.18"), {"runtime_cost": "0.18"})

    if limit == "wallet":
        other = harness.budgets.create("alice", 90, idempotency_key="other-draft")
        operation = harness.budgets.reserve(
            other.id,
            "alice",
            generation=0,
            phase="setup",
            cost_kind="sandbox",
            operation_key="other-usage",
            request_fingerprint="other",
            price_snapshot={"version": "fixture-v1"},
            max_credits=90,
        )
        harness.budgets.mark_dispatched(operation.id, "alice", "other-provider-request")
        harness.budgets.settle(
            operation.id, "alice", evidence_key="other-final", actual_credits=90, evidence={"measured_credits": 90}
        )
        with pytest.raises(BudgetReached):
            runtime.execute(quote, policy, dispatch, operation_key="run", cost_kind="sandbox")
        assert not dispatched
    else:
        assert runtime.execute(quote, policy, dispatch, operation_key="run", cost_kind="sandbox") == "actual result"
        budget = harness.budgets.get(runtime.budget_id, "alice")
        assert budget.setup_spent_credits == Decimal("1.5")
        assert budget.run_spent_credits == 18
        assert budget.available_credits == Decimal("0.5")
        assert budget.billed_credits == 20
        assert StripeBillingService(engine=harness.store.engine).spendable_credits("alice") == 80
        with pytest.raises(BudgetReached):
            runtime.execute(quote, policy, dispatch, operation_key="next", cost_kind="sandbox")
        assert len(dispatched) == 1
    assert harness.budgets.get(runtime.budget_id, "alice").reserved_credits == 0


def test_attachment_uses_current_generation_and_fences_old_setup(harness: _Harness) -> None:
    """Stamp the durable generation and reject an obsolete setup owner's next operation.

    Args:
        harness: Real preflight and attachment services.
    """
    payload, _checked = _prepare(harness)
    fenced = harness.budgets.fence_generation(payload["execution_budget_id"], "alice", expected_generation=0)
    payload["execution_budget_revision"] = fenced.revision
    response = harness.client.post("/blackbox/run", json=payload)
    assert response.status_code == 201, response.text
    job = harness.store.get_job(response.json()["optimization_id"])
    assert job["execution_budget_generation"] == fenced.generation == 1
    with pytest.raises(BudgetFencedError):
        harness.budgets.reserve(
            fenced.id,
            "alice",
            generation=0,
            phase="run",
            cost_kind="model",
            operation_key="stale-worker",
            request_fingerprint="old",
            price_snapshot={"version": "fixture-v1"},
            max_credits=1,
        )


def test_concurrent_attachment_keeps_one_complete_root(harness: _Harness) -> None:
    """Serialize competing root attachments so the losing insert and budget mutation roll back.

    Args:
        harness: Real file-backed store and completed setup evidence.
    """
    payload, _checked = _prepare(harness)
    typed = BlackboxRunRequest.model_validate(payload)
    typed.username = "alice"
    normalize_model_token_sources(typed)
    canonical = submissions._protected_submission(typed, harness.store, "anything")
    assert canonical is not None

    def attach(identity: str) -> str:
        """Run the actual job and budget transaction in a separate database connection."""
        try:
            harness.store.create_job(
                identity,
                username="alice",
                budget_service=harness.budgets,
                preflight_store=PreflightStore(harness.store.engine),
                execution_budget_id=payload["execution_budget_id"],
                execution_budget_revision=payload["execution_budget_revision"],
                preflight_id=payload["preflight_id"],
                preflight_fingerprint=payload["preflight_fingerprint"],
                preflight_payload=canonical,
                preflight_workflow="anything",
            )
            return identity
        except BudgetConflictError:
            return "rejected"

    identities = [str(uuid4()), str(uuid4())]
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(attach, identities))
    assert outcomes.count("rejected") == 1
    assert harness.count(JobModel) == 1
    budget = harness.budgets.get(payload["execution_budget_id"], "alice")
    assert budget.job_id in outcomes
    job = harness.store.get_job(budget.job_id)
    assert job["execution_budget_id"] == budget.id
    assert job["execution_budget_generation"] == budget.generation


@pytest.mark.parametrize("route", ROUTES)
def test_paid_setup_does_not_rewrite_the_approved_total(harness: _Harness, route: str) -> None:
    """Preserve the shared total after setup has already debited part of that allowance.

    Args:
        harness: Real API, setup ledger, and wallet with exactly the approved total.
        route: Each public submission endpoint using the shared budget.
    """
    with Session(harness.store.engine) as session:
        session.get(BillingCustomerModel, "alice").credit_balance = 20
        session.commit()
    response = harness.client.post(route, json=_payload(route))
    assert response.status_code == 201, response.text
    job = harness.store.get_job(response.json()["optimization_id"], include_payload=True)
    budget = harness.budgets.get(job["execution_budget_id"], "alice")
    assert budget.total_credits == 20
    assert budget.setup_spent_credits == Decimal("1.5")
    assert job["payload"]["max_cost_credits"] == budget.total_credits


def test_legacy_commitment_is_counted_once_during_protected_submission(harness: _Harness) -> None:
    """Keep legacy work covered while permitting paid setup within the genuinely free wallet.

    Args:
        harness: Real wallet, one active legacy job, and the protected API.
    """
    harness.store.create_job("legacy", username="alice")
    harness.store.set_payload_overview("legacy", {"max_cost_credits": 60, "token_source": "managed"})
    assert StripeBillingService(engine=harness.store.engine).spendable_credits("alice") == 40
    response = harness.client.post("/run", json=_payload("/run"))
    assert response.status_code == 201, response.text
    job = harness.store.get_job(response.json()["optimization_id"])
    assert job["execution_budget_id"] is not None
    assert StripeBillingService(engine=harness.store.engine).spendable_credits("alice") == 38
