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
from core.models.common import ModelConfig

_ENV_VARS = (
    "APP_LOCAL_MODE",
    "SKYNET_LOCAL_MODE",
    "RAILWAY_ENVIRONMENT_NAME",
    "API_HOST",
    "APP_LOCAL_SANDBOX_IMAGE",
    "APP_CLI_MAX_CONCURRENCY",
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
    """Local mode loads when the API binds a loopback host off Railway.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
    """
    monkeypatch.setenv("APP_LOCAL_MODE", "1")
    monkeypatch.setenv("API_HOST", "127.0.0.1")

    assert Settings(_env_file=None).local_mode is True


def test_local_mode_refuses_railway(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Railway environment name makes local mode fail at startup.

    Args:
        monkeypatch: Pytest fixture used to set the environment.
    """
    monkeypatch.setenv("APP_LOCAL_MODE", "1")
    monkeypatch.setenv("API_HOST", "127.0.0.1")
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "x")

    with pytest.raises(ValidationError, match="Railway"):
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


def _dockerfile_bind(env: dict[str, str]) -> str:
    """Run the image's start command with ``exec`` replaced by ``echo``.

    The command still runs the real Python bind helper from this backend.

    Args:
        env: Environment the container would start with, without ``PATH``.

    Returns:
        The command line the container would run.
    """
    backend = Path(__file__).resolve().parents[2]
    cmd = next(line for line in (backend / "Dockerfile").read_text().splitlines() if line.startswith("CMD "))
    script = json.loads(cmd.removeprefix("CMD "))[2].replace("exec ", "echo ")
    path = f"{Path(sys.executable).parent}:/usr/bin:/bin"
    result = subprocess.run(
        ["sh", "-c", script], env={"PATH": path, **env}, cwd=backend, capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def test_dockerfile_keeps_the_hosted_bind() -> None:
    """Without local mode the image binds every interface, as before."""
    assert _dockerfile_bind({"API_HOST": "127.0.0.1"}) == "uvicorn main:app --host 0.0.0.0 --port 8000"


@pytest.mark.parametrize("flag", ["APP_LOCAL_MODE", "SKYNET_LOCAL_MODE", "app_local_mode", "Skynet_Local_Mode"])
def test_dockerfile_binds_the_checked_host_in_local_mode(flag: str) -> None:
    """In local mode the image binds API_HOST, read in any case as Settings reads it.

    Args:
        flag: Local-mode variable name the container sets.
    """
    env = {flag: "1", "api_host": "127.0.0.1", "PORT": "9000"}

    assert _dockerfile_bind(env) == "uvicorn main:app --host 127.0.0.1 --port 9000"


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
