"""Broker optimizer model calls through a trusted, account-scoped parent process."""

from __future__ import annotations

import copy
import json
import os
import re
import secrets
import threading
from collections.abc import Mapping
from dataclasses import asdict
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx

from ..exceptions import DETERMINISTIC_FAILURE, INFRASTRUCTURE_INTERRUPTION, InfrastructureInterruptionError
from .budgets import BudgetError, BudgetInsufficientError
from .credential_safety import scrub_model_config
from .mcp_broker import McpToolsBroker
from .model_dispatch import MODEL_ATTEMPT_HEADER, ModelHTTPResult, OpenRouterDispatcher
from .openrouter_quotes import resolve_model_slug
from .operation_pricing import ChargePolicy, UnpricedOperationError
from .protected_credentials import (
    MCP_CREDENTIAL_REF_FIELD,
    MCP_CREDENTIAL_REVISION_FIELD,
    MCP_URL_REF_FIELD,
    MCP_URL_REVISION_FIELD,
    SCORER_CREDENTIAL_REF_FIELD,
    SCORER_CREDENTIAL_REVISION_FIELD,
    SCORER_URL_REF_FIELD,
    SCORER_URL_REVISION_FIELD,
)
from .recovery_admission import (
    build_recovery_plan,
    model_call_bound,
    quote_fits_bound,
    runtime_bound,
    validate_recovery_runtime,
)
from .remote_evaluator import RemoteEvaluatorBroker, RemoteEvaluatorTransportError
from .runtime import BudgetRuntime, UsagePendingError
from .signals import BudgetReached

ROUTE_KEY = "_skynet_budget_route"
_MAX_REQUEST_BYTES = 32 * 1024 * 1024
_MODEL_ATTEMPT_ID = re.compile(r"[0-9a-f]{32}\Z")
_TRANSIENT_SANDBOX_ERROR_TYPES = frozenset(
    {
        "SandboxResponseError",
        "SandboxStreamError",
        "SandboxTimeoutError",
    }
)


def _sandbox_failure_kind(error: BaseException) -> str:
    """Classify trusted sandbox failures from their exception types and causes.

    Args:
        error: Exception raised by the parent-owned sandbox implementation.

    Returns:
        A stable failure kind for the sandbox child protocol.
    """
    pending = [error]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, InfrastructureInterruptionError | httpx.TransportError):
            return INFRASTRUCTURE_INTERRUPTION
        if type(current).__name__ in _TRANSIENT_SANDBOX_ERROR_TYPES:
            return INFRASTRUCTURE_INTERRUPTION
        pending.extend(
            nested
            for nested in (current.__cause__, current.__context__, getattr(current, "cause", None))
            if isinstance(nested, BaseException)
        )
    return DETERMINISTIC_FAILURE


def _model_attempt_key(headers: Mapping[str, str]) -> str | None:
    """Validate a supervisor-issued physical model attempt identity.

    Args:
        headers: Normalized request headers crossing the protected relay.

    Returns:
        A durable operation key, or None for trusted direct setup probes.

    Raises:
        UnpricedOperationError: When an alleged mailbox identity is malformed.
    """
    identity = headers.get(MODEL_ATTEMPT_HEADER)
    if identity is None:
        return None
    if _MODEL_ATTEMPT_ID.fullmatch(identity) is None:
        raise UnpricedOperationError("The model attempt identity is invalid.")
    return f"model-attempt:{identity}"


