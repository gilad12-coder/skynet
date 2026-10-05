"""Prove batched chat requests are submitted together, answered individually, and billed exactly."""

from __future__ import annotations

import json
import threading
from decimal import Decimal

import httpx
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from core.billing.model_batch import BatchCollector, allocate_cost
from core.billing.model_dispatch import OpenRouterDispatcher
from core.billing.operation_pricing import ChargePolicy
from core.billing.tests.test_protected_dispatch import CATALOG, REQUEST, _runtime
from core.config import settings
from core.storage.models import Base, BillingCustomerModel, ExecutionUsageEvidenceModel

RATES = (Decimal("0.000001"), Decimal("0.000004"))


def _body(text: str) -> dict:
    """Build a priced chat body as the dispatcher would send it."""
    return {
        "model": "fixture/text",
        "max_tokens": 10,
        "provider": {"only": ["fixture"], "max_price": {"prompt": 1}},
        "messages": [{"role": "user", "content": text}],
    }


def _collector(handler, **kwargs) -> tuple[BatchCollector, httpx.Client]:
    """Build a collector with instant sleeps against a fake OpenRouter."""
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return BatchCollector(api_key="k", model="fixture/text", client=client, sleep=lambda _: None, **kwargs), client


def _run_all(collector: BatchCollector, texts: list[str]) -> list:
    """Submit requests from concurrent threads, as an optimizer's evaluation round does."""
    answers: list = [None] * len(texts)

    def worker(index: int) -> None:
        answers[index] = collector.run(_body(texts[index]), RATES)

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(len(texts))]
    # Hold the gather window open until every request has queued.
    gate = threading.Event()
    collector._sleep = lambda seconds: gate.wait()
    for thread in threads:
        thread.start()
    while len(collector._pending) < len(texts):
        pass
    collector._sleep = lambda _: None
    gate.set()
    for thread in threads:
        thread.join(timeout=5)
    return answers


def test_allocation_sums_exactly_to_the_batch_bill() -> None:
    """Share a bill by weight without losing or inventing a fraction of a cent."""
    shares = allocate_cost(Decimal("0.01"), [Decimal(1), Decimal(1), Decimal(1)])
    assert sum(shares) == Decimal("0.01")
    assert allocate_cost(Decimal("0.3"), [Decimal(0), Decimal(0)]) == [Decimal("0.15"), Decimal("0.15")]


def test_concurrent_requests_share_one_batch_and_its_bill() -> None:
    """Submit one batch with batch fields first, then split its cost by token weight."""
    submitted = []
    polls = []

    def provider(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            payload = json.loads(request.content)
            submitted.append((list(payload), payload))
            return httpx.Response(200, json={"id": "batch-1", "status": "validating"})
        polls.append(request.url.path)
        if len(polls) == 1:
            return httpx.Response(200, json={"id": "batch-1", "status": "in_progress"})
        requests = submitted[0][1]["requests"]
        return httpx.Response(
            200,
            json={
                "id": "batch-1",
                "status": "completed",
                "results": [
                    {
                        "custom_id": item["custom_id"],
                        "response": {
                            "status_code": 200,
                            "body": {
                                "id": f"gen-batch-{index}",
                                "choices": [{"message": {"content": item["body"]["messages"][0]["content"]}}],
                                "usage": {"prompt_tokens": 100 * (index + 1), "completion_tokens": 0},
                            },
                        },
                    }
                    for index, item in enumerate(requests)
                ],
                "usage": {"cost": "0.0003", "is_byok": False},
            },
        )

    beats = []
    collector, client = _collector(provider, heartbeat=lambda: beats.append(1))
    with client:
        answers = _run_all(collector, ["a", "b"])
    assert len(submitted) == 1
    order, payload = submitted[0]
    assert order == ["endpoint", "model", "provider", "completion_window", "requests"]
    assert payload["provider"] == {"only": ["fixture"]}
    assert all("model" not in item["body"] and "provider" not in item["body"] for item in payload["requests"])
    bodies = {
        json.loads(answer.body)["choices"][0]["message"]["content"]: json.loads(answer.body) for answer in answers
    }
    costs = [Decimal(body["usage"]["cost"]) for body in bodies.values()]
    assert sum(costs) == Decimal("0.0003")
    assert sorted(costs) == [Decimal("0.0001"), Decimal("0.0002")]
    assert all(answer.status == 200 and not answer.interrupted for answer in answers)
    assert len(beats) == 2


def test_rejected_batch_is_refused_without_a_charge() -> None:
    """A batch the provider refuses never ran, so each request fails with no usage."""
    collector, client = _collector(lambda request: httpx.Response(400, json={"error": "bad"}))
    with client:
        answer = collector.run(_body("a"), RATES)
    assert answer.status == 502
    assert not answer.interrupted
    assert "usage" not in json.loads(answer.body)


def test_lost_batch_holds_coverage() -> None:
    """A batch that never finishes is interrupted, so its coverage waits for reconciliation."""

    def provider(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "batch-1"})
        return httpx.Response(200, json={"id": "batch-1", "status": "in_progress"})

    ticks = iter(range(0, 10**6, 100))
    collector, client = _collector(provider, deadline_seconds=250, clock=lambda: next(ticks))
    with client:
        answer = collector.run(_body("a"), RATES)
    assert answer.interrupted


def test_unfinished_requests_in_an_expired_batch_are_refused() -> None:
    """Only requests with results are answered and billed when a batch expires partway."""

    def provider(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "batch-1"})
        return httpx.Response(200, json={"id": "batch-1", "status": "expired", "results": [], "usage": {"cost": 0}})

    collector, client = _collector(provider)
    with client:
        answer = collector.run(_body("a"), RATES)
    assert answer.status == 502
    assert not answer.interrupted
    assert json.loads(answer.body)["error"]["type"] == "batch_incomplete"


