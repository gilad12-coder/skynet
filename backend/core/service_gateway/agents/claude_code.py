"""Run the Claude Code CLI as an agent loop over in-process tools.

Two pieces, both agnostic of which agent uses them:

* :func:`serve_tool_bridge` exposes a list of :class:`BridgeTool` handlers as a
  throwaway MCP server on a loopback port for the span of one turn. The CLI is
  pointed at it with ``--strict-mcp-config`` and has its built-in tools
  disabled, so the handlers are the only actions the model can take.
* :func:`run_claude_code_turn` launches ``claude -p`` against an
  Anthropic-format gateway, decodes its ``stream-json`` output into reasoning /
  reply deltas, keeps a :class:`ClaudeCodeUsage` current for billing, and
  returns the final reply.

The handlers run on the caller's event loop, so they can share the caller's
MCP session, approval futures and SSE queue without any thread hop.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import secrets
import signal
import socket
import tempfile
from collections.abc import AsyncGenerator, Awaitable, Callable, Generator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import uvicorn
from fastmcp import FastMCP
from fastmcp.tools import Tool
from fastmcp.tools.tool import ToolResult

from ...config import settings
from ...exceptions import ServiceError
from ..language_models import LmUsageTotals

logger = logging.getLogger(__name__)

CLAUDE_BINARY = "claude"
MCP_SERVER_NAME = "app"
"""Name the bridge is registered under; the model sees ``mcp__app__<tool>``.

Kept short: providers cap a tool name at 64 characters, prefix included, and
the longest app tool name is 52.
"""

OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api"
_OPENROUTER_ROUTER_PREFIX = "openrouter/auto"

# The CLI sends adaptive thinking and ignores token budgets; its only dials
# are an effort level and an off switch. It has no "minimal" level.
_CLI_EFFORT_BY_LEVEL = {
    "minimal": "low",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
    "max": "max",
}

# A parent Claude Code session exports these; inherited, they make the child
# believe it is nested or bill a personal Anthropic key instead of the gateway.
_STRIPPED_ENV = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY")

_SYNTHETIC_MODEL = "<synthetic>"
_STDERR_TAIL_CHARS = 2000
_KILL_GRACE_SECONDS = 3.0


class ClaudeCodeError(RuntimeError):
    """The CLI exited without a usable reply."""


@dataclass
class BridgeTool:
    """One tool served to the CLI: its MCP spec plus the coroutine that runs it."""

    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[[dict[str, Any]], Awaitable[Any]]


@dataclass
class ToolBridge:
    """Address of a running bridge, as the CLI's MCP config needs it."""

    url: str
    token: str


@dataclass
class ClaudeCodeGateway:
    """Where the CLI sends model calls, and how the turn is billed."""

    base_url: str
    auth_token: str
    model: str
    billing_model: str


@dataclass
class ClaudeCodeUsage:
    """Token usage of one CLI turn, shaped like the LM objects billing harvests.

    ``model`` / ``usage_totals`` feed ``usage_by_model_from_history`` and
    ``last_request_model`` / ``last_response_model`` feed ``served_model_from``,
    so a turn meters through the same seam as a ``MeteredLM``. The totals are
    updated as the stream arrives, which keeps a cancelled turn billable.
    """

    model: str
    usage_totals: LmUsageTotals = field(default_factory=LmUsageTotals)
    last_request_model: str | None = None
    last_response_model: str | None = None
    _per_message: dict[str, list[int]] = field(default_factory=dict)

    def record_message(self, message_id: str, usage: dict[str, Any] | None) -> None:
        """Fold one API call's usage in, keeping the largest counts seen for it.

        The same call reports usage several times (``message_start``,
        ``message_delta``, the assembled ``assistant`` event), some of them
        zeroed, so each message keeps its maximum rather than a sum.

        Args:
            message_id: Id of the API response the usage belongs to.
            usage: Anthropic-format usage block; ``None`` is ignored.
        """
        if not isinstance(usage, dict):
            return
        slot = self._per_message.setdefault(message_id, [0, 0])
        slot[0] = max(slot[0], _input_tokens(usage))
        slot[1] = max(slot[1], _int(usage.get("output_tokens")))
        self._apply(sum(s[0] for s in self._per_message.values()), sum(s[1] for s in self._per_message.values()))

    def record_result(self, model_usage: dict[str, Any] | None) -> None:
        """Adopt the CLI's end-of-turn ``modelUsage`` when it reports more.

        The final tally also covers calls that never streamed (non-streaming
        retries), so it wins whenever it is the larger figure.

        Args:
            model_usage: The ``result`` event's per-model usage mapping.
        """
        if not isinstance(model_usage, dict):
            return
        rows = [row for row in model_usage.values() if isinstance(row, dict)]
        input_tokens = sum(
            _int(row.get("inputTokens"))
            + _int(row.get("cacheReadInputTokens"))
            + _int(row.get("cacheCreationInputTokens"))
            for row in rows
        )
        output_tokens = sum(_int(row.get("outputTokens")) for row in rows)
        self._apply(
            max(input_tokens, self.usage_totals.input_tokens),
            max(output_tokens, self.usage_totals.output_tokens),
        )

    def _apply(self, input_tokens: int, output_tokens: int) -> None:
        """Write the running totals in the shape the billing harvest reads.

        Args:
            input_tokens: Total input tokens so far, cached ones included.
            output_tokens: Total output tokens so far.
        """
        totals = self.usage_totals
        totals.calls = max(len(self._per_message), 1)
        totals.input_tokens = input_tokens
        totals.output_tokens = output_tokens
        totals.total_tokens = input_tokens + output_tokens
        totals.total_found = totals.split_found = True


