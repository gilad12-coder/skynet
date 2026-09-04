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
from core.billing.model_dispatch import OpenRouterDispatcher, response_usage
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
    assert first.quote.maximum.total == Decimal("2.6775")
    assert changed.quote.maximum.total == Decimal("3.9375")
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
        assert runtime.service.get(runtime.budget_id, "alice").reserved_credits == Decimal("2.6775")
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
    assert snapshot.setup_spent_credits == Decimal("0.6")
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
    assert held_before_dispatch == [Decimal("2.6775"), Decimal("2.6775")]
    snapshot = runtime.service.get(runtime.budget_id, "alice")
    assert snapshot.setup_spent_credits == Decimal("0.9")
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
    assert snapshot.reserved_credits == Decimal("2.6775")
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
    """Pass sandbox dollars through at cost while retaining the approved model policy."""
    assert ChargePolicy("sandbox").convert(Decimal("0.01")).total == 1
    assert ChargePolicy("managed_model").convert(Decimal("0.01")).total == Decimal("1.5")
    byok = ChargePolicy("byok_model").convert(Decimal("0.01"))
    assert byok.total == byok.wallet == Decimal("0.42")


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
    assert snapshot.setup_spent_credits == Decimal("0.3")
    assert snapshot.reserved_credits == 0
