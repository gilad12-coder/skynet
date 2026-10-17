"""The contract-check routes: static answers, budget gating and the sandboxed result."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.api import preflight_execution
from core.api.auth import AuthenticatedUser, get_authenticated_user
from core.api.routers import wizard_preflight
from core.billing.budgets import BudgetInsufficientError
from core.i18n import t
from core.worker.failure_events import failure_event

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


def test_sandbox_route_gives_an_older_images_items_their_message_codes(
    calls: list[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The pinned sandbox image can predate ``message_code``; the client still gets a code on every item.

    Without it, an English UI rendered the Hebrew base text of each item.
    """
    error = "KeyError: 'product'"
    traceback = f'Traceback (user code):\n  File "<run_code>", line 10, in run\n{error}'
    legacy_checks: list[dict[str, Any]] = [
        {"key": key, "status": "passed", "message": t("contract.passed")}
        for key in ("workspace.run_signature", "metric.signature", "metric.model")
    ]
    for index in range(3):
        legacy_checks += [
            {
                "key": "workspace.run",
                "status": "failed",
                "message": t("contract.run_error", index=index + 1, error=error),
                "sample_index": index,
                "detail": traceback,
            },
            {
                "key": "metric.shape",
                "status": "skipped",
                "message": t("contract.shape.blackbox"),
                "sample_index": index,
            },
        ]
    legacy = {
        "ok": False,
        "optimizer_resolved": "best_of_n",
        "metric_shape": "blackbox_side_info",
        "checks": legacy_checks,
        "samples": [{"index": i, "input_preview": "{}"} for i in range(3)],
        "fingerprint": "f",
    }
    monkeypatch.setattr(
        wizard_preflight,
        "run_preflight",
        lambda request, user, store: SimpleNamespace(status="failed", checks=[], workflow_result={"contract": legacy}),
    )
    with _client() as client:
        body = client.post("/optimizations/contract-check", json={"spec": _spec()}).json()

    assert body["ok"] is False
    assert all(item["message_code"] for item in body["checks"])
    runs = [item for item in body["checks"] if item["key"] == "workspace.run"]
    assert [(item["message_code"], item["message_params"]) for item in runs] == [
        ("contract.run_error", {"index": i + 1, "error": error}) for i in range(3)
    ]
    assert {item["message_code"] for item in body["checks"] if item["key"] == "metric.shape"} == {
        "contract.shape.blackbox"
    }
    assert {item["message_code"] for item in body["checks"] if item["sample_index"] is None} == {"contract.passed"}


SPENT = "The next operation needs up to 135 cents, but only 53 of the 53-cent limit remain."


@pytest.mark.parametrize(
    ("key", "code"),
    [("budget", "submit.unified.contract_budget"), ("setup", "submit.unified.contract_failed")],
)
def test_sandbox_route_tells_a_spent_budget_from_a_code_mismatch(
    monkeypatch: pytest.MonkeyPatch, calls: list[Any], key: str, code: str
) -> None:
    """A check stopped by the spending limit says so, instead of blaming the code."""
    failed = SimpleNamespace(key=key, status="failed", message=SPENT)
    monkeypatch.setattr(
        wizard_preflight,
        "run_preflight",
        lambda request, user, store: SimpleNamespace(status="failed", checks=[failed], workflow_result=None),
    )
    with _client() as client:
        body = client.post("/optimizations/contract-check", json={"spec": _spec()}).json()

    [run] = [item for item in body["checks"] if item["key"] == "workspace.run"]
    assert (run["message_code"], run["message_params"]) == (code, {"error": SPENT})
    assert run["message"] == t(code, error=SPENT)
    assert run["detail"] is None


