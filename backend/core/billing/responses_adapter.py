"""Bound stateless OpenRouter Responses requests and retain actual terminal usage."""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from .openrouter_quotes import PricedRequest, price_text_request
from .operation_pricing import ChargePolicy, UnpricedOperationError, operation_quote

_TERMINAL_EVENTS = {
    "response.done",
    "response.completed",
    "response.incomplete",
    "response.failed",
    "response.cancelled",
}
_TERMINAL_STATES = {"completed", "incomplete", "failed", "cancelled"}


def _content_parts(content: Any) -> list[dict[str, Any]]:
    """Project supported Responses content into the existing image-aware quote validator.

    Args:
        content: Text or explicit message/tool-output content parts.

    Returns:
        A quote-only content projection; the provider receives the original payload.
    """
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if not isinstance(content, list):
        raise UnpricedOperationError("Responses content must be explicit text or supported message parts.")
    result = []
    for part in content:
        if not isinstance(part, dict):
            raise UnpricedOperationError("Responses content parts must be explicit typed objects.")
        kind = part.get("type")
        if kind in {"input_text", "output_text", "summary_text", "refusal"}:
            result.append({"type": "text", "text": part.get("text", part.get("refusal", ""))})
        elif kind == "input_image" and isinstance(part.get("image_url"), str) and not part.get("file_id"):
            result.append({"type": "image_url", "image_url": part["image_url"]})
        else:
            raise UnpricedOperationError("This Responses input modality has no verified cost bound.")
    return result


def _input_messages(value: Any) -> list[dict[str, Any]]:
    """Account for every supported visible history item without resolving hidden server state.

    Args:
        value: Stateless Responses input containing the complete conversation history.

    Returns:
        Quote-only messages including every nested input image.
    """
    if isinstance(value, str):
        return [{"role": "user", "content": value}]
    if not isinstance(value, list):
        raise UnpricedOperationError("Responses requires explicit input text or a complete input array.")
    messages = []
    for item in value:
        if not isinstance(item, dict):
            raise UnpricedOperationError("Responses history items must be explicit typed objects.")
        kind = item.get("type", "message")
        if kind == "message":
            content = _content_parts(item.get("content"))
        elif kind in {"function_call_output", "custom_tool_call_output"}:
            content = _content_parts(item.get("output"))
        elif kind in {"function_call", "custom_tool_call"}:
            content = [{"type": "text", "text": json.dumps(item)}]
        elif kind == "reasoning":
            content = _content_parts(item.get("summary") or [])
            if item.get("encrypted_content") is not None and not isinstance(item["encrypted_content"], str):
                raise UnpricedOperationError("Unrecognized encrypted reasoning cannot authorize work.")
        else:
            raise UnpricedOperationError("This Responses history item needs a separately verified cost adapter.")
        messages.append({"role": item.get("role", "user"), "content": content})
    return messages


def _default_output_limit(body: Mapping[str, Any], catalog: Mapping[str, Any]) -> tuple[int, dict[str, Any]]:
    """Use a verified endpoint maximum when the unchanged harness omits a completion limit.

    Args:
        body: Original request with any explicit provider selection.
        catalog: Fresh endpoint prices and hard limits.

    Returns:
        An enforceable output ceiling and the verified eligible endpoint catalog.
    """
    routing = body.get("provider") or {}
    if not isinstance(routing, Mapping):
        raise UnpricedOperationError("Responses provider routing must be an explicit mapping.")
    selected, ignored = set(routing.get("only") or []), set(routing.get("ignore") or [])
    endpoints = []
    for endpoint in catalog.get("endpoints") or []:
        tag, provider = endpoint.get("tag"), endpoint.get("provider_name")
        names = {tag, provider, str(tag).split("/")[0]}
        if (selected and not selected.intersection(names)) or ignored.intersection(names):
            continue
        maximum = endpoint.get("max_completion_tokens")
        if isinstance(maximum, int) and not isinstance(maximum, bool) and maximum > 0:
            endpoints.append(endpoint)
    if not endpoints:
        raise UnpricedOperationError("The selected Responses endpoints have no verified maximum output bound.")
    return max(endpoint["max_completion_tokens"] for endpoint in endpoints), {**catalog, "endpoints": endpoints}