def _int(value: Any) -> int:
    """Return ``value`` as a non-negative int, or 0 when it is not a number."""
    return max(int(value), 0) if isinstance(value, (int, float)) else 0


def _input_tokens(usage: dict[str, Any]) -> int:
    """Total input tokens of an Anthropic usage block, cached ones included."""
    return (
        _int(usage.get("input_tokens"))
        + _int(usage.get("cache_read_input_tokens"))
        + _int(usage.get("cache_creation_input_tokens"))
    )


def resolve_gateway(model_name: str, base_url: str | None = None) -> ClaudeCodeGateway:
    """Pick the Anthropic-format endpoint a managed turn on ``model_name`` uses.

    Mirrors ``_apply_managed_gateway``: the self-hosted LiteLLM proxy when one
    is configured (it serves ``/v1/messages`` and fronts OpenRouter), otherwise
    OpenRouter's own Anthropic-compatible API. Both address a model by its
    OpenRouter slug, so a leading ``openrouter/`` is dropped. OpenRouter's
    auto router skips the proxy whenever a direct key exists.

    Args:
        model_name: Catalog model id (``openrouter/deepseek/deepseek-v4.1-flash``).
        base_url: Explicit Anthropic-format endpoint that overrides the proxy
            and OpenRouter (on-prem gateways).

    Returns:
        The endpoint, credential, model slug and billing key for the turn.

    Raises:
        ServiceError: When no credential is configured for the chosen endpoint.
    """
    slug = model_name.removeprefix("openrouter/")
    proxy_key = settings.litellm_proxy_api_key
    direct_key = settings.openrouter_api_key
    # OpenRouter names the model its router picked only on its own endpoint;
    # the proxy echoes the requested id, which would hide the served model
    # from the reply footer and price the turn as the router itself.
    prefer_direct = slug.startswith(_OPENROUTER_ROUTER_PREFIX) and direct_key is not None
    if base_url or (settings.litellm_proxy_url and not prefer_direct):
        key = proxy_key or direct_key
        url = base_url or settings.litellm_proxy_url or ""
        # The CLI appends ``/v1/messages`` itself.
        url = url.rstrip("/").removesuffix("/v1")
        billing_model = f"litellm_proxy/{slug}" if not base_url else model_name
    else:
        key = direct_key
        url = OPENROUTER_ANTHROPIC_BASE_URL
        billing_model = model_name
    if key is None:
        raise ServiceError("The assistant's model gateway is not configured (no API key).")
    return ClaudeCodeGateway(base_url=url, auth_token=key.get_secret_value(), model=slug, billing_model=billing_model)


class _BridgeMcpTool(Tool):
    """FastMCP tool whose schema is supplied verbatim and whose body is a handler."""

    bridge: Any = None
    handler: Any = None

    async def run(self, arguments: dict[str, Any]) -> ToolResult:
        """Run the handler under the bridge's serial lock and return its result as text.

        Args:
            arguments: Tool arguments from the model.

        Returns:
            The handler's result; non-strings are JSON-encoded.
        """
        return await self.bridge.dispatch(self.name, self.handler, arguments)


