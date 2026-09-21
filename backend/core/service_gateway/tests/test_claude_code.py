"""Tests for the Claude Code CLI harness (:mod:`...agents.claude_code`)."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from pydantic import SecretStr

from ...exceptions import ServiceError
from ..agents import claude_code as cc
from ..language_models import served_model_from, usage_by_model_from_history


def _gateway() -> cc.ClaudeCodeGateway:
    """Return a gateway whose values are recognisable in assertions."""
    return cc.ClaudeCodeGateway(
        base_url="http://gateway.test", auth_token="secret-token", model="vendor/model", billing_model="bill/model"
    )


def _decoder() -> tuple[cc.StreamDecoder, cc.ClaudeCodeUsage, dict[str, list[str]]]:
    """Build a decoder whose callbacks append to named lists.

    Returns:
        The decoder, its usage accumulator, and the captured callback calls.
    """
    seen: dict[str, list[str]] = {"reasoning": [], "reply": [], "reset": []}
    usage = cc.ClaudeCodeUsage(model="bill/model")
    decoder = cc.StreamDecoder(
        usage,
        on_reasoning=seen["reasoning"].append,
        on_reply=seen["reply"].append,
        on_reply_reset=seen["reset"].append,
    )
    return decoder, usage, seen


def _stream(inner: dict[str, Any]) -> dict[str, Any]:
    """Wrap a Messages-API streaming event the way the CLI does."""
    return {"type": "stream_event", "event": inner}


def _text_delta(text: str) -> dict[str, Any]:
    """Return a streamed reply-text delta."""
    return _stream({"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}})


def _message_start(message_id: str, **usage: int) -> dict[str, Any]:
    """Return a ``message_start`` event carrying ``usage``."""
    return _stream({"type": "message_start", "message": {"id": message_id, "usage": usage}})


@pytest.fixture
def gateway_settings(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Start from settings with no proxy and no keys; tests set what they need."""
    monkeypatch.setattr(cc.settings, "litellm_proxy_url", None)
    monkeypatch.setattr(cc.settings, "litellm_proxy_api_key", None)
    monkeypatch.setattr(cc.settings, "openrouter_api_key", None)
    return monkeypatch


def test_resolve_gateway_prefers_the_proxy(gateway_settings: pytest.MonkeyPatch) -> None:
    """With a proxy configured the turn goes through it and bills under its prefix."""
    gateway_settings.setattr(cc.settings, "litellm_proxy_url", "http://proxy:4000/v1/")
    gateway_settings.setattr(cc.settings, "litellm_proxy_api_key", SecretStr("proxy-key"))
    gateway_settings.setattr(cc.settings, "openrouter_api_key", SecretStr("direct-key"))

    gateway = cc.resolve_gateway("openrouter/deepseek/deepseek-v4.1-flash")

    assert gateway.base_url == "http://proxy:4000"
    assert gateway.auth_token == "proxy-key"
    assert gateway.model == "deepseek/deepseek-v4.1-flash"
    assert gateway.billing_model == "litellm_proxy/deepseek/deepseek-v4.1-flash"


def test_resolve_gateway_falls_back_to_openrouter(gateway_settings: pytest.MonkeyPatch) -> None:
    """Without a proxy the turn uses OpenRouter's Anthropic-format API."""
    gateway_settings.setattr(cc.settings, "openrouter_api_key", SecretStr("direct-key"))

    gateway = cc.resolve_gateway("openrouter/deepseek/deepseek-v4.1-flash")

    assert gateway.base_url == cc.OPENROUTER_ANTHROPIC_BASE_URL
    assert gateway.auth_token == "direct-key"
    assert gateway.billing_model == "openrouter/deepseek/deepseek-v4.1-flash"