def price_responses_request(
    request: Mapping[str, Any], catalog: Mapping[str, Any], policy: ChargePolicy
) -> PricedRequest:
    """Authorize a stateless Responses request with the same conservative endpoint coverage.

    Args:
        request: Final unchanged harness payload before physical provider dispatch.
        catalog: Fresh prices and limits for its exact selected model.
        policy: Approved managed or external credit conversion.

    Returns:
        Original protocol body with enforced output/routing caps and its immutable quote.
    """
    body = copy.deepcopy(dict(request))
    if any(body.get(key) is not None for key in ("previous_response_id", "conversation", "prompt")):
        raise UnpricedOperationError("Responses must include complete stateless input to bound all charges.")
    if body.get("store") not in {None, False} or body.get("background") or body.get("context_management"):
        raise UnpricedOperationError("Stateful or server-managed Responses work has no verified cost bound.")
    if "max_tokens" in body or "max_completion_tokens" in body or "messages" in body:
        raise UnpricedOperationError("Responses requests must use their own input and max_output_tokens fields.")
    tools = body.get("tools") or []
    if not isinstance(tools, list) or any(
        not isinstance(tool, dict) or tool.get("type") not in {"function", "custom"} for tool in tools
    ):
        raise UnpricedOperationError("Provider-operated Responses tools require separately verified coverage.")
    choice = body.get("tool_choice")
    if isinstance(choice, dict) and choice.get("type") not in {"function", "custom"}:
        raise UnpricedOperationError("This Responses tool selection has no verified cost bound.")
    messages = _input_messages(body.get("input"))
    if body.get("instructions") is not None:
        if not isinstance(body["instructions"], str):
            raise UnpricedOperationError("Responses instructions must be explicit text.")
        messages.insert(0, {"role": "system", "content": body["instructions"]})
    if body.get("max_output_tokens") is None:
        body["max_output_tokens"], catalog = _default_output_limit(body, catalog)
    projection = {**body, "messages": messages, "max_tokens": body["max_output_tokens"]}
    priced = price_text_request(projection, catalog, policy)
    body["provider"] = priced.body["provider"]
    body.setdefault("store", False)
    evidence = {
        **priced.quote.price_snapshot,
        "protocol": "responses",
        "protocol_source": "https://openrouter.ai/docs/api_reference/responses/overview",
    }
    quote = operation_quote(body, Decimal(str(evidence["maximum_provider_usd"])), policy, evidence)
    return PricedRequest(body, quote)


def responses_receipt(body: bytes, content_type: str) -> tuple[str | None, dict[str, Any] | None, bool]:
    """Read actual nested Responses usage without inventing a zero-cost terminal receipt.

    Args:
        body: Fully collected provider protocol bytes, possibly interrupted.
        content_type: JSON or event-stream content type reported by the provider.

    Returns:
        Provider response identity, reported usage when present, and observed terminal state.
    """
    stream = "text/event-stream" in content_type
    raw_events = []
    if stream:
        for block in body.decode("utf-8", errors="replace").replace("\r\n", "\n").split("\n\n"):
            data = "\n".join(line[5:].lstrip() for line in block.splitlines() if line.startswith("data:"))
            if data and data != "[DONE]":
                raw_events.append(data)
    else:
        raw_events = [body.decode("utf-8", errors="replace")]
    identity, usage, complete = None, None, False
    for raw in raw_events:
        try:
            event = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        response = event.get("response") if stream else event
        if not isinstance(response, dict):
            continue
        if isinstance(response.get("id"), str):
            identity = response["id"]
        if isinstance(response.get("usage"), dict):
            usage = dict(response["usage"])
        complete = complete or (
            response.get("status") in _TERMINAL_STATES and (not stream or event.get("type") in _TERMINAL_EVENTS)
        )
    return identity, usage, complete
