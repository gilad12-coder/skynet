"""Tests for the subscription model catalog and its model-id parser."""

from __future__ import annotations

import pytest

from core.local.cli_catalog import CLI_MODELS, MIN_VERSIONS, cli_model_arg, parse_subscription_model_id


@pytest.mark.parametrize(
    ("model_id", "expected"),
    [
        ("subscription/claude/anthropic/claude-sonnet-4.6", ("claude", "anthropic/claude-sonnet-4.6")),
        ("subscription/codex/openai/gpt-6-sol", ("codex", "openai/gpt-6-sol")),
        ("subscription/droid/z-ai/glm-5.3/", ("droid", "z-ai/glm-5.3")),
    ],
)
def test_parse_subscription_model_id_splits_cli_and_slug(model_id: str, expected: tuple[str, str]) -> None:
    """A well-formed id gives its CLI and catalog slug.

    Args:
        model_id: The wire model id.
        expected: The ``(cli, slug)`` pair it must give.
    """
    assert parse_subscription_model_id(model_id) == expected


@pytest.mark.parametrize(
    "model_id",
    [
        "anthropic/claude-sonnet-4.6",
        "openrouter/subscription/claude/anthropic/claude-sonnet-4.6",
        "subscription/gemini/google/gemini-3.5-flash",
        "subscription/claude",
        "subscription/claude/",
        "",
    ],
)
def test_parse_subscription_model_id_rejects_other_ids(model_id: str) -> None:
    """An id without the prefix, a known CLI and a slug gives ``None``.

    Args:
        model_id: The wire model id.
    """
    assert parse_subscription_model_id(model_id) is None


def test_cli_model_arg_maps_slug_to_cli_name() -> None:
    """Each CLI gets its own ``--model`` name for a catalog slug."""
    assert cli_model_arg("claude", "anthropic/claude-sonnet-4.5") == "claude-sonnet-4-5-20250929"
    assert cli_model_arg("droid", "anthropic/claude-haiku-4.5") == "claude-haiku-4-5-20251001"
    assert cli_model_arg("codex", "openai/gpt-6-sol") == "gpt-6-sol"


def test_cli_model_arg_rejects_unmapped_slug() -> None:
    """A slug the CLI does not serve raises instead of guessing a name."""
    with pytest.raises(ValueError, match="no model"):
        cli_model_arg("codex", "anthropic/claude-sonnet-4.6")
    with pytest.raises(ValueError, match="Unknown CLI"):
        cli_model_arg("gemini", "google/gemini-3.5-flash")  # type: ignore[arg-type]


def test_every_cli_has_models_and_a_minimum_version() -> None:
    """The catalog and the version table cover the same three CLIs."""
    assert set(CLI_MODELS) == set(MIN_VERSIONS) == {"codex", "claude", "droid"}
    assert all(CLI_MODELS[cli] for cli in CLI_MODELS)