def test_resolve_gateway_sends_the_auto_router_direct(gateway_settings: pytest.MonkeyPatch) -> None:
    """The auto router skips the proxy so the served model stays visible."""
    gateway_settings.setattr(cc.settings, "litellm_proxy_url", "http://proxy:4000")
    gateway_settings.setattr(cc.settings, "litellm_proxy_api_key", SecretStr("proxy-key"))
    gateway_settings.setattr(cc.settings, "openrouter_api_key", SecretStr("direct-key"))

    gateway = cc.resolve_gateway("openrouter/openrouter/auto-beta")

    assert gateway.base_url == cc.OPENROUTER_ANTHROPIC_BASE_URL
    assert gateway.auth_token == "direct-key"
    assert gateway.model == "openrouter/auto-beta"


def test_resolve_gateway_auto_router_uses_proxy_without_direct_key(gateway_settings: pytest.MonkeyPatch) -> None:
    """With only a proxy key the auto router still runs, through the proxy."""
    gateway_settings.setattr(cc.settings, "litellm_proxy_url", "http://proxy:4000")
    gateway_settings.setattr(cc.settings, "litellm_proxy_api_key", SecretStr("proxy-key"))

    assert cc.resolve_gateway("openrouter/openrouter/auto-beta").base_url == "http://proxy:4000"


def test_resolve_gateway_explicit_base_url_wins(gateway_settings: pytest.MonkeyPatch) -> None:
    """An explicit gateway overrides both managed endpoints."""
    gateway_settings.setattr(cc.settings, "openrouter_api_key", SecretStr("direct-key"))

    gateway = cc.resolve_gateway("openrouter/openrouter/auto-beta", "http://onprem/v1")

    assert gateway.base_url == "http://onprem"
    assert gateway.billing_model == "openrouter/openrouter/auto-beta"


def test_resolve_gateway_without_a_key_is_a_service_error(gateway_settings: pytest.MonkeyPatch) -> None:
    """A missing credential surfaces as a user-facing error, not a CLI failure."""
    with pytest.raises(ServiceError):
        cc.resolve_gateway("openrouter/deepseek/deepseek-v4.1-flash")


def test_usage_keeps_the_max_per_message_and_sums_messages() -> None:
    """Repeated reports for one call do not double count; separate calls add up."""
    usage = cc.ClaudeCodeUsage(model="bill/model")
    usage.record_message("m1", {"input_tokens": 100, "cache_read_input_tokens": 50, "output_tokens": 1})
    usage.record_message("m1", {"input_tokens": 0, "output_tokens": 40})
    usage.record_message("m2", {"input_tokens": 200, "output_tokens": 10})

    assert usage_by_model_from_history(usage) == {"bill/model": (350, 50)}
    assert usage.usage_totals.calls == 2


def test_usage_adopts_a_larger_final_tally_only() -> None:
    """The end-of-turn figure wins when larger and never shrinks the total."""
    usage = cc.ClaudeCodeUsage(model="bill/model")
    usage.record_message("m1", {"input_tokens": 100, "output_tokens": 40})

    usage.record_result({"vendor/model": {"inputTokens": 10, "outputTokens": 5}})
    assert usage_by_model_from_history(usage) == {"bill/model": (100, 40)}

    usage.record_result({"vendor/model": {"inputTokens": 300, "cacheReadInputTokens": 20, "outputTokens": 60}})
    assert usage_by_model_from_history(usage) == {"bill/model": (320, 60)}


def test_usage_with_no_reports_is_untracked() -> None:
    """A turn that died before any usage arrived bills nothing."""
    assert usage_by_model_from_history(cc.ClaudeCodeUsage(model="bill/model")) is None


