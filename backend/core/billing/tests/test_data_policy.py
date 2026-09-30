"""Prove the model data-privacy setting reaches every platform-paid request and fails closed."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from core.billing import data_policy
from core.billing.data_policy import apply_data_policy, configure_data_policy, data_policy_for, zero_retention_models
from core.billing.model_dispatch import OpenRouterDispatcher
from core.billing.operation_pricing import ChargePolicy
from core.billing.tests.test_protected_dispatch import CATALOG, REQUEST, _runtime, database  # noqa: F401
from core.storage.models import Base, ModelPrivacyPreferenceModel


@pytest.fixture
def preferences(tmp_path: Path) -> Iterator[Engine]:
    """Point preference lookups at a private database and restore the default afterwards."""
    engine = create_engine(f"sqlite:///{tmp_path / 'prefs.db'}")
    Base.metadata.create_all(engine)
    configure_data_policy(engine)
    yield engine
    configure_data_policy(None)
    engine.dispose()


def test_missing_row_unknown_value_and_unavailable_storage_all_deny(preferences: Engine) -> None:
    """Never widen where prompts go because a preference could not be read."""
    assert data_policy_for("alice") == "deny"
    with Session(preferences) as session:
        session.add(ModelPrivacyPreferenceModel(username="alice", data_policy="bogus"))
        session.add(ModelPrivacyPreferenceModel(username="bob", data_policy="allow"))
        session.commit()
    assert data_policy_for("alice") == "deny"
    assert data_policy_for("bob") == "allow"
    preferences.dispose()
    configure_data_policy(create_engine("sqlite:////nonexistent/dir/prefs.db"))
    assert data_policy_for("bob") == "deny"


@pytest.mark.parametrize(
    ("policy", "expected"),
    [
        ("allow", {"only": ["x"], "data_collection": "allow"}),
        ("deny", {"only": ["x"], "data_collection": "deny"}),
        ("zdr", {"only": ["x"], "data_collection": "deny", "zdr": True}),
    ],
)
def test_setting_overrides_guest_routing(policy: str, expected: dict) -> None:
    """A guest cannot loosen the owner's setting through its own provider routing."""
    guest = {**REQUEST, "provider": {"only": ["x"], "data_collection": "allow", "zdr": False}}
    assert apply_data_policy(guest, policy)["provider"] == expected  # type: ignore[arg-type]


def test_managed_dispatch_sends_the_policy_and_names_the_setting_on_refusal(database: Engine) -> None:  # noqa: F811
    """Send data_collection upstream and turn OpenRouter's account-centric 404 into guidance."""
    sent = []

    def provider(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"data": CATALOG})
        sent.append(json.loads(request.content))
        return httpx.Response(
            404,
            json={"error": {"message": "No endpoints found matching your data policy. Configure: openrouter.ai"}},
        )

    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        dispatcher = OpenRouterDispatcher(
            _runtime(database),
            api_key="private",
            model="fixture/text",
            role="task",
            policy=ChargePolicy("managed_model"),
            client=client,
            data_policy="zdr",
        )
        result = dispatcher.dispatch("/chat/completions", REQUEST)
    assert sent[0]["provider"]["data_collection"] == "deny"
    assert sent[0]["provider"]["zdr"] is True
    assert result.status == 404
    error = json.loads(result.body)["error"]
    assert error["type"] == "data_policy_unavailable"
    assert "Model data privacy" in error["message"]
    assert "openrouter.ai" not in error["message"]


def test_zero_retention_list_is_cached_and_survives_an_outage(monkeypatch: pytest.MonkeyPatch) -> None:
    """Flag models from OpenRouter's ZDR list and keep the last good list when it is unreachable."""
    monkeypatch.setattr(data_policy, "_zdr_cache", None)
    rows = {"data": [{"model_id": "a/one"}, {"model_id": "a/one"}, {"model_id": "b/two"}, {"bad": 1}]}
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=rows))) as client:
        assert zero_retention_models(client) == {"a/one", "b/two"}
    monkeypatch.setattr(data_policy, "_ZDR_TTL_SECONDS", 0.0)
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(503))) as client:
        assert zero_retention_models(client) == {"a/one", "b/two"}
