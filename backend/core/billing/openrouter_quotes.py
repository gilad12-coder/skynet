"""Bound final OpenRouter text requests using live endpoint prices and routing caps."""

from __future__ import annotations

import copy
import time
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from urllib.parse import quote

import httpx

from .operation_pricing import ChargePolicy, OperationQuote, UnpricedOperationError, exact_nonnegative, operation_quote

_RATE_FIELDS = {
    "prompt",
    "completion",
    "request",
    "image",
    "input_cache_read",
    "input_cache_write",
    "internal_reasoning",
}
_UNSUPPORTED_REQUEST_FIELDS = {"plugins", "web_search_options", "audio", "image_config", "models", "route"}


@dataclass(frozen=True)
class PricedRequest:
    """Retain the exact final body with the reservation that authorizes it."""

    body: dict[str, Any]
    quote: OperationQuote


def resolve_model_slug(model: str, *, client: httpx.Client) -> str:
    """Resolve legacy short model names only when the provider catalog has one exact match.

    Args:
        model: User-selected full slug or an older API's short model identifier.
        client: Trusted non-retrying transport used only for public catalog reads.

    Returns:
        The same model's qualified identifier; an empty deferred selection stays empty.

    Raises:
        UnpricedOperationError: When a short name is unavailable or ambiguous.
    """
    name = model.strip("/").removeprefix("openrouter/")
    if not name or "/" in name:
        return name
    response = client.get("https://openrouter.ai/api/v1/models")
    response.raise_for_status()
    matches = {
        row["id"]
        for row in response.json().get("data", [])
        if isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"].rsplit("/", 1)[-1] == name
    }
    if len(matches) != 1:
        raise UnpricedOperationError(
            "Choose an exact provider/model; this short model name is unavailable or ambiguous."
        )
    return matches.pop()


def fetch_endpoint_prices(model: str, *, client: httpx.Client) -> dict[str, Any]:
    """Read current public endpoint pricing without invoking a model.

    Args:
        model: Exact OpenRouter model slug, without a LiteLLM provider prefix.
        client: Bounded HTTP client owned by the trusted dispatch adapter.

    Returns:
        Provider endpoint limits and rates for this exact model.

    Raises:
        UnpricedOperationError: When the catalog cannot verify this model.
    """
    if not model or model.startswith("openrouter/") or "/" not in model:
        raise UnpricedOperationError("An exact provider/model is required for protected execution.")
    response = client.get(f"https://openrouter.ai/api/v1/models/{quote(model, safe='/')}/endpoints")
    response.raise_for_status()
    result = response.json().get("data")
    if not isinstance(result, dict) or result.get("id") != model or not result.get("endpoints"):
        raise UnpricedOperationError("The requested model has no verified endpoint pricing.")
    return result


