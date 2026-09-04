"""Verify paid Continue deduplication and current evidence ownership at submission."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from core.api import preflight_execution as wizard_preflight
from core.api.auth import AuthenticatedUser, get_authenticated_user
from core.api.model_billing import normalize_model_token_sources
from core.api.routers import wizard_preflight as preflight_router
from core.api.routers.execution_budgets import create_execution_budgets_router
from core.billing.budgets import BudgetConflictError
from core.billing.operation_pricing import ChargePolicy, operation_quote
from core.billing.protected_credentials import (
    ProtectedCredentialVault,
    protect_execution_credentials,
)
from core.billing.runtime import PaidResult, UsagePendingError
from core.models import BlackboxRunRequest
from core.storage.models import Base, BillingCustomerModel, BillingProviderKeyModel
from core.storage.preflights import PreflightStore, setup_seed

PAYLOAD = {
    "seed_candidate": "A real starting candidate",
    "scorer": {"kind": "python", "metric_code": "def score(candidate): return 1.0"},
    "reflection_model_config": {"name": "fixture/text"},
    "strategy": {"mode": "single", "engine": "gepa"},
    "max_cost_credits": 20,
}


class _Gateway:
    """Replace only external transport while keeping the real spending authority."""

    def __init__(self, runtime) -> None:
        """Retain the setup budget passed by the real API."""
        self.runtime = runtime

    def protect_payload(self, payload: dict, **kwargs) -> dict:
        """Return test inputs without provisioning model credentials."""
        return payload

    def close(self) -> None:
        """Complete the deterministic test transport."""


@pytest.fixture
def setup_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[TestClient, object, list]]:
    """Serve real evidence and ledger tables around one synthetic paid setup adapter."""
    engine = create_engine(f"sqlite:///{tmp_path / 'setup.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(username="alice", stripe_customer_id="local", credit_balance=100, grant_remaining=0)
        )
        session.commit()
    calls = []

    def verify(gateway, payload, **kwargs) -> dict:
        """Settle a measured setup charge using the production admission path."""
        calls.append(payload)
        policy = ChargePolicy("managed_model")
        quote = operation_quote({"case": len(calls)}, Decimal("0.02"), policy, {"provider": "fixture"})
        gateway.runtime.execute(
            quote,
            policy,
            lambda: PaidResult(None, Decimal("0.01"), {"actual": "0.01"}),
            operation_key=f"check-{len(calls)}",
            cost_kind="model",
        )
        return {"checks": [{"key": "scorer", "status": "succeeded"}]}

    monkeypatch.setattr(wizard_preflight, "ModelGateway", _Gateway)
    monkeypatch.setattr(wizard_preflight, "bind_protected_sandbox", lambda *args, **kwargs: None)
    monkeypatch.setattr(wizard_preflight, "_verify_anything", verify)
    monkeypatch.setattr(preflight_router, "enforce_submission_rate", lambda username: None)
    monkeypatch.setattr(wizard_preflight.settings, "openrouter_api_key", SecretStr("test-only"))
    app = FastAPI()
    store = SimpleNamespace(engine=engine)
    app.include_router(create_execution_budgets_router(job_store=store))
    app.include_router(preflight_router.create_wizard_preflight_router(job_store=store))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser("alice", "user", ())
    with TestClient(app) as client:
        yield client, engine, calls
    engine.dispose()


def _budget(client: TestClient) -> dict:
    """Create one funded draft authority for the API scenarios."""
    return client.post("/execution-budgets", json={"total_credits": 20}, headers={"Idempotency-Key": "draft"}).json()


def _request(budget: dict, payload: dict | None = None) -> dict:
    """Build the same Continue request shape used by both wizard workflows."""
    return {
        "scope": "execution",
        "workflow": "anything",
        "payload": payload or PAYLOAD,
        "execution_budget_id": budget["id"],
        "execution_budget_revision": budget["revision"],
    }


def test_continue_reuses_matching_success_and_preserves_setup_spend(setup_client) -> None:
    """Reuse current evidence across retries and cosmetic edits without another paid operation."""
    client, _engine, calls = setup_client
    budget = _budget(client)
    first = client.post("/wizard/preflight", json=_request(budget))
    assert first.status_code == 200
    assert first.json()["status"] == "succeeded"
    assert first.json()["may_advance"] is True
    assert first.json()["budget"]["setup_spent_credits"] == "1.5"
    second = client.post("/wizard/preflight", json=_request(budget, {**PAYLOAD, "name": "Renamed", "is_private": True}))
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["budget"]["setup_spent_credits"] == "1.5"
    assert len(calls) == 1


def test_byok_continue_needs_no_managed_model_key(setup_client, monkeypatch: pytest.MonkeyPatch) -> None:
    """Resolve the owner's verified key and keep managed provider funding out of a BYOK setup."""
    client, engine, calls = setup_client
    cipher_key = Fernet.generate_key()
    monkeypatch.setattr(wizard_preflight.settings, "byok_vault_key", SecretStr(cipher_key.decode()))
    monkeypatch.setattr(wizard_preflight.settings, "openrouter_api_key", None)
    with Session(engine) as session:
        session.add(
            BillingProviderKeyModel(
                username="alice",
                provider="openrouter",
                secret_ciphertext=Fernet(cipher_key).encrypt(b"account-owned-key"),
                last4="-key",
                status="verified",
                params={},
            )
        )
        session.commit()
    budget = _budget(client)
    payload = {
        **PAYLOAD,
        "token_source": "byok",
        "reflection_model_config": {
            "name": "openrouter/fixture/text",
            "token_source": "byok",
            "byok_provider": "openrouter",
        },
    }

    response = client.post("/wizard/preflight", json=_request(budget, payload))

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "succeeded"
    assert calls[0]["reflection_model_config"]["extra"]["api_key"] == "account-owned-key"


