"""Tests for the local-mode settings and their hosted-safety check."""

# mypy: disable-error-code="call-arg"

from __future__ import annotations

import pytest
from pydantic import ValidationError

from core.config import Settings
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
