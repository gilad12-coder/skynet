"""The contract-check routes: static answers, budget gating and the sandboxed result."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.api.auth import AuthenticatedUser, get_authenticated_user
from core.api.routers import wizard_preflight

RUN_CODE = "def run(artifact, input):\n    return artifact\n"
METRIC_CODE = "def score(input, output, expected=None):\n    return 1.0, {'feedback': 'ok'}\n"


def _spec(*, run_code: str = RUN_CODE, budget: bool = True) -> dict[str, Any]:
    """Build a unified spec as the wizard sends it."""
    spec: dict[str, Any] = {
        "task": {"objective": "o", "artifact": {"kind": "prompt", "starting_version": "p"}},
        "data": {
            "mode": "pairs",
            "cases": [{"input": {"q": str(i)}, "expected": "p"} for i in range(3)],
            "input_fields": ["q"],
        },
        "optimizer": {"choice": "best_of_n"},
        "models": {"reflection_model": {"name": "openrouter/task"}},
        "workspace": {"run_code": run_code, "metric_code": METRIC_CODE},
    }
    if budget:
        spec["execution_budget_id"] = "b1"
        spec["execution_budget_revision"] = 1
    return spec


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """Replace paid preflight work with a recorder that returns a passing contract."""
    recorded: list[Any] = []

    def run(request: Any, user: Any, store: Any) -> Any:
        """Record the request and answer with an in-box contract result."""
        recorded.append(request)
        return SimpleNamespace(
            status="succeeded",
            checks=[],
            workflow_result={
                "contract": {
                    "ok": True,
                    "optimizer_resolved": "best_of_n",
                    "metric_shape": "blackbox_side_info",
                    "checks": [],
                    "samples": [],
                    "fingerprint": "f",
                }
            },
        )

    monkeypatch.setattr(wizard_preflight, "run_preflight", run)
    monkeypatch.setattr(wizard_preflight, "enforce_submission_rate", lambda username: None)
    monkeypatch.setattr(wizard_preflight, "_materialize_unified_cases", lambda *args, **kwargs: None)
    return recorded


def _client() -> TestClient:
    """Mount the router behind a signed-in user."""
    app = FastAPI()
    app.include_router(wizard_preflight.create_wizard_preflight_router(job_store=object()))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser("alice", "user", ())
    return TestClient(app)


def test_static_route_reports_a_mismatch_without_running(calls: list[Any]) -> None:
    """The static route answers 200 with ``ok=false`` and never dispatches work."""
    with _client() as client:
        response = client.post("/optimizations/contract-check/static", json={"spec": _spec(run_code="x = 1\n")})

    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert calls == []


def test_sandbox_route_skips_the_box_when_static_checks_fail(calls: list[Any]) -> None:
    """A signature mismatch is returned as is, without spending."""
    with _client() as client:
        response = client.post("/optimizations/contract-check", json={"spec": _spec(run_code="x = 1\n")})

    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert calls == []


def test_sandbox_route_needs_a_budget(calls: list[Any]) -> None:
    """Without a spending budget the check is refused with 402."""
    with _client() as client:
        response = client.post("/optimizations/contract-check", json={"spec": _spec(budget=False)})

    assert response.status_code == 402
    assert calls == []


def test_sandbox_route_returns_the_in_box_contract(calls: list[Any]) -> None:
    """A fitting spec runs as a unified evaluation preflight and returns its contract."""
    with _client() as client:
        response = client.post("/optimizations/contract-check", json={"spec": _spec()})

    assert response.status_code == 200
    assert response.json()["ok"] is True
    [request] = calls
    assert (request.scope, request.workflow) == ("evaluation", "unified")


def test_sandbox_route_forwards_the_sample_count(calls: list[Any]) -> None:
    """The wizard's sample count reaches the preflight; over the maximum is a 422."""
    with _client() as client:
        response = client.post("/optimizations/contract-check", json={"spec": _spec(), "sample_count": 5})
        too_many = client.post("/optimizations/contract-check", json={"spec": _spec(), "sample_count": 50})

    assert response.status_code == 200
    assert too_many.status_code == 422
    [request] = calls
    assert request.contract_sample_count == 5


def test_static_route_reports_whether_the_metric_calls_llm(calls: list[Any]) -> None:
    """``uses_llm`` mirrors the metric source, so the wizard asks for a metric model only when needed."""
    spec = _spec()
    spec["workspace"]["metric_code"] = (
        "from skynet import llm\ndef score(input, output, expected=None):\n    return float(llm('j', output)), {}\n"
    )
    with _client() as client:
        plain = client.post("/optimizations/contract-check/static", json={"spec": _spec()})
        judged = client.post("/optimizations/contract-check/static", json={"spec": spec})

    assert plain.json()["uses_llm"] is False
    assert judged.json()["uses_llm"] is True