def test_decoder_streams_reply_and_reasoning_deltas() -> None:
    """Text and thinking deltas reach their callbacks and build the reply."""
    decoder, _, seen = _decoder()
    decoder.feed(_message_start("m1", input_tokens=10))
    decoder.feed(_stream({"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "hmm"}}))
    decoder.feed(_text_delta("Hel"))
    decoder.feed(_text_delta("lo"))
    decoder.feed({"type": "result", "result": "Hello", "is_error": False})

    assert seen == {"reasoning": ["hmm"], "reply": ["Hel", "lo"], "reset": []}
    assert decoder.final_reply() == "Hello"


def test_decoder_retracts_text_that_preceded_a_tool_call() -> None:
    """A preamble before ``tool_use`` is handed back and excluded from the reply."""
    decoder, _, seen = _decoder()
    decoder.feed(_message_start("m1"))
    decoder.feed(_text_delta("Let me check."))
    decoder.feed(_stream({"type": "content_block_start", "content_block": {"type": "tool_use"}}))
    decoder.feed(_message_start("m2"))
    decoder.feed(_text_delta("Done."))

    assert seen["reset"] == ["Let me check."]
    assert decoder.final_reply() == "Done."


def test_decoder_falls_back_to_the_assembled_message_when_nothing_streamed() -> None:
    """A non-streamed answer is emitted once from the ``assistant`` event."""
    decoder, usage, seen = _decoder()
    decoder.feed(_message_start("m1"))
    message = {
        "id": "m1",
        "model": "vendor/served",
        "usage": {"input_tokens": 7, "output_tokens": 3},
        "content": [{"type": "thinking", "thinking": "plan"}, {"type": "text", "text": "Answer"}],
    }
    decoder.feed({"type": "assistant", "message": message})

    assert seen["reply"] == ["Answer"]
    assert seen["reasoning"] == ["plan"]
    assert usage.last_response_model == "vendor/served"
    assert usage_by_model_from_history(usage) == {"bill/model": (7, 3)}


def test_decoder_does_not_repeat_streamed_text_from_the_assembled_message() -> None:
    """Text that already streamed is not emitted again."""
    decoder, _, seen = _decoder()
    decoder.feed(_message_start("m1"))
    decoder.feed(_text_delta("Answer"))
    decoder.feed({"type": "assistant", "message": {"id": "m1", "content": [{"type": "text", "text": "Answer"}]}})

    assert seen["reply"] == ["Answer"]


def test_decoder_ignores_synthetic_messages() -> None:
    """The CLI's own placeholder messages are neither reply nor served model."""
    decoder, usage, seen = _decoder()
    message = {"id": "s", "model": "<synthetic>", "content": [{"type": "text", "text": "No response requested."}]}
    decoder.feed({"type": "assistant", "message": message})

    assert seen["reply"] == []
    assert usage.last_response_model is None


def test_final_reply_raises_the_cli_error_text() -> None:
    """A failed turn surfaces the CLI's message."""
    decoder, _, _ = _decoder()
    decoder.feed({"type": "result", "is_error": True, "result": "API Error: 401", "subtype": "success"})

    with pytest.raises(cc.ClaudeCodeError, match="401"):
        decoder.final_reply()


def test_final_reply_keeps_the_text_written_before_the_turn_cap() -> None:
    """Hitting ``max_turns`` after writing a reply still shows that reply."""
    decoder, _, _ = _decoder()
    decoder.feed(_message_start("m1"))
    decoder.feed(_text_delta("Partial answer"))
    decoder.feed({"type": "result", "is_error": True, "subtype": "error_max_turns"})

    assert decoder.final_reply() == "Partial answer"


def test_final_reply_without_any_output_raises() -> None:
    """A process that ends silently is an error, not an empty reply."""
    decoder, _, _ = _decoder()
    with pytest.raises(cc.ClaudeCodeError):
        decoder.final_reply()


def test_served_model_is_reported_only_when_it_differs() -> None:
    """An echoed request id is not news; a router's concrete pick is."""
    usage = cc.ClaudeCodeUsage(model="bill/model", last_request_model="openrouter/auto-beta")
    usage.last_response_model = "openrouter/auto-beta"
    assert served_model_from(usage) is None
    usage.last_response_model = "deepseek/deepseek-v4-flash"
    assert served_model_from(usage) == "deepseek/deepseek-v4-flash"


def test_build_env_points_the_cli_at_the_gateway(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Gateway values are set and credentials of a parent session are dropped."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "personal-key")
    monkeypatch.setenv("CLAUDECODE", "1")

    env = cc._build_env(
        _gateway(),
        tmp_path,
        reasoning_effort="minimal",
        request_timeout_seconds=90,
        tool_timeout_seconds=30,
        extra_body={"session_id": "conv-1"},
    )

    assert env["ANTHROPIC_BASE_URL"] == "http://gateway.test"
    assert env["ANTHROPIC_AUTH_TOKEN"] == "secret-token"
    assert env["ANTHROPIC_MODEL"] == env["ANTHROPIC_SMALL_FAST_MODEL"] == "vendor/model"
    assert env["CLAUDE_CONFIG_DIR"] == str(tmp_path)
    assert env["API_TIMEOUT_MS"] == "90000"
    assert env["MCP_TOOL_TIMEOUT"] == "30000"
    assert env["CLAUDE_CODE_EFFORT_LEVEL"] == "low"
    assert json.loads(env["CLAUDE_CODE_EXTRA_BODY"]) == {"session_id": "conv-1"}
    assert "ANTHROPIC_API_KEY" not in env
    assert "CLAUDECODE" not in env


@pytest.mark.parametrize(
    ("effort", "expected"),
    [(None, {}), ("none", {"CLAUDE_CODE_DISABLE_THINKING": "1"}), ("xhigh", {"CLAUDE_CODE_EFFORT_LEVEL": "xhigh"})],
)
def test_build_env_maps_reasoning_effort(tmp_path: Path, effort: str | None, expected: dict[str, str]) -> None:
    """Effort levels map onto the CLI's two thinking controls; unset leaves both alone."""
    env = cc._build_env(
        _gateway(),
        tmp_path,
        reasoning_effort=effort,
        request_timeout_seconds=90,
        tool_timeout_seconds=30,
        extra_body=None,
    )

    controls = {k: v for k, v in env.items() if k in ("CLAUDE_CODE_DISABLE_THINKING", "CLAUDE_CODE_EFFORT_LEVEL")}
    assert controls == expected
    assert "CLAUDE_CODE_EXTRA_BODY" not in env


def _bridge_tool(name: str, handler: Any) -> cc.BridgeTool:
    """Return a bridge tool taking one optional string argument."""
    schema = {"type": "object", "properties": {"q": {"type": "string"}}}
    return cc.BridgeTool(name=name, description=f"{name} tool", input_schema=schema, handler=handler)


def _client(bridge: cc.ToolBridge, token: str | None = None) -> Client:
    """Return an MCP client for ``bridge`` presenting ``token`` (default: the right one)."""
    headers = {"Authorization": f"Bearer {token or bridge.token}"}
    return Client(StreamableHttpTransport(bridge.url, headers=headers))


@pytest.mark.asyncio
async def test_bridge_serves_tools_with_their_schema_and_results() -> None:
    """Tools are listed under their upstream schema; results come back as text."""

    async def echo(arguments: dict[str, Any]) -> Any:
        """Return the arguments as a structured result."""
        return {"got": arguments}

    async with cc.serve_tool_bridge([_bridge_tool("echo", echo)]) as bridge, _client(bridge) as client:
        listed = await client.list_tools()
        result = await client.call_tool("echo", {"q": "שלום"})

    assert [tool.name for tool in listed] == ["echo"]
    assert listed[0].inputSchema["properties"] == {"q": {"type": "string"}}
    assert json.loads(result.content[0].text) == {"got": {"q": "שלום"}}
    assert "שלום" in result.content[0].text


@pytest.mark.asyncio
async def test_bridge_reports_a_failing_tool_as_text() -> None:
    """A handler exception becomes the observation the model reads."""

    async def boom(arguments: dict[str, Any]) -> Any:
        """Fail the way a rejected backend call does."""
        raise RuntimeError("HTTP 422: bad column")

    async with cc.serve_tool_bridge([_bridge_tool("boom", boom)]) as bridge, _client(bridge) as client:
        result = await client.call_tool("boom", {})

    assert result.content[0].text == "Execution error in boom: HTTP 422: bad column"


@pytest.mark.asyncio
async def test_bridge_rejects_a_wrong_token() -> None:
    """Another local process without the turn's token cannot reach the tools."""

    async def never(arguments: dict[str, Any]) -> Any:
        """Fail the test if the gate lets a call through."""
        raise AssertionError("handler reached without the token")

    async with cc.serve_tool_bridge([_bridge_tool("never", never)]) as bridge:
        with pytest.raises(Exception, match=r"401|Unauthorized"):
            async with _client(bridge, token="wrong") as client:
                await client.list_tools()


@pytest.mark.asyncio
async def test_bridge_runs_calls_one_at_a_time() -> None:
    """Concurrent calls from the model are serialized."""
    running = 0
    peak = 0

    async def slow(arguments: dict[str, Any]) -> Any:
        """Record how many handlers overlap."""
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.05)
        running -= 1
        return "ok"

    async with cc.serve_tool_bridge([_bridge_tool("slow", slow)]) as bridge, _client(bridge) as client:
        await asyncio.gather(*(client.call_tool("slow", {}) for _ in range(3)))

    assert peak == 1


@pytest.mark.asyncio
async def test_bridge_teardown_cancels_a_call_still_waiting() -> None:
    """Closing the bridge releases a handler parked on an approval."""
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def parked(arguments: dict[str, Any]) -> Any:
        """Wait forever, as a tool awaiting approval would."""
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    async with cc.serve_tool_bridge([_bridge_tool("parked", parked)]) as bridge:
        client = _client(bridge)
        await client.__aenter__()
        call = asyncio.create_task(client.call_tool("parked", {}))
        await asyncio.wait_for(started.wait(), 5)
    await asyncio.wait_for(cancelled.wait(), 5)
    call.cancel()
    await asyncio.gather(call, return_exceptions=True)


_FAKE_CLI = """\
    #!{python}
    import json, os, sys
    record = {{
        "argv": sys.argv[1:],
        "stdin": sys.stdin.read(),
        "env": {{k: os.environ.get(k) for k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_EXTRA_BODY")}},
        "mcp": json.load(open(sys.argv[sys.argv.index("--mcp-config") + 1])),
        "system": open(sys.argv[sys.argv.index("--system-prompt-file") + 1], encoding="utf-8").read(),
    }}
    json.dump(record, open({record!r}, "w", encoding="utf-8"))
    for event in json.load(open({events!r}, encoding="utf-8")):
        print(json.dumps(event), flush=True)
    sys.exit({exit_code})
"""


def _install_fake_cli(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, events: list[dict[str, Any]], exit_code: int = 0
) -> Path:
    """Replace the CLI with a script that replays ``events`` and records its inputs.

    Args:
        tmp_path: Directory for the script and its record file.
        monkeypatch: Used to point the harness at the script.
        events: ``stream-json`` events the script prints.
        exit_code: Exit status of the script.

    Returns:
        Path of the JSON file the script writes its argv, stdin and env to.
    """
    record = tmp_path / "record.json"
    events_file = tmp_path / "events.json"
    events_file.write_text(json.dumps(events), encoding="utf-8")
    script = tmp_path / "fake-claude"
    script.write_text(
        textwrap.dedent(_FAKE_CLI).format(
            python=sys.executable, record=str(record), events=str(events_file), exit_code=exit_code
        ),
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(cc, "CLAUDE_BINARY", str(script))
    return record


async def _run_turn(usage: cc.ClaudeCodeUsage, seen: dict[str, list[str]], **kwargs: Any) -> str:
    """Run one harness turn against whatever CLI is installed.

    Args:
        usage: Accumulator for the turn.
        seen: Lists the ``reply`` and ``reset`` callbacks append to.
        **kwargs: Extra arguments for ``run_claude_code_turn``.

    Returns:
        The turn's reply.
    """
    return await cc.run_claude_code_turn(
        system_prompt="SYSTEM שלום",
        user_prompt="USER שלום",
        gateway=_gateway(),
        bridge=cc.ToolBridge(url="http://127.0.0.1:1/mcp", token="bridge-token"),
        usage=usage,
        on_reasoning=lambda chunk: None,
        on_reply=seen["reply"].append,
        on_reply_reset=seen["reset"].append,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_turn_drives_the_cli_and_returns_its_reply(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The CLI gets the prompts, the bridge config and the gateway; its stream is decoded."""
    events = [
        _message_start("m1", input_tokens=12),
        _text_delta("Hi "),
        _text_delta("there"),
        {"type": "assistant", "message": {"id": "m1", "model": "vendor/served", "usage": {"output_tokens": 4}}},
        {"type": "result", "is_error": False, "result": "Hi there"},
    ]
    record_path = _install_fake_cli(tmp_path, monkeypatch, events)
    usage = cc.ClaudeCodeUsage(model="bill/model")
    seen: dict[str, list[str]] = {"reply": [], "reset": []}

    reply = await _run_turn(usage, seen, extra_body={"session_id": "conv-1"})

    record = json.loads(record_path.read_text(encoding="utf-8"))
    assert reply == "Hi there"
    assert seen["reply"] == ["Hi ", "there"]
    assert record["stdin"] == "USER שלום"
    assert record["system"] == "SYSTEM שלום"
    assert record["env"]["ANTHROPIC_BASE_URL"] == "http://gateway.test"
    assert record["env"]["ANTHROPIC_AUTH_TOKEN"] == "secret-token"
    assert json.loads(record["env"]["CLAUDE_CODE_EXTRA_BODY"]) == {"session_id": "conv-1"}
    server = record["mcp"]["mcpServers"][cc.MCP_SERVER_NAME]
    assert server == {
        "type": "http",
        "url": "http://127.0.0.1:1/mcp",
        "headers": {"Authorization": "Bearer bridge-token"},
    }
    argv = record["argv"]
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--model") + 1] == "vendor/model"
    assert "--strict-mcp-config" in argv
    assert "secret-token" not in " ".join(argv)
    assert usage_by_model_from_history(usage) == {"bill/model": (12, 4)}
    assert served_model_from(usage) == "vendor/served"


@pytest.mark.asyncio
async def test_turn_raises_when_the_cli_reports_an_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed CLI run raises with the CLI's message."""
    events = [{"type": "result", "is_error": True, "result": "API Error: 401 Missing Authentication header"}]
    _install_fake_cli(tmp_path, monkeypatch, events, exit_code=1)

    with pytest.raises(cc.ClaudeCodeError, match="401"):
        await _run_turn(cc.ClaudeCodeUsage(model="bill/model"), {"reply": [], "reset": []})


@pytest.mark.asyncio
async def test_turn_reports_a_missing_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    """A server without the CLI fails with a clear message."""
    monkeypatch.setattr(cc, "CLAUDE_BINARY", str(Path(os.sep, "nonexistent", "claude")))

    with pytest.raises(cc.ClaudeCodeError, match="not installed"):
        await _run_turn(cc.ClaudeCodeUsage(model="bill/model"), {"reply": [], "reset": []})


@pytest.mark.asyncio
async def test_cancelling_a_turn_kills_the_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Cancellation terminates the subprocess instead of orphaning it."""
    pid_file = tmp_path / "pid"
    script = tmp_path / "hang-claude"
    script.write_text(
        f"#!{sys.executable}\nimport os, sys, time\nsys.stdin.read()\n"
        f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\ntime.sleep(600)\n",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(cc, "CLAUDE_BINARY", str(script))

    task = asyncio.create_task(_run_turn(cc.ClaudeCodeUsage(model="bill/model"), {"reply": [], "reset": []}))
    for _ in range(100):
        if pid_file.exists() and pid_file.read_text():
            break
        await asyncio.sleep(0.05)
    pid = int(pid_file.read_text())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