@pytest.mark.parametrize(
    ("error", "key"),
    [(BudgetInsufficientError(SPENT), "budget"), (RuntimeError(SPENT), "setup")],
)
def test_preflight_reports_a_reservation_over_the_limit_as_a_budget_check(
    monkeypatch: pytest.MonkeyPatch, error: Exception, key: str
) -> None:
    """A runtime stopped by the check's limit fails the ``budget`` check; any other failure stays ``setup``.

    The sandbox supervisor reports every failure as an error event, so this
    drives the real ``_verify_anything`` through that event rather than
    raising past it.
    """

    class _Gateway:
        """Stand in for the model gateway without any paid transport."""

        budget_refusal = None

        def __init__(self, runtime: Any) -> None:
            """Ignore the budget runtime."""

        def protect_payload(self, payload: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
            """Hand the payload back unchanged."""
            return payload

        def close(self) -> None:
            """Nothing to settle."""

    def dispatch(payload: Any, artifact_id: str, events: Any, start_method: str) -> None:
        """Report the failure the way ``run_vercel_dspy`` does: as an error event."""
        events.put(failure_event(error))

    monkeypatch.setattr(preflight_execution, "ModelGateway", _Gateway)
    monkeypatch.setattr(preflight_execution, "bind_protected_sandbox", lambda *args, **kwargs: {})
    monkeypatch.setattr(preflight_execution, "payload_uses_token_source", lambda *args, **kwargs: False)
    monkeypatch.setattr(preflight_execution, "run_vercel_dspy", dispatch)
    request = preflight_execution.WizardPreflightRequest(
        scope="evaluation",
        workflow="anything",
        payload={"scorer": {"kind": "python", "metric_code": "def metric(candidate, case):\n    return 1.0\n"}},
        execution_budget_id="draft",
        execution_budget_revision=1,
    )

    status, result = preflight_execution._perform_preflight(
        request,
        SimpleNamespace(username="alice"),
        object(),
        SimpleNamespace(id="budget", generation=1),
        {"id": "setup"},
        attempt=1,
        engine=object(),
    )

    assert status == "failed"
    assert result["checks"] == [{"key": key, "status": "failed", "message": SPENT}]


@pytest.mark.parametrize(("refusal", "raised"), [(SPENT, BudgetInsufficientError), (None, ValueError)])
def test_unified_guest_failure_after_a_refused_call_is_a_budget_error(
    monkeypatch: pytest.MonkeyPatch, refusal: str | None, raised: type[Exception]
) -> None:
    """A guest that failed after the limit refused one of its model calls reports the budget, not the code."""

    def guest(payload: dict[str, Any], artifact_id: str, events: Any, start_method: str) -> None:
        """Fail in the guest the way a sample stopped by the limit does."""
        events.put({"type": "error", "error": "The code does not match", "traceback": ""})

    monkeypatch.setattr(preflight_execution, "run_vercel_dspy", guest)
    gateway = SimpleNamespace(budget_refusal=refusal)

    with pytest.raises(raised, match="135 cents" if refusal else "does not match"):
        preflight_execution._verify_unified(gateway, {}, scope="evaluation", identity="setup-1")


class _RouteGateway:
    """Answer the model route checks of a unified run without any paid transport."""

    budget_refusal = None

    def __init__(self, outcome: Exception | int) -> None:
        """Keep the refusal to raise, or the HTTP status to answer, for every route check."""
        self.outcome = outcome
        self.dispatched: list[str] = []

    def model_routes(self) -> list[dict[str, str]]:
        """List the one route the spec configures."""
        return [{"role": "optimization", "model": "openrouter/task", "token": "route-token"}]

    def dispatch_guest(self, token: str, path: str, body: dict[str, Any], headers: dict[str, str]) -> Any:
        """Refuse the call as the ledger does, or answer it with the configured status."""
        self.dispatched.append(token)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return SimpleNamespace(status=self.outcome, content=b'{"error": {"message": "no such model"}}')


def _sandbox_recorder(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Replace the outer sandbox with one that records its start and answers a ready contract."""
    started: list[str] = []

    def guest(payload: dict[str, Any], artifact_id: str, events: Any, start_method: str) -> None:
        """Report the contract and optimizer checks the guest verifier returns."""
        started.append(artifact_id)
        checks = [{"key": "metric.contract", "status": "succeeded"}, {"key": "optimizer", "status": "succeeded"}]
        events.put({"type": "preflight_result", "result": {"checks": checks}})

    monkeypatch.setattr(preflight_execution, "run_vercel_dspy", guest)
    return started


def test_unified_execution_check_refuses_a_limit_below_one_call_before_the_sandbox(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A limit that cannot hold one model call fails at once instead of after the contract check."""
    started = _sandbox_recorder(monkeypatch)
    gateway = _RouteGateway(BudgetInsufficientError(SPENT))

    with pytest.raises(BudgetInsufficientError, match="135 cents"):
        preflight_execution._verify_unified(gateway, _spec(budget=False), scope="execution", identity="setup-1")

    assert gateway.dispatched == ["route-token"]
    assert started == []


def test_unified_execution_check_stops_at_a_rejected_model_route(monkeypatch: pytest.MonkeyPatch) -> None:
    """A model the provider rejects ends the check with that route's failure, without opening the sandbox."""
    started = _sandbox_recorder(monkeypatch)

    result = preflight_execution._verify_unified(
        _RouteGateway(404), _spec(budget=False), scope="execution", identity="setup-1"
    )

    [check] = result["checks"]
    assert (check["key"], check["status"], check["field"]) == ("model.optimization", "failed", "optimization")
    assert "HTTP 404: no such model" in check["message"]
    assert started == []


@pytest.mark.parametrize(
    ("scope", "keys"),
    [
        ("execution", ["metric.contract", "model.optimization", "optimizer"]),
        ("evaluation", ["metric.contract", "optimizer"]),
    ],
)
def test_unified_check_reports_model_routes_beside_the_optimizer(
    monkeypatch: pytest.MonkeyPatch, scope: str, keys: list[str]
) -> None:
    """Passing route checks sit before the optimizer check; an evaluation check never probes the models."""
    started = _sandbox_recorder(monkeypatch)
    gateway = _RouteGateway(200)

    result = preflight_execution._verify_unified(gateway, _spec(budget=False), scope=scope, identity="setup-1")

    assert [check["key"] for check in result["checks"]] == keys
    assert started == ["preflight-setup-1"]
    assert gateway.dispatched == (["route-token"] if scope == "execution" else [])
