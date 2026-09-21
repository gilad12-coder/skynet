"""Tests for the generalist agent's turn on the Claude Code harness."""

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
from pydantic import SecretStr

from ...models import ModelConfig
from ..agents import claude_code as cc
from ..agents import generalist as generalist_module
from ..agents.generalist import (
    ApprovalRegistry,
    WizardState,
    _bridge_tool,
    _build_user_prompt,
    _retract_reply,
    approval_key,
    run_generalist_agent,
)
from ..language_models import usage_by_model_from_history
from .test_generalist_agent import _make_fake_tool

# Stands in for the ``claude`` binary: connects to the bridge named in the MCP
# config like the real CLI, calls the tools listed in FAKE_CLI_CALLS, and
# replies with what it saw.
_FAKE_CLI = """\
    #!{python}
    import asyncio, json, os, sys
    from fastmcp import Client
    from fastmcp.client.transports import StreamableHttpTransport

    server = json.load(open(sys.argv[sys.argv.index("--mcp-config") + 1]))["mcpServers"]["app"]
    prompt = sys.stdin.read()
    if os.environ.get("FAKE_CLI_PID_FILE"):
        open(os.environ["FAKE_CLI_PID_FILE"], "w").write(str(os.getpid()))

    async def main():
        async with Client(StreamableHttpTransport(server["url"], headers=server["headers"])) as client:
            listed = sorted(tool.name for tool in await client.list_tools())
            results = []
            for name in {calls!r}:
                outcome = await client.call_tool(name, {{}}, raise_on_error=False)
                results.append(outcome.content[0].text)
        settings = {{k: v for k, v in os.environ.items() if k.startswith("CLAUDE_CODE_")}}
        return {{"listed": listed, "results": results, "prompt": prompt, "settings": settings}}

    reply = json.dumps(asyncio.run(main()), ensure_ascii=False)
    events = [
        {{"type": "stream_event", "event": {{"type": "message_start", "message": {{"id": "m1", "usage": {{"input_tokens": 9}}}}}}}},
        {{"type": "stream_event", "event": {{"type": "content_block_delta", "delta": {{"type": "text_delta", "text": reply}}}}}},
        {{"type": "assistant", "message": {{"id": "m1", "model": "vendor/served", "usage": {{"output_tokens": 5}}}}}},
        {{"type": "result", "is_error": False, "result": reply}},
    ]
    for event in events:
        print(json.dumps(event), flush=True)
"""


def _upstream_tool(name: str, result: str) -> cc.BridgeTool:
    """Return an app-side MCP tool that answers ``result``."""

    async def handler(arguments: dict[str, Any]) -> Any:
        """Answer with the canned result."""
        return result

    schema = {"type": "object", "properties": {}}
    return cc.BridgeTool(name=name, description=f"{name} tool", input_schema=schema, handler=handler)


