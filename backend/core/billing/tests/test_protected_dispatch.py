"""Prove final-request admission and exactly-once charging at the HTTP boundary."""

from __future__ import annotations

import json
from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
from sqlalchemy import Engine, create_engine, select
from sqlalchemy.orm import Session

from core.billing.budgets import BudgetInsufficientError, BudgetService
from core.billing.model_dispatch import (
    BYOK_FUNDS_EXHAUSTED,
    FUNDS_BUSY,
    MANAGED_FUNDS_EXHAUSTED,
    OpenRouterDispatcher,
    response_usage,
)
from core.billing.openrouter_quotes import price_text_request
from core.billing.operation_pricing import ChargePolicy, UnpricedOperationError
from core.billing.runtime import BudgetRuntime, OperationCompletedError, UsagePendingError
from core.storage.models import Base, BillingCustomerModel, ExecutionOperationModel

CATALOG = {
    "id": "fixture/text",
    "endpoints": [
        {
            "tag": "fixture",
            "provider_name": "Fixture",
            "context_length": 1000,
            "max_completion_tokens": 1000,
            "pricing": {"prompt": "0.00001", "completion": "0.00002", "input_cache_write": "0.000015"},
        }
    ],
}
REQUEST = {"model": "fixture/text", "max_tokens": 100, "messages": [{"role": "user", "content": "hello"}]}


@pytest.fixture
def database(tmp_path: Path) -> Iterator[Engine]:
    """Keep wallet and operation evidence in a private test database."""
    engine = create_engine(f"sqlite:///{tmp_path / 'dispatch.db'}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(username="alice", stripe_customer_id="fixture", credit_balance=100, grant_remaining=0)
        )
        session.commit()
    yield engine
    engine.dispose()


def _runtime(database: Engine, total: int = 50) -> BudgetRuntime:
    """Create a setup authority with real durable admission and settlement."""
    service = BudgetService(engine=database)
    budget = service.create("alice", total, idempotency_key="setup")
    return BudgetRuntime(service, username="alice", budget_id=budget.id, generation=0, phase="setup", wait_timeout=0)


def test_final_request_caps_include_cache_and_output_overrides() -> None:
    """Bind quotes after overrides and cover cache writes without billing the hold."""
    original = json.loads(json.dumps(REQUEST))
    policy = ChargePolicy("managed_model")
    first = price_text_request(original, CATALOG, policy)
    changed = price_text_request({**original, "max_tokens": 500}, CATALOG, policy)
    assert first.quote.maximum.total == Decimal("1.785")
    assert changed.quote.maximum.total == Decimal("2.625")
    assert first.quote.request_fingerprint != changed.quote.request_fingerprint
    assert first.body["provider"]["max_price"]["completion"] == 20
    assert "provider" not in original


@pytest.mark.parametrize(
    "extra",
    [
        {"max_tokens": None},
        {"plugins": [{"id": "web"}]},
        {"n": 2},
        {"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": "https://example.com"}]}]},
        {"model": "other/model"},
        {"service_tier": "priority"},
    ],
)
def test_unbounded_requests_never_authorize_work(extra: dict) -> None:
    """Reject absent bounds or uncovered billable categories before dispatch."""
    with pytest.raises(UnpricedOperationError):
        price_text_request({**REQUEST, **extra}, CATALOG, ChargePolicy("managed_model"))


def test_paid_provider_failure_settles_and_is_not_replayed(database: Engine) -> None:
    """Charge measured usage on a failed response and reject duplicate physical dispatch."""
    runtime = _runtime(database)
    calls = []

    def provider(request: httpx.Request) -> httpx.Response:
        """Assert the hold exists before the first byte reaches the fake provider."""
        if request.method == "GET":
            return httpx.Response(200, json={"data": CATALOG})
        calls.append(request)
        assert runtime.service.get(runtime.budget_id, "alice").reserved_credits == Decimal("1.785")
        return httpx.Response(
            500, json={"id": "gen-one", "error": "failed after inference", "usage": {"cost": "0.004"}}
        )

    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        dispatcher = OpenRouterDispatcher(
            runtime,
            api_key="private",
            model="fixture/text",
            role="judge",
            policy=ChargePolicy("managed_model"),
            client=client,
        )
        result = dispatcher.dispatch("/chat/completions", REQUEST)
    assert result.status == 500
    snapshot = runtime.service.get(runtime.budget_id, "alice")
    assert len(calls) == 1
    assert snapshot.setup_spent_credits == Decimal("0.4")
    assert snapshot.billed_credits == 1
    assert snapshot.reserved_credits == 0


