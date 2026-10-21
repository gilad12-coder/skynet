"""Tests for thinking summaries in local mode: built on the user's agent engine, never on a managed model."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from core import config
from core.api import model_router
from core.billing import cli_dispatch
from core.billing.tests.test_cli_runners import CLAUDE_SUCCESS, fake_cli, local_settings, printing
from core.constants import TOKEN_SOURCE_BYOK
from core.local.cli_catalog import CLI_MODELS
from core.models import ModelConfig
from core.service_gateway import language_models
from core.service_gateway.agents import generalist
from core.service_gateway.agents.generalist import WizardState

INTERVIEW_MODEL = "google/gemini-3.5-flash"
REASONING = "The question column holds the input and the answer column holds the expected output for each row."
LABEL = "Matching columns to inputs\nThe question column becomes the input."


class _LabelLM:
    """A summary model stand-in that answers every call with one label."""

    side_call = False

    def __call__(self, messages: list[dict]) -> list[str]:
        """Answer a label call.

        Args:
            messages: The call's chat messages.

        Returns:
            One label.
        """
        return [LABEL]


@pytest.fixture
def built(monkeypatch: pytest.MonkeyPatch) -> list[ModelConfig]:
    """Record each config the summary path builds an LM from, and fail any managed build.

    Args:
        monkeypatch: Replaces the LM builder and the managed summary builder.

    Returns:
        The configs, in build order.
    """
    configs: list[ModelConfig] = []

    def build(model_config: ModelConfig, *, disable_cache: bool = False) -> _LabelLM:
        """Record the config and return a label model."""
        configs.append(model_config)
        return _LabelLM()

    def managed() -> None:
        """Fail the test if the managed summary model is built."""
        raise AssertionError("local mode built the managed summary model")

    monkeypatch.setattr(generalist.settings, "local_mode", True)
    monkeypatch.setattr(generalist, "build_language_model", build)
    monkeypatch.setattr(generalist, "_build_summary_lm", managed)
    monkeypatch.setattr(generalist, "interview_model_id", lambda: INTERVIEW_MODEL)
    return configs


def _byok_turn() -> ModelConfig:
    """Return a turn config as ``route_local_byok_model`` resolves it, with a high effort.

    Returns:
        A BYOK OpenRouter config that carries a fake key.
    """
    return ModelConfig(
        name="anthropic/claude-opus-5.5",
        token_source=TOKEN_SOURCE_BYOK,
        byok_provider="openrouter",
        extra={"api_key": "sk-or-fake", "reasoning_effort": "high", "extra_body": {"provider": {"sort": "price"}}},
    )


async def test_local_summary_runs_on_the_saved_openrouter_key(built: list[ModelConfig]) -> None:
    """Label thinking with a small model on the turn's saved OpenRouter key, metered with the turn."""
    sink: list = []
    summaries = generalist._thinking_summaries("English", asyncio.Queue(), sink, _byok_turn())

    assert await summaries._summarize(REASONING) == generalist._clean_summary(LABEL)
    assert await summaries._summarize(REASONING) == generalist._clean_summary(LABEL)
    assert len(built) == 1
    summary = built[0]
    assert summary.name == INTERVIEW_MODEL
    assert summary.token_source == TOKEN_SOURCE_BYOK
    assert summary.byok_provider == "openrouter"
    assert summary.extra["api_key"] == "sk-or-fake"
    assert summary.extra.get("reasoning_effort") != "high"
    assert summary.extra["extra_body"]["provider"] == {"sort": "price"}
    assert summary.extra["timeout"] == generalist._SUMMARY_TIMEOUT_SECONDS
    assert summary.extra["num_retries"] == 0
    # The user's key must never reach the managed gateway.
    assert summary.base_url is None
    assert len(sink) == 1
    assert sink[0].side_call is True


