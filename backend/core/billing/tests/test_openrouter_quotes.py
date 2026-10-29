"""Prove live OpenRouter price shapes bound text requests instead of rejecting unreachable categories."""

from __future__ import annotations

import json
import re
from decimal import Decimal
from typing import Any

import pytest

from core.billing.openrouter_quotes import price_embedding_request, price_text_request
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


def _catalog(pricing: dict[str, Any], *, context: int = 1000) -> dict[str, Any]:
    """Wrap one endpoint's published pricing in the catalog shape the quote reads.

    Args:
        pricing: Endpoint pricing as published by the OpenRouter endpoints API.
        context: The endpoint's context window in tokens.

    Returns:
        Catalog for the fixture model with a single endpoint.
    """
    return {
        "id": "fixture/text",
        "endpoints": [
            {
                "tag": "fixture",
                "provider_name": "Fixture",
                "context_length": context,
                "max_completion_tokens": 1000,
                "pricing": pricing,
            }
        ],
    }


@pytest.mark.parametrize(
    ("pricing", "maximum_provider_usd"),
    [
        pytest.param(GEMINI_PRICING, "0.00147", id="audio-and-web-search-unreachable"),
        pytest.param(CLAUDE_PRICING, "0.0055125", id="unreachable-long-context-override-and-unrequested-1h-cache"),
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
    """Send OpenRouter the highest reachable override rate as the per-token cap so a surcharge cannot exceed the hold."""
    request = {**REQUEST, "messages": [{"role": "user", "content": "x" * 200_000}]}
    priced = price_text_request(request, _catalog(CLAUDE_PRICING, context=1_000_000), POLICY)
    assert priced.body["provider"]["max_price"]["prompt"] == 6
    assert priced.body["provider"]["max_price"]["completion"] == 22.5


def _body_bytes(request: dict[str, Any]) -> int:
    """Measure a request the way the quote does.

    Args:
        request: Request body before routing is added.

    Returns:
        Compact UTF-8 JSON size in bytes.
    """
    return len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def test_input_is_bounded_by_the_request_bytes_not_the_context_window() -> None:
    """A short prompt on a million-token endpoint holds its bytes plus the wrapper allowance, not the window."""
    pricing = {"prompt": "0.000001", "completion": "0.000002"}
    priced = price_text_request(REQUEST, _catalog(pricing, context=1_000_000), POLICY)
    input_tokens = _body_bytes(REQUEST) + 2048
    expected = (input_tokens * Decimal("0.000001") + 100 * Decimal("0.000002")) * Decimal("1.05")
    assert Decimal(priced.quote.price_snapshot["maximum_provider_usd"]) == expected
    assert priced.quote.price_snapshot["input_bound_tokens"] == input_tokens
    assert priced.quote.price_snapshot["endpoints"][0]["input_tokens"] == input_tokens


def test_hebrew_text_is_bounded_by_its_utf8_bytes() -> None:
    """Multi-byte text counts every byte, so a non-Latin prompt cannot slip under its own token count."""
    request = {**REQUEST, "messages": [{"role": "user", "content": "שלום עולם" * 100}]}
    priced = price_text_request(request, _catalog({"prompt": "0.000001", "completion": "0"}, context=1_000_000), POLICY)
    assert priced.quote.price_snapshot["input_bound_tokens"] == _body_bytes(request) + 2048
    assert _body_bytes(request) > len("שלום עולם".encode()) * 100 > len("שלום עולם") * 100


def test_each_input_image_adds_a_full_image_of_tokens() -> None:
    """An image URL is a few bytes but bills thousands of tokens, so each one adds its own allowance."""
    request = {
        **REQUEST,
        "messages": [
            {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://x.test/a.png"}}]}
        ],
    }
    pricing = {"prompt": "0.000001", "completion": "0", "image": "0"}
    priced = price_text_request(request, _catalog(pricing, context=1_000_000), POLICY)
    assert priced.quote.price_snapshot["input_bound_tokens"] == _body_bytes(request) + 2048 + 8192


def test_the_one_hour_cache_rate_applies_only_when_a_breakpoint_asks_for_it() -> None:
    """A default ephemeral breakpoint holds the five-minute write rate; a 1h ttl holds the dearer one."""
    pricing = {
        "prompt": "0.000003",
        "completion": "0",
        "input_cache_write": "0.00000375",
        "input_cache_write_1h": "0.000006",
    }
    catalog = _catalog(pricing, context=1_000_000)

    def hold(control: dict[str, str]) -> Decimal:
        """Price one cached message under the given breakpoint."""
        content = [{"type": "text", "text": "cached", "cache_control": control}]
        request = {**REQUEST, "messages": [{"role": "user", "content": content}]}
        tokens = _body_bytes(request) + 2048
        priced = Decimal(price_text_request(request, catalog, POLICY).quote.price_snapshot["maximum_provider_usd"])
        return priced / Decimal("1.05") / tokens

    assert hold({"type": "ephemeral"}) == Decimal("0.00000375")
    assert hold({"type": "ephemeral", "ttl": "1h"}) == Decimal("0.000006")


FAST_CATALOG = {
    "id": "fixture/text",
    "endpoints": [
        {
            "tag": "anthropic",
            "provider_name": "Anthropic",
            "context_length": 1000,
            "pricing": {"prompt": "0.000004", "completion": "0.00002"},
        },
        {
            "tag": "anthropic/fast",
            "provider_name": "Anthropic",
            "context_length": 1000,
            "pricing": {"prompt": "0.000008", "completion": "0.00004"},
        },
    ],
}


def test_fast_endpoints_stay_out_of_the_hold_unless_routing_names_them() -> None:
    """A fast variant bills double, so it is neither priced nor routable unless the caller picks its tag."""
    default = price_text_request(REQUEST, FAST_CATALOG, POLICY)
    assert default.body["provider"]["only"] == ["anthropic"]
    assert default.body["provider"]["max_price"]["prompt"] == 4

    chosen = price_text_request({**REQUEST, "provider": {"only": ["anthropic/fast"]}}, FAST_CATALOG, POLICY)
    assert chosen.body["provider"]["only"] == ["anthropic/fast"]
    assert chosen.body["provider"]["max_price"]["prompt"] == 8


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


EMBEDDING_CATALOG = {
    "id": "openai/text-embedding-3-small",
    "architecture": {"output_modalities": ["embeddings"]},
    "endpoints": [
        {
            "tag": "openai",
            "provider_name": "OpenAI",
            "context_length": 8192,
            "pricing": {"prompt": "0.00000002", "completion": "0", "discount": 0},
        },
        {
            "tag": "azure",
            "provider_name": "Azure",
            "context_length": 8192,
            "pricing": {"prompt": "0.00000002", "completion": "0", "discount": 0},
        },
    ],
}


def test_embeddings_reserve_a_full_context_per_input() -> None:
    """Bound every embedded text by the endpoint context and pin the priced endpoints."""
    request = {"model": "openai/text-embedding-3-small", "input": ["a", "b"]}
    priced = price_embedding_request(request, EMBEDDING_CATALOG, POLICY)
    # Two inputs x 8192 tokens x $0.02/M, plus the 5% fee margin.
    assert Decimal(priced.quote.price_snapshot["maximum_provider_usd"]) == Decimal("0.00034406400")
    assert priced.body["provider"]["only"] == ["openai", "azure"]
    assert priced.body["provider"]["allow_fallbacks"] is False
    assert priced.body["input"] == ["a", "b"]


@pytest.mark.parametrize(
    ("request_body", "catalog", "message"),
    [
        pytest.param(
            {"model": "openai/text-embedding-3-small", "input": []},
            EMBEDDING_CATALOG,
            "must embed one or more texts",
            id="no-input",
        ),
        pytest.param(
            {"model": "openai/text-embedding-3-small", "input": [[1, 2, 3]]},
            EMBEDDING_CATALOG,
            "must embed one or more texts",
            id="token-arrays",
        ),
        pytest.param(
            {"model": "fixture/text", "input": "hello"},
            _catalog({"prompt": "0.00001", "completion": "0.00002"}),
            "not an embeddings model",
            id="chat-model",
        ),
        pytest.param(
            {"model": "other/model", "input": "hello"},
            EMBEDDING_CATALOG,
            "differs from its verified price catalog",
            id="other-model",
        ),
    ],
)
def test_unbounded_embedding_requests_never_authorize_work(
    request_body: dict[str, Any], catalog: dict[str, Any], message: str
) -> None:
    """Refuse an embeddings request whose cost the catalog cannot bound.

    Args:
        request_body: Guest embeddings body.
        catalog: Endpoint catalog the request is priced against.
        message: Expected refusal text.
    """
    with pytest.raises(UnpricedOperationError, match=message):
        price_embedding_request(request_body, catalog, POLICY)
