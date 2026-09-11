"""Prove live OpenRouter price shapes bound text requests instead of rejecting unreachable categories."""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

import pytest

from core.billing.openrouter_quotes import price_text_request
from core.billing.operation_pricing import ChargePolicy, UnpricedOperationError

REQUEST = {"model": "fixture/text", "max_tokens": 100, "messages": [{"role": "user", "content": "hello"}]}
POLICY = ChargePolicy("managed_model")
GEMINI_PRICING = {
    "prompt": "0.000001",
    "completion": "0.000002",
    "image": "0.000001",
    "audio": "0.000004",
    "input_audio_cache": "0.000001",
    "web_search": "0.014",
    "internal_reasoning": "0.000002",
    "input_cache_read": "0.0000005",
    "input_cache_write": "0.000001",
    "discount": 0,
}
CLAUDE_PRICING = {
    "prompt": "0.000003",
    "completion": "0.000015",
    "web_search": "0.01",
    "input_cache_read": "0.0000003",
    "input_cache_write": "0.00000375",
    "input_cache_write_1h": "0.000006",
    "discount": 0,
    "overrides": [
        {
            "min_prompt_tokens": 200000,
            "prompt": "0.000006",
            "completion": "0.0000225",
            "input_cache_read": "0.0000006",
            "input_cache_write": "0.0000075",
            "input_cache_write_1h": "0.000012",
        }
    ],
}
DEEPSEEK_PRICING = {
    "prompt": "0.00000028",
    "completion": "0.00000042",
    "input_cache_read": "0.000000028",
    "overrides": [
        {
            "utc_days": ["saturday", "sunday"],
            "prompt": "0.00000014",
            "completion": "0.00000021",
            "input_cache_read": "0.000000014",
        },
        {
            "utc_start": 0,
            "utc_end": 100,
            "utc_days": ["monday", "tuesday", "wednesday", "thursday", "friday"],
            "prompt": "0.00000056",
            "completion": "0.00000084",
            "input_cache_read": "0.000000056",
        },
    ],
}


def _catalog(pricing: dict[str, Any]) -> dict[str, Any]:
    """Wrap one endpoint's published pricing in the catalog shape the quote reads.

    Args:
        pricing: Endpoint pricing as published by the OpenRouter endpoints API.

    Returns:
        Catalog for the fixture model with a single endpoint of 1,000 context tokens.
    """
    return {
        "id": "fixture/text",
        "endpoints": [
            {
                "tag": "fixture",
                "provider_name": "Fixture",
                "context_length": 1000,
                "max_completion_tokens": 1000,
                "pricing": pricing,
            }
        ],
    }


@pytest.mark.parametrize(
    ("pricing", "maximum_provider_usd"),
    [
        pytest.param(GEMINI_PRICING, "0.00147", id="audio-and-web-search-unreachable"),
        pytest.param(CLAUDE_PRICING, "0.0149625", id="long-context-override-and-1h-cache"),
        pytest.param(DEEPSEEK_PRICING, "0.0006762", id="scheduled-overrides"),
    ],
)
def test_published_price_shapes_bound_text_requests(pricing: dict[str, Any], maximum_provider_usd: str) -> None:
    """Ignore categories a text request cannot incur and take the maximum over every override row.

    Args:
        pricing: Endpoint pricing modeled on a live OpenRouter endpoint.
        maximum_provider_usd: Expected raw bound including the 5% OpenRouter fee margin.
    """
    priced = price_text_request(REQUEST, _catalog(pricing), POLICY)
    assert Decimal(priced.quote.price_snapshot["maximum_provider_usd"]) == Decimal(maximum_provider_usd)
    assert priced.body["provider"]["only"] == ["fixture"]


def test_override_rates_raise_the_routing_caps() -> None:
    """Send OpenRouter the highest override rate as the per-token cap so a surcharge cannot exceed the hold."""
    priced = price_text_request(REQUEST, _catalog(CLAUDE_PRICING), POLICY)
    assert priced.body["provider"]["max_price"]["prompt"] == 6
    assert priced.body["provider"]["max_price"]["completion"] == 22.5


@pytest.mark.parametrize(
    ("pricing", "message"),
    [
        pytest.param(
            {"prompt": "0.000001", "completion": "0.000002", "video": "0.00001"},
            "The provider reports an uncovered price category: video.",
            id="unknown-category",
        ),
        pytest.param(
            {"prompt": "0.000001", "completion": "0.000002", "overrides": [["0.000002"]]},
            "Unrecognized tiered pricing cannot authorize work.",
            id="malformed-override",
        ),
    ],
)
def test_unbounded_price_shapes_never_authorize_work(pricing: dict[str, Any], message: str) -> None:
    """Keep refusing categories the bound does not cover and override rows it cannot read.

    Args:
        pricing: Endpoint pricing with an unknown nonzero category or a malformed override row.
        message: Exact rejection the dispatch surfaces.
    """
    with pytest.raises(UnpricedOperationError, match=f"^{re.escape(message)}$"):
        price_text_request(REQUEST, _catalog(pricing), POLICY)


def test_audio_input_stays_rejected_even_when_the_endpoint_prices_it() -> None:
    """Skipping the audio rate is safe only because audio parts never reach the provider."""
    request = {
        **REQUEST,
        "messages": [
            {"role": "user", "content": [{"type": "input_audio", "input_audio": {"data": "", "format": "wav"}}]}
        ],
    }
    with pytest.raises(UnpricedOperationError, match=re.escape("This input modality has no verified price bound.")):
        price_text_request(request, _catalog(GEMINI_PRICING), POLICY)