class _BridgeState:
    """Serializes tool calls and tracks in-flight ones so teardown can cancel them."""

    def __init__(self) -> None:
        """Create the lock and the in-flight task set."""
        self._lock = asyncio.Lock()
        self._inflight: set[asyncio.Task[Any]] = set()

    async def dispatch(
        self, name: str, handler: Callable[[dict[str, Any]], Awaitable[Any]], arguments: dict[str, Any]
    ) -> ToolResult:
        """Run one tool call to completion.

        Calls run one at a time: handlers share turn-scoped state (approval
        flags, dry-run proofs) that assumes the order the model issued them in.

        A failing handler is reported to the model as the call's text result
        rather than raised: FastMCP logs a traceback for every raised tool
        error, and the failure was already logged where it happened.

        Args:
            name: Tool name, used in the failure text.
            handler: The tool's coroutine function.
            arguments: Tool arguments from the model.

        Returns:
            The result, or the failure, as MCP text content.
        """
        async with self._lock:
            task = asyncio.ensure_future(handler(arguments))
            self._inflight.add(task)
            try:
                result = await task
            except asyncio.CancelledError:
                task.cancel()
                raise
            except Exception as exc:
                return ToolResult(content=f"Execution error in {name}: {exc or type(exc).__name__}")
            finally:
                self._inflight.discard(task)
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
        return ToolResult(content=text)

    def cancel_inflight(self) -> None:
        """Cancel every handler still running (a tool awaiting approval, say)."""
        for task in list(self._inflight):
            task.cancel()


class _BearerGate:
    """ASGI wrapper that rejects requests lacking the turn's bearer token.

    The bridge listens on loopback, which other local processes (sandboxed
    scorers among them) can reach; the per-turn token keeps the caller's tools
    reachable only by the CLI process that was handed it.
    """

    def __init__(self, app: Any, token: str) -> None:
        """Wrap ``app`` behind ``token``.

        Args:
            app: The ASGI application to protect.
            token: Bearer token every HTTP request must present.
        """
        self._app = app
        self._expected = f"Bearer {token}".encode()

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        """Forward authorized requests; answer the rest with 401.

        Args:
            scope: ASGI connection scope.
            receive: ASGI receive callable.
            send: ASGI send callable.
        """
        if scope["type"] == "http":
            presented = dict(scope.get("headers") or []).get(b"authorization", b"")
            if not secrets.compare_digest(presented, self._expected):
                await send({"type": "http.response.start", "status": 401, "headers": []})
                await send({"type": "http.response.body", "body": b""})
                return
        await self._app(scope, receive, send)


class _EmbeddedServer(uvicorn.Server):
    """uvicorn server that leaves the host process's signal handlers alone."""

    @contextlib.contextmanager
    def capture_signals(self) -> Generator[None, None, None]:
        """Skip signal capture; the API process owns SIGINT / SIGTERM."""
        yield


@asynccontextmanager
async def serve_tool_bridge(tools: list[BridgeTool]) -> AsyncGenerator[ToolBridge, None]:
    """Serve ``tools`` over MCP on an ephemeral loopback port for one turn.

    Args:
        tools: The tools to expose, with their upstream JSON schemas.

    Yields:
        The bridge's URL and bearer token.

    Raises:
        ClaudeCodeError: When the embedded server fails to start.
    """
    state = _BridgeState()
    mcp = FastMCP("Skynet")
    for spec in tools:
        tool = _BridgeMcpTool(name=spec.name, description=spec.description, parameters=spec.input_schema)
        tool.bridge = state
        tool.handler = spec.handler
        mcp.add_tool(tool)
    token = secrets.token_urlsafe(32)
    app = _BearerGate(mcp.http_app(path="/mcp"), token)

    # Binding here (not inside uvicorn) makes the kernel-assigned port known
    # before the CLI config is written, with no bind race.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = _EmbeddedServer(
        uvicorn.Config(app, log_level="warning", access_log=False, lifespan="on", timeout_graceful_shutdown=1)
    )
    serve_task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        while not server.started:
            if serve_task.done():
                raise ClaudeCodeError("tool bridge failed to start")
            await asyncio.sleep(0.01)
        yield ToolBridge(url=f"http://127.0.0.1:{port}/mcp", token=token)
    finally:
        state.cancel_inflight()
        server.should_exit = True
        try:
            await asyncio.wait_for(asyncio.shield(serve_task), timeout=5)
        except (TimeoutError, asyncio.CancelledError):
            serve_task.cancel()
        except Exception:
            logger.exception("tool bridge shutdown failed")
        finally:
            sock.close()


