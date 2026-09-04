"""Verify stateless Responses bounds and real terminal receipts without provider execution."""

from __future__ import annotations

import copy
import json

import pytest

from core.billing.operation_pricing import ChargePolicy, UnpricedOperationError, json_fingerprint
from core.billing.responses_adapter import price_responses_request, responses_receipt

_CATALOG = {
    "id": "fixture/text",
    "endpoints": [
        {
            "tag": "fixture",
            "provider_name": "Fixture",
            "context_length": 1000,
            "max_completion_tokens": 500,
            "pricing": {"prompt": "0.00001", "completion": "0.00002", "image": "0.02"},
        }
    ],
}


def test_responses_keeps_original_history_and_hashes_final_bound_body() -> None:
    """Retain instructions, local tool calls and outputs while enforcing the verified output ceiling."""
    request = {
        "model": "fixture/text",
        "instructions": "Solve the task.",
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": "question"}]},
            {"type": "function_call", "call_id": "call", "name": "read", "arguments": '{"file":"sample"}'},
            {"type": "function_call_output", "call_id": "call", "output": "actual tool output"},
            {
                "type": "reasoning",
                "summary": [{"type": "summary_text", "text": "reason"}],
                "encrypted_content": "opaque",
            },
        ],
        "tools": [{"type": "function", "name": "read", "parameters": {"type": "object"}}],
        "stream": True,
    }
    original = copy.deepcopy(request)
    priced = price_responses_request(request, _CATALOG, ChargePolicy("managed_model"))
    assert request == original
    assert priced.body["input"] == original["input"]
    assert priced.body["instructions"] == original["instructions"]
    assert priced.body["max_output_tokens"] == 500
    assert priced.body["provider"]["allow_fallbacks"] is False
    assert priced.body["provider"]["only"] == ["fixture"]
    assert "messages" not in priced.body
    assert "max_tokens" not in priced.body
    assert priced.quote.request_fingerprint == json_fingerprint(priced.body)
    assert priced.quote.price_snapshot["max_output_tokens"] == 500


def test_responses_counts_images_inside_tool_output() -> None:
    """Cover explicit image fees in both normal input and returned tool content."""
    image = {"type": "input_image", "image_url": "data:image/png;base64,aGVsbG8="}
    request = {
        "model": "fixture/text",
        "max_output_tokens": 50,
        "input": [
            {"role": "user", "content": [image]},
            {"type": "function_call_output", "call_id": "call", "output": [image]},
        ],
    }
    priced = price_responses_request(request, _CATALOG, ChargePolicy("managed_model"))
    assert priced.quote.price_snapshot["input_image_count"] == 2
    catalog = copy.deepcopy(_CATALOG)
    del catalog["endpoints"][0]["pricing"]["image"]
    with pytest.raises(UnpricedOperationError, match="image price"):
        price_responses_request(request, catalog, ChargePolicy("managed_model"))


@pytest.mark.parametrize(
    "extra",
    [
        {"previous_response_id": "previous"},
        {"store": True},
        {"background": True},
        {"conversation": "conversation"},
        {"prompt": {"id": "server-prompt"}},
        {"context_management": [{"type": "compaction"}]},
        {"tools": [{"type": "web_search_preview"}]},
        {"input": [{"type": "item_reference", "id": "hidden"}]},
        {"input": [{"role": "user", "content": [{"type": "input_file", "file_id": "opaque"}]}]},
        {"input": [{"type": "function_call_output", "call_id": "call", "output": [{"type": "input_audio"}]}]},
        {"max_output_tokens": -1},
    ],
)
def test_responses_rejects_unbounded_categories(extra: dict) -> None:
    """Refuse hidden history, server tools and uncovered media before reserving or dispatching."""
    with pytest.raises(UnpricedOperationError):
        price_responses_request(
            {"model": "fixture/text", "input": "text", **extra}, _CATALOG, ChargePolicy("managed_model")
        )


def test_responses_missing_output_endpoint_maximum_is_not_guessed() -> None:
    """Leave omission unpriced when the selected endpoint supplies no authoritative bound."""
    catalog = copy.deepcopy(_CATALOG)
    del catalog["endpoints"][0]["max_completion_tokens"]
    with pytest.raises(UnpricedOperationError, match="no verified maximum output"):
        price_responses_request({"model": "fixture/text", "input": "text"}, catalog, ChargePolicy("managed_model"))


@pytest.mark.parametrize(
    "event_type", ["response.done", "response.completed", "response.incomplete", "response.failed"]
)
def test_responses_sse_reads_nested_terminal_usage(event_type: str) -> None:
    """Retain the provider's response identity and cost from a real terminal envelope."""
    status = event_type.removeprefix("response.")
    if status == "done":
        status = "completed"
    usage = {"input_tokens": 8, "output_tokens": 4, "cost": 0.001}
    body = (
        'data: {"type":"response.created","response":{"id":"response-id","status":"in_progress"}}\n\n'
        "data: "
        + json.dumps({"type": event_type, "response": {"id": "response-id", "status": status, "usage": usage}})
        + "\n\ndata: [DONE]\n\n"
    ).encode()
    assert responses_receipt(body, "text/event-stream") == ("response-id", usage, True)


def test_responses_missing_cost_and_interrupted_usage_remain_unresolved() -> None:
    """Never fabricate zero spend from token counts or a stream that lacks a terminal response."""
    usage = {"input_tokens": 8, "output_tokens": 4}
    body = json.dumps({"id": "actual", "status": "completed", "usage": usage}).encode()
    assert responses_receipt(body, "application/json") == ("actual", usage, True)
    interrupted = b'data: {"type":"response.created","response":{"id":"actual","status":"in_progress"}}\n\n'
    assert responses_receipt(interrupted, "text/event-stream") == ("actual", None, False)
