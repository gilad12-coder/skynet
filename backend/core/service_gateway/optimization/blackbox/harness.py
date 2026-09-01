"""Harness catalog: how each coding agent is installed, pointed at the gateway and run.

A harness is the program that turns a model into a coding agent — Pi,
Codex, Claude Code, OpenCode, or a user-supplied command. Every entry
knows the file its instructions live in (that file is the text under
optimization), how to install itself, the config that routes its model
calls to Skynet's gateway, the command that runs one case headlessly, and
how to read the agent's final answer and token usage out of its output.
Model routing is gateway-only: a sandbox sees the run's gateway key, never
a provider key.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

from ....exceptions import ServiceError
from ....models.blackbox import (
    BLACKBOX_HARNESS_CLAUDE_CODE,
    BLACKBOX_HARNESS_CODEX,
    BLACKBOX_HARNESS_CUSTOM,
    BLACKBOX_HARNESS_OPENCODE,
    BLACKBOX_HARNESS_PI,
    BlackboxTarget,
)

PROVIDER = "skynet"
PROMPT_FILE = "task/PROMPT.md"
ANSWER_FILE = "output/answer.txt"
ENV_MODEL = "SKYNET_MODEL"
ENV_GATEWAY_URL = "SKYNET_GATEWAY_URL"
ENV_API_KEY = "SKYNET_API_KEY"
ENV_PROMPT_FILE = "SKYNET_PROMPT_FILE"
ENV_ANSWER_FILE = "SKYNET_ANSWER_FILE"
# Substituted verbatim into a custom harness's commands; the env vars above
# are the quoting-safe alternative.
PLACEHOLDERS = ("{model}", "{gateway_url}", "{api_key}", "{prompt_file}", "{answer_file}")

Usage = dict[str, int]
OutputParser = Callable[[str], tuple[str | None, Usage]]

_PROMPT_ARG = f'"$(cat "${ENV_PROMPT_FILE}")"'


@dataclass(frozen=True)
class GatewayConfig:
    """Where a sandboxed harness sends its model calls."""

    url: str
    api_key: str


@dataclass(frozen=True)
class HarnessLaunch:
    """Everything a sandbox needs to run one harness on one case."""

    instructions_file: str
    run_command: str
    parse_output: OutputParser
    install_command: str | None = None
    files: dict[str, str] = field(default_factory=dict)
    env: dict[str, str] = field(default_factory=dict)


PI_PACKAGE = "@earendil-works/pi-coding-agent"
PI_VERSION = "0.84.1"
# The LiteLLM-style routing prefix; the gateway fronts OpenRouter itself and
# rejects model ids that still carry it.
_OPENROUTER_PREFIX = "openrouter/"
# The sandbox image ships its own pi in /usr/local/bin. A pinned copy lives in
# a private prefix put ahead of it on PATH, so the version the transcript logs
# is the one that ran.
_PI_PREFIX = '"$HOME/.skynet/pi"'
_PI_PATH = 'export PATH="$HOME/.skynet/pi/bin:$PATH"'


def _pi_install() -> str:
    """Return the command that pins pi to :data:`PI_VERSION` and logs the version that will run.

    The image's own pi is kept when it already is the pinned version, so the
    install is free on the common path.

    Returns:
        The shell command.
    """
    return (
        f'{_PI_PATH}; [ "$(pi --version 2>/dev/null)" = "{PI_VERSION}" ] '
        f"|| npm install -g --prefix {_PI_PREFIX} {PI_PACKAGE}@{PI_VERSION} >/dev/null && pi --version"
    )


def _npm_install(binary: str, package: str) -> str:
    """Return a command that installs ``package`` globally unless ``binary`` is already on PATH.

    Args:
        binary: Executable the package provides.
        package: npm package name.

    Returns:
        The shell command.
    """
    return f"command -v {binary} >/dev/null 2>&1 || npm install -g {package}"


def _base_env(model: str, gateway: GatewayConfig) -> dict[str, str]:
    """Return the environment every harness gets.

    Args:
        model: Target model id as the gateway knows it.
        gateway: Gateway URL and key.

    Returns:
        Environment variables for the sandbox.
    """
    return {
        ENV_MODEL: model,
        ENV_GATEWAY_URL: gateway.url,
        ENV_API_KEY: gateway.api_key,
        ENV_PROMPT_FILE: PROMPT_FILE,
        ENV_ANSWER_FILE: ANSWER_FILE,
        "CI": "1",
        "NO_COLOR": "1",
    }


def _json_lines(stdout: str) -> Iterator[dict[str, Any]]:
    """Yield every line of ``stdout`` that parses as a JSON object.

    Args:
        stdout: Captured harness output.

    Yields:
        Parsed event objects, skipping anything that is not JSON.
    """
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event


def _usage(input_tokens: Any, output_tokens: Any) -> Usage:
    """Normalize a token pair into the usage shape the run record carries.

    Args:
        input_tokens: Prompt tokens, or ``None``.
        output_tokens: Completion tokens, or ``None``.

    Returns:
        ``{"input_tokens": n, "output_tokens": m}`` with missing values as 0.
    """
    return {"input_tokens": int(input_tokens or 0), "output_tokens": int(output_tokens or 0)}


def _add_usage(total: Usage, extra: Usage) -> Usage:
    """Sum two usage records.

    Args:
        total: Running total.
        extra: Usage to add.

    Returns:
        The summed usage.
    """
    return {key: total.get(key, 0) + extra.get(key, 0) for key in ("input_tokens", "output_tokens")}


def _parse_plain_output(stdout: str) -> tuple[str | None, Usage]:
    """Treat the whole output as the answer; nothing reports usage.

    Args:
        stdout: Captured harness output.

    Returns:
        The stripped output (``None`` when empty) and an empty usage record.
    """
    text = stdout.strip()
    return (text or None), {}


def _parse_pi_output(stdout: str) -> tuple[str | None, Usage]:
    """Read the last assistant message and summed usage from Pi's ``--mode json`` stream.

    Args:
        stdout: Captured harness output.

    Returns:
        The final assistant text (``None`` when absent) and the usage total.
    """
    text: str | None = None
    usage: Usage = {}
    for event in _json_lines(stdout):
        if event.get("type") != "message_end":
            continue
        message = event.get("message") or {}
        if message.get("role") != "assistant":
            continue
        parts = [part.get("text", "") for part in message.get("content") or [] if part.get("type") == "text"]
        if any(parts):
            text = "\n".join(part for part in parts if part).strip()
        used = message.get("usage") or {}
        usage = _add_usage(usage, _usage(used.get("input"), used.get("output")))
    return text, usage


def _parse_codex_output(stdout: str) -> tuple[str | None, Usage]:
    """Read the last agent message and turn usage from ``codex exec --json``.

    Args:
        stdout: Captured harness output.

    Returns:
        The final agent text (``None`` when absent) and the usage total.
    """
    text: str | None = None
    usage: Usage = {}
    for event in _json_lines(stdout):
        kind = event.get("type")
        if kind == "item.completed":
            item = event.get("item") or {}
            if item.get("type") == "agent_message" and item.get("text"):
                text = str(item["text"]).strip()
        elif kind == "turn.completed":
            used = event.get("usage") or {}
            usage = _add_usage(usage, _usage(used.get("input_tokens"), used.get("output_tokens")))
    return text, usage


def _parse_claude_output(stdout: str) -> tuple[str | None, Usage]:
    """Read the result and usage from ``claude -p --output-format json``.

    Args:
        stdout: Captured harness output.

    Returns:
        The result text (``None`` when absent) and the usage total.
    """
    candidates = [stdout.strip(), *reversed(stdout.strip().splitlines())]
    for raw in candidates:
        try:
            payload = json.loads(raw)
        except ValueError:
            continue
        if isinstance(payload, dict) and "result" in payload:
            used = payload.get("usage") or {}
            result = payload.get("result")
            text = str(result).strip() if result else None
            return (text or None), _usage(used.get("input_tokens"), used.get("output_tokens"))
    return None, {}


def _pi_launch(model: str, gateway: GatewayConfig) -> HarnessLaunch:
    """Build the launch for Pi (:data:`PI_PACKAGE`, pinned to :data:`PI_VERSION`).

    Args:
        model: Target model id.
        gateway: Gateway URL and key.

    Returns:
        The launch.
    """
    models_json = {
        "providers": {
            PROVIDER: {
                "baseUrl": gateway.url,
                "api": "openai-completions",
                # Pi reads a bare env-var name as the literal key; the shell form is honoured.
                "apiKey": f"!printenv {ENV_API_KEY}",
                "models": [
                    {
                        "id": model,
                        "name": model,
                        "reasoning": False,
                        "input": ["text"],
                        "contextWindow": 200_000,
                        "maxTokens": 32_000,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                    }
                ],
            }
        }
    }
    return HarnessLaunch(
        instructions_file="AGENTS.md",
        install_command=_pi_install(),
        files={".skynet/pi/models.json": json.dumps(models_json, indent=2)},
        run_command=(
            f'{_PI_PATH}; mkdir -p "$HOME/.pi/agent" && cp .skynet/pi/models.json "$HOME/.pi/agent/models.json" && '
            f'pi --mode json --no-session --provider {PROVIDER} --model "${ENV_MODEL}" {_PROMPT_ARG}'
        ),
        env=_base_env(model, gateway),
        parse_output=_parse_pi_output,
    )


def _codex_launch(model: str, gateway: GatewayConfig) -> HarnessLaunch:
    """Build the launch for Codex CLI (``@openai/codex``).

    Args:
        model: Target model id.
        gateway: Gateway URL and key.

    Returns:
        The launch.
    """
    config_toml = (
        f"model = {json.dumps(model)}\n"
        f'model_provider = "{PROVIDER}"\n'
        "\n"
        f"[model_providers.{PROVIDER}]\n"
        'name = "Skynet gateway"\n'
        f"base_url = {json.dumps(gateway.url)}\n"
        f'env_key = "{ENV_API_KEY}"\n'
        'wire_api = "chat"\n'
    )
    return HarnessLaunch(
        instructions_file="AGENTS.md",
        install_command=_npm_install("codex", "@openai/codex"),
        files={".skynet/codex/config.toml": config_toml},
        run_command=(
            'CODEX_HOME="$PWD/.skynet/codex" codex exec --skip-git-repo-check '
            f"--dangerously-bypass-approvals-and-sandbox --json {_PROMPT_ARG}"
        ),
        env=_base_env(model, gateway),
        parse_output=_parse_codex_output,
    )


def _claude_code_launch(model: str, gateway: GatewayConfig) -> HarnessLaunch:
    """Build the launch for Claude Code (``@anthropic-ai/claude-code``).

    Needs a gateway that speaks the Anthropic Messages API (LiteLLM does).

    Args:
        model: Target model id.
        gateway: Gateway URL and key.

    Returns:
        The launch.
    """
    env = _base_env(model, gateway)
    # The Anthropic SDK appends ``/v1/messages`` itself.
    base_url = gateway.url.removesuffix("/v1")
    env.update(
        {
            "ANTHROPIC_BASE_URL": base_url,
            "ANTHROPIC_AUTH_TOKEN": gateway.api_key,
            "DISABLE_AUTOUPDATER": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        }
    )
    return HarnessLaunch(
        instructions_file="CLAUDE.md",
        install_command=_npm_install("claude", "@anthropic-ai/claude-code"),
        run_command=(
            f'claude -p {_PROMPT_ARG} --model "${ENV_MODEL}" --output-format json --dangerously-skip-permissions'
        ),
        env=env,
        parse_output=_parse_claude_output,
    )


def _opencode_launch(model: str, gateway: GatewayConfig) -> HarnessLaunch:
    """Build the launch for OpenCode (``opencode-ai``).

    Args:
        model: Target model id.
        gateway: Gateway URL and key.

    Returns:
        The launch.
    """
    config = {
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            PROVIDER: {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Skynet gateway",
                "options": {"baseURL": gateway.url, "apiKey": f"{{env:{ENV_API_KEY}}}"},
                "models": {model: {"name": model}},
            }
        },
        "model": f"{PROVIDER}/{model}",
    }
    return HarnessLaunch(
        instructions_file="AGENTS.md",
        install_command=_npm_install("opencode", "opencode-ai"),
        files={"opencode.json": json.dumps(config, indent=2)},
        run_command=f'opencode run --model "{PROVIDER}/${ENV_MODEL}" {_PROMPT_ARG}',
        env=_base_env(model, gateway),
        parse_output=_parse_plain_output,
    )


def _fill(command: str | None, model: str, gateway: GatewayConfig) -> str | None:
    """Substitute the custom-harness placeholders into ``command``.

    Args:
        command: A command line that may use :data:`PLACEHOLDERS`.
        model: Target model id.
        gateway: Gateway URL and key.

    Returns:
        The command with placeholders replaced, or ``None`` when there is no command.
    """
    if not command or not command.strip():
        return None
    values = {
        "{model}": model,
        "{gateway_url}": gateway.url,
        "{api_key}": gateway.api_key,
        "{prompt_file}": PROMPT_FILE,
        "{answer_file}": ANSWER_FILE,
    }
    for placeholder, value in values.items():
        command = command.replace(placeholder, value)
    return command


_CATALOG: dict[str, Callable[[str, GatewayConfig], HarnessLaunch]] = {
    BLACKBOX_HARNESS_PI: _pi_launch,
    BLACKBOX_HARNESS_CODEX: _codex_launch,
    BLACKBOX_HARNESS_CLAUDE_CODE: _claude_code_launch,
    BLACKBOX_HARNESS_OPENCODE: _opencode_launch,
}


def build_launch(target: BlackboxTarget, gateway: GatewayConfig) -> HarnessLaunch:
    """Resolve the launch for a job's target: catalog harness or custom command.

    ``target.install_command`` and ``target.run_command`` override the
    catalog defaults when set; a custom harness is nothing but those two.

    Args:
        target: The job's agent target.
        gateway: Gateway URL and key the harness routes its model calls through.

    Returns:
        The launch.

    Raises:
        ServiceError: When the harness id is unknown.
    """
    model = str(target.model).removeprefix(_OPENROUTER_PREFIX)
    if target.harness == BLACKBOX_HARNESS_CUSTOM:
        run_command = _fill(target.run_command, model, gateway)
        if run_command is None:
            raise ServiceError("A custom harness needs a run_command.")
        return HarnessLaunch(
            instructions_file="AGENTS.md",
            install_command=_fill(target.install_command, model, gateway),
            run_command=run_command,
            env=_base_env(model, gateway),
            parse_output=_parse_plain_output,
        )
    factory = _CATALOG.get(target.harness)
    if factory is None:
        raise ServiceError(f"Unknown harness '{target.harness}'.")
    launch = factory(model, gateway)
    install_command = _fill(target.install_command, model, gateway) or launch.install_command
    run_command = _fill(target.run_command, model, gateway) or launch.run_command
    return HarnessLaunch(
        instructions_file=launch.instructions_file,
        install_command=install_command,
        run_command=run_command,
        files=launch.files,
        env=launch.env,
        parse_output=launch.parse_output,
    )
