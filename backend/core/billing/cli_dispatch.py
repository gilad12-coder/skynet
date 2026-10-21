"""Serve chat completions from the user's own coding-CLI subscriptions in local mode.

A :class:`CliDispatcher` stands where an ``OpenRouterDispatcher`` stands in the
model gateway, so guests keep the OpenAI chat protocol while the answer comes
from ``claude``, ``codex`` or ``droid`` on the user's machine. The wallet
records every call at zero cents; ``usage.cost`` carries the model's public
list price so cost scores stay comparable with hosted runs.
"""

from __future__ import annotations

import contextlib
import json
import random
import secrets
import tempfile
import threading
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from .. import config
from ..config import Settings
from ..local.cli_catalog import CliProvider, cli_model_arg
from ..local.cli_probe import read_cli_limits, write_cli_limit
from .cli_runners import RUNNERS, CliCompletion, CliRunError, SubscriptionRateLimitedError
from .model_dispatch import ModelHTTPResult
from .openrouter_quotes import fetch_endpoint_prices
from .operation_pricing import ChargePolicy, UnpricedOperationError, operation_quote
from .runtime import BudgetRuntime, PaidResult

__all__ = [
    "CliDispatcher",
    "SubscriptionRateLimitedError",
    "local_subscription_route",
]

_CHAT_PATH = "/chat/completions"
_UNSUPPORTED_PATHS = frozenset({"/responses", "/messages", "/embeddings"})
_RETRY_DELAYS_SECONDS = (2.0, 4.0, 8.0)
_MAX_REQUEST_BYTES = 32 * 1024 * 1024
_PRICE_TIMEOUT_SECONDS = 10
# Seams for tests: the back-off sleep and the price lookup.
_sleep: Callable[[float], None] = time.sleep
_prices_lock = threading.Lock()
_last_prices: dict[str, tuple[Decimal, Decimal]] = {}
_semaphores_lock = threading.Lock()
_semaphores: dict[tuple[str, int], threading.BoundedSemaphore] = {}


def _semaphore(cli: str, size: int) -> threading.BoundedSemaphore:
    """Return the process-wide slot pool for one CLI.

    Args:
        cli: The CLI.
        size: Concurrent calls allowed.

    Returns:
        The shared semaphore for ``(cli, size)``.
    """
    with _semaphores_lock:
        return _semaphores.setdefault((cli, size), threading.BoundedSemaphore(size))


def _list_prices(model: str) -> tuple[Decimal, Decimal] | None:
    """Return the model's public prompt and completion price per token.

    Args:
        model: OpenRouter catalog slug.

    Returns:
        ``(prompt_usd, completion_usd)`` per token, the last value read when the
        catalog is unreachable now, or ``None`` when it was never read.
    """
    try:
        with httpx.Client(timeout=_PRICE_TIMEOUT_SECONDS, trust_env=False) as client:
            data = fetch_endpoint_prices(model, client=client)
        pricing = data["endpoints"][0]["pricing"]
        prices = (Decimal(str(pricing["prompt"])), Decimal(str(pricing["completion"])))
    except Exception:
        with _prices_lock:
            return _last_prices.get(model)
    with _prices_lock:
        _last_prices[model] = prices
    return prices


