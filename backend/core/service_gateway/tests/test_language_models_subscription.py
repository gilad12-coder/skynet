"""Tests for API-side subscription models: routing, zero billed cost, model time and the router."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from core import config
from core.api import model_router
from core.api.errors import DomainError
from core.billing import cli_dispatch
from core.billing.tests.test_cli_runners import CLAUDE_SUCCESS, fake_cli, local_settings, printing
from core.exceptions import ServiceError
from core.models import ModelConfig
from core.service_gateway import language_models
from core.service_gateway.agents import generalist
from core.service_gateway.language_models import LmUsageTotals, build_language_model
from core.service_gateway.optimization.blackbox.workspace_harness import attempt_record

MODEL = "anthropic/claude-haiku-4.5"
SUBSCRIPTION_ID = f"subscription/claude/{MODEL}"


@pytest.fixture
def local(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Turn local mode on everywhere with a fake claude and a fresh loopback gateway."""
    fake_cli(tmp_path, "claude", printing(CLAUDE_SUCCESS))
    current = local_settings(tmp_path)
    monkeypatch.setattr(config, "settings", current)
    monkeypatch.setattr(language_models, "settings", current)
    monkeypatch.setattr(model_router, "settings", current)
    monkeypatch.setattr(cli_dispatch, "_gateway", None)
    monkeypatch.setattr(cli_dispatch, "_list_prices", lambda model: None)


@pytest.mark.usefixtures("local")
def test_subscription_config_uses_the_local_route() -> None:
    """Point a subscription model at the loopback CLI route with its own token."""
    lm = build_language_model(ModelConfig(name=MODEL, token_source="subscription", cli_provider="claude"))
    assert lm.model == f"litellm_proxy/{MODEL}"
    assert str(lm.kwargs["base_url"]).startswith("http://127.0.0.1:")
    route = cli_dispatch.local_subscription_route(MODEL, "claude", "agent")
    assert lm.kwargs["api_key"] == route["token"]


@pytest.mark.usefixtures("local")
def test_subscription_model_answers_through_dspy() -> None:
    """Answer a real DSPy call from the fake CLI through the loopback route."""
    lm = build_language_model(
        ModelConfig(name=SUBSCRIPTION_ID, token_source="subscription", cli_provider="claude"), disable_cache=True
    )
    assert lm("ping") == ["pong"]
    assert lm.usage_totals.calls == 1
    assert lm.usage_totals.reported_cost_usd == 0.0
    assert lm.usage_totals.model_ms == 1326


def test_subscription_config_outside_local_mode_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """Refuse a subscription model when local mode is off."""
    monkeypatch.setattr(config.settings, "local_mode", False)
    with pytest.raises(ServiceError):
        build_language_model(ModelConfig(name=MODEL, token_source="subscription", cli_provider="claude"))


def test_subscription_usage_bills_nothing() -> None:
    """Report no billed cost for a subscription call, though its list price is kept."""
    totals = LmUsageTotals()
    totals.add_split({"cost": 0.25, "token_source": "subscription", "model_ms": 40}, (10, 2))
    totals.add_split({"cost": 0.5}, (10, 2))
    assert totals.reported_cost_usd == 0.5
    assert totals.model_ms == 40


def test_attempt_record_prefers_model_time() -> None:
    """Use the usage block's ``model_ms`` as the attempt time when it is present."""
    usage = {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4, "cost": 0.001, "model_ms": 250}
    body = json.dumps({"usage": usage}).encode()
    assert attempt_record("task", 200, 9.0, body)["ms"] == 250.0
    without = json.dumps({"usage": {k: v for k, v in usage.items() if k != "model_ms"}}).encode()
    assert attempt_record("task", 200, 9.0, without)["ms"] == 9000.0


@pytest.mark.usefixtures("local")
def test_router_accepts_subscription_ids_in_local_mode() -> None:
    """Keep a subscription id in local mode and build its subscription config."""
    assert model_router.route_menu_model(SUBSCRIPTION_ID) == SUBSCRIPTION_ID
    agent = model_router.route_agent_model(SUBSCRIPTION_ID)
    assert (agent.name, agent.token_source, agent.cli_provider) == (MODEL, "subscription", "claude")
    with pytest.raises(DomainError) as caught:
        model_router.route_menu_model("subscription/codex/anthropic/claude-haiku-4.5")
    assert (caught.value.status_code, caught.value.code) == (422, "billing.subscription_unmapped_model")


MANAGED_DEFAULT = "openrouter/z-ai/glm-5.3-flash"


@pytest.mark.usefixtures("local")
@pytest.mark.parametrize("model", [None, "", "auto:intelligent"], ids=["none", "empty", "retired_sentinel"])
@pytest.mark.parametrize(
    "route",
    [model_router.route_menu_model, model_router.route_interview_model, model_router.route_agent_model],
    ids=["menu", "interview", "agent"],
)
def test_local_mode_never_falls_back_to_a_managed_model(
    monkeypatch: pytest.MonkeyPatch, route: object, model: str | None
) -> None:
    """Refuse a turn with no subscription pick instead of sending it to managed OpenRouter.

    Args:
        monkeypatch: Gives the catalog and interview a managed default.
        route: The composer router under test.
        model: A request that picks no model.
    """
    monkeypatch.setattr(model_router, "default_model_id", lambda: MANAGED_DEFAULT)
    monkeypatch.setattr(model_router, "interview_model_id", lambda: MANAGED_DEFAULT)
    with pytest.raises(DomainError) as caught:
        route(model)
    assert (caught.value.status_code, caught.value.code) == (422, "models.managed_unavailable_local")


@pytest.mark.parametrize(
    "route", [model_router.route_menu_model, model_router.route_interview_model], ids=["menu", "interview"]
)
def test_hosted_mode_still_falls_back_to_the_managed_default(monkeypatch: pytest.MonkeyPatch, route: object) -> None:
    """Keep the managed default for a hosted turn with no pick.

    Args:
        monkeypatch: Keeps local mode off and gives a managed default.
        route: The composer router under test.
    """
    monkeypatch.setattr(model_router.settings, "local_mode", False)
    monkeypatch.setattr(model_router, "default_model_id", lambda: MANAGED_DEFAULT)
    monkeypatch.setattr(model_router, "interview_model_id", lambda: MANAGED_DEFAULT)
    assert route(None) == MANAGED_DEFAULT


async def test_local_mode_labels_no_thinking_on_a_managed_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Skip the managed thinking-summary side call in local mode.

    Args:
        monkeypatch: Turns local mode on and fails any summary model build.
    """

    def managed_lm() -> None:
        """Fail the test if a managed summary model is built."""
        raise AssertionError("local mode built the managed summary model")

    monkeypatch.setattr(generalist.settings, "local_mode", True)
    monkeypatch.setattr(generalist, "_build_summary_lm", managed_lm)
    sink: list = []
    summaries = generalist._thinking_summaries("English", asyncio.Queue(), sink)

    assert await summaries._summarize("Reading the dataset columns.") is None
    assert sink == []


def test_router_ignores_subscription_ids_outside_local_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never return a subscription config when local mode is off."""
    monkeypatch.setattr(model_router.settings, "local_mode", False)
    try:
        agent = model_router.route_agent_model(SUBSCRIPTION_ID)
    except DomainError:
        return
    assert agent.token_source != "subscription"