async def test_local_summary_drops_the_connection_reasoning_body(
    built: list[ModelConfig], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep a saved connection's ``extra_body`` reasoning out of the label, so only the no-thinking settings apply."""
    monkeypatch.setattr(generalist, "_no_thinking_extra", lambda model: {"reasoning_effort": "none"})
    turn = _byok_turn()
    turn.extra["extra_body"] = {"provider": {"sort": "price"}, "reasoning": {"effort": "high"}}
    summaries = generalist._thinking_summaries("English", asyncio.Queue(), [], turn)

    assert await summaries._summarize(REASONING) == generalist._clean_summary(LABEL)
    summary = built[0]
    assert summary.extra["reasoning_effort"] == "none"
    assert summary.extra["extra_body"] == {"provider": {"sort": "price"}}
    # The turn keeps its own reasoning body.
    assert turn.extra["extra_body"]["reasoning"] == {"effort": "high"}


async def test_local_summary_drops_the_connection_top_level_reasoning(
    built: list[ModelConfig], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep a saved connection's top-level ``reasoning`` and ``thinking`` params out of the label."""
    monkeypatch.setattr(generalist, "_no_thinking_extra", lambda model: {"reasoning_effort": "none"})
    turn = _byok_turn()
    turn.extra["reasoning"] = {"effort": "high"}
    turn.extra["thinking"] = {"type": "enabled", "budget_tokens": 4096}
    summaries = generalist._thinking_summaries("English", asyncio.Queue(), [], turn)

    assert await summaries._summarize(REASONING) == generalist._clean_summary(LABEL)
    summary = built[0]
    assert summary.extra["reasoning_effort"] == "none"
    assert "reasoning" not in summary.extra
    assert "thinking" not in summary.extra
    # The turn keeps its own params.
    assert turn.extra["reasoning"] == {"effort": "high"}
    assert turn.extra["thinking"] == {"type": "enabled", "budget_tokens": 4096}


async def test_local_turn_labels_thinking_on_its_own_saved_key(
    built: list[ModelConfig], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pass the turn's config from ``run_generalist_agent`` to the label, so a local BYOK turn gets labels."""

    async def fake_drive(*, emit: Any, **_kwargs: Any) -> str:
        """Stream one stretch of thinking, then reply.

        Args:
            emit: The turn's emitter.

        Returns:
            The reply.
        """
        emit({"event": "reasoning_patch", "data": {"chunk": REASONING}})
        await asyncio.sleep(0)
        return "ok"

    monkeypatch.setattr(generalist, "_drive_generalist_agent", fake_drive)
    monkeypatch.setattr(generalist, "served_model_from", lambda lm: None)

    events = [
        ev
        async for ev in generalist.run_generalist_agent(
            wizard_state=WizardState(),
            chat_history=[],
            user_message="go",
            model_config=_byok_turn(),
            locale="en",
            usage_sink=[],
        )
    ]

    labels = [e["data"]["text"] for e in events if e["event"] == "thinking_summary"]
    assert labels == [generalist._clean_summary(LABEL)]
    turn, summary = built
    assert turn.name == "anthropic/claude-opus-5.5"
    assert summary.name == INTERVIEW_MODEL
    assert summary.token_source == TOKEN_SOURCE_BYOK
    assert summary.extra["api_key"] == "sk-or-fake"


async def test_local_summary_runs_on_the_selected_cli(built: list[ModelConfig]) -> None:
    """Label thinking on the turn's CLI subscription, with a small model that CLI runs."""
    turn = ModelConfig(name="anthropic/claude-opus-5.5", token_source="subscription", cli_provider="claude")
    sink: list = []
    summaries = generalist._thinking_summaries("English", asyncio.Queue(), sink, turn)

    assert await summaries._summarize(REASONING) == generalist._clean_summary(LABEL)
    assert len(built) == 1
    summary = built[0]
    assert summary.token_source == "subscription"
    assert summary.cli_provider == "claude"
    assert summary.name in CLI_MODELS["claude"]
    assert summary.name != turn.name
    assert len(sink) == 1


@pytest.mark.parametrize("cli", list(CLI_MODELS))
def test_every_cli_has_a_summary_model_it_runs(cli: str) -> None:
    """Name a summary model in each CLI's own catalog, so no CLI engine is left without labels."""
    assert generalist._LOCAL_SUMMARY_MODELS[cli] in CLI_MODELS[cli]  # type: ignore[index]


@pytest.mark.parametrize(
    "turn",
    [None, ModelConfig(name="anthropic/claude-opus-5.5")],
    ids=["no-engine", "managed-config"],
)
async def test_local_summary_is_off_with_no_usable_engine(built: list[ModelConfig], turn: ModelConfig | None) -> None:
    """Build no model and give no model label when the turn has no BYOK key or CLI.

    Args:
        built: Records any LM build.
        turn: The turn's config.
    """
    sink: list = []
    summaries = generalist._thinking_summaries("English", asyncio.Queue(), sink, turn)

    assert await summaries._summarize(REASONING) is None
    assert built == []
    assert sink == []


async def test_hosted_summary_stays_on_the_managed_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep hosted labels on the managed summary model, also for a BYOK turn."""
    managed = _LabelLM()
    monkeypatch.setattr(generalist.settings, "local_mode", False)
    monkeypatch.setattr(generalist, "_build_summary_lm", lambda: managed)
    sink: list = []
    summaries = generalist._thinking_summaries("English", asyncio.Queue(), sink, _byok_turn())

    assert await summaries._summarize(REASONING) == generalist._clean_summary(LABEL)
    assert sink == [managed]


async def test_local_cli_summary_answers_through_the_fake_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Get a label from a fake claude CLI through the loopback gateway, at zero billed cost."""
    fake_cli(tmp_path, "claude", printing({**CLAUDE_SUCCESS, "result": LABEL}))
    current = local_settings(tmp_path)
    for module in (config, language_models, model_router, generalist):
        monkeypatch.setattr(module, "settings", current)
    monkeypatch.setattr(cli_dispatch, "_gateway", None)
    monkeypatch.setattr(cli_dispatch, "_list_prices", lambda model: None)
    turn = ModelConfig(name="anthropic/claude-opus-5.5", token_source="subscription", cli_provider="claude")
    sink: list[Any] = []
    summaries = generalist._thinking_summaries("English", asyncio.Queue(), sink, turn)

    assert await summaries._summarize(REASONING) == generalist._clean_summary(LABEL)
    assert len(sink) == 1
    assert sink[0].subscription is True
    assert sink[0].usage_totals.reported_cost_usd == 0.0
    log = (tmp_path / "claude.log").read_text()
    assert CLI_MODELS["claude"][generalist._LOCAL_SUMMARY_MODELS["claude"]] in log