def test_scorer_changes_require_new_paid_verification(setup_client) -> None:
    """Bind executable changes to new checks while preserving the same cumulative budget."""
    client, _engine, calls = setup_client
    budget = _budget(client)
    first = client.post("/wizard/preflight", json=_request(budget)).json()
    changed = {**PAYLOAD, "scorer": {"kind": "python", "metric_code": "def score(candidate): return 0.5"}}
    second = client.post("/wizard/preflight", json=_request(budget, changed)).json()
    assert second["fingerprint"] != first["fingerprint"]
    assert second["budget"]["setup_spent_credits"] == "3"
    assert len(calls) == 2


def test_submission_rejects_stale_or_foreign_evidence(setup_client) -> None:
    """Revalidate account, content, and current provider identity before budget attachment."""
    client, engine, _calls = setup_client
    budget = _budget(client)
    checked = client.post("/wizard/preflight", json=_request(budget)).json()
    typed = BlackboxRunRequest.model_validate(
        {
            **PAYLOAD,
            "username": "alice",
            "seed": setup_seed(budget["id"]),
            "execution_budget_id": budget["id"],
            "execution_budget_revision": budget["revision"],
        }
    )
    normalize_model_token_sources(typed)
    payload = protect_execution_credentials(
        typed.model_dump(mode="json", by_alias=True),
        username="alice",
        binding_id=budget["id"],
        vault=ProtectedCredentialVault(engine=engine),
    )
    store = PreflightStore(engine)
    kwargs = {
        "username": "alice",
        "budget_id": budget["id"],
        "identity": checked["id"],
        "fingerprint": checked["fingerprint"],
        "workflow": "anything",
        "payload": payload,
    }
    store.require_current(**kwargs)
    with pytest.raises(BudgetConflictError):
        store.require_current(**{**kwargs, "username": "bob"})
    with pytest.raises(BudgetConflictError):
        store.require_current(**{**kwargs, "payload": {**payload, "seed_candidate": "Changed"}})


def test_preflight_never_uses_held_out_case() -> None:
    """Select from the actual submitted training split rather than the first raw row."""
    rows = [{"id": index} for index in range(20)]
    payload = {"cases": rows, "seed": 19, "shuffle": True, "split_fractions": {"train": 0.5, "val": 0.25, "test": 0.25}}
    splits = wizard_preflight.split_examples(
        rows,
        wizard_preflight.SplitFractions.model_validate(payload["split_fractions"]),
        shuffle=True,
        seed=19,
    )
    chosen = wizard_preflight._sample(payload)
    assert chosen in splits.train
    assert chosen not in splits.test


@pytest.mark.parametrize("key", ["_gepa_log_dir", "_budget_gateway_descriptor", "_skynet_tools_route", "_preflight"])
def test_public_preflight_rejects_parent_runtime_controls(setup_client, key: str) -> None:
    """Reject forged filesystem and relay authority before claiming setup or spending credits."""
    client, _engine, calls = setup_client
    budget = _budget(client)
    response = client.post("/wizard/preflight", json=_request(budget, {**PAYLOAD, key: "/"}))
    assert response.status_code == 422
    assert "Runtime control fields" in response.text
    assert calls == []
    assert client.get(f"/execution-budgets/{budget['id']}").json()["setup_spent_credits"] == "0"


def test_unavailable_default_runtime_defers_evaluation_to_optimization(
    setup_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Let users reach the runtime picker without claiming a paid evaluator check occurred."""
    client, _engine, calls = setup_client
    budget = _budget(client)
    monkeypatch.setattr(wizard_preflight, "protected_vercel_unavailable_reason", lambda *args: "Missing image")
    response = client.post(
        "/wizard/preflight",
        json={**_request(budget), "scope": "evaluation", "workflow": "dspy", "payload": {}},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "pending"
    assert result["may_advance"] is True
    assert result["pending_reason"]["category"] == "later_stage_dependency"
    assert result["checks"][0]["field"] == "execution_runtime"
    assert result["budget"]["setup_spent_credits"] == "0"
    assert calls == []


def test_unresolved_paid_usage_blocks_stage_advancement(setup_client, monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the wizard on its current stage until provider or sandbox usage settles."""
    client, _engine, _calls = setup_client
    budget = _budget(client)

    def pending(_gateway: Any, _payload: dict[str, Any], **_kwargs: Any) -> dict[str, Any]:
        """Simulate a paid setup call whose final receipt is unavailable.

        Args:
            _gateway: Unused protected model gateway.
            _payload: Unused canonical setup payload.
            **_kwargs: Unused scope and evidence identity.

        Raises:
            UsagePendingError: Always, to model unresolved provider usage.
        """
        raise UsagePendingError("The final provider receipt is unavailable.")

    monkeypatch.setattr(wizard_preflight, "_verify_anything", pending)
    response = client.post("/wizard/preflight", json=_request(budget))
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "pending"
    assert result["may_advance"] is False
    assert result["pending_reason"]["category"] == "usage_reconciliation"
    assert any(check["key"] == "usage" and check["status"] == "pending" for check in result["checks"])