class SandboxControl(Protocol):
    """Describe the parent-owned sandbox boundary without importing optimizer code."""

    def handle(self, action: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        """Perform a non-streaming action on an owned sandbox."""
        ...

    def run(self, payload: Mapping[str, Any], on_output: Any = None) -> Any:
        """Execute an owned guest command and return its terminal result."""
        ...

    def close(self) -> None:
        """Stop every owned sandbox and settle its confirmed usage."""
        ...


def raise_gateway_stop(route: Mapping[str, Any]) -> None:
    """Restore the typed control signal after a native CLI reports a gateway failure.

    Args:
        route: Scoped endpoint and opaque credential supplied by the trusted parent.

    Raises:
        BudgetReached: When the authoritative parent stopped admission for budget.
        UsagePendingError: When the authority is closed for another accounting reason.
    """
    try:
        response = httpx.get(
            f"{os.environ.get('SKYNET_BUDGET_RELAY_URL', str(route['url'])).rstrip('/')}/_budget/state",
            headers={"Authorization": f"Bearer {route['token']}"},
            timeout=10,
            trust_env=False,
        )
    except httpx.TransportError as error:
        raise InfrastructureInterruptionError("The trusted parent model transport was interrupted.") from error
    response.raise_for_status()
    budget = response.json()
    if budget.get("blocked_reason") == "budget_reached":
        raise BudgetReached()
    if budget.get("blocked_reason"):
        raise UsagePendingError("The spending authority is awaiting reconciliation.")


class ModelGateway:
    """Keep upstream credentials and dispatch authority outside the optimizer child."""

    def __init__(
        self,
        runtime: BudgetRuntime,
        *,
        timeout: float = 600,
        recovery_plan: Mapping[str, Any] | None = None,
    ) -> None:
        """Start a loopback-only service for one setup or run authority.

        Args:
            runtime: Owner-bound, generation-fenced spending context.
            timeout: Physical provider request timeout, excluding hidden retries.
            recovery_plan: Checkpoint-bound replay caps already covered by one ledger hold.
        """
        self.runtime = runtime
        self._client = httpx.Client(timeout=timeout, follow_redirects=False, trust_env=False)
        self._routes: dict[str, OpenRouterDispatcher] = {}
        self._sandbox: SandboxControl | None = None
        self._tools: McpToolsBroker | None = None
        self._evaluator: RemoteEvaluatorBroker | None = None
        self._evaluator_token = secrets.token_urlsafe(32)
        self._tool_token = secrets.token_urlsafe(32)
        self._control_token = secrets.token_urlsafe(32)
        self._descriptor: dict[str, Any] | None = None
        self._recovery_lock = threading.Lock()
        self._recovery_plan = copy.deepcopy(dict(recovery_plan)) if recovery_plan is not None else None
        self._seed_marker_count = 0
        self._seed_complete = False
        self._seed_bounds: dict[tuple[str, str, str, str, str], dict[str, Any]] = {}
        self._execution_bounds: dict[tuple[str, str, str, str, str], dict[str, Any]] = {}
        self._recovery_seed_used: dict[int, int] = {}
        self._recovery_seed_claims: dict[tuple[str, int], int] = {}
        self._recovery_execution_claim: tuple[str, int] | None = None
        self._recovery_ineligible_reason: str | None = None
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            """Serve only registered model roles and their own budget state."""

            def log_message(self, format: str, *args: Any) -> None:
                """Avoid logging guest requests or scoped credentials."""

            def _route(self) -> OpenRouterDispatcher | None:
                """Resolve a short-lived role token without accepting provider credentials."""
                token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                if not token:
                    token = self.headers.get("x-api-key", "")
                return gateway._routes.get(token)

            def _reply(self, response: ModelHTTPResult) -> None:
                """Write a bounded protocol response with no credential-bearing headers."""
                self.send_response(response.status)
                self.send_header("Content-Type", response.content_type)
                self.send_header("Content-Length", str(len(response.body)))
                self.end_headers()
                self.wfile.write(response.body)

            def _error(self, status: int, code: str, message: str) -> None:
                """Report a machine-readable admission result to every guest protocol."""
                self._reply(
                    ModelHTTPResult(
                        status,
                        "application/json",
                        json.dumps({"error": {"type": code, "code": code, "message": message}}).encode(),
                    )
                )

            def do_GET(self) -> None:
                """Return state only to a token already bound to this spending authority."""
                token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                if self._route() is None and not (
                    (gateway._tools is not None and secrets.compare_digest(token, gateway._tool_token))
                    or (gateway._evaluator is not None and secrets.compare_digest(token, gateway._evaluator_token))
                ):
                    self._error(401, "unauthorized", "Unknown scoped model route.")
                    return
                if self.path != "/v1/_budget/state":
                    self._error(404, "not_found", "Unknown protected endpoint.")
                    return
                body = gateway._budget_state()
                self._reply(ModelHTTPResult(200, "application/json", json.dumps(body, default=str).encode()))

            def do_POST(self) -> None:
                """Admit the fully resolved SDK body before forwarding any provider request."""
                if self.path == "/v1/_sandbox":
                    self._sandbox_request()
                    return
                route = self._route()
                token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                is_tools = (
                    self.path == "/v1/_mcp"
                    and gateway._tools is not None
                    and secrets.compare_digest(token, gateway._tool_token)
                )
                is_evaluator = (
                    self.path == "/v1/_evaluator"
                    and gateway._evaluator is not None
                    and secrets.compare_digest(token, gateway._evaluator_token)
                )
                if route is None and not is_tools and not is_evaluator:
                    self._error(401, "unauthorized", "Unknown scoped model route.")
                    return
                if self.path == "/v1/_budget/recovery-seed-complete":
                    try:
                        length = int(self.headers.get("Content-Length", "0"))
                        if not 0 <= length <= 1024:
                            raise ValueError("Recovery marker exceeds the supported size.")
                        if length and json.loads(self.rfile.read(length)) != {}:
                            raise ValueError("Recovery marker body must be empty.")
                        gateway.finish_recovery_seed()
                        self._reply(ModelHTTPResult(200, "application/json", b'{"ok":true}'))
                    except (ValueError, TypeError) as error:
                        self._error(422, "invalid_recovery_marker", str(error))
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= _MAX_REQUEST_BYTES:
                        self._error(413, "request_too_large", "The model request exceeds the supported size.")
                        return
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict):
                        raise TypeError("A JSON object is required.")
                    response = (
                        gateway._evaluator.dispatch(body)
                        if is_evaluator
                        else gateway._tools.dispatch(body)
                        if is_tools
                        else route.dispatch(
                            self.path.removeprefix("/v1"),
                            body,
                            operation_key=_model_attempt_key(
                                {name.lower(): value for name, value in self.headers.items()}
                            ),
                            protocol_headers={
                                name: value
                                for name, value in self.headers.items()
                                if name.lower() in {"anthropic-version", "anthropic-beta"}
                            },
                        )
                    )
                    self._reply(response)
                except BudgetReached:
                    self._error(402, "budget_reached", "The remaining budget cannot cover the next operation.")
                except BudgetInsufficientError:
                    self._error(
                        402, "budget_insufficient", "Increase the total budget or available credits to continue."
                    )
                except (UsagePendingError, BudgetError):
                    self._error(424, "usage_pending", "Previous work must settle before another attempt is admitted.")
                except (UnpricedOperationError, ValueError, TypeError) as error:
                    self._error(422, "unpriced_operation", str(error))
                except httpx.HTTPError:
                    self._error(
                        502,
                        "provider_transport_interruption",
                        "The model provider transport could not complete this request.",
                    )
                except RemoteEvaluatorTransportError:
                    self._error(
                        502, "evaluator_unavailable", "The configured evaluator could not complete this request."
                    )

            def _sandbox_request(self) -> None:
                """Serve guest control with a separate capability and streamed command output."""
                token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                if not secrets.compare_digest(token, gateway._control_token) or gateway._sandbox is None:
                    self._error(401, "unauthorized", "Unknown sandbox control capability.")
                    return
                streaming = False
                write_lock = threading.Lock()

                def frame(value: dict[str, Any]) -> None:
                    """Flush one NDJSON frame without interleaving parallel output callbacks."""
                    with write_lock:
                        self.wfile.write(json.dumps(value).encode() + b"\n")
                        self.wfile.flush()

                def output(stream: str, data: str) -> None:
                    """Forward ordinary guest output after trusted model interception."""
                    frame({"type": "output", "stream": stream, "data": data})

                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= _MAX_REQUEST_BYTES:
                        raise ValueError("Sandbox request exceeds the supported size.")
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict) or not isinstance(body.get("payload"), dict):
                        raise TypeError("Sandbox control requires a JSON action and payload.")
                    action, payload = body.get("action"), body["payload"]
                    if action == "run":
                        self.send_response(200)
                        self.send_header("Content-Type", "application/x-ndjson")
                        self.end_headers()
                        streaming = True
                        result = gateway._sandbox.run(payload, on_output=output)
                        frame({"type": "result", **asdict(result)})
                    else:
                        value = gateway._sandbox.handle(action, payload)
                        self._reply(ModelHTTPResult(200, "application/json", json.dumps(value).encode()))
                except BaseException as error:
                    value = {
                        "type": "error",
                        "error_type": type(error).__name__,
                        "failure_kind": _sandbox_failure_kind(error),
                        "message": str(error),
                    }
                    if streaming:
                        frame(value)
                    else:
                        self._reply(ModelHTTPResult(422, "application/json", json.dumps(value).encode()))

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = False
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True, name="budget-model-gateway")
        self._thread.start()

    @staticmethod
    def _bound_key(bound: Mapping[str, Any]) -> tuple[str, str, str, str, str]:
        """Return the prompt-free identity of one repeatable model request ceiling."""
        return (
            str(bound.get("role")),
            str(bound.get("model")),
            str(bound.get("price_binding")),
            str(bound.get("max_credits")),
            str(bound.get("max_wallet_credits")),
        )

    def _observe_model_quote(
        self,
        role: str,
        model: str,
        quote: Any,
        operation_key: str,
        attempt: int,
    ) -> bool:
        """Record initial seed bounds or enforce the persisted replay call quota.

        Args:
            role: Fixed model-route role.
            model: Exact provider model slug.
            quote: Fresh verified quote for the fully resolved physical request.
            operation_key: Stable identity of the physical model attempt.
            attempt: Retry number within that operation identity.

        Returns:
            Whether this exact attempt owns recovery headroom in the ledger.
        """
        observed = model_call_bound(role, model, quote)
        claim = (operation_key, attempt)
        with self._recovery_lock:
            if self._recovery_plan is None:
                target = self._execution_bounds if self._seed_complete else self._seed_bounds
                key = self._bound_key(observed)
                current = target.get(key)
                if current is None:
                    target[key] = observed
                elif not self._seed_complete:
                    current["count"] = int(current["count"]) + 1
                return False
            if not self._seed_complete:
                bounds = self._recovery_plan.get("seed_reevaluation", {}).get("model_calls", [])
                claimed_index = self._recovery_seed_claims.get(claim)
                if claimed_index is not None:
                    if not quote_fits_bound(bounds[claimed_index], role, model, quote):
                        raise ValueError("A recovered seed attempt identity changed its bounded request.")
                    return True
                for index, bound in enumerate(bounds):
                    used = self._recovery_seed_used.get(index, 0)
                    if used < int(bound.get("count", 0)) and quote_fits_bound(bound, role, model, quote):
                        self._recovery_seed_used[index] = used + 1
                        self._recovery_seed_claims[claim] = index
                        key = self._bound_key(observed)
                        current = self._seed_bounds.get(key)
                        if current is None:
                            self._seed_bounds[key] = observed
                        else:
                            current["count"] = int(current["count"]) + 1
                        return True
                raise ValueError("Recovered seed evaluation exceeded its persisted model-call or price bound.")
            if self._recovery_execution_claim is None:
                bounds = self._recovery_plan.get("execution_headroom", {}).get("model_calls", [])
                if not any(quote_fits_bound(bound, role, model, quote) for bound in bounds):
                    raise ValueError("The resumed operation differs from its persisted execution headroom bound.")
                self._recovery_execution_claim = claim
            elif self._recovery_execution_claim == claim:
                return True
            self._execution_bounds.setdefault(self._bound_key(observed), observed)
            return self._recovery_execution_claim == claim

    def finish_recovery_seed(self) -> None:
        """Close the mandatory seed-evaluation phase and activate one execution bound."""
        with self._recovery_lock:
            self._seed_marker_count += 1
            if self._seed_marker_count > 1 and self._recovery_plan is None:
                self._recovery_ineligible_reason = (
                    "Multiple independent seed evaluators share this process; recover them as separate GEPA pairs."
                )
            self._seed_complete = True
            if self._recovery_plan is not None:
                self.runtime.finish_recovery_seed()

    def checkpoint_recovery_plan(self, manifest: Mapping[str, Any], *, runtime: str) -> dict[str, Any]:
        """Build a checkpoint-bound plan from observed calls and enforced sandbox limits.

        Args:
            manifest: Compatibility evidence for the exact state bytes being published.
            runtime: Selected managed outer sandbox.

        Returns:
            Eligible or precisely ineligible recovery admission evidence.
        """
        with self._recovery_lock:
            seed_bounds = [copy.deepcopy(value) for value in self._seed_bounds.values()]
            execution_bounds = [copy.deepcopy(value) for value in self._execution_bounds.values()]
            marker_seen = self._seed_marker_count == 1
            reason = self._recovery_ineligible_reason
        execution = None
        if execution_bounds:
            execution = {
                "model_calls": execution_bounds,
                "max_credits": str(max(Decimal(item["max_credits"]) for item in execution_bounds)),
                "max_wallet_credits": str(max(Decimal(item["max_wallet_credits"]) for item in execution_bounds)),
            }
        return build_recovery_plan(
            manifest,
            runtime=runtime_bound(runtime, self._descriptor),
            seed_bounds=seed_bounds,
            execution_bound=execution,
            seed_marker_seen=marker_seen,
            ineligible_reason=reason,
        )

    def validate_recovery_runtime(self, runtime: str) -> None:
        """Verify the selected current sandbox against the checkpoint's covered profile.

        Args:
            runtime: Selected managed execution runtime.

        Raises:
            RecoveryAdmissionError: When current resources or prices differ from the plan.
        """
        if self._recovery_plan is not None:
            validate_recovery_runtime(self._recovery_plan, runtime_bound(runtime, self._descriptor))

    @property
    def url(self) -> str:
        """Return the loopback endpoint passed to the authorized optimizer child."""
        return f"http://127.0.0.1:{self._server.server_port}/v1"

    def register(self, *, model: str, api_key: str, role: str, policy: ChargePolicy) -> dict[str, str]:
        """Register one fixed role without exposing its provider credential.

        Args:
            model: Exact permitted OpenRouter model slug.
            api_key: Provider credential retained only in the trusted parent.
            role: Task, judge, or optimization usage attribution.
            policy: Approved conversion policy for this particular model source.

        Returns:
            Scoped guest route containing no upstream credential.
        """
        model = resolve_model_slug(model, client=self._client)
        token = secrets.token_urlsafe(32)
        self._routes[token] = OpenRouterDispatcher(
            self.runtime,
            api_key=api_key,
            model=model,
            role=role,
            policy=policy,
            client=self._client,
            quote_observer=self._observe_model_quote,
        )
        return {"url": self.url, "token": token, "model": model, "role": role}

    def model_routes(self) -> list[dict[str, str]]:
        """Return only capabilities registered by this trusted parent for readiness probes."""
        return [
            {"url": self.url, "token": token, "model": route.model, "role": route.role}
            for token, route in self._routes.items()
        ]

    def bind_sandbox(self, broker: SandboxControl, *, image: str, lifetime_seconds: float) -> None:
        """Bind the trusted runtime before passing a scoped descriptor to its child.

        Args:
            broker: Parent-owned sandbox credentials and cost accounting.
            image: Immutable deployment profile used for this workload.
            lifetime_seconds: Maximum already bounded by the configured runtime profile.
        """
        if self._sandbox is not None:
            raise ValueError("This gateway already owns a sandbox broker.")
        self._sandbox = broker
        self._descriptor = {
            "url": self.url,
            "control_token": self._control_token,
            "image": image,
            "lifetime_seconds": lifetime_seconds,
        }

    def dispatch_guest(
        self, token: str, path: str, body: Mapping[str, Any], headers: Mapping[str, str]
    ) -> ModelHTTPResult:
        """Serve a sandbox mailbox request under its original fixed model role.

        Args:
            token: Short-lived scoped role credential registered by this parent.
            path: Supported model protocol path or own-budget state endpoint.
            body: Exact model request emitted by the guest SDK.
            headers: Permitted protocol headers, never upstream credentials.

        Returns:
            Model response after authoritative admission and settlement.
        """
        route = self._routes.get(token)
        is_tools = self._tools is not None and secrets.compare_digest(token, self._tool_token)
        is_evaluator = self._evaluator is not None and secrets.compare_digest(token, self._evaluator_token)
        if route is None and not is_tools and not is_evaluator:
            raise ValueError("Unknown scoped model route.")
        if path == "/v1/_budget/state":
            snapshot = self._budget_state()
            return ModelHTTPResult(200, "application/json", json.dumps(snapshot, default=str).encode())
        if path == "/v1/_budget/recovery-seed-complete":
            if body:
                raise ValueError("Recovery marker body must be empty.")
            self.finish_recovery_seed()
            return ModelHTTPResult(200, "application/json", b'{"ok":true}')
        if is_evaluator:
            if path != "/v1/_evaluator":
                raise ValueError("The evaluator capability cannot dispatch models, tools, or sandbox commands.")
            return self._evaluator.dispatch(body)
        if is_tools:
            if path != "/v1/_mcp":
                raise ValueError("The tool capability cannot dispatch models or sandbox commands.")
            return self._tools.dispatch(body)
        return route.dispatch(
            path.removeprefix("/v1"),
            body,
            operation_key=_model_attempt_key(headers),
            protocol_headers=headers,
        )

    def _budget_state(self) -> dict[str, Any]:
        """Expose only the owning run's state and mark replaced capabilities as fenced."""
        snapshot = asdict(self.runtime.service.get(self.runtime.budget_id, self.runtime.username))
        snapshot.pop("username", None)
        snapshot.pop("account_available_credits", None)
        if snapshot["generation"] != self.runtime.generation:
            snapshot["blocked_reason"] = "generation_fenced"
        return snapshot

    def protect_payload(
        self, payload: dict[str, Any], *, managed_key: str, allow_private_tools: bool = False
    ) -> dict[str, Any]:
        """Replace resolved provider credentials with fixed, metered model-role routes.

        Args:
            payload: In-memory submission after account-owned credentials are resolved.
            managed_key: Platform OpenRouter credential used only for managed roles.
            allow_private_tools: Explicit deployment opt-in for private MCP destinations.

        Returns:
            A copied payload carrying opaque role routes and no model provider keys.

        Raises:
            UnpricedOperationError: When a configured external route cannot be verified.
        """
        result = copy.deepcopy(payload)
        for key in (
            "_skynet_target_route",
            "_skynet_tools_route",
            "_skynet_evaluator_route",
            "_budget_gateway_descriptor",
        ):
            result.pop(key, None)
        source = result.get("tool_source")
        if isinstance(source, dict) and source.get("kind") == "live_mcp":
            if any(
                field in source
                for field in (
                    MCP_CREDENTIAL_REF_FIELD,
                    MCP_CREDENTIAL_REVISION_FIELD,
                    MCP_URL_REF_FIELD,
                    MCP_URL_REVISION_FIELD,
                )
            ):
                raise ValueError("The MCP credential reference must be resolved by the trusted parent.")
            if self._tools is not None:
                raise ValueError("This gateway already owns a tool roster.")
            self._tools = McpToolsBroker(
                str(source.get("mcp_url") or ""),
                auth_header=source.pop("mcp_auth_header", None),
                tool_filter=source.get("tool_filter"),
                allow_private=allow_private_tools,
                check_admission=self.runtime.check_admission,
            )
            source["mcp_url"] = "https://scoped-tools.invalid/mcp"
            result["_skynet_tools_route"] = {"url": self.url, "token": self._tool_token}
        if self._descriptor is not None:
            result["_budget_gateway_descriptor"] = dict(self._descriptor)
        target = result.get("target")
        target_config = result.get("task_model_config") if isinstance(target, dict) else None
        target_route: dict[str, str] | None = None
        models = []
        for key, role in (
            ("model_config", "task"),
            ("reflection_model_config", "optimization"),
            ("task_model_config", "task"),
        ):
            if isinstance(result.get(key), dict):
                models.append((result[key], role))
        scorer = result.get("scorer")
        if isinstance(scorer, dict) and scorer.get("kind") == "remote":
            if any(
                field in scorer
                for field in (
                    SCORER_CREDENTIAL_REF_FIELD,
                    SCORER_CREDENTIAL_REVISION_FIELD,
                    SCORER_URL_REF_FIELD,
                    SCORER_URL_REVISION_FIELD,
                )
            ):
                raise ValueError("The evaluator credential reference must be resolved by the trusted parent.")
            if self._evaluator is not None:
                raise ValueError("This gateway already owns an evaluator endpoint.")
            self._evaluator = RemoteEvaluatorBroker(
                str(scorer.get("url") or ""),
                secret=scorer.pop("secret", None),
                timeout_seconds=float(scorer.get("timeout_seconds", 60)),
                check_admission=self.runtime.check_admission,
                allow_private=allow_private_tools,
            )
            scorer["url"] = "https://scoped-evaluator.invalid/score"
            # Remote evaluators never use the optional Python scorer model or its credentials.
            scorer.pop("model", None)
            result["_skynet_evaluator_route"] = {"url": self.url, "token": self._evaluator_token}
        elif isinstance(scorer, dict) and isinstance(scorer.get("model"), dict):
            models.append((scorer["model"], "judge"))
        for key, role in (("generation_models", "task"), ("reflection_models", "optimization")):
            models.extend((config, role) for config in result.get(key, []) if isinstance(config, dict))
        for config, role in models:
            source = config.get("token_source") or result.get("token_source") or "managed"
            extra = config.get("extra") or {}
            endpoint = extra.get("api_base") or extra.get("base_url") or config.get("base_url")
            if source == "byok" and urlsplit(str(endpoint or "")).hostname != "openrouter.ai":
                raise UnpricedOperationError("This BYOK endpoint has no verified operation budget adapter.")
            if source == "managed" and endpoint and urlsplit(str(endpoint)).hostname != "openrouter.ai":
                raise UnpricedOperationError("An explicit custom endpoint cannot be silently rerouted.")
            model = str(extra.get("model") or config.get("name", "")).removeprefix("openrouter/")
            key = extra.get("api_key") if source == "byok" else managed_key
            if not key:
                raise UnpricedOperationError("This model role has no available provider credential.")
            route = self.register(
                model=model,
                api_key=str(key),
                role=role,
                policy=ChargePolicy("byok_model" if source == "byok" else "managed_model"),
            )
            if config is target_config:
                target_name = str(target.get("model") or "").strip("/")
                if not target_name or target_name != str(config.get("name") or "").strip("/"):
                    raise UnpricedOperationError("The agent task model does not match its credential configuration.")
                target_route = route
            cleaned = scrub_model_config(config)
            config.clear()
            config.update(cleaned)
            config["extra"] = dict(config.get("extra") or {})
            config["extra"][ROUTE_KEY] = route
            config.pop("base_url", None)
        if isinstance(target, dict) and target.get("model"):
            if target_route is not None:
                result["_skynet_target_route"] = target_route
            else:
                if result.get("token_source") == "byok":
                    raise UnpricedOperationError("A BYOK agent target needs an explicit verified model configuration.")
                result["_skynet_target_route"] = self.register(
                    model=str(target["model"]).removeprefix("openrouter/"),
                    api_key=managed_key,
                    role="task",
                    policy=ChargePolicy("managed_model"),
                )
        return result

    def close(self) -> None:
        """Finish covered requests before releasing the trusted transport and route tokens."""
        try:
            self._server.shutdown()
            self._server.server_close()
            self._thread.join(timeout=2)
            if self._sandbox is not None:
                self._sandbox.close()
        finally:
            self.runtime.release_recovery_headroom()
            self._client.close()
            self._routes.clear()
            self._tools = None
            self._evaluator = None
