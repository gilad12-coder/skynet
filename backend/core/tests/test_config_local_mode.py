"""Tests for the local-mode settings and their hosted-safety check."""

# mypy: disable-error-code="call-arg"

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from core.config import Settings, local_bind_host
from core.models.blackbox import BlackboxProposer
from core.models.common import ModelConfig

_ENV_VARS = (
    "APP_LOCAL_MODE",
    "SKYNET_LOCAL_MODE",
    "APP_ENVIRONMENT",
    "API_HOST",
    "APP_LOCAL_SANDBOX_IMAGE",
    "APP_CLI_MAX_CONCURRENCY",
    "PORT",
    "API_PORT",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove ambient values that would change what ``Settings()`` reads.

    Args:
        monkeypatch: Pytest fixture that restores the environment afterwards.
    """
    for var in _ENV_VARS:
        monkeypatch.delenv(var, raising=False)


def test_local_mode_is_off_by_default() -> None:
    """Without the flag the settings keep hosted behavior."""
    settings = Settings(_env_file=None)

    assert settings.local_mode is False
    assert settings.cli_max_concurrency == 2


def test_local_mode_starts_on_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    """Local mode loads when the API binds a loopback host off any deployment.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
    """
    monkeypatch.setenv("APP_LOCAL_MODE", "1")
    monkeypatch.setenv("API_HOST", "127.0.0.1")

    assert Settings(_env_file=None).local_mode is True


@pytest.mark.parametrize("environment", ["staging", "production", "skynet-pr-766"])
def test_local_mode_refuses_a_deployed_environment(monkeypatch: pytest.MonkeyPatch, environment: str) -> None:
    """A deployment environment name makes local mode fail at startup.

    Every deployed service sets ``APP_ENVIRONMENT``, so this keeps local mode
    off staging, production and PR previews.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
        environment: The ``APP_ENVIRONMENT`` value a deployment sets.
    """
    monkeypatch.setenv("APP_LOCAL_MODE", "1")
    monkeypatch.setenv("API_HOST", "127.0.0.1")
    monkeypatch.setenv("APP_ENVIRONMENT", environment)

    with pytest.raises(ValidationError, match="deployed environment"):
        Settings(_env_file=None)


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.10"])
def test_local_mode_refuses_a_network_host(monkeypatch: pytest.MonkeyPatch, host: str) -> None:
    """A non-loopback API_HOST makes local mode fail at startup.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
        host: The bind address under test.
    """
    monkeypatch.setenv("APP_LOCAL_MODE", "1")
    monkeypatch.setenv("API_HOST", host)

    with pytest.raises(ValidationError, match="loopback"):
        Settings(_env_file=None)


def test_local_mode_refuses_an_unset_api_host(monkeypatch: pytest.MonkeyPatch) -> None:
    """The server's default bind address is 0.0.0.0, so an unset host is refused.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
    """
    monkeypatch.setenv("APP_LOCAL_MODE", "1")

    with pytest.raises(ValidationError, match="loopback"):
        Settings(_env_file=None)


def test_sandbox_image_must_be_a_digest(monkeypatch: pytest.MonkeyPatch) -> None:
    """The sandbox image setting takes only a pinned ``sha256:`` digest.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
    """
    monkeypatch.setenv("APP_LOCAL_SANDBOX_IMAGE", "skynet-sandbox:latest")

    with pytest.raises(ValidationError):
        Settings(_env_file=None)

    monkeypatch.setenv("APP_LOCAL_SANDBOX_IMAGE", "sha256:" + "a" * 64)
    assert Settings(_env_file=None).local_sandbox_image == "sha256:" + "a" * 64


def test_cli_concurrency_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """The CLI concurrency limit refuses values outside 1 to 16.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
    """
    monkeypatch.setenv("APP_CLI_MAX_CONCURRENCY", "0")

    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_subscription_model_needs_a_cli() -> None:
    """A subscription model config without ``cli_provider`` fails validation."""
    with pytest.raises(ValidationError, match="cli_provider"):
        ModelConfig(name="anthropic/claude-sonnet-4.6", token_source="subscription")

    config = ModelConfig(name="anthropic/claude-sonnet-4.6", token_source="subscription", cli_provider="claude")
    assert config.cli_provider == "claude"


@pytest.mark.parametrize("cli", ["droid", "Droid", " DROID "])
def test_model_config_naming_droid_is_refused_with_a_clear_error(cli: str) -> None:
    """A saved model or stored run that names Droid fails with a message that says why.

    Args:
        cli: A ``cli_provider`` value that names Droid.
    """
    with pytest.raises(ValidationError, match="Droid is no longer supported"):
        ModelConfig(name="anthropic/claude-sonnet-4.6", token_source="subscription", cli_provider=cli)


def test_proposer_naming_droid_is_refused_with_a_clear_error() -> None:
    """A saved proposer that names Droid as its host CLI fails with the same message."""
    with pytest.raises(ValidationError, match="Droid is no longer supported"):
        BlackboxProposer(host_cli="droid")

    assert BlackboxProposer(host_cli="claude").host_cli == "claude"


def test_old_droid_bin_env_var_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    """A machine that still sets ``APP_DROID_BIN`` starts, and the setting is gone.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
    """
    monkeypatch.setenv("APP_DROID_BIN", "/usr/local/bin/droid")

    loaded = Settings(_env_file=None)

    assert not hasattr(loaded, "droid_bin")


# The image trusts forwarded headers only from FORWARDED_ALLOW_IPS; unset keeps
# uvicorn's own default.
_PROXY_FLAGS = " --proxy-headers --forwarded-allow-ips 127.0.0.1"


def _dockerfile_bind(env: dict[str, str]) -> str:
    """Run the image's start command with ``exec`` replaced by ``echo``.

    Args:
        env: Environment the container would start with, without ``PATH``.

    Returns:
        The command line the container would run.
    """
    return _run_dockerfile_cmd(env, ("exec ", "echo "))


def _dockerfile_env(env: dict[str, str], name: str) -> str:
    """Run the image's start command and read one variable the server would inherit.

    Args:
        env: Environment the container would start with, without ``PATH``.
        name: Variable to read at the point where uvicorn would start.

    Returns:
        The variable's value, or an empty string when it is unset.
    """
    return _run_dockerfile_cmd(env, ("exec uvicorn", f"printenv {name}; : uvicorn"))


def _run_dockerfile_cmd(env: dict[str, str], swap: tuple[str, str]) -> str:
    """Run the image's API start command with one text swap.

    The command still runs the real Python bind helper from this backend.

    Args:
        env: Environment the container would start with, without ``PATH``.
        swap: Text to replace in the command and its replacement.

    Returns:
        The command's standard output, stripped.
    """
    backend = Path(__file__).resolve().parents[2]
    cmd = next(line for line in (backend / "Dockerfile").read_text().splitlines() if line.startswith("CMD "))
    script = json.loads(cmd.removeprefix("CMD "))[2].replace(*swap)
    path = f"{Path(sys.executable).parent}:/usr/bin:/bin"
    result = subprocess.run(
        ["sh", "-c", script], env={"PATH": path, **env}, cwd=backend, capture_output=True, text=True, check=False
    )
    return result.stdout.strip()


def test_dockerfile_keeps_the_hosted_bind() -> None:
    """Without local mode the image binds every interface, as before."""
    assert _dockerfile_bind({"API_HOST": "127.0.0.1"}) == "uvicorn main:app --host 0.0.0.0 --port 8000" + _PROXY_FLAGS


@pytest.mark.parametrize("flag", ["APP_LOCAL_MODE", "SKYNET_LOCAL_MODE", "app_local_mode", "Skynet_Local_Mode"])
def test_dockerfile_binds_the_checked_host_in_local_mode(flag: str) -> None:
    """In local mode the image binds API_HOST, read in any case as Settings reads it.

    Args:
        flag: Local-mode variable name the container sets.
    """
    env = {flag: "1", "api_host": "127.0.0.1", "PORT": "9000"}

    assert _dockerfile_bind(env) == "uvicorn main:app --host 127.0.0.1 --port 9000" + _PROXY_FLAGS


def test_local_bind_host_reads_the_env_file(tmp_path: Path) -> None:
    """Local mode and API_HOST set only in backend/.env still give the loopback bind.

    Args:
        tmp_path: Pytest directory that holds the ``.env`` file.
    """
    env_file = tmp_path / ".env"
    env_file.write_text("APP_LOCAL_MODE=1\nAPI_HOST=127.0.0.1\n")

    assert local_bind_host(Settings(_env_file=env_file)) == "127.0.0.1"
    assert local_bind_host(Settings(_env_file=None)) == ""


def test_env_file_local_mode_without_a_host_is_refused(tmp_path: Path) -> None:
    """Local mode from backend/.env with no loopback API_HOST still fails at startup.

    Args:
        tmp_path: Pytest directory that holds the ``.env`` file.
    """
    env_file = tmp_path / ".env"
    env_file.write_text("APP_LOCAL_MODE=1\n")

    with pytest.raises(ValidationError, match="loopback"):
        Settings(_env_file=env_file)


def test_api_port_sets_the_mcp_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """The agent's MCP URL uses the API_PORT that main.run_server binds.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
    """
    monkeypatch.setenv("APP_LOCAL_MODE", "1")
    monkeypatch.setenv("API_HOST", "127.0.0.1")
    monkeypatch.setenv("API_PORT", "48100")

    settings = Settings(_env_file=None)

    assert settings.port == 48100
    assert settings.generalist_agent_mcp_url == "http://127.0.0.1:48100/mcp/"


def test_api_port_wins_over_a_stray_port(monkeypatch: pytest.MonkeyPatch) -> None:
    """main.py binds API_PORT, so a PORT left in the shell does not take over.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
    """
    monkeypatch.setenv("PORT", "3000")
    monkeypatch.setenv("API_PORT", "48100")

    settings = Settings(_env_file=None)

    assert settings.port == 48100
    assert settings.generalist_agent_mcp_url == "http://127.0.0.1:48100/mcp/"


def test_local_mcp_url_dials_the_ipv6_bind_host(monkeypatch: pytest.MonkeyPatch) -> None:
    """In local mode the MCP URL dials the host the API binds, with IPv6 brackets.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
    """
    monkeypatch.setenv("APP_LOCAL_MODE", "1")
    monkeypatch.setenv("API_HOST", "::1")
    monkeypatch.setenv("API_PORT", "48100")

    assert Settings(_env_file=None).generalist_agent_mcp_url == "http://[::1]:48100/mcp/"


@pytest.mark.parametrize(
    ("env", "port"),
    [
        ({"API_PORT": "9000"}, "8000"),
        ({"PORT": "8080", "API_PORT": "9000"}, "8080"),
        ({"PORT": "8080"}, "8080"),
    ],
)
def test_dockerfile_binds_the_settings_port(env: dict[str, str], port: str) -> None:
    """The image binds the platform PORT and hands the same port to Settings.

    docker compose passes backend/.env (with API_PORT) into the container, and
    a PaaS runtime may set PORT. The image keeps its old bind in both cases and exports
    it as API_PORT, so Settings and the MCP URL see the port uvicorn binds.

    Args:
        env: Environment the container starts with.
        port: Port the image must bind and export.
    """
    assert _dockerfile_bind(env) == f"uvicorn main:app --host 0.0.0.0 --port {port}" + _PROXY_FLAGS
    assert _dockerfile_env(env, "API_PORT") == port


def test_process_api_port_wins_over_the_env_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The port the image exports wins over an API_PORT in backend/.env.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
        tmp_path: Pytest directory that holds the ``.env`` file.
    """
    env_file = tmp_path / ".env"
    env_file.write_text("API_PORT=9000\n")
    monkeypatch.setenv("API_PORT", "8000")

    assert Settings(_env_file=env_file).port == 8000
