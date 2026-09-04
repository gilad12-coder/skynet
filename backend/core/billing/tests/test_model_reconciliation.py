"""Verify uncertain model usage settles once from the original provider receipt."""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from core.billing.model_dispatch import OpenRouterDispatcher, generation_charge
from core.billing.model_reconciliation import OpenRouterUsageReconciler
from core.billing.openrouter_quotes import resolve_model_slug
from core.billing.operation_pricing import ChargePolicy
from core.billing.runtime import UsagePendingError
from core.billing.tests.test_protected_dispatch import CATALOG, REQUEST, _runtime
from core.billing.tests.test_protected_dispatch import database as _database_fixture
from core.storage.models import ExecutionOperationModel

database = _database_fixture


def test_truncated_stream_retains_charge_until_original_generation_settles(database) -> None:
    """Reject an early stream cost and later settle the exact generation without another POST."""
    runtime = _runtime(database)
    calls = []
    confirmed = False

    def provider(request: httpx.Request) -> httpx.Response:
        """Return early usage followed by a delayed authoritative billing receipt."""
        calls.append(request)
        if request.url.path.endswith("/endpoints"):
            return httpx.Response(200, json={"data": CATALOG})
        if request.method == "POST":
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=b'data: {"id":"gen-held","usage":{"cost":0}}\n\n',
            )
        if not confirmed:
            return httpx.Response(404)
        return httpx.Response(
            200,
            json={
                "data": {
                    "id": "gen-held",
                    "model": "fixture/text",
                    "total_cost": "0.004",
                    "is_byok": False,
                }
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
        with pytest.raises(UsagePendingError):
            dispatcher.dispatch("/chat/completions", {**REQUEST, "stream": True})
        with Session(database) as session:
            operation = session.scalar(select(ExecutionOperationModel))
            operation_id = operation.id
        snapshot = runtime.service.get(runtime.budget_id, "alice")
        assert snapshot.setup_spent_credits == 0
        assert snapshot.pending_operations == 1
        assert snapshot.reserved_credits > 0
        reconciler = OpenRouterUsageReconciler(runtime.service, lambda owner, digest: "private")
        confirmed = True
        assert reconciler.reconcile(operation_id, "alice", client=client).state == "settled"
        read_count = len(calls)
        reconciler.reconcile(operation_id, "alice", client=client)
        assert len(calls) == read_count
    snapshot = runtime.service.get(runtime.budget_id, "alice")
    assert snapshot.setup_spent_credits == Decimal("0.6")
    assert snapshot.reserved_credits == 0
    assert len([call for call in calls if call.method == "POST"]) == 1


def test_rotated_credential_does_not_query_or_release_original_hold(database) -> None:
    """Keep uncertain usage covered when its original provider credential is unavailable."""
    runtime = _runtime(database)

    def pending_provider(request: httpx.Request) -> httpx.Response:
        """Return one paid generation with no available final usage yet."""
        if request.url.path.endswith("/endpoints"):
            return httpx.Response(200, json={"data": CATALOG})
        if request.method == "POST":
            return httpx.Response(200, json={"id": "gen-original"})
        return httpx.Response(404)

    with httpx.Client(transport=httpx.MockTransport(pending_provider)) as client:
        dispatcher = OpenRouterDispatcher(
            runtime,
            api_key="original",
            model="fixture/text",
            role="judge",
            policy=ChargePolicy("managed_model"),
            client=client,
        )
        with pytest.raises(UsagePendingError):
            dispatcher.dispatch("/chat/completions", REQUEST)
    with Session(database) as session:
        operation_id = session.scalar(select(ExecutionOperationModel.id))

    def forbidden(request: httpx.Request) -> httpx.Response:
        """Fail if reconciliation attempts to use an unrelated provider credential."""
        pytest.fail("Rotated credentials must not be used for an old generation.")

    with httpx.Client(transport=httpx.MockTransport(forbidden)) as client:
        reconciler = OpenRouterUsageReconciler(runtime.service, lambda owner, digest: "rotated")
        with pytest.raises(UsagePendingError):
            reconciler.reconcile(operation_id, "alice", client=client)
    assert runtime.service.get(runtime.budget_id, "alice").pending_operations == 1


@pytest.mark.parametrize(
    ("is_byok", "upstream", "expected"),
    [
        (True, "0.01", Decimal("0.0105")),
        (False, "0.01", Decimal("0.0005")),
        (None, "0.01", None),
        (True, None, None),
        (None, None, Decimal("0.0005")),
    ],
)
def test_provider_fee_and_external_cost_are_not_double_counted(is_byok, upstream, expected) -> None:
    """Use explicit provider attribution rather than guessing an external bill's scope."""
    assert (
        generation_charge({"total_cost": "0.0005", "is_byok": is_byok, "upstream_inference_cost": upstream}) == expected
    )


def test_legacy_model_alias_requires_a_unique_exact_catalog_match() -> None:
    """Preserve old short identifiers without choosing a different or ambiguous model."""
    rows = [{"id": "openai/gpt-4o-mini"}]
    with httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"data": rows}))
    ) as client:
        assert resolve_model_slug("gpt-4o-mini", client=client) == "openai/gpt-4o-mini"
        rows.append({"id": "other/gpt-4o-mini"})
        with pytest.raises(ValueError, match="ambiguous"):
            resolve_model_slug("gpt-4o-mini", client=client)