class StreamDecoder:
    """Turn the CLI's ``stream-json`` events into reasoning / reply deltas.

    The reply is the text of the model's LAST message. Text a model writes
    before a tool call is a preamble, not the reply: it has usually streamed
    already, so the decoder hands it back through ``on_reply_reset`` for the
    caller to retract.
    """

    def __init__(
        self,
        usage: ClaudeCodeUsage,
        *,
        on_reasoning: Callable[[str], None],
        on_reply: Callable[[str], None],
        on_reply_reset: Callable[[str], None],
    ) -> None:
        """Bind the usage accumulator and the delta callbacks.

        Args:
            usage: Accumulator updated as usage figures arrive.
            on_reasoning: Receives thinking deltas.
            on_reply: Receives reply-text deltas.
            on_reply_reset: Receives reply text that turned out to be a preamble.
        """
        self._usage = usage
        self._on_reasoning = on_reasoning
        self._on_reply = on_reply
        self._on_reply_reset = on_reply_reset
        self._message_id = ""
        self._text_streamed = False
        self._thinking_streamed = False
        self.reply = ""
        self.result: dict[str, Any] | None = None

    def feed(self, event: dict[str, Any]) -> None:
        """Consume one decoded JSONL event.

        Args:
            event: A ``stream-json`` object from the CLI's stdout.
        """
        kind = event.get("type")
        if kind == "stream_event":
            self._feed_stream_event(event.get("event") or {})
        elif kind == "assistant":
            self._feed_assistant(event.get("message") or {})
        elif kind == "result":
            self.result = event
            self._usage.record_result(event.get("modelUsage"))

    def _retract_reply(self) -> None:
        """Hand streamed reply text back as a preamble and start the reply over."""
        if self.reply:
            self._on_reply_reset(self.reply)
            self.reply = ""

    def _feed_stream_event(self, inner: dict[str, Any]) -> None:
        """Handle one raw Messages-API streaming event.

        Args:
            inner: The ``event`` payload of a ``stream_event`` line.
        """
        kind = inner.get("type")
        if kind == "message_start":
            message = inner.get("message") or {}
            self._retract_reply()
            self._message_id = str(message.get("id") or "")
            self._text_streamed = self._thinking_streamed = False
            self._usage.record_message(self._message_id, message.get("usage"))
        elif kind == "content_block_start":
            if (inner.get("content_block") or {}).get("type") == "tool_use":
                self._retract_reply()
        elif kind == "content_block_delta":
            delta = inner.get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                self._text_streamed = True
                self.reply += delta["text"]
                self._on_reply(delta["text"])
            elif delta.get("type") == "thinking_delta" and delta.get("thinking"):
                self._thinking_streamed = True
                self._on_reasoning(delta["thinking"])
        elif kind == "message_delta":
            self._usage.record_message(self._message_id, inner.get("usage"))

    def _feed_assistant(self, message: dict[str, Any]) -> None:
        """Handle an assembled assistant message.

        Deltas normally carried its content already. Some models answer
        through a non-streamed retry, though, and then this event is the only
        place the text and the usage appear.

        Args:
            message: The ``message`` payload of an ``assistant`` line.
        """
        model = message.get("model")
        if model == _SYNTHETIC_MODEL:
            return
        if isinstance(model, str) and model:
            self._usage.last_response_model = model
        self._usage.record_message(str(message.get("id") or self._message_id), message.get("usage"))
        for block in message.get("content") or []:
            block_type = block.get("type")
            if block_type == "tool_use":
                self._retract_reply()
            elif block_type == "text" and not self._text_streamed and block.get("text"):
                self.reply += block["text"]
                self._on_reply(block["text"])
            elif block_type == "thinking" and not self._thinking_streamed and block.get("thinking"):
                self._on_reasoning(block["thinking"])

    def final_reply(self) -> str:
        """Return the turn's reply once the stream has ended.

        Returns:
            The reply text.

        Raises:
            ClaudeCodeError: When the CLI reported a failure, or ended with no
                result and no reply text.
        """
        result = self.result
        if result is None:
            if self.reply.strip():
                return self.reply
            raise ClaudeCodeError("the agent process ended without a reply")
        text = result.get("result")
        text = text if isinstance(text, str) else ""
        if result.get("is_error"):
            # Hitting the turn cap after real work is still worth showing.
            if result.get("subtype") == "error_max_turns" and self.reply.strip():
                return self.reply
            raise ClaudeCodeError(text or str(result.get("subtype") or "the agent failed"))
        return text if text.strip() else self.reply