def test_finished_batch_is_deleted_after_its_answers() -> None:
    """Purge a terminal batch so its prompts do not sit in provider storage for 30 days."""
    deleted = threading.Event()
    paths = []

    def provider(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "batch-1"})
        if request.method == "DELETE":
            paths.append(request.url.path)
            deleted.set()
            return httpx.Response(200, json={"id": "batch-1", "deleted": True})
        return httpx.Response(200, json={"id": "batch-1", "status": "expired", "results": [], "usage": {"cost": 0}})

    collector, client = _collector(provider)
    with client:
        collector.run(_body("a"), RATES)
        assert deleted.wait(5)
    assert paths == ["/api/v1/batches/batch-1"]


def test_lost_batch_is_not_deleted() -> None:
    """A batch still running past the deadline is left alone, since deleting needs a terminal state."""
    methods = []

    def provider(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        if request.method == "POST":
            return httpx.Response(200, json={"id": "batch-1"})
        return httpx.Response(200, json={"id": "batch-1", "status": "in_progress"})

    ticks = iter(range(0, 10**6, 100))
    collector, client = _collector(provider, deadline_seconds=250, clock=lambda: next(ticks))
    with client:
        collector.run(_body("a"), RATES)
    assert "DELETE" not in methods


def test_requests_with_different_data_policies_are_batched_apart() -> None:
    """Carry each group's data policy as batch-level routing instead of mixing policies."""
    submitted = []

    def provider(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            submitted.append(json.loads(request.content)["provider"])
            return httpx.Response(200, json={"id": f"batch-{len(submitted)}"})
        return httpx.Response(200, json={"id": "batch", "status": "expired", "results": []})

    collector, client = _collector(provider)
    deny = {**_body("a"), "provider": {"only": ["fixture"], "data_collection": "deny", "zdr": True}}
    allow = {**_body("b"), "provider": {"only": ["fixture"], "data_collection": "allow"}}
    gate = threading.Event()
    collector._sleep = lambda seconds: gate.wait()
    threads = [threading.Thread(target=collector.run, args=(body, RATES)) for body in (deny, allow)]
    with client:
        for thread in threads:
            thread.start()
        while len(collector._pending) < 2:
            pass
        collector._sleep = lambda _: None
        gate.set()
        for thread in threads:
            thread.join(timeout=5)
    assert sorted(submitted, key=json.dumps) == sorted(
        [
            {"only": ["fixture"], "data_collection": "deny", "zdr": True},
            {"only": ["fixture"], "data_collection": "allow"},
        ],
        key=json.dumps,
    )


def test_economy_dispatch_settles_the_batch_share(tmp_path, monkeypatch) -> None:
    """A managed chat call through the relay waits for its batch and is charged its measured share."""
    monkeypatch.setattr(settings, "usage_markup", 1.0)
    engine = create_engine(f"sqlite:///{tmp_path / 'batch.db'}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(username="alice", stripe_customer_id="fixture", balance_cents=100, grant_remaining=0)
        )
        session.commit()
    runtime = _runtime(engine)
    direct = []

    def provider(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/endpoints"):
            return httpx.Response(200, json={"data": CATALOG})
        if request.url.path == "/api/v1/chat/completions":
            direct.append(request)
        if request.method == "POST":
            custom_id = json.loads(request.content)["requests"][0]["custom_id"]
            provider.custom_id = custom_id
            return httpx.Response(200, json={"id": "batch-1"})
        return httpx.Response(
            200,
            json={
                "id": "batch-1",
                "status": "completed",
                "results": [
                    {
                        "custom_id": provider.custom_id,
                        "response": {"status_code": 200, "body": {"id": "gen-batch-1", "usage": {"prompt_tokens": 5}}},
                    }
                ],
                "usage": {"cost": "0.002", "is_byok": False},
            },
        )

    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        collector = BatchCollector(api_key="k", model="fixture/text", client=client, sleep=lambda _: None)
        dispatcher = OpenRouterDispatcher(
            runtime,
            api_key="k",
            model="fixture/text",
            role="task",
            policy=ChargePolicy("managed_model"),
            client=client,
            batch=collector,
        )
        result = dispatcher.dispatch("/chat/completions", REQUEST)
    assert result.status == 200
    assert not direct
    with Session(engine) as session:
        evidence = session.scalars(select(ExecutionUsageEvidenceModel)).one().evidence
    assert evidence["batched"] is True
    assert "latency_ms" not in evidence
    snapshot = runtime.service.get(runtime.budget_id, "alice")
    assert snapshot.setup_spent_cents == Decimal("0.2")
    assert snapshot.reserved_cents == 0


def test_stop_releases_waiting_requests() -> None:
    """Closing a run ends the wait at once, holding submitted work and refusing new work."""
    polled = threading.Event()

    def provider(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "batch-1"})
        polled.set()
        return httpx.Response(200, json={"id": "batch-1", "status": "in_progress"})

    client = httpx.Client(transport=httpx.MockTransport(provider))
    collector = BatchCollector(api_key="k", model="fixture/text", client=client, gather_seconds=0, poll_seconds=0.01)
    answers = []
    thread = threading.Thread(target=lambda: answers.append(collector.run(_body("a"), RATES)))
    thread.start()
    assert polled.wait(5)
    collector.stop()
    thread.join(timeout=5)
    assert answers[0].interrupted
    assert collector.run(_body("b"), RATES).status == 502
    client.close()