def _install_fake_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, calls: list[str]) -> None:
    """Point the harness at a fake CLI that calls ``calls`` through the bridge."""
    script = tmp_path / "fake-claude"
    script.write_text(textwrap.dedent(_FAKE_CLI).format(python=sys.executable, calls=calls), encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(cc, "CLAUDE_BINARY", str(script))
    monkeypatch.setattr(cc.settings, "litellm_proxy_url", "http://proxy.test")
    monkeypatch.setattr(cc.settings, "litellm_proxy_api_key", SecretStr("proxy-key"))
    monkeypatch.setattr(cc.settings, "openrouter_api_key", None)


def test_every_tool_name_fits_the_provider_limit_once_prefixed() -> None:
    """Providers reject tool names over 64 characters; the CLI adds the server prefix."""
    names = {
        name
        for constant, value in vars(generalist_module).items()
        if constant.endswith("_TOOLS") and isinstance(value, frozenset)
        for name in value
    }
    prefix = f"mcp__{cc.MCP_SERVER_NAME}__"

    assert "blackbox_scorer_dry_run_blackbox_scorer_dry_run_post" in names
    assert [name for name in names if len(prefix + name) > 64] == []


def test_user_prompt_tags_every_input_and_restates_the_language() -> None:
    """Each turn input gets its own section, Hebrew intact, language last."""
    prompt = _build_user_prompt(
        wizard_state=WizardState(job_name="ריצה"),
        memory_context="likes short answers",
        chat_history=[{"role": "user", "content": "שלום"}],
        user_message="מה הלאה?",
        reply_language="Hebrew",
    )

    assert '<wizard_state>\n{"job_name": "ריצה"}\n</wizard_state>' in prompt
    assert "<memory_context>\nlikes short answers\n</memory_context>" in prompt
    assert '"content": "שלום"' in prompt
    assert "<user_message>\nמה הלאה?\n</user_message>" in prompt
    assert prompt.endswith("Write your final message in Hebrew.")


@pytest.mark.asyncio
async def test_bridge_tool_brackets_the_call_with_status_lines() -> None:
    """The arguments the model set reach the tool, nulls dropped, between the status lines."""
    events: list[dict] = []
    seen: dict[str, Any] = {}

    async def body(**kwargs: Any) -> str:
        """Record the arguments and emit a marker between the status lines."""
        seen.update(kwargs)
        events.append({"event": "ran"})
        return "done"

    tool = _make_fake_tool("list_models_for_agent")
    tool.func._async_body = body
    spec = type("Spec", (), {"name": "list_models_for_agent", "description": None, "inputSchema": None})()

    bridged = _bridge_tool(spec, tool, events.append)

    assert await bridged.handler({"q": "x", "model_config": None}) == "done"
    assert seen == {"q": "x"}
    assert [event["event"] for event in events] == ["status_patch", "ran", "status_patch"]
    assert bridged.description == ""
    assert bridged.input_schema == {"type": "object", "properties": {}}


@pytest.mark.asyncio
async def test_bridge_tool_closes_the_status_line_when_the_call_fails() -> None:
    """A failing call still emits its end status and propagates to the bridge."""
    events: list[dict] = []

    async def body(**kwargs: Any) -> str:
        """Fail like a rejected backend call."""
        raise RuntimeError("HTTP 422")

    tool = _make_fake_tool("list_models_for_agent")
    tool.func._async_body = body
    spec = type("Spec", (), {"name": "list_models_for_agent", "description": "d", "inputSchema": {"type": "object"}})()

    with pytest.raises(RuntimeError):
        await _bridge_tool(spec, tool, events.append).handler({})

    assert [event["event"] for event in events] == ["status_patch", "status_patch"]


def test_retract_reply_clears_the_bubble_then_files_the_text_as_reasoning() -> None:
    """The reset comes first so the client never shows the preamble twice."""
    events: list[dict] = []

    _retract_reply(events.append, "Let me check.")

    assert events == [
        {"event": "message_reset", "data": {}},
        {"event": "reasoning_patch", "data": {"chunk": "Let me check.\n"}},
    ]


@pytest.mark.asyncio
async def test_turn_phases_tools_gates_approvals_and_meters(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A full turn: only phased tools reach the CLI, a gated call waits for its owner, usage is billed."""
    _install_fake_cli(tmp_path, monkeypatch, ["list_models_for_agent", "delete_job_optimizations"])
    registry = ApprovalRegistry()
    usage_sink: list = []
    upstream = [
        _upstream_tool("list_models_for_agent", "models"),
        _upstream_tool("delete_job_optimizations", "deleted"),
        _upstream_tool("submit_job_run_post", "submitted"),
    ]
    events: list[dict] = []

    async with cc.serve_tool_bridge(upstream) as app_mcp:
        stream = run_generalist_agent(
            wizard_state=WizardState(),
            chat_history=[],
            user_message="מחק את הריצה",
            trust_mode="ask",
            mcp_url=app_mcp.url,
            model_config=ModelConfig(name="openrouter/vendor/model"),
            approval_registry=registry,
            auth_header=f"Bearer {app_mcp.token}",
            locale="he",
            usage_sink=usage_sink,
            approval_owner="alice",
        )
        async for event in stream:
            events.append(event)
            if event["event"] == "pending_approval":
                assert registry.resolve(event["data"]["id"], True) is False
                assert registry.resolve(approval_key(event["data"]["id"], "alice"), True) is True

    names = [event["event"] for event in events]
    done = events[-1]
    assert done["event"] == "done", events[-1]
    reply = json.loads(done["data"]["assistant_message"])
    assert reply["listed"] == ["delete_job_optimizations", "list_models_for_agent"]
    assert reply["results"] == ["models", "deleted"]
    assert "<user_message>\nמחק את הריצה\n</user_message>" in reply["prompt"]
    assert reply["prompt"].endswith("Write your final message in Hebrew.")
    assert done["data"]["model"] == "openrouter/vendor/model"
    assert done["data"]["served_model"] == "vendor/served"
    metadata = next(event for event in events if event["event"] == "turn_metadata")
    assert metadata["data"]["allowed_tools"] == ["delete_job_optimizations", "list_models_for_agent"]
    assert names.count("pending_approval") == 1
    assert names.count("tool_start") == 2
    assert names.count("status_patch") == 4
    assert "message_patch" in names
    assert usage_by_model_from_history(usage_sink[0]) == {"litellm_proxy/vendor/model": (9, 5)}


@pytest.mark.asyncio
async def test_turn_forwards_the_model_settings_to_the_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Temperature, the output cap and the reasoning level of the model config all reach the CLI."""
    _install_fake_cli(tmp_path, monkeypatch, [])
    config = ModelConfig(
        name="openrouter/vendor/model", temperature=0.3, max_tokens=512, extra={"reasoning_effort": "high"}
    )

    async with cc.serve_tool_bridge([_upstream_tool("list_models_for_agent", "models")]) as app_mcp:
        stream = run_generalist_agent(
            wizard_state=WizardState(),
            chat_history=[],
            user_message="hello",
            trust_mode="ask",
            mcp_url=app_mcp.url,
            model_config=config,
            approval_registry=ApprovalRegistry(),
            auth_header=f"Bearer {app_mcp.token}",
            locale="en",
        )
        events = [event async for event in stream]

    assert events[-1]["event"] == "done", events[-1]
    settings = json.loads(events[-1]["data"]["assistant_message"])["settings"]
    assert json.loads(settings["CLAUDE_CODE_EXTRA_BODY"]) == {"temperature": 0.3}
    assert settings["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == "512"
    assert settings["CLAUDE_CODE_EFFORT_LEVEL"] == "high"


@pytest.mark.asyncio
async def test_declined_approval_reaches_the_model_as_the_tool_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Declining a gated call does not run it; the model reads the refusal."""
    _install_fake_cli(tmp_path, monkeypatch, ["delete_job_optimizations"])
    registry = ApprovalRegistry()
    ran: list[str] = []

    async def delete(arguments: dict[str, Any]) -> Any:
        """Record that the destructive call ran."""
        ran.append("delete")
        return "deleted"

    schema = {"type": "object", "properties": {}}
    upstream = [cc.BridgeTool(name="delete_job_optimizations", description="", input_schema=schema, handler=delete)]
    events: list[dict] = []

    async with cc.serve_tool_bridge(upstream) as app_mcp:
        stream = run_generalist_agent(
            wizard_state=WizardState(),
            chat_history=[],
            user_message="delete it",
            mcp_url=app_mcp.url,
            model_config=ModelConfig(name="openrouter/vendor/model"),
            approval_registry=registry,
            auth_header=f"Bearer {app_mcp.token}",
        )
        async for event in stream:
            events.append(event)
            if event["event"] == "pending_approval":
                registry.resolve(event["data"]["id"], False)

    assert events[-1]["event"] == "done", events[-1]
    assert ran == []
    assert json.loads(events[-1]["data"]["assistant_message"])["results"] != ["deleted"]


@pytest.mark.asyncio
async def test_missing_gateway_key_is_a_clean_error_event(monkeypatch: pytest.MonkeyPatch) -> None:
    """A server with no LLM credential tells the user instead of crashing the stream."""
    monkeypatch.setattr(cc.settings, "litellm_proxy_url", None)
    monkeypatch.setattr(cc.settings, "litellm_proxy_api_key", None)
    monkeypatch.setattr(cc.settings, "openrouter_api_key", None)

    stream = run_generalist_agent(wizard_state=WizardState(), chat_history=[], user_message="hi")
    events = [event async for event in stream]

    assert [event["event"] for event in events] == ["error"]
    assert set(events[0]["data"]) == {"error"}


@pytest.mark.asyncio
async def test_closing_the_stream_cancels_the_turn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A dropped SSE stream stops the turn while a call is parked on an approval."""
    _install_fake_cli(tmp_path, monkeypatch, ["delete_job_optimizations"])
    pid_file = tmp_path / "pid"
    monkeypatch.setenv("FAKE_CLI_PID_FILE", str(pid_file))
    upstream = [_upstream_tool("delete_job_optimizations", "deleted")]

    async with cc.serve_tool_bridge(upstream) as app_mcp:
        stream = run_generalist_agent(
            wizard_state=WizardState(),
            chat_history=[],
            user_message="delete it",
            mcp_url=app_mcp.url,
            model_config=ModelConfig(name="openrouter/vendor/model"),
            approval_registry=ApprovalRegistry(),
            auth_header=f"Bearer {app_mcp.token}",
        )
        consumer = asyncio.ensure_future(_consume_until(stream, "pending_approval"))
        await asyncio.wait_for(consumer, 30)
        await stream.aclose()
        pid = int(pid_file.read_text())
        for _ in range(100):
            if not _alive(pid):
                break
            await asyncio.sleep(0.05)

    assert not _alive(pid)


def _alive(pid: int) -> bool:
    """Report whether process ``pid`` still exists."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def _consume_until(stream: Any, name: str) -> None:
    """Pull events from ``stream`` until one named ``name`` arrives."""
    async for event in stream:
        if event["event"] == name:
            return
