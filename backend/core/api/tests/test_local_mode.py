"""Tests for the local-mode API: hidden routes, the local session, and submission gates."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...billing.service import FREE_GRANT_CENTS, free_grant_cents
from ...config import settings
from ...local.cli_probe import clear_probe_cache
from ...registry.core import ServiceRegistry
from ...storage.models import BillingCustomerModel, ExecutionBudgetModel, UserIdentityModel, UserModel
from ..app import create_app
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError
from ..model_billing import enforce_local_mode_sources, enforce_raw_local_mode_sources
from ..preflight_execution import WizardPreflightRequest, _canonical_execution_payload
from ..routers import submissions as _sub_mod
from ..routers import wizard_preflight
from ..routers.accounts import create_accounts_router
from ..routers.local_runtime import create_local_runtime_router
from .conftest import bypass_auth
from .test_submissions_router import _billing_engine, _FakeJobStore, make_client, unified_payload

_SECRET = "test-internal-secret"
_REAL_ENSURE_API_BUDGET = _sub_mod._ensure_api_budget
_LOCAL_PATHS = ("/local/status", "/auth/local/session")
_SUBSCRIPTION_MODELS = {
    "reflection_model": {
        "name": "anthropic/claude-sonnet-4.6",
        "token_source": "subscription",
        "cli_provider": "claude",
    }
}


class _Store:
    """Minimal store exposing only the SQLAlchemy engine the account routes need."""

    def __init__(self, engine: Any) -> None:
        """Hold the engine the accounts router opens sessions on.

        Args:
            engine: A SQLAlchemy engine with the account tables created.
        """
        self.engine = engine


@pytest.fixture
def local_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Build a client for the account and local-status routers.

    Args:
        monkeypatch: Pytest fixture used to set the shared secret and CLI paths.

    Returns:
        A ``TestClient`` over in-memory SQLite. Local mode stays off until a
        test turns it on.
    """
    monkeypatch.setattr(settings, "backend_auth_secret", SecretStr(_SECRET))
    for name in ("codex_bin", "claude_bin", "docker_bin"):
        monkeypatch.setattr(settings, name, "/nonexistent/skynet-test-binary")
    clear_probe_cache()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    UserModel.__table__.create(engine)
    UserIdentityModel.__table__.create(engine)
    store = _Store(engine)
    app = FastAPI()
    app.include_router(create_accounts_router(job_store=store))
    app.include_router(create_local_runtime_router())
    bypass_auth(app)
    return TestClient(app)


def test_local_routes_are_404_outside_local_mode(local_client: TestClient) -> None:
    """Hosted deployments answer 404 on both local-only routes."""
    status = local_client.get("/local/status")
    session = local_client.post("/auth/local/session", headers={"X-Internal-Auth": _SECRET})

    assert status.status_code == 404
    assert session.status_code == 404


