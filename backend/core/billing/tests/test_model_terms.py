"""Prove Gemma and Llama models never run on the platform's provider account."""

from __future__ import annotations

import json

import httpx
import pytest
from sqlalchemy import Engine

from core.billing.model_dispatch import OpenRouterDispatcher
from core.billing.model_terms import excluded_from_managed
from core.billing.operation_pricing import ChargePolicy
from core.billing.tests.test_protected_dispatch import _runtime, database  # noqa: F401


@pytest.mark.parametrize(
    ("model", "excluded"),
    [
        ("openrouter/google/gemma-3-27b-it", True),
        ("google/gemma-3n-e4b-it", True),
        ("openrouter/meta-llama/llama-4-maverick", True),
        ("nvidia/llama-3.3-nemotron-super-49b-v1.5", True),
        ("gemini/gemini-2.5-pro", False),
        ("openrouter/openai/gpt-5.1", False),
        ("ollama/llama3.2", False),
    ],
)
def test_licensed_families_are_withheld_from_managed_runs(model: str, excluded: bool) -> None:
    """Match Gemma and Llama by family name, leaving self-hosted and other models alone."""
    assert excluded_from_managed(model) is excluded


def test_managed_dispatch_refuses_a_withheld_model_before_any_provider_call(database: Engine) -> None:  # noqa: F811
    """A platform-paid call to Llama is refused without pricing or sending it."""
    calls = []
    client = httpx.Client(transport=httpx.MockTransport(lambda request: calls.append(request) or httpx.Response(500)))
    model = "meta-llama/llama-4-maverick"
    dispatcher = OpenRouterDispatcher(
        _runtime(database),
        api_key="k",
        model=model,
        role="task",
        policy=ChargePolicy("managed_model"),
        client=client,
    )
    with client:
        result = dispatcher.dispatch("/chat/completions", {"model": model, "messages": []})
    assert result.status == 403
    assert json.loads(result.body)["error"]["type"] == "model_requires_own_key"
    assert not calls