def _build_env(
    gateway: ClaudeCodeGateway,
    config_dir: Path,
    *,
    reasoning_effort: str | None,
    request_timeout_seconds: float,
    tool_timeout_seconds: float,
    extra_body: dict[str, Any] | None,
) -> dict[str, str]:
    """Assemble the CLI's environment: isolated config, gateway, no side traffic.

    Args:
        gateway: Endpoint, credential and model for the turn.
        config_dir: Private config directory for this turn.
        reasoning_effort: LiteLLM-style effort level; ``None`` keeps the CLI default.
        request_timeout_seconds: Longest a single model call may take.
        tool_timeout_seconds: Longest a single tool call may take.
        extra_body: Provider-specific fields merged into every model request.

    Returns:
        The environment for the subprocess.
    """
    env = {k: v for k, v in os.environ.items() if k not in _STRIPPED_ENV}
    env.update(
        {
            "CLAUDE_CONFIG_DIR": str(config_dir),
            "ANTHROPIC_BASE_URL": gateway.base_url,
            "ANTHROPIC_AUTH_TOKEN": gateway.auth_token,
            # Background helpers (titles, summaries) default to a Haiku id the
            # gateway cannot serve; pin every slot to the turn's model.
            "ANTHROPIC_MODEL": gateway.model,
            "ANTHROPIC_SMALL_FAST_MODEL": gateway.model,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": gateway.model,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_TELEMETRY": "1",
            "DISABLE_AUTOUPDATER": "1",
            # The CLI's defaults (10-minute calls, 10 retries) are sized for
            # unattended coding; a chat turn must fail while someone is waiting.
            "API_TIMEOUT_MS": str(int(request_timeout_seconds * 1000)),
            "CLAUDE_CODE_MAX_RETRIES": "2",
            "MCP_TIMEOUT": "30000",
            "MCP_TOOL_TIMEOUT": str(int(tool_timeout_seconds * 1000)),
        }
    )
    if reasoning_effort == "none":
        env["CLAUDE_CODE_DISABLE_THINKING"] = "1"
    elif reasoning_effort in _CLI_EFFORT_BY_LEVEL:
        env["CLAUDE_CODE_EFFORT_LEVEL"] = _CLI_EFFORT_BY_LEVEL[reasoning_effort]
    if extra_body:
        env["CLAUDE_CODE_EXTRA_BODY"] = json.dumps(extra_body)
    return env


async def _terminate(process: asyncio.subprocess.Process) -> None:
    """Stop the CLI and everything it spawned.

    Args:
        process: The subprocess, started in its own session.
    """
    if process.returncode is not None:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, sig)
        try:
            await asyncio.wait_for(asyncio.shield(process.wait()), timeout=_KILL_GRACE_SECONDS)
            return
        except TimeoutError:
            continue


async def _drain(stream: asyncio.StreamReader, sink: list[str]) -> None:
    """Keep the tail of ``stream`` so a full stderr pipe never blocks the CLI.

    Args:
        stream: The subprocess's stderr.
        sink: One-element list holding the retained tail.
    """
    while chunk := await stream.read(4096):
        sink[0] = (sink[0] + chunk.decode("utf-8", "replace"))[-_STDERR_TAIL_CHARS:]