def _positive_integer(value: Any, label: str) -> int:
    """Require an explicit positive integral token bound."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise UnpricedOperationError(f"An explicit positive {label} is required.")
    return value


def _check_text_request(body: Mapping[str, Any]) -> int:
    """Reject unbounded generation categories and count every input image for its price cap."""
    if any(body.get(key) for key in _UNSUPPORTED_REQUEST_FIELDS):
        raise UnpricedOperationError("This request includes a cost category without verified coverage.")
    if body.get("service_tier") not in {None, "default"}:
        raise UnpricedOperationError("This service tier has no verified price bound.")
    if body.get("modalities") not in (None, ["text"]):
        raise UnpricedOperationError("Media generation requires a separately verified price bound.")
    for tool in body.get("tools") or []:
        if not isinstance(tool, dict) or tool.get("type", "function") not in {"function", "custom"}:
            raise UnpricedOperationError("Provider-operated tools require a separately verified price bound.")

    def images(content: Any) -> int:
        """Count input images including those nested in an Anthropic tool result."""
        count = 0
        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict) or part.get("type") not in {
                    "text",
                    "image",
                    "image_url",
                    "tool_use",
                    "tool_result",
                    "thinking",
                    "redacted_thinking",
                }:
                    raise UnpricedOperationError("This input modality has no verified price bound.")
                if part["type"] in {"image", "image_url"}:
                    count += 1
                elif part["type"] == "tool_result":
                    count += images(part.get("content"))
        return count

    image_count = sum(
        images(message.get("content")) for message in body.get("messages") or [] if isinstance(message, dict)
    )
    if body.get("n", 1) != 1 or body.get("best_of", 1) != 1:
        raise UnpricedOperationError("Multiple completions require independently reserved requests.")
    if "max_tokens" in body and "max_completion_tokens" in body and body["max_tokens"] != body["max_completion_tokens"]:
        raise UnpricedOperationError("Conflicting output token limits cannot authorize work.")
    return image_count


def _rate_maxima(pricing: Any) -> dict[str, Decimal]:
    """Include published long-context tiers and cache rates in the maximum bound."""
    if isinstance(pricing, list):
        if not pricing or any(not isinstance(row, dict) for row in pricing):
            raise UnpricedOperationError("Unrecognized tiered pricing cannot authorize work.")
        pricing = {**pricing[0], "tiers": pricing[1:]}
    if not isinstance(pricing, dict) or pricing.get("prompt") is None or pricing.get("completion") is None:
        raise UnpricedOperationError("Both prompt and completion prices must be verified.")
    tiers = pricing.get("tiers") or []
    if not isinstance(tiers, list) or any(not isinstance(tier, dict) for tier in tiers):
        raise UnpricedOperationError("Unrecognized tiered pricing cannot authorize work.")
    rows = [pricing, *tiers]
    for row in rows:
        for key, value in row.items():
            if (
                key not in _RATE_FIELDS | {"tiers", "min_context", "max_context", "discount"}
                and exact_nonnegative(value) != 0
            ):
                raise UnpricedOperationError(f"The provider reports an uncovered price category: {key}.")
    return {
        field: max(exact_nonnegative(row.get(field, pricing.get(field, "0"))) for row in rows) for field in _RATE_FIELDS
    }


def price_text_request(request: Mapping[str, Any], catalog: Mapping[str, Any], policy: ChargePolicy) -> PricedRequest:
    """Reserve an enforceable upper bound for one fully resolved text request.

    A full endpoint context window is used as the conservative input bound.
    It includes system prompts, tools, cached input, and provider wrappers;
    client token estimates cannot silently understate those categories.

    Args:
        request: Final OpenAI or Anthropic compatible body after SDK overrides.
        catalog: Fresh endpoint response for the exact routed model.
        policy: Approved managed or BYOK credit conversion.

    Returns:
        A copied request with price and endpoint caps, and its immutable quote.

    Raises:
        UnpricedOperationError: When the request cannot be bounded without changing its meaning.
    """
    body = copy.deepcopy(dict(request))
    image_count = _check_text_request(body)
    if "image" in (catalog.get("architecture") or {}).get("output_modalities", []) and body.get("modalities") != [
        "text"
    ]:
        raise UnpricedOperationError("Image generation requires separately bounded output pricing.")
    if body.get("model") != catalog.get("id"):
        raise UnpricedOperationError("The resolved model differs from its verified price catalog.")
    output_limit = _positive_integer(body.get("max_completion_tokens", body.get("max_tokens")), "output token limit")
    routing = body.get("provider") or {}
    if not isinstance(routing, dict):
        raise UnpricedOperationError("Unrecognized provider routing cannot authorize work.")
    routing = copy.deepcopy(routing)
    selected = set(routing.get("only") or [])
    ignored = set(routing.get("ignore") or [])
    candidates = []
    for endpoint in catalog.get("endpoints") or []:
        tag = endpoint.get("tag")
        provider = endpoint.get("provider_name")
        names = {tag, provider, str(tag).split("/")[0]}
        if selected and not names.intersection(selected):
            continue
        if names.intersection(ignored):
            continue
        if not isinstance(tag, str) or not tag:
            raise UnpricedOperationError("A priced endpoint is missing its routing identity.")
        context = _positive_integer(endpoint.get("context_length"), "endpoint context bound")
        maximum_output = endpoint.get("max_completion_tokens")
        if maximum_output is not None and output_limit > _positive_integer(maximum_output, "endpoint output bound"):
            continue
        rates = _rate_maxima(endpoint.get("pricing") or {})
        prices = endpoint.get("pricing") or {}
        base_prices = prices[0] if isinstance(prices, list) else prices
        if image_count and base_prices.get("image") is None:
            raise UnpricedOperationError("Image inputs require an explicit provider image price.")
        input_rate = max(rates[key] for key in ("prompt", "input_cache_read", "input_cache_write"))
        maximum_usd = (
            context * input_rate
            + output_limit * (rates["completion"] + rates["internal_reasoning"])
            + rates["request"]
            + image_count * rates["image"]
        )
        candidates.append((endpoint, rates, maximum_usd))
    if not candidates:
        raise UnpricedOperationError("No selected provider supports the requested output limit with verified pricing.")
    caps = {
        "prompt": max(rates["prompt"] for _, rates, _ in candidates) * 1_000_000,
        "completion": max(rates["completion"] for _, rates, _ in candidates) * 1_000_000,
        "request": max(rates["request"] for _, rates, _ in candidates),
        "image": max(rates["image"] for _, rates, _ in candidates),
    }
    user_caps = routing.get("max_price") or {}
    for name, value in user_caps.items():
        amount = exact_nonnegative(value)
        caps[name] = min(caps.get(name, amount), amount)
    routing["max_price"] = {name: float(value) for name, value in caps.items()}
    routing["only"] = [endpoint["tag"] for endpoint, _, _ in candidates]
    routing["allow_fallbacks"] = False
    body["provider"] = routing
    maximum = max(amount for _, _, amount in candidates) * Decimal("1.05")
    evidence = {
        "provider": "openrouter",
        "model": body["model"],
        "retrieved_at": time.time(),
        "source": f"https://openrouter.ai/api/v1/models/{body['model']}/endpoints",
        "input_bound": "maximum endpoint context including provider formatting",
        "max_output_tokens": output_limit,
        "input_image_count": image_count,
        "endpoints": [
            {"tag": endpoint["tag"], "context_length": endpoint["context_length"], "pricing": endpoint["pricing"]}
            for endpoint, _, _ in candidates
        ],
        "maximum_provider_usd": str(maximum),
        "maximum_openrouter_byok_fee_fraction": "0.05",
    }
    return PricedRequest(body, operation_quote(body, maximum, policy, evidence))