def _text(content: Any) -> str:
    """Flatten one OpenAI message content into plain text.

    Args:
        content: A string or a list of content parts.

    Returns:
        The text parts joined by newlines.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(part.get("text") or "") if isinstance(part, dict) else str(part)
            for part in content
            if not isinstance(part, dict) or part.get("type", "text") == "text"
        )
    return "" if content is None else json.dumps(content)


def render_prompt(request: Mapping[str, Any]) -> str:
    """Turn an OpenAI chat request into one prompt for a CLI.

    Args:
        request: The chat completion body.

    Returns:
        The prompt. One user message is sent as is; a longer chat is sent as
        labeled turns, with any tools listed as JSON.
    """
    messages = [m for m in request.get("messages") or [] if isinstance(m, dict)]
    tools = request.get("tools")
    if len(messages) == 1 and messages[0].get("role") == "user" and not tools:
        return _text(messages[0].get("content"))
    parts = []
    for message in messages:
        role = str(message.get("role") or "user")
        body = _text(message.get("content"))
        if message.get("tool_calls"):
            body = f"{body}\n{json.dumps(message['tool_calls'])}".strip()
        parts.append(f"### {role.capitalize()}\n{body}")
    if tools:
        parts.append(
            "### Tools\nThese tools are described for reference; reply in text and "
            f"describe any tool call as JSON.\n{json.dumps(tools)}"
        )
    return "\n\n".join(parts)


def _schema(request: Mapping[str, Any]) -> dict[str, Any] | None:
    """Return the JSON schema a ``json_schema`` response format asks for.

    Args:
        request: The chat completion body.

    Returns:
        The schema, or ``None`` when the request asks for free text.
    """
    response_format = request.get("response_format")
    if not isinstance(response_format, dict) or response_format.get("type") != "json_schema":
        return None
    wrapper = response_format.get("json_schema")
    schema = wrapper.get("schema") if isinstance(wrapper, dict) else None
    return schema if isinstance(schema, dict) else None


def _error(status: int, code: str, message: str, **fields: Any) -> ModelHTTPResult:
    """Build a JSON error answer in the gateway's error shape.

    Args:
        status: HTTP status.
        code: Stable error code.
        message: Human-readable reason.
        **fields: More fields for the error object.

    Returns:
        The answer.
    """
    error = {"type": code, "code": code, "message": message, **fields}
    return ModelHTTPResult(status, "application/json", json.dumps({"error": error}).encode())


def _future_reset(settings: Settings, cli: str) -> datetime | None:
    """Return when a recorded cap on ``cli`` ends, if it is still in force.

    Args:
        settings: Application settings (the limits file location).
        cli: The CLI.

    Returns:
        The reset time, or ``None`` when no cap is in force.
    """
    try:
        stamp = (read_cli_limits(settings).get(cli) or {}).get("reset_at")
        reset = datetime.fromisoformat(str(stamp)) if stamp else None
    except (OSError, ValueError):
        return None
    if reset is None:
        return None
    reset = reset if reset.tzinfo else reset.replace(tzinfo=UTC)
    return reset if reset > datetime.now(UTC) else None


class CliDispatcher:
    """Answer one model role's chat calls from a local CLI subscription."""

    embeddings = False

    def __init__(
        self, runtime: BudgetRuntime | None, cli: CliProvider, model: str, role: str, settings: Settings
    ) -> None:
        """Bind one model role to a CLI.

        Args:
            runtime: The spending authority that records each call at zero
                cents, or ``None`` for API-side agents, which meter their own usage.
            cli: The CLI that serves this role first.
            model: OpenRouter catalog slug the guest names.
            role: Task, judge, optimization or agent attribution.
            settings: Application settings.

        Raises:
            UnpricedOperationError: Outside local mode, or when ``cli`` cannot run ``model``.
        """
        if not settings.local_mode:
            raise UnpricedOperationError("Subscription models run only in local mode.")
        try:
            cli_model_arg(cli, model)
        except ValueError as error:
            raise UnpricedOperationError(str(error)) from error
        self.runtime = runtime
        self.cli = cli
        self.model = model
        self.role = role
        self.settings = settings
        self.policy = ChargePolicy("subscription_model")

    def dispatch(
        self,
        path: str,
        request: Mapping[str, Any],
        operation_key: str | None = None,
        attempt: int = 0,
        protocol_headers: Mapping[str, str] | None = None,
    ) -> ModelHTTPResult:
        """Answer one chat completion and record it at zero cents.

        Args:
            path: The protocol path; only ``/chat/completions`` is served.
            request: The chat completion body.
            operation_key: Stable identity of this physical attempt, if any.
            attempt: Retry number within the logical operation.
            protocol_headers: Unused; kept for the dispatcher interface.

        Returns:
            The OpenAI-shaped answer, a 429 for a capped subscription, a 502 for
            a failed CLI, or a 422 for a path a CLI cannot serve.

        Raises:
            UnpricedOperationError: When the request names another model or path.
        """
        del protocol_headers
        if path in _UNSUPPORTED_PATHS:
            return _error(422, "subscription.unsupported_path", "Subscription models serve only chat completions.")
        if path != _CHAT_PATH or request.get("model") != self.model:
            raise UnpricedOperationError("This scoped route cannot dispatch a different model or API operation.")
        if self.runtime is None:
            return self._answer(request)[0]
        quote = operation_quote(
            request, Decimal(0), self.policy, {"provider": "subscription", "cli": self.cli, "model": self.model}
        )

        def send() -> PaidResult[ModelHTTPResult]:
            """Run the CLI and report a zero charge with its usage as evidence."""
            result, evidence = self._answer(request)
            return PaidResult(value=result, provider_usd=Decimal(0), evidence=evidence)

        return self.runtime.execute(
            quote,
            self.policy,
            send,
            operation_key=operation_key or str(uuid4()),
            cost_kind="model",
            role=self.role,
            attempt=attempt,
        )

    def stop_batch(self) -> None:
        """Do nothing: subscription calls never wait on a batch."""

    def reconcile(self, generation_id: str | None = None) -> None:
        """Do nothing: a subscription call never leaves a bill to read later.

        Args:
            generation_id: Unused; kept for the dispatcher interface.
        """
        del generation_id

    def _providers(self) -> list[str]:
        """Return this role's CLI, then the configured fallbacks, without repeats."""
        fallback = [name.strip() for name in self.settings.cli_fallback_order.split(",") if name.strip()]
        order = [self.cli]
        order += [name for name in fallback if name in RUNNERS and name not in order]
        return order

    def _answer(self, request: Mapping[str, Any]) -> tuple[ModelHTTPResult, dict[str, Any]]:
        """Run the request on the first CLI that is not capped.

        Args:
            request: The chat completion body.

        Returns:
            The answer and the evidence to record with it.
        """
        prompt = render_prompt(request)
        schema = _schema(request)
        capped: SubscriptionRateLimitedError | None = None
        evidence: dict[str, Any] = {"provider": "subscription", "model": self.model, "cli": self.cli}
        for provider in self._providers():
            try:
                model_arg = cli_model_arg(provider, self.model)  # type: ignore[arg-type]
            except ValueError:
                continue
            reset = _future_reset(self.settings, provider)
            if reset is not None:
                capped = SubscriptionRateLimitedError(
                    provider, reset, f"{provider} is capped until {reset.isoformat()}"
                )
                continue
            started = time.monotonic()
            try:
                completion = self._run(provider, model_arg, prompt, schema)
            except SubscriptionRateLimitedError as error:
                capped = error
                if error.reset_at is not None:
                    # Without a state directory the cap still answers 429; only the UI hint is lost.
                    with contextlib.suppress(OSError, ValueError):
                        write_cli_limit(self.settings, provider, error.reset_at, error.message)  # type: ignore[arg-type]
                continue
            except CliRunError as error:
                evidence.update(cli=provider, status=502, failure=error.message)
                return _error(502, "subscription.cli_failed", error.message, provider=provider), evidence
            usage = self._usage(provider, completion)
            evidence.update(
                cli=provider,
                status=200,
                usage=usage,
                latency_ms=completion.model_ms
                if completion.model_ms is not None
                else round((time.monotonic() - started) * 1000),
            )
            return self._success(request, completion.text, usage), evidence
        assert capped is not None or not self._providers()
        provider = capped.provider if capped else self.cli
        reset_at = capped.reset_at.isoformat() if capped and capped.reset_at else None
        message = capped.message if capped else "No subscription CLI can serve this model."
        evidence.update(cli=provider, status=429, failure=message)
        return (
            _error(429, "subscription.rate_limited", message, provider=provider, reset_at=reset_at),
            evidence,
        )

    def _run(self, provider: str, model_arg: str, prompt: str, schema: dict[str, Any] | None) -> CliCompletion:
        """Run one CLI call, retrying transient failures with jittered back-off.

        Every retry is free under a subscription, so retrying inside one
        recorded operation cannot double-charge the wallet.

        Args:
            provider: The CLI.
            model_arg: Its ``--model`` value.
            prompt: The full prompt.
            schema: A JSON schema for the answer, or ``None``.

        Returns:
            The completion.

        Raises:
            SubscriptionRateLimitedError: When the subscription is capped (never retried).
            CliRunError: When the call still fails after the last retry.
        """
        runner = RUNNERS[provider]
        slots = _semaphore(provider, self.settings.cli_max_concurrency)
        for retry in range(len(_RETRY_DELAYS_SECONDS) + 1):
            try:
                with slots, tempfile.TemporaryDirectory(prefix="skynet-cli-") as cwd:
                    return runner(model_arg, prompt, schema, self.settings, Path(cwd))
            except CliRunError as error:
                if not error.transient or retry == len(_RETRY_DELAYS_SECONDS):
                    raise
                _sleep(_RETRY_DELAYS_SECONDS[retry] * random.uniform(0.75, 1.25))
        raise AssertionError("unreachable")

    def _usage(self, provider: str, completion: CliCompletion) -> dict[str, Any]:
        """Build the usage block, priced at the model's public list price.

        Args:
            provider: The CLI that served the call.
            completion: Its answer.

        Returns:
            The OpenAI-shaped usage block with the subscription fields.
        """
        prices = _list_prices(self.model)
        cost = (
            float(prices[0] * completion.prompt_tokens + prices[1] * completion.completion_tokens)
            if prices is not None
            else None
        )
        return {
            "prompt_tokens": completion.prompt_tokens,
            "completion_tokens": completion.completion_tokens,
            "total_tokens": completion.prompt_tokens + completion.completion_tokens,
            "cost": cost,
            "is_byok": False,
            "cost_details": {"upstream_inference_cost": 0},
            "model_ms": completion.model_ms,
            "token_source": "subscription",
            "cli_provider": provider,
        }

    def _success(self, request: Mapping[str, Any], text: str, usage: dict[str, Any]) -> ModelHTTPResult:
        """Build the chat completion answer, as JSON or as one-delta SSE.

        Args:
            request: The chat completion body.
            text: The CLI's answer.
            usage: The usage block.

        Returns:
            The answer.
        """
        identity = f"cli-{uuid4()}"
        if not request.get("stream"):
            body = {
                "id": identity,
                "object": "chat.completion",
                "created": int(time.time()),
                "model": self.model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                "usage": usage,
            }
            return ModelHTTPResult(200, "application/json", json.dumps(body).encode())
        base = {"id": identity, "object": "chat.completion.chunk", "created": int(time.time()), "model": self.model}
        chunks = [
            {
                **base,
                "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}],
            },
            {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": usage},
        ]
        stream = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        return ModelHTTPResult(200, "text/event-stream", stream.encode())


class _LocalSubscriptionGateway:
    """A loopback endpoint that serves API-side agents from CLI subscriptions."""

    def __init__(self, settings: Settings) -> None:
        """Start the endpoint on a free loopback port.

        Args:
            settings: Application settings.
        """
        self.settings = settings
        self.routes: dict[str, CliDispatcher] = {}
        self.tokens: dict[tuple[str, str, str], str] = {}
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            """Serve chat completions for registered tokens only."""

            def log_message(self, format: str, *args: Any) -> None:
                """Keep prompts and tokens out of the logs."""

            def _reply(self, response: ModelHTTPResult) -> None:
                """Write one answer."""
                self.send_response(response.status)
                self.send_header("Content-Type", response.content_type)
                self.send_header("Content-Length", str(len(response.body)))
                self.end_headers()
                self.wfile.write(response.body)

            def do_POST(self) -> None:
                """Answer one chat completion for a known token."""
                token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                route = gateway.routes.get(token)
                if route is None:
                    self._reply(_error(401, "unauthorized", "Unknown scoped model route."))
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= _MAX_REQUEST_BYTES:
                        self._reply(_error(413, "request_too_large", "The model request exceeds the supported size."))
                        return
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict):
                        raise TypeError("A JSON object is required.")
                    self._reply(route.dispatch(self.path.removeprefix("/v1"), body))
                except (UnpricedOperationError, ValueError, TypeError) as error:
                    self._reply(_error(422, "unpriced_operation", str(error)))

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        threading.Thread(target=self._server.serve_forever, daemon=True, name="local-subscription-gateway").start()

    @property
    def url(self) -> str:
        """Return the loopback base URL."""
        return f"http://127.0.0.1:{self._server.server_port}/v1"

    def route(self, model: str, cli: CliProvider, role: str) -> dict[str, str]:
        """Return the route for one model role, registering it on first use.

        Args:
            model: OpenRouter catalog slug.
            cli: The CLI that serves it first.
            role: Usage attribution.

        Returns:
            ``{url, token, model, role}``.
        """
        key = (model, cli, role)
        with _gateway_lock:
            token = self.tokens.get(key)
            if token is None:
                dispatcher = CliDispatcher(None, cli, model, role, self.settings)
                token = secrets.token_urlsafe(32)
                self.routes[token] = dispatcher
                self.tokens[key] = token
        return {"url": self.url, "token": token, "model": model, "role": role}


_gateway_lock = threading.RLock()
_gateway: _LocalSubscriptionGateway | None = None


def local_subscription_route(model: str, cli: CliProvider, role: str) -> dict[str, str]:
    """Return a loopback route that answers ``model`` from a CLI subscription.

    API-side agents have no run gateway; they share this process-wide one.

    Args:
        model: OpenRouter catalog slug.
        cli: The CLI that serves it first.
        role: Usage attribution.

    Returns:
        ``{url, token, model, role}`` for an OpenAI-compatible client.

    Raises:
        UnpricedOperationError: Outside local mode, or when ``cli`` cannot run ``model``.
    """
    global _gateway
    current = config.settings
    if not current.local_mode:
        raise UnpricedOperationError("Subscription models run only in local mode.")
    with _gateway_lock:
        if _gateway is None:
            _gateway = _LocalSubscriptionGateway(current)
        gateway = _gateway
    return gateway.route(model, cli, role)
