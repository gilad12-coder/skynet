"""Adapters that drive the four command-line agent harnesses.

Each adapter runs the harness's headless mode in a clean, isolated config
directory (so no personal instructions, hooks or plugins leak in), with its
built-in coding tools switched off and only the benchmark world's tools
available, then parses the harness's own JSON event stream.
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from bench.harnesses.base import MODEL, Attempt

PI_EXTENSION = Path(__file__).resolve().parent / "pi_ext" / "skynet-tools.ts"

OPENCODE_BUILTINS = [
    "bash", "edit", "write", "read", "grep", "glob", "list", "patch", "webfetch",
    "websearch", "todowrite", "todoread", "task", "skill", "lsp",
]  # fmt: skip

# Variables set by an enclosing Claude Code session; a nested headless run
# must not inherit them.
_STRIP_ENV = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY")

_OPENCODE_FIRST_USE = threading.Lock()


def _events(stdout: str) -> Iterator[dict[str, Any]]:
    """Yield the JSON objects of a JSON-lines stream, skipping any other lines."""
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def _execute(cmd: list[str], env: dict[str, str], workdir: Path, timeout: int) -> tuple[str, str]:
    """Run a harness command and keep its raw output next to the attempt.

    Args:
        cmd: The command line.
        env: Extra environment variables.
        workdir: The attempt directory; also the harness's working directory.
        timeout: Seconds before the harness is killed.

    Returns:
        ``(stdout, error)`` where ``error`` is empty on a clean exit.
    """
    full_env = {k: v for k, v in os.environ.items() if k not in _STRIP_ENV}
    full_env.update(env)
    cwd = workdir / "cwd"
    cwd.mkdir(parents=True, exist_ok=True)
    # subprocess changes the directory but not PWD, and opencode resolves its project from PWD.
    full_env["PWD"] = str(cwd)
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            env=full_env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        stdout, stderr, error = proc.stdout, proc.stderr, "" if proc.returncode == 0 else f"exit {proc.returncode}"
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        error = f"timeout after {timeout}s"
    (workdir / "stdout.jsonl").write_text(stdout)
    (workdir / "stderr.log").write_text(stderr)
    return stdout, error


def run_claude_code(message: str, brief: str, port: int, workdir: Path, home: Path, key: str, timeout: int) -> Attempt:
    """Run Claude Code headless against the world's MCP endpoint.

    Args:
        message: The user message.
        brief: The shared system prompt.
        port: Port of the attempt's world server.
        workdir: Directory for this attempt's files.
        home: Clean config directory shared by this harness's attempts.
        key: OpenRouter API key.
        timeout: Seconds before the harness is killed.

    Returns:
        The parsed attempt.
    """
    mcp_config = workdir / "mcp.json"
    mcp_config.write_text(
        json.dumps({"mcpServers": {"skynet": {"type": "http", "url": f"http://127.0.0.1:{port}/mcp"}}})
    )
    env = {
        "CLAUDE_CONFIG_DIR": str(home),
        "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
        "ANTHROPIC_AUTH_TOKEN": key,
        "ANTHROPIC_API_KEY": "",
        "ANTHROPIC_MODEL": MODEL,
        "ANTHROPIC_SMALL_FAST_MODEL": MODEL,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": MODEL,
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_TELEMETRY": "1",
    }
    cmd = [
        "claude", "-p", message, "--system-prompt", brief, "--mcp-config", str(mcp_config),
        "--strict-mcp-config", "--tools", "", "--setting-sources", "", "--permission-mode",
        "bypassPermissions", "--no-session-persistence", "--output-format", "stream-json", "--verbose",
    ]  # fmt: skip
    stdout, error = _execute(cmd, env, workdir, timeout)
    attempt = Attempt(error=error)
    for event in _events(stdout):
        if event.get("type") != "result":
            continue
        attempt.answer = event.get("result") or ""
        attempt.llm_calls = event.get("num_turns") or 0
        for usage in (event.get("modelUsage") or {}).values():
            attempt.fresh_input_tokens += usage.get("inputTokens", 0) + usage.get("cacheCreationInputTokens", 0)
            attempt.cached_input_tokens += usage.get("cacheReadInputTokens", 0)
            attempt.output_tokens += usage.get("outputTokens", 0)
        if event.get("is_error") and not attempt.error:
            attempt.error = str(event.get("subtype") or "error")
    return attempt


def run_codex(message: str, brief: str, port: int, workdir: Path, home: Path, key: str, timeout: int) -> Attempt:
    """Run Codex headless against the world's MCP endpoint.

    Args:
        message: The user message.
        brief: The shared system prompt.
        port: Port of the attempt's world server.
        workdir: Directory for this attempt's files.
        home: Clean ``CODEX_HOME`` shared by this harness's attempts.
        key: OpenRouter API key.
        timeout: Seconds before the harness is killed.

    Returns:
        The parsed attempt.
    """
    brief_file = home / "brief.md"
    brief_file.write_text(brief)
    (home / "config.toml").write_text(
        f'model = "{MODEL}"\n'
        'model_provider = "openrouter"\n'
        'approval_policy = "never"\n'
        'sandbox_mode = "read-only"\n'
        f'model_instructions_file = "{brief_file}"\n\n'
        "[model_providers.openrouter]\n"
        'name = "OpenRouter"\n'
        'base_url = "https://openrouter.ai/api/v1"\n'
        'env_key = "OPENROUTER_API_KEY"\n'
        'wire_api = "responses"\n'
    )
    # The MCP server is passed per call so concurrent attempts, each with its
    # own port, can share one CODEX_HOME.
    cmd = [
        "codex", "exec", "--json", "--skip-git-repo-check", "--ephemeral",
        "-c", f'mcp_servers.skynet.url="http://127.0.0.1:{port}/mcp"',
        "-c", 'mcp_servers.skynet.default_tools_approval_mode="approve"',
        message,
    ]  # fmt: skip
    stdout, error = _execute(cmd, {"CODEX_HOME": str(home), "OPENROUTER_API_KEY": key}, workdir, timeout)
    attempt = Attempt(error=error)
    for event in _events(stdout):
        kind = event.get("type")
        item = event.get("item") or {}
        if kind == "item.completed" and item.get("type") == "agent_message":
            attempt.answer = item.get("text") or ""
        elif kind == "turn.completed":
            usage = event.get("usage") or {}
            cached = usage.get("cached_input_tokens", 0)
            attempt.fresh_input_tokens += usage.get("input_tokens", 0) - cached
            attempt.cached_input_tokens += cached
            attempt.output_tokens += usage.get("output_tokens", 0)
        elif kind in ("error", "turn.failed") and not attempt.error:
            attempt.error = json.dumps(event.get("error") or event.get("message") or event)[:300]
    attempt.llm_calls = sum(
        1
        for e in _events(stdout)
        if e.get("type") == "item.completed" and (e.get("item") or {}).get("type") in ("mcp_tool_call", "agent_message")
    )
    return attempt


def run_pi(message: str, brief: str, port: int, workdir: Path, home: Path, key: str, timeout: int) -> Attempt:
    """Run Pi headless with the extension that bridges the world's tools.

    Args:
        message: The user message.
        brief: The shared system prompt.
        port: Port of the attempt's world server.
        workdir: Directory for this attempt's files.
        home: Clean Pi agent directory shared by this harness's attempts.
        key: OpenRouter API key.
        timeout: Seconds before the harness is killed.

    Returns:
        The parsed attempt.
    """
    env = {
        "PI_CODING_AGENT_DIR": str(home),
        "PI_OFFLINE": "1",
        "SKYNET_WORLD_URL": f"http://127.0.0.1:{port}",
        "OPENROUTER_API_KEY": key,
    }
    cmd = [
        "pi", "-p", "--mode", "json", "--no-session", "--provider", "openrouter", "--model", MODEL,
        "--system-prompt", brief, "-nbt", "-ne", "-e", str(PI_EXTENSION), "-ns", "-nc", "-np",
        "--no-themes", message,
    ]  # fmt: skip
    stdout, error = _execute(cmd, env, workdir, timeout)
    attempt = Attempt(error=error)
    for event in _events(stdout):
        if event.get("type") != "agent_end":
            continue
        for msg in event.get("messages") or []:
            if msg.get("role") != "assistant":
                continue
            usage = msg.get("usage") or {}
            attempt.llm_calls += 1
            attempt.fresh_input_tokens += usage.get("input", 0) + usage.get("cacheWrite", 0)
            attempt.cached_input_tokens += usage.get("cacheRead", 0)
            attempt.output_tokens += usage.get("output", 0)
            text = "".join(p.get("text", "") for p in msg.get("content") or [] if p.get("type") == "text")
            if text.strip():
                attempt.answer = text
            if msg.get("stopReason") == "error" and not attempt.error:
                attempt.error = str(msg.get("errorMessage") or "model error")[:300]
    return attempt


def run_opencode(message: str, brief: str, port: int, workdir: Path, home: Path, key: str, timeout: int) -> Attempt:
    """Run opencode headless against the world's MCP endpoint.

    Args:
        message: The user message.
        brief: The shared system prompt.
        port: Port of the attempt's world server.
        workdir: Directory for this attempt's files.
        home: Clean XDG root shared by this harness's attempts.
        key: OpenRouter API key.
        timeout: Seconds before the harness is killed.

    Returns:
        The parsed attempt.
    """
    config = {
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": False,
        "share": "disabled",
        "model": f"openrouter/{MODEL}",
        "provider": {"openrouter": {"models": {MODEL: {}}}},
        "mcp": {"skynet": {"type": "remote", "url": f"http://127.0.0.1:{port}/mcp", "enabled": True}},
        "permission": {"*": "allow"},
        "agent": {
            "skynet": {"mode": "primary", "prompt": brief, "tools": dict.fromkeys(OPENCODE_BUILTINS, False)},
        },
    }
    cwd = workdir / "cwd"
    cwd.mkdir(parents=True, exist_ok=True)
    (cwd / "opencode.json").write_text(json.dumps(config, ensure_ascii=False, indent=1))
    env = {f"XDG_{part.upper()}_HOME": str(home / part) for part in ("config", "data", "cache", "state")}
    for path in env.values():
        Path(path).mkdir(parents=True, exist_ok=True)
    env.update({"OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENROUTER_API_KEY": key})
    cmd = ["opencode", "run", "--agent", "skynet", "--format", "json", message]
    warm = home / ".warm"
    # opencode installs its plugins on first use of a home, and two installs racing crash both runs.
    with _OPENCODE_FIRST_USE if not warm.exists() else contextlib.nullcontext():
        stdout, error = _execute(cmd, env, workdir, timeout)
        warm.touch()
    attempt = Attempt(error=error)
    step_text: list[str] = []
    for event in _events(stdout):
        kind = event.get("type")
        part = event.get("part") or {}
        if kind == "step_start":
            step_text = []
        elif kind == "text":
            step_text.append(part.get("text") or "")
        elif kind == "step_finish":
            tokens = part.get("tokens") or {}
            cache = tokens.get("cache") or {}
            attempt.llm_calls += 1
            attempt.fresh_input_tokens += tokens.get("input", 0) + cache.get("write", 0)
            attempt.cached_input_tokens += cache.get("read", 0)
            attempt.output_tokens += tokens.get("output", 0) + tokens.get("reasoning", 0)
            if "".join(step_text).strip():
                attempt.answer = "".join(step_text)
        elif kind == "error" and not attempt.error:
            attempt.error = json.dumps(event.get("error") or event)[:300]
    return attempt


CLI_HARNESSES: dict[str, Callable[..., Attempt]] = {
    "claude-code": run_claude_code,
    "codex": run_codex,
    "pi": run_pi,
    "opencode": run_opencode,
}