def test_local_session_signs_in_the_local_user(local_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """The right secret returns the local account; the first call creates it.

    Args:
        local_client: Client over the account routes.
        monkeypatch: Pytest fixture used to turn on local mode.
    """
    monkeypatch.setattr(settings, "local_mode", True)

    first = local_client.post("/auth/local/session", headers={"X-Internal-Auth": _SECRET})
    second = local_client.post("/auth/local/session", headers={"X-Internal-Auth": _SECRET})

    assert first.status_code == 200, first.text
    assert first.json() == {
        "email": "local@skynet.local",
        "name": "local@skynet.local",
        "role": "user",
        "first_login": True,
    }
    assert second.json()["first_login"] is False


def test_local_account_has_no_password_login(local_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """The local row has an empty hash, so ``/auth/login`` never opens it.

    Args:
        local_client: Client over the account routes.
        monkeypatch: Pytest fixture used to turn on local mode.
    """
    monkeypatch.setattr(settings, "local_mode", True)
    local_client.post("/auth/local/session", headers={"X-Internal-Auth": _SECRET})

    login = local_client.post(
        "/auth/login",
        json={"email": "local@skynet.local", "password": ""},
        headers={"X-Internal-Auth": _SECRET},
    )

    assert login.status_code != 200


def test_local_session_rejects_a_wrong_secret(local_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """A wrong or missing internal secret gets 403.

    Args:
        local_client: Client over the account routes.
        monkeypatch: Pytest fixture used to turn on local mode.
    """
    monkeypatch.setattr(settings, "local_mode", True)

    wrong = local_client.post("/auth/local/session", headers={"X-Internal-Auth": "wrong"})
    missing = local_client.post("/auth/local/session")

    assert wrong.status_code == 403
    assert missing.status_code == 403


def test_local_status_reports_docker_and_clis(local_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """In local mode the status route reports each dependency.

    Args:
        local_client: Client over the local-status route.
        monkeypatch: Pytest fixture used to turn on local mode.
    """
    monkeypatch.setattr(settings, "local_mode", True)

    body = local_client.get("/local/status").json()

    assert body["local_mode"] is True
    assert body["docker"]["available"] is False
    assert "Docker CLI not found" in body["docker"]["error"]
    assert body["sandbox_image"] is None
    assert [cli["id"] for cli in body["clis"]] == ["codex", "claude"]
    assert all(cli["path"] is None for cli in body["clis"])


def test_app_hides_local_routes_from_openapi() -> None:
    """The full app serves both routes but keeps them out of the schema."""
    with (
        patch("core.api.app.get_job_store"),
        patch("core.api.app.get_worker"),
        patch("core.api.app.DspyService"),
    ):
        application = create_app(registry=ServiceRegistry())

    served = {getattr(route, "path", None) for route in application.routes}
    schema_paths = set(application.openapi()["paths"])

    assert set(_LOCAL_PATHS) <= served
    assert not set(_LOCAL_PATHS) & schema_paths


def _local_submit_client(monkeypatch: pytest.MonkeyPatch, *, local_mode: bool) -> tuple[TestClient, _FakeJobStore]:
    """Build an ``/optimize`` client that runs the real budget step.

    The billing database has no wallet for ``alice``, so the account has a $0
    Stripe balance. The setup check itself is replaced; its behavior is
    covered by ``test_protected_submissions.py``.

    Args:
        monkeypatch: Pytest fixture used to set local mode and the stubs.
        local_mode: Whether the deployment runs in local mode.

    Returns:
        The client and its fake store.
    """
    store = _FakeJobStore()
    store.engine = _billing_engine()
    client = make_client(store, monkeypatch=monkeypatch)
    monkeypatch.setattr(_sub_mod.settings, "local_mode", local_mode)
    monkeypatch.setattr(_sub_mod, "_ensure_api_budget", _REAL_ENSURE_API_BUDGET)
    monkeypatch.setattr(
        _sub_mod,
        "run_preflight",
        lambda *args, **kwargs: SimpleNamespace(
            pending_reason=None, status="succeeded", id="preflight-fixture", fingerprint="fixture"
        ),
    )
    return client, store


def test_local_subscription_run_creates_an_uncapped_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    """In local mode a subscription run with a $0 balance is accepted, not refused with 402.

    Args:
        monkeypatch: Pytest fixture used to set local mode.
    """
    client, store = _local_submit_client(monkeypatch, local_mode=True)

    resp = client.post("/optimize", json=unified_payload(token_source="subscription", models=_SUBSCRIPTION_MODELS))

    assert resp.status_code == 201, resp.text
    with Session(store.engine) as session:
        budget = session.scalars(select(ExecutionBudgetModel)).one()
        wallet = session.get(BillingCustomerModel, "alice")
    assert budget.username == "alice"
    assert budget.uncapped is True
    assert wallet is not None
    assert wallet.balance_cents == 0
    payload = store._jobs[resp.json()["optimization_id"]]["payload"]
    assert payload["token_source"] == "subscription"
    assert payload["execution_budget_id"] == budget.id


def test_local_subscription_run_naming_droid_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """A run that names Droid gets 422 with a clear message and creates no job.

    Args:
        monkeypatch: Pytest fixture used to set local mode.
    """
    client, store = _local_submit_client(monkeypatch, local_mode=True)
    models = {"reflection_model": {**_SUBSCRIPTION_MODELS["reflection_model"], "cli_provider": "droid"}}

    resp = client.post("/optimize", json=unified_payload(token_source="subscription", models=models))

    assert resp.status_code == 422, resp.text
    assert "Droid is no longer supported" in resp.text
    assert store.created_ids() == []


def test_subscription_run_is_refused_outside_local_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """A hosted deployment refuses the same submission with 422.

    Args:
        monkeypatch: Pytest fixture used to keep local mode off.
    """
    client, store = _local_submit_client(monkeypatch, local_mode=False)

    resp = client.post("/optimize", json=unified_payload(token_source="subscription", models=_SUBSCRIPTION_MODELS))

    assert resp.status_code == 422
    assert resp.json()["code"] == "models.subscription_local_only"
    assert store.created_ids() == []


def test_host_cli_proposer_is_refused_outside_local_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """A host-CLI proposer on a managed run is still a local-only run.

    Args:
        monkeypatch: Pytest fixture used to keep local mode off.
    """
    client, store = _local_submit_client(monkeypatch, local_mode=False)

    resp = client.post(
        "/optimize", json=unified_payload(optimizer={"choice": "gepa", "proposer": {"host_cli": "codex"}})
    )

    assert resp.status_code == 422
    assert resp.json()["code"] == "models.subscription_local_only"
    assert store.created_ids() == []


def test_droid_is_not_a_host_cli_option(monkeypatch: pytest.MonkeyPatch) -> None:
    """Droid cannot run isolated, so the submit schema refuses it as a host proposer.

    Args:
        monkeypatch: Pytest fixture used to set local mode.
    """
    client, store = _local_submit_client(monkeypatch, local_mode=True)

    resp = client.post(
        "/optimize",
        json=unified_payload(
            token_source="subscription",
            models=_SUBSCRIPTION_MODELS,
            optimizer={"choice": "gepa", "proposer": {"host_cli": "droid"}},
        ),
    )

    assert resp.status_code == 422, resp.text
    [issue] = [issue for issue in resp.json()["detail"] if issue["loc"][-1] == "host_cli"]
    assert issue["loc"] == ["body", "optimizer", "proposer", "host_cli"]
    assert "Droid is no longer supported" in issue["msg"]
    assert store.created_ids() == []
    schema = client.get("/openapi.json").json()["components"]["schemas"]["BlackboxProposer"]
    assert schema["properties"]["host_cli"]["anyOf"][0]["enum"] == ["codex", "claude"]


def test_docker_runtime_is_refused_outside_local_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """A hosted deployment runs only Vercel sandboxes, so a Docker run gets 422.

    Args:
        monkeypatch: Pytest fixture used to switch local mode.
    """
    payload = SimpleNamespace(execution_runtime="docker")
    monkeypatch.setattr(settings, "local_mode", False)

    with pytest.raises(DomainError) as refused:
        enforce_local_mode_sources(payload, "byok", [])

    assert refused.value.status_code == 422
    assert refused.value.code == "local.not_available"
    monkeypatch.setattr(settings, "local_mode", True)
    enforce_local_mode_sources(payload, "subscription", [])


def test_managed_run_is_refused_in_local_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """The Mac app has no managed routing, so a managed model gets 422.

    Args:
        monkeypatch: Pytest fixture used to set local mode.
    """
    client, store = _local_submit_client(monkeypatch, local_mode=True)

    resp = client.post("/optimize", json=unified_payload())

    assert resp.status_code == 422
    assert resp.json()["code"] == "models.managed_unavailable_local"
    assert store.created_ids() == []


def test_local_mode_skips_the_global_spend_ceiling(monkeypatch: pytest.MonkeyPatch) -> None:
    """The platform-wide ceiling never reads the ledger in local mode.

    Args:
        monkeypatch: Pytest fixture used to set local mode and the ceiling.
    """
    monkeypatch.setattr(_sub_mod.settings, "local_mode", True)
    monkeypatch.setattr(_sub_mod.settings, "global_daily_spend_ceiling_cents", 1)

    _sub_mod._enforce_global_daily_spend_ceiling(SimpleNamespace(engine=object()))


def test_local_mode_grants_the_local_credit(monkeypatch: pytest.MonkeyPatch) -> None:
    """A new local account gets ``local_grant_cents`` instead of the hosted grant.

    Args:
        monkeypatch: Pytest fixture used to set local mode.
    """
    monkeypatch.setattr(settings, "local_grant_cents", 12_345)
    assert free_grant_cents() == FREE_GRANT_CENTS

    monkeypatch.setattr(settings, "local_mode", True)
    assert free_grant_cents() == 12_345


def _execution_request(**overrides: Any) -> WizardPreflightRequest:
    """Build a unified execution setup check around ``unified_payload``.

    Args:
        **overrides: Top-level payload keys replacing the defaults.

    Returns:
        A request in the shape the wizard sends before a run.
    """
    return WizardPreflightRequest(
        scope="execution",
        workflow="unified",
        payload=unified_payload(**overrides),
        execution_budget_id="draft",
        execution_budget_revision=1,
    )


def test_hosted_execution_check_refuses_a_subscription_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """A hosted setup check must not charge a subscription model as managed.

    Args:
        monkeypatch: Pytest fixture used to keep local mode off.
    """
    monkeypatch.setattr(settings, "local_mode", False)

    with pytest.raises(DomainError) as refused:
        _canonical_execution_payload(_execution_request(models=_SUBSCRIPTION_MODELS), "alice")

    assert refused.value.status_code == 422
    assert refused.value.code == "models.subscription_local_only"


def test_local_execution_check_keeps_a_subscription_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Local mode accepts the same check and keeps its subscription source.

    Args:
        monkeypatch: Pytest fixture used to set local mode.
    """
    monkeypatch.setattr(settings, "local_mode", True)

    payload = _canonical_execution_payload(_execution_request(models=_SUBSCRIPTION_MODELS), "alice")

    assert payload["token_source"] == "subscription"


def test_local_execution_check_refuses_a_managed_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Local mode refuses a managed check, as it refuses the managed run.

    Args:
        monkeypatch: Pytest fixture used to set local mode.
    """
    monkeypatch.setattr(settings, "local_mode", True)

    with pytest.raises(DomainError) as refused:
        _canonical_execution_payload(_execution_request(), "alice")

    assert refused.value.code == "models.managed_unavailable_local"


@pytest.mark.parametrize(
    "payload",
    [
        {"token_source": "subscription"},
        {"proposer": {"host_cli": "codex"}},
        {"task_model_config": {"name": "anthropic/claude-sonnet-4.6", "token_source": "subscription"}},
        {"execution_runtime": "docker"},
    ],
)
def test_hosted_wizard_check_refuses_local_only_work(monkeypatch: pytest.MonkeyPatch, payload: dict[str, Any]) -> None:
    """The hosted wizard check route refuses subscription work before it claims a budget.

    The job store is a bare object, so the request would fail if the check
    went past the gate.

    Args:
        monkeypatch: Pytest fixture used to keep local mode off.
        payload: Raw evaluation inputs that only a local deployment can run.
    """
    monkeypatch.setattr(settings, "local_mode", False)
    monkeypatch.setattr(wizard_preflight, "enforce_submission_rate", lambda username: None)
    app = FastAPI()
    app.include_router(wizard_preflight.create_wizard_preflight_router(job_store=object()))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser("alice", "user", ())

    with TestClient(app) as client:
        response = client.post(
            "/wizard/preflight",
            json={
                "workflow": "anything",
                "scope": "evaluation",
                "payload": payload,
                "execution_budget_id": "draft",
                "execution_budget_revision": 1,
            },
        )

    assert response.status_code == 422
    code = "local.not_available" if "execution_runtime" in payload else "models.subscription_local_only"
    assert response.json()["detail"] == DomainError(code).detail


def test_local_wizard_check_passes_the_raw_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """Local mode lets raw subscription and host-CLI inputs through the gate.

    Args:
        monkeypatch: Pytest fixture used to set local mode.
    """
    monkeypatch.setattr(settings, "local_mode", True)

    enforce_raw_local_mode_sources({"token_source": "subscription", "proposer": {"host_cli": "codex"}})