def test_each_physical_retry_has_separate_coverage_and_delivery_replay_is_deduplicated(database: Engine) -> None:
    """Reserve and settle each real retry while refusing a replay of either attempt."""
    runtime = _runtime(database)
    posts: list[httpx.Request] = []
    held_before_dispatch: list[Decimal] = []

    def provider(request: httpx.Request) -> httpx.Response:
        """Return measured usage for two separately admitted provider attempts."""
        if request.method == "GET":
            return httpx.Response(200, json={"data": CATALOG})
        posts.append(request)
        held_before_dispatch.append(runtime.service.get(runtime.budget_id, "alice").reserved_credits)
        number = len(posts)
        return httpx.Response(
            503 if number == 1 else 200,
            json={
                "id": f"gen-{number}",
                "usage": {"cost": "0.004" if number == 1 else "0.002"},
                "choices": [{"message": {"content": "retry" if number == 1 else "OK"}}],
            },
        )

    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        dispatcher = OpenRouterDispatcher(
            runtime,
            api_key="private",
            model="fixture/text",
            role="optimization",
            policy=ChargePolicy("managed_model"),
            client=client,
        )
        first = dispatcher.dispatch("/chat/completions", REQUEST, operation_key="logical-call", attempt=0)
        with pytest.raises(OperationCompletedError):
            dispatcher.dispatch("/chat/completions", REQUEST, operation_key="logical-call", attempt=0)
        second = dispatcher.dispatch("/chat/completions", REQUEST, operation_key="logical-call", attempt=1)
        with pytest.raises(OperationCompletedError):
            dispatcher.dispatch("/chat/completions", REQUEST, operation_key="logical-call", attempt=1)

    assert (first.status, second.status) == (503, 200)
    assert len(posts) == 2
    assert held_before_dispatch == [Decimal("1.785"), Decimal("1.785")]
    snapshot = runtime.service.get(runtime.budget_id, "alice")
    assert snapshot.setup_spent_credits == Decimal("0.6")
    assert snapshot.reserved_credits == 0
    with Session(database) as session:
        operations = session.scalars(select(ExecutionOperationModel).order_by(ExecutionOperationModel.attempt)).all()
    assert [(operation.attempt, operation.state) for operation in operations] == [(0, "settled"), (1, "settled")]


def test_insufficient_setup_never_sends_inference_and_remains_editable(database: Engine) -> None:
    """Leave the user able to increase setup allowance without silently truncating a request."""
    runtime = _runtime(database, total=1)

    def provider(request: httpx.Request) -> httpx.Response:
        """Permit only free catalog retrieval when the operation is not covered."""
        assert request.method == "GET"
        return httpx.Response(200, json={"data": CATALOG})

    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        dispatcher = OpenRouterDispatcher(
            runtime,
            api_key="private",
            model="fixture/text",
            role="judge",
            policy=ChargePolicy("managed_model"),
            client=client,
        )
        with pytest.raises(BudgetInsufficientError):
            dispatcher.dispatch("/chat/completions", REQUEST)
    assert runtime.service.get(runtime.budget_id, "alice").state == "open"


def test_missing_usage_remains_reserved_without_a_fake_zero_charge(database: Engine) -> None:
    """Keep a completed but unpriced response pending for later reconciliation."""
    runtime = _runtime(database)

    def provider(request: httpx.Request) -> httpx.Response:
        """Return a provider result whose charge is temporarily unavailable."""
        if request.url.path.endswith("/endpoints"):
            return httpx.Response(200, json={"data": CATALOG})
        if request.method == "GET":
            return httpx.Response(404)
        return httpx.Response(200, json={"id": "gen-pending", "choices": []})

    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        dispatcher = OpenRouterDispatcher(
            runtime,
            api_key="private",
            model="fixture/text",
            role="judge",
            policy=ChargePolicy("managed_model"),
            client=client,
        )
        with pytest.raises(UsagePendingError):
            dispatcher.dispatch("/chat/completions", REQUEST)
    snapshot = runtime.service.get(runtime.budget_id, "alice")
    assert snapshot.reserved_credits == Decimal("1.785")
    assert snapshot.setup_spent_credits == 0
    assert snapshot.pending_operations == 1
    with Session(database) as session:
        operation = session.scalar(select(ExecutionOperationModel))
        assert operation.provider_request_id == "gen-pending"
        assert operation.state == "pending"


def test_anthropic_stream_merges_final_cost_without_inventing_zero() -> None:
    """Read a generation identity from message-start and its cost from message-delta."""
    stream = b'data: {"type":"message_start","message":{"id":"gen-stream","usage":{"input_tokens":8}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":2,"cost":0.001}}\n\ndata: [DONE]\n'
    identity, usage = response_usage(stream, "text/event-stream")
    assert identity == "gen-stream"
    assert usage == {"input_tokens": 8, "output_tokens": 2, "cost": 0.001}


def test_sandbox_cost_has_no_model_markup() -> None:
    """Pass sandbox and managed dollars through at cost; charge BYOK only the platform fee."""
    assert ChargePolicy("sandbox").convert(Decimal("0.01")).total == 1
    # MARKUP is 1.0 (runs at cost), so a managed model bills its par credit value.
    assert ChargePolicy("managed_model").convert(Decimal("0.01")).total == 1
    byok = ChargePolicy("byok_model").convert(Decimal("0.01"))
    # PLATFORM_FEE_FRACTION 0.05 of the par cost — OpenRouter's BYOK fee.
    assert byok.total == byok.wallet == Decimal("0.05")


