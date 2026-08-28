"""Tests for the harness catalog: per-harness launches, overrides and output parsers."""

from __future__ import annotations

import json

import pytest

from core.exceptions import ServiceError
from core.models.blackbox import (
    BLACKBOX_HARNESS_CLAUDE_CODE,
    BLACKBOX_HARNESS_CODEX,
    BLACKBOX_HARNESS_CUSTOM,
    BLACKBOX_HARNESS_OPENCODE,
    BLACKBOX_HARNESS_PI,
    BLACKBOX_TARGET_AGENT,
    BlackboxTarget,
)

from ..harness import (
    ANSWER_FILE,
    PROMPT_FILE,
    GatewayConfig,
    _parse_claude_output,
    _parse_codex_output,
    _parse_pi_output,
    _parse_plain_output,
    build_launch,
)

_GATEWAY = GatewayConfig(url="https://gw.example/v1", api_key="secret-key")


def _target(harness: str, **overrides: object) -> BlackboxTarget:
    """Build an agent target for ``harness`` with the given field overrides.

    Args:
        harness: Harness id.
        **overrides: Extra target fields.

    Returns:
        The target.
    """
    return BlackboxTarget(kind=BLACKBOX_TARGET_AGENT, harness=harness, model="target-model", **overrides)


def test_pi_launch_wires_the_gateway_provider_and_json_stream() -> None:
    """Pi writes AGENTS.md, a models.json pointed at the gateway, and runs in JSON mode."""
    launch = build_launch(_target(BLACKBOX_HARNESS_PI), _GATEWAY)

    assert launch.instructions_file == "AGENTS.md"
    models = json.loads(launch.files[".skynet/pi/models.json"])
    provider = models["providers"]["skynet"]
    assert provider["baseUrl"] == _GATEWAY.url
    assert provider["api"] == "openai-completions"
    assert provider["apiKey"] == "SKYNET_API_KEY"
    assert provider["models"][0]["id"] == "target-model"
    assert 'cp .skynet/pi/models.json "$HOME/.pi/agent/models.json"' in launch.run_command
    assert "pi --mode json --no-session --provider skynet --model" in launch.run_command
    assert launch.parse_output is _parse_pi_output


def test_pi_launch_carries_the_base_environment() -> None:
    """Every SKYNET_* var plus the CI/NO_COLOR pair reaches the sandbox."""
    launch = build_launch(_target(BLACKBOX_HARNESS_PI), _GATEWAY)

    assert launch.env == {
        "SKYNET_MODEL": "target-model",
        "SKYNET_GATEWAY_URL": _GATEWAY.url,
        "SKYNET_API_KEY": "secret-key",
        "SKYNET_PROMPT_FILE": PROMPT_FILE,
        "SKYNET_ANSWER_FILE": ANSWER_FILE,
        "CI": "1",
        "NO_COLOR": "1",
    }


def test_codex_launch_writes_a_gateway_config_toml() -> None:
    """Codex routes through the gateway via CODEX_HOME config and the chat wire API."""
    launch = build_launch(_target(BLACKBOX_HARNESS_CODEX), _GATEWAY)

    assert launch.instructions_file == "AGENTS.md"
    config = launch.files[".skynet/codex/config.toml"]
    assert 'env_key = "SKYNET_API_KEY"' in config
    assert 'wire_api = "chat"' in config
    assert json.dumps(_GATEWAY.url) in config
    assert 'CODEX_HOME="$PWD/.skynet/codex" codex exec' in launch.run_command
    assert launch.parse_output is _parse_codex_output


def test_claude_code_launch_strips_the_v1_suffix_for_the_anthropic_sdk() -> None:
    """Claude Code uses CLAUDE.md and an ANTHROPIC_BASE_URL without the trailing /v1."""
    launch = build_launch(_target(BLACKBOX_HARNESS_CLAUDE_CODE), _GATEWAY)

    assert launch.instructions_file == "CLAUDE.md"
    assert launch.env["ANTHROPIC_BASE_URL"] == "https://gw.example"
    assert launch.env["ANTHROPIC_AUTH_TOKEN"] == "secret-key"
    assert launch.files == {}
    assert "claude -p" in launch.run_command
    assert launch.parse_output is _parse_claude_output


