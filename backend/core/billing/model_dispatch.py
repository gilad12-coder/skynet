"""Dispatch bounded model attempts and reconcile provider-reported dollar usage."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Any
from uuid import uuid4

import httpx

from .openrouter_quotes import PricedRequest, fetch_endpoint_prices, price_text_request
from .operation_pricing import ChargePolicy, OperationQuote, UnpricedOperationError, exact_nonnegative, json_fingerprint
from .responses_adapter import price_responses_request, responses_receipt
from .runtime import BudgetRuntime, PaidResult

MODEL_ATTEMPT_HEADER = "x-skynet-model-attempt-id"


@dataclass(frozen=True)
class ModelHTTPResult:
    """Retain the protocol response without putting generated text in the billing ledger."""

    status: int
    content_type: str
    body: bytes


def response_usage(body: bytes, content_type: str) -> tuple[str | None, dict[str, Any] | None]:
    """Extract actual usage from either JSON or the final OpenAI/Anthropic SSE event.

    Args:
        body: Complete provider response bytes from the trusted HTTP client.
        content_type: Provider response content type.

    Returns:
        Generation identity and the most recent usage block, if reported.
    """
    if "text/event-stream" in content_type:
        events = []
        for line in body.decode("utf-8").splitlines():
            if line.startswith("data:") and line[5:].strip() != "[DONE]":
                try:
                    events.append(json.loads(line[5:].strip()))
                except ValueError:
                    continue
    else:
        try:
            events = [json.loads(body)]
        except ValueError:
            return None, None
    identity = None
    usage = None
    for event in events:
        if not isinstance(event, dict):
            continue
        message = event.get("message")
        if isinstance(message, dict):
            identity = message.get("id") or identity
            if isinstance(message.get("usage"), dict):
                usage = {**(usage or {}), **message["usage"]}
        identity = event.get("id") or identity
        if isinstance(event.get("usage"), dict):
            usage = {**(usage or {}), **event["usage"]}
    return identity if isinstance(identity, str) else None, usage


def generation_charge(record: Mapping[str, Any]) -> Decimal | None:
    """Count an external upstream bill only when the provider identifies a BYOK generation.

    Args:
        record: Exact generation metadata returned by the trusted provider.

    Returns:
        Actual combined provider USD, or None while its billing scope is ambiguous.
    """
    if record.get("total_cost") is None:
        return None
    charge = exact_nonnegative(record["total_cost"])
    byok = record.get("is_byok")
    upstream = record.get("upstream_inference_cost")
    if byok is True:
        return charge + exact_nonnegative(upstream) if upstream is not None else None
    if byok is False or upstream in {None, 0, "0"}:
        return charge
    return None


def usage_charge(usage: Mapping[str, Any]) -> Decimal | None:
    """Use a final usage receipt only when it describes the complete provider charge."""
    if usage.get("cost") is None:
        return None
    details = usage.get("cost_details") or {}
    return generation_charge(
        {
            "total_cost": usage["cost"],
            "is_byok": usage.get("is_byok"),
            "upstream_inference_cost": details.get("upstream_inference_cost"),
        }
    )


def response_complete(body: bytes, content_type: str) -> bool:
    """Require a terminal protocol marker before treating streamed usage as final."""
    if "text/event-stream" not in content_type:
        return True
    for line in body.decode("utf-8", errors="replace").splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            return True
        try:
            event = json.loads(data)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "message_stop":
            return True
    return False


class OpenRouterDispatcher:
    """Keep credentials and the spending ledger outside optimizer-controlled code."""

    def __init__(
        self,
        runtime: BudgetRuntime,
        *,
        api_key: str,
        model: str,
        role: str,
        policy: ChargePolicy,
        client: httpx.Client,
        quote_observer: Callable[[str, str, OperationQuote, str, int], bool] | None = None,
    ) -> None:
        """Bind one model role to a trusted transport and pricing policy.

        Args:
            runtime: Shared setup or run spending authority.
            api_key: Managed or account-owned OpenRouter credential, never exposed to guests.
            model: Exact model slug permitted for this role.
            role: Task, judge, or optimization attribution.
            policy: The approved model charge and external-cost scope.
            client: Non-retrying HTTP client with an enforced request timeout.
            quote_observer: Optional parent-side recovery bound recorder and
                atomic headroom claimant.
        """
        self.runtime = runtime
        self._api_key = api_key
        self.model = model
        self.role = role
        self.policy = policy
        self._client = client
        self._quote_observer = quote_observer
        self._attempt_quotes: dict[tuple[str, str, int], tuple[str, PricedRequest]] = {}

    def dispatch(
        self,
        path: str,
        request: Mapping[str, Any],
        *,
        operation_key: str | None = None,
        attempt: int = 0,
        protocol_headers: Mapping[str, str] | None = None,
    ) -> ModelHTTPResult:
        """Send one final request only after its physical attempt is fully reserved.

        Args:
            path: Chat completions or Anthropic messages protocol path.
            request: Fully resolved SDK body including final token and tool settings.
            operation_key: Optional stable physical-attempt identity for a transport replay.
            attempt: Physical retry number within a stable logical operation.
            protocol_headers: Non-secret Anthropic protocol version or beta headers.

        Returns:
            Provider response after its actual charge is settled or held for reconciliation.
        """
        if path not in {"/chat/completions", "/messages", "/responses"} or request.get("model") != self.model:
            raise UnpricedOperationError("This scoped route cannot dispatch a different model or API operation.")
        request_identity = json_fingerprint({"body": dict(request), "headers": dict(protocol_headers or {})})
        attempt_key = (path, operation_key, attempt) if operation_key is not None else None
        cached = self._attempt_quotes.get(attempt_key) if attempt_key is not None else None
        if cached is not None:
            if cached[0] != request_identity:
                raise UnpricedOperationError("A model attempt identity cannot be reused for a different request.")
            priced = cached[1]
        else:
            catalog = fetch_endpoint_prices(self.model, client=self._client)
            priced = (price_responses_request if path == "/responses" else price_text_request)(
                request, catalog, self.policy
            )
            priced = replace(
                priced,
                quote=replace(
                    priced.quote,
                    price_snapshot={
                        **priced.quote.price_snapshot,
                        "credential_fingerprint": json_fingerprint(self._api_key),
                    },
                ),
            )
            if attempt_key is not None:
                self._attempt_quotes[attempt_key] = (request_identity, priced)
        physical_key = operation_key or str(uuid4())
        recovery_headroom = False
        if self._quote_observer is not None:
            recovery_headroom = self._quote_observer(
                self.role,
                self.model,
                priced.quote,
                physical_key,
                attempt,
            )
        headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}
        headers.update(
            {
                name: value
                for name, value in (protocol_headers or {}).items()
                if name.lower() in {"anthropic-version", "anthropic-beta"}
            }
        )

        def send() -> PaidResult[ModelHTTPResult]:
            """Send exactly once and retain trusted usage even for a provider error response."""
            chunks = []
            interrupted = False
            with self._client.stream(
                "POST", f"https://openrouter.ai/api/v1{path}", headers=headers, json=priced.body, follow_redirects=False
            ) as response:
                content_type = response.headers.get("content-type", "application/json")
                try:
                    for chunk in response.iter_bytes():
                        chunks.append(chunk)  # noqa: PERF402 - Preserve received chunks if the iterator raises.
                except httpx.HTTPError:
                    interrupted = True
                content = b"".join(chunks)
                status = response.status_code
            if path == "/responses":
                identity, usage, complete = responses_receipt(content, content_type)
                interrupted = interrupted or not complete
            else:
                interrupted = interrupted or not response_complete(content, content_type)
                identity, usage = response_usage(content, content_type)
            evidence: dict[str, Any] = {
                "provider": "openrouter",
                "model": self.model,
                "request_id": identity,
                "status": status,
                "usage": usage,
                "interrupted": interrupted,
            }
            amount = None
            if not interrupted and usage is not None and usage.get("cost") is not None:
                amount = usage_charge(usage)
            if amount is None and identity:
                reconciled = self.reconcile(identity)
                if reconciled is not None:
                    amount, record = reconciled
                    evidence["generation"] = record
            result = ModelHTTPResult(status, content_type, content)
            if interrupted:
                result = ModelHTTPResult(
                    502,
                    "application/json",
                    json.dumps(
                        {
                            "error": {
                                "type": "provider_interrupted",
                                "message": "The provider response ended before completion.",
                            }
                        }
                    ).encode(),
                )
            return PaidResult(
                value=result,
                provider_usd=amount,
                evidence=evidence,
                provider_request_id=identity,
            )

        return self.runtime.execute(
            priced.quote,
            self.policy,
            send,
            operation_key=physical_key,
            cost_kind="model",
            role=self.role,
            attempt=attempt,
            recovery_headroom=recovery_headroom,
        )

    def reconcile(self, generation_id: str) -> tuple[Decimal, dict[str, Any]] | None:
        """Read provider billing evidence without launching or repeating inference.

        Args:
            generation_id: Identity returned by the original paid request.

        Returns:
            Measured USD and usage-only evidence, or None while the bill is unavailable.
        """
        try:
            response = self._client.get(
                "https://openrouter.ai/api/v1/generation",
                params={"id": generation_id},
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
            response.raise_for_status()
            record = response.json().get("data")
            if (
                not isinstance(record, dict)
                or record.get("id") != generation_id
                or record.get("model") != self.model
                or record.get("total_cost") is None
            ):
                return None
            safe = {
                key: record[key]
                for key in (
                    "id",
                    "model",
                    "provider_name",
                    "total_cost",
                    "upstream_inference_cost",
                    "native_tokens_prompt",
                    "native_tokens_completion",
                    "native_tokens_reasoning",
                    "num_search_results",
                    "is_byok",
                )
                if key in record
            }
            amount = generation_charge(record)
            return (amount, safe) if amount is not None else None
        except (httpx.HTTPError, ValueError):
            return None
