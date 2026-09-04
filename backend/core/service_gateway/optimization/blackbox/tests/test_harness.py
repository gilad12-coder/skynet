"""Tests for the harness catalog: per-harness launches, overrides and output parsers."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from core.exceptions import ServiceError
from core.models.blackbox import (
    BLACKBOX_HARNESS_CLAUDE_CODE,
    BLACKBOX_HARNESS_CODEX,
    BLACKBOX_HARNESS_CUSTOM,
    BLACKBOX_HARNESS_OPENCODE,
    BLACKBOX_HARNESS_PI,
    BLACKBOX_HARNESS_PRIME,
    BLACKBOX_TARGET_AGENT,
    BlackboxTarget,
)

from ..harness import (
    ANSWER_FILE,
    PRIME_AGENT_TARBALL,
    PRIME_AGENT_VERSION,
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
    assert provider["apiKey"] == "!printenv SKYNET_API_KEY"
    assert provider["models"][0]["id"] == "target-model"
    assert 'cp .skynet/pi/models.json "$HOME/.pi/agent/models.json"' in launch.run_command
    assert "pi --mode json --no-session --provider skynet --model" in launch.run_command
    assert launch.parse_output is _parse_pi_output


def test_pi_launch_bounds_reasoning_behind_openrouter() -> None:
    """Behind OpenRouter the model is declared reasoning-capable and every call carries an explicit low effort."""
    gateway = GatewayConfig(url="https://openrouter.ai/api/v1", api_key="secret-key")

    launch = build_launch(_target(BLACKBOX_HARNESS_PI), gateway)

    entry = json.loads(launch.files[".skynet/pi/models.json"])["providers"]["skynet"]["models"][0]
    assert entry["reasoning"] is True
    assert entry["compat"] == {"thinkingFormat": "openrouter"}
    assert '--model "$SKYNET_MODEL:low"' in launch.run_command


def test_pi_launch_leaves_reasoning_alone_behind_other_gateways() -> None:
    """A generic OpenAI-compatible gateway may reject OpenRouter's reasoning field, so pi never sends it."""
    launch = build_launch(_target(BLACKBOX_HARNESS_PI), _GATEWAY)

    entry = json.loads(launch.files[".skynet/pi/models.json"])["providers"]["skynet"]["models"][0]
    assert entry["reasoning"] is False
    assert "compat" not in entry
    assert '--model "$SKYNET_MODEL" ' in launch.run_command


def test_pi_launch_pins_the_harness_version_ahead_of_the_image_copy() -> None:
    """The install pins pi, prefers the pinned copy on PATH and logs the version that runs."""
    launch = build_launch(_target(BLACKBOX_HARNESS_PI), _GATEWAY)

    assert launch.install_command is not None
    assert "@earendil-works/pi-coding-agent@0.84.1" in launch.install_command
    assert '[ "$(pi --version 2>/dev/null)" = "0.84.1" ]' in launch.install_command
    assert launch.install_command.endswith("&& pi --version")
    for command in (launch.install_command, launch.run_command):
        assert command.startswith('export PATH="$HOME/.skynet/pi/bin:$PATH";')


def test_build_launch_drops_the_openrouter_routing_prefix() -> None:
    """The gateway fronts OpenRouter itself, so the model id it sees has no ``openrouter/`` prefix."""
    target = BlackboxTarget(kind=BLACKBOX_TARGET_AGENT, harness=BLACKBOX_HARNESS_PI, model="openrouter/acme/agent-1")

    launch = build_launch(target, _GATEWAY)

    models = json.loads(launch.files[".skynet/pi/models.json"])
    assert models["providers"]["skynet"]["models"][0]["id"] == "acme/agent-1"
    assert launch.env["SKYNET_MODEL"] == "acme/agent-1"


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
    assert 'wire_api = "responses"' in config
    assert "request_max_retries = 0" in config
    assert "stream_max_retries = 0" in config
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