async def run_claude_code_turn(
    *,
    system_prompt: str,
    user_prompt: str,
    gateway: ClaudeCodeGateway,
    bridge: ToolBridge,
    usage: ClaudeCodeUsage,
    on_reasoning: Callable[[str], None],
    on_reply: Callable[[str], None],
    on_reply_reset: Callable[[str], None],
    reasoning_effort: str | None = None,
    max_turns: int = 25,
    request_timeout_seconds: float = 120.0,
    tool_timeout_seconds: float = 960.0,
    extra_body: dict[str, Any] | None = None,
) -> str:
    """Run one agent turn through the Claude Code CLI and return its reply.

    The CLI gets no built-in tools, no user or project settings and no session
    persistence: the bridge's tools are its whole action space and the turn
    leaves nothing behind. Cancelling the awaiting task kills the process group.

    Args:
        system_prompt: Replaces the CLI's own system prompt.
        user_prompt: The turn's input, sent over stdin.
        gateway: Endpoint, credential and model for the turn.
        bridge: Address of the running tool bridge.
        usage: Accumulator kept current while the stream arrives.
        on_reasoning: Receives thinking deltas.
        on_reply: Receives reply-text deltas.
        on_reply_reset: Receives reply text that turned out to be a preamble.
        reasoning_effort: LiteLLM-style effort level; ``"none"`` disables thinking
            and ``None`` keeps the CLI default.
        max_turns: Cap on model calls in the turn.
        request_timeout_seconds: Longest a single model call may take.
        tool_timeout_seconds: Longest a single tool call may take. Must exceed
            the approval timeout, or a slow confirmation fails the call.
        extra_body: Provider-specific fields merged into every model request
            (OpenRouter's router plugins and ``session_id``).

    Returns:
        The reply text.

    Raises:
        ClaudeCodeError: When the CLI is missing, fails, or produces no reply.
    """
    usage.last_request_model = gateway.model
    decoder = StreamDecoder(usage, on_reasoning=on_reasoning, on_reply=on_reply, on_reply_reset=on_reply_reset)
    with tempfile.TemporaryDirectory(prefix="skynet-agent-") as workdir:
        root = Path(workdir)
        config_dir = root / "config"
        cwd = root / "cwd"
        config_dir.mkdir()
        cwd.mkdir()
        prompt_file = root / "system.md"
        prompt_file.write_text(system_prompt, encoding="utf-8")
        mcp_config = root / "mcp.json"
        mcp_config.touch(mode=0o600)
        mcp_config.write_text(
            json.dumps(
                {
                    "mcpServers": {
                        MCP_SERVER_NAME: {
                            "type": "http",
                            "url": bridge.url,
                            "headers": {"Authorization": f"Bearer {bridge.token}"},
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        cmd = [
            CLAUDE_BINARY, "-p",
            "--system-prompt-file", str(prompt_file),
            "--mcp-config", str(mcp_config), "--strict-mcp-config",
            "--tools", "",
            "--setting-sources", "",
            "--permission-mode", "bypassPermissions",
            "--no-session-persistence",
            "--output-format", "stream-json", "--include-partial-messages", "--verbose",
            "--max-turns", str(max_turns),
            "--model", gateway.model,
        ]  # fmt: skip
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=_build_env(
                    gateway,
                    config_dir,
                    reasoning_effort=reasoning_effort,
                    request_timeout_seconds=request_timeout_seconds,
                    tool_timeout_seconds=tool_timeout_seconds,
                    extra_body=extra_body,
                ),
                # Own session = own process group, so one killpg reaps the
                # CLI's children too.
                start_new_session=True,
                # One JSONL event can carry a whole tool result.
                limit=32 * 1024 * 1024,
            )
        except FileNotFoundError as exc:
            raise ClaudeCodeError(f"the '{CLAUDE_BINARY}' CLI is not installed on this server") from exc
        stderr_tail = [""]
        drain_task = asyncio.create_task(_drain(process.stderr, stderr_tail))
        try:
            process.stdin.write(user_prompt.encode("utf-8"))
            await process.stdin.drain()
            process.stdin.close()
            async for raw in process.stdout:
                line = raw.strip()
                if not line.startswith(b"{"):
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict):
                    decoder.feed(event)
            await process.wait()
        finally:
            await _terminate(process)
            drain_task.cancel()
    try:
        return decoder.final_reply()
    except ClaudeCodeError:
        if stderr_tail[0].strip():
            logger.warning("claude CLI stderr tail: %s", stderr_tail[0].strip())
        raise