def test_responses_dispatch_reserves_the_actual_protocol_body(database: Engine) -> None:
    """Cover native Responses output before sending and settle its nested final usage."""
    runtime = _runtime(database)
    calls = []

    def provider(request: httpx.Request) -> httpx.Response:
        """Check the real dispatch body against the admitted Responses operation."""
        if request.method == "GET":
            return httpx.Response(200, json={"data": CATALOG})
        calls.append(request)
        assert request.url.path == "/api/v1/responses"
        sent = json.loads(request.content)
        assert sent["input"] == [{"role": "user", "content": "Reply OK"}]
        assert sent["max_output_tokens"] == 1000
        assert "messages" not in sent
        assert "max_tokens" not in sent
        assert sent["provider"]["allow_fallbacks"] is False
        assert runtime.service.get(runtime.budget_id, "alice").reserved_credits > 0
        return httpx.Response(
            200,
            json={
                "id": "gen-responses",
                "status": "completed",
                "output": [],
                "usage": {"cost": "0.002"},
            },
        )

    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        dispatcher = OpenRouterDispatcher(
            runtime,
            api_key="private",
            model="fixture/text",
            role="task",
            policy=ChargePolicy("managed_model"),
            client=client,
        )
        response = dispatcher.dispatch(
            "/responses",
            {
                "model": "fixture/text",
                "input": [{"role": "user", "content": "Reply OK"}],
                "store": False,
            },
        )
    assert response.status == 200
    assert len(calls) == 1
    snapshot = runtime.service.get(runtime.budget_id, "alice")
    assert snapshot.setup_spent_credits == Decimal("0.2")
    assert snapshot.reserved_credits == 0


def _refusing_dispatcher(database: Engine, kind: str, headers: dict[str, str], calls: list) -> tuple:
    """Build a dispatcher whose fake OpenRouter answers every inference with 402."""
    runtime = _runtime(database)

    def provider(request: httpx.Request) -> httpx.Response:
        """Serve the price catalog and refuse inference for lack of credits."""
        if request.method == "GET":
            return httpx.Response(200, json={"data": CATALOG})
        calls.append(request)
        body = {"error": {"code": 402, "message": "Your account or API key has insufficient credits"}}
        return httpx.Response(402, json=body, headers=headers)

    client = httpx.Client(transport=httpx.MockTransport(provider))
    dispatcher = OpenRouterDispatcher(
        runtime, api_key="private", model="fixture/text", role="task", policy=ChargePolicy(kind), client=client
    )
    return runtime, dispatcher, client


@pytest.mark.parametrize(
    ("kind", "headers", "code"),
    [
        ("managed_model", {}, MANAGED_FUNDS_EXHAUSTED),
        ("byok_model", {}, BYOK_FUNDS_EXHAUSTED),
        ("managed_model", {"Retry-After": "5"}, FUNDS_BUSY),
    ],
)
def test_funds_refusal_is_named_uncharged_and_not_resent(
    database: Engine, monkeypatch: pytest.MonkeyPatch, kind: str, headers: dict, code: str
) -> None:
    """A 402 says which funds ran out, costs nothing, and later retries never reach OpenRouter."""
    alerts: list[str] = []
    monkeypatch.setattr("core.billing.model_dispatch.notify_managed_refusal", alerts.append)
    calls: list = []
    runtime, dispatcher, client = _refusing_dispatcher(database, kind, headers, calls)
    with client:
        first = dispatcher.dispatch("/chat/completions", REQUEST)
        second = dispatcher.dispatch("/chat/completions", REQUEST, attempt=1)
    assert first.status == second.status == 402
    assert json.loads(first.body)["error"]["type"] == code
    assert second.body == first.body
    assert len(calls) == 1
    snapshot = runtime.service.get(runtime.budget_id, "alice")
    assert snapshot.billed_credits == 0
    assert snapshot.reserved_credits == 0
    assert alerts == (["fixture/text"] if code == MANAGED_FUNDS_EXHAUSTED else [])


def test_funds_refusal_hold_expires(database: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """Once the hold lapses the route asks OpenRouter again."""
    calls: list = []
    clock = [1000.0]
    monkeypatch.setattr("core.billing.model_dispatch.time.monotonic", lambda: clock[0])
    monkeypatch.setattr("core.billing.model_dispatch.notify_managed_refusal", lambda model: None)
    _, dispatcher, client = _refusing_dispatcher(database, "managed_model", {"Retry-After": "5"}, calls)
    with client:
        dispatcher.dispatch("/chat/completions", REQUEST)
        clock[0] += 6
        dispatcher.dispatch("/chat/completions", REQUEST, attempt=1)
    assert len(calls) == 2