@pytest.mark.parametrize(
    "harness", [BLACKBOX_HARNESS_PI, BLACKBOX_HARNESS_CODEX, BLACKBOX_HARNESS_OPENCODE, BLACKBOX_HARNESS_PRIME]
)
def test_protected_harness_uses_offline_dependencies_and_local_relay(tmp_path: Path, harness: str) -> None:
    """Execute generated config substitution without invoking a CLI or contacting a provider."""
    launch = build_launch(_target(harness, run_command="true"), _GATEWAY, protected=True)
    assert "npm install" not in launch.install_command
    assert "--version" in launch.install_command
    for name, content in launch.files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    subprocess.run(
        launch.run_command,
        shell=True,
        cwd=tmp_path,
        env={"PATH": os.defpath, "SKYNET_BUDGET_RELAY_URL": "http://127.0.0.1:3210/v1"},
        timeout=10,
        check=True,
    )
    for name in launch.files:
        content = (tmp_path / name).read_text()
        assert _GATEWAY.url not in content
        assert "http://127.0.0.1:3210/v1" in content


def test_prime_agent_launch_reuses_the_pi_gateway_config_in_its_own_agent_dir() -> None:
    """Prime Agent gets Pi's models.json under .skynet/prime, is pointed there, and streams Pi-shaped JSON."""
    launch = build_launch(_target(BLACKBOX_HARNESS_PRIME), _GATEWAY)

    assert launch.instructions_file == "AGENTS.md"
    models = json.loads(launch.files[".skynet/prime/models.json"])
    provider = models["providers"]["skynet"]
    assert provider["baseUrl"] == _GATEWAY.url
    assert provider["api"] == "openai-completions"
    assert provider["apiKey"] == "!printenv SKYNET_API_KEY"
    assert provider["models"][0]["id"] == "target-model"
    assert launch.run_command.startswith('PRIME_AGENT_CODING_AGENT_DIR="$PWD/.skynet/prime" prime-agent --mode json')
    assert '--no-session --provider skynet --model "$SKYNET_MODEL"' in launch.run_command
    assert launch.parse_output is _parse_pi_output


def test_prime_agent_launch_pins_the_release_tarball_and_bootstraps_the_kernel() -> None:
    """The install pins the CDN tarball, builds the Python kernel up front, and never waits on a prompt."""
    launch = build_launch(_target(BLACKBOX_HARNESS_PRIME), _GATEWAY)

    assert launch.install_command is not None
    assert f'"$(prime-agent --version 2>/dev/null)" = "{PRIME_AGENT_VERSION}"' in launch.install_command
    assert "PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1 npm install -g" in launch.install_command
    assert f'"{PRIME_AGENT_TARBALL}"' in launch.install_command
    assert launch.env["PRIME_AGENT_INSTALL_UV"] == "1"
    assert launch.env["PRIME_AGENT_TELEMETRY"] == "0"
    assert launch.env["PI_SKIP_VERSION_CHECK"] == "1"
    assert launch.env["SKYNET_MODEL"] == "target-model"


def test_prime_agent_launch_bounds_reasoning_behind_openrouter() -> None:
    """Behind OpenRouter the Prime Agent entry carries Pi's thinking format and effort, like Pi's does."""
    gateway = GatewayConfig(url="https://openrouter.ai/api/v1", api_key="k")
    launch = build_launch(_target(BLACKBOX_HARNESS_PRIME), gateway)

    entry = json.loads(launch.files[".skynet/prime/models.json"])["providers"]["skynet"]["models"][0]
    assert entry["reasoning"] is True
    assert entry["compat"] == {"thinkingFormat": "openrouter"}
    assert '--model "$SKYNET_MODEL:low"' in launch.run_command


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


def test_protected_custom_gateway_placeholder_uses_guest_endpoint() -> None:
    """Keep the parent-only origin out of custom commands after mailbox isolation."""
    target = _target(BLACKBOX_HARNESS_CUSTOM, run_command='printf "%s" "{gateway_url}"')
    launch = build_launch(target, _GATEWAY, protected=True)
    result = subprocess.run(
        launch.run_command,
        shell=True,
        env={"PATH": os.defpath, "SKYNET_GATEWAY_URL": "http://127.0.0.1:3210/v1"},
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    assert result.stdout == "http://127.0.0.1:3210/v1"
    assert _GATEWAY.url not in launch.run_command


def test_protected_opencode_disables_startup_dependency_downloads() -> None:
    """Use the bundled provider without network-fetched metadata, plugins, or language servers."""
    launch = build_launch(_target(BLACKBOX_HARNESS_OPENCODE), _GATEWAY, protected=True)
    for flag in ("AUTOUPDATE", "MODELS_FETCH", "DEFAULT_PLUGINS", "LSP_DOWNLOAD"):
        assert launch.env[f"OPENCODE_DISABLE_{flag}"] == "true"


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