def test_opencode_launch_names_the_gateway_model() -> None:
    """OpenCode writes opencode.json and runs the skynet/<model> selection."""
    launch = build_launch(_target(BLACKBOX_HARNESS_OPENCODE), _GATEWAY)

    assert launch.instructions_file == "AGENTS.md"
    config = json.loads(launch.files["opencode.json"])
    assert config["model"] == "skynet/target-model"
    assert config["provider"]["skynet"]["options"]["apiKey"] == "{env:SKYNET_API_KEY}"
    assert 'opencode run --model "skynet/$SKYNET_MODEL"' in launch.run_command
    assert launch.parse_output is _parse_plain_output


def test_custom_launch_fills_placeholders() -> None:
    """A custom harness substitutes the model/gateway/file placeholders into its commands."""
    target = _target(
        BLACKBOX_HARNESS_CUSTOM,
        install_command="setup {model}",
        run_command="agent {model} {gateway_url} {api_key} {prompt_file} {answer_file}",
    )

    launch = build_launch(target, _GATEWAY)

    assert launch.instructions_file == "AGENTS.md"
    assert launch.install_command == "setup target-model"
    assert launch.run_command == f"agent target-model {_GATEWAY.url} secret-key {PROMPT_FILE} {ANSWER_FILE}"
    assert launch.parse_output is _parse_plain_output


def test_catalog_overrides_replace_the_default_commands() -> None:
    """Target install/run commands override the catalog defaults but keep its files and parser."""
    target = _target(BLACKBOX_HARNESS_PI, install_command="my-install {model}", run_command="my-run {prompt_file}")

    launch = build_launch(target, _GATEWAY)

    assert launch.install_command == "my-install target-model"
    assert launch.run_command == f"my-run {PROMPT_FILE}"
    assert ".skynet/pi/models.json" in launch.files
    assert launch.parse_output is _parse_pi_output


def test_custom_without_run_command_is_a_typed_error() -> None:
    """A custom harness missing its run command fails with a service error."""
    target = BlackboxTarget.model_construct(
        kind=BLACKBOX_TARGET_AGENT, harness=BLACKBOX_HARNESS_CUSTOM, model="m", run_command=None, install_command=None
    )

    with pytest.raises(ServiceError, match="custom harness needs a run_command"):
        build_launch(target, _GATEWAY)


def test_unknown_harness_is_a_typed_error() -> None:
    """An unrecognized harness id is rejected."""
    target = BlackboxTarget.model_construct(kind=BLACKBOX_TARGET_AGENT, harness="ferrari", model="m")

    with pytest.raises(ServiceError, match="Unknown harness 'ferrari'"):
        build_launch(target, _GATEWAY)


def test_parse_plain_output_strips_and_reports_none_when_empty() -> None:
    """Plain output is the stripped text, or None when blank, with no usage."""
    assert _parse_plain_output("  hello \n") == ("hello", {})
    assert _parse_plain_output("   ") == (None, {})


def test_parse_pi_output_takes_the_last_assistant_message_and_sums_usage() -> None:
    """Pi parsing keeps the final assistant text, joins its parts, and sums usage across turns."""
    stdout = "\n".join(
        [
            "not json",
            json.dumps(
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "first"}],
                        "usage": {"input": 10, "output": 5},
                    },
                }
            ),
            json.dumps({"type": "message_end", "message": {"role": "user", "content": []}}),
            json.dumps(
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "second"}, {"type": "text", "text": "line"}],
                        "usage": {"input": 3, "output": 7},
                    },
                }
            ),
        ]
    )

    text, usage = _parse_pi_output(stdout)

    assert text == "second\nline"
    assert usage == {"input_tokens": 13, "output_tokens": 12}


def test_parse_codex_output_reads_agent_message_and_turn_usage() -> None:
    """Codex parsing keeps the final agent message and the turn's token usage."""
    stdout = "\n".join(
        [
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "the answer"}}),
            json.dumps({"type": "turn.completed", "usage": {"input_tokens": 8, "output_tokens": 4}}),
        ]
    )

    assert _parse_codex_output(stdout) == ("the answer", {"input_tokens": 8, "output_tokens": 4})


def test_parse_claude_output_finds_the_result_object() -> None:
    """Claude parsing reads the result and usage whether or not the JSON is the whole output."""
    whole = json.dumps({"result": "done", "usage": {"input_tokens": 2, "output_tokens": 3}})
    assert _parse_claude_output(whole) == ("done", {"input_tokens": 2, "output_tokens": 3})

    trailing = "chatter\n" + json.dumps({"result": "later", "usage": {"input_tokens": 1, "output_tokens": 1}})
    assert _parse_claude_output(trailing) == ("later", {"input_tokens": 1, "output_tokens": 1})

    assert _parse_claude_output(json.dumps({"foo": "bar"})) == (None, {})
