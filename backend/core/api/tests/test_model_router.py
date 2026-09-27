"""Unit tests for the agent composers' model routing."""

from __future__ import annotations

import pytest

from ...config import DEFAULT_AGENT_MODEL_ID
from .. import model_catalog
from .. import model_router as mr
from ..errors import DomainError
from ..model_catalog import CatalogModel, ModelCatalogResponse
from ..model_router import effective_reasoning_effort, route_agent_model, route_menu_model

_DEFAULT_ID = "openrouter/z-ai/glm-5.3-flash"


def _catalog_with(*model_ids: str, default: str | None = None) -> ModelCatalogResponse:
    """Build a minimal catalog response listing the given model ids plus the default."""
    ids = [*model_ids, default] if default else list(model_ids)
    return ModelCatalogResponse(
        providers=[],
        models=[
            CatalogModel(value=mid, label=mid, provider="test", available=True, is_default=mid == default)
            for mid in ids
        ],
    )


@pytest.mark.parametrize("model", [None, "", "  ", "auto:intelligent"], ids=["none", "empty", "whitespace", "retired_sentinel"])
def test_no_pick_runs_catalog_default(monkeypatch: pytest.MonkeyPatch, model: str | None) -> None:
    """No pick, and the retired Auto sentinel, run the catalog's flagged default."""
    monkeypatch.setattr(
        mr,
        "get_catalog_cached",
        lambda: _catalog_with("openrouter/anthropic/claude-sonnet-5", "openai/gpt-5.5", default=_DEFAULT_ID),
    )
    assert route_menu_model(model) == _DEFAULT_ID
    assert route_agent_model(model).name == _DEFAULT_ID


def test_without_catalog_default_degrades(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no flagged default, the engine's configured default runs."""
    monkeypatch.setattr(model_catalog, "_cached_response", None)
    monkeypatch.setattr(mr, "get_catalog_cached", lambda: _catalog_with("openai/gpt-5.5"))
    assert route_menu_model(None) is None
    assert route_agent_model(None).name == DEFAULT_AGENT_MODEL_ID


def test_route_survives_catalog_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """A gateway outage routes to the server default instead of raising."""
    monkeypatch.setattr(model_catalog, "_cached_response", None)

    def _boom() -> ModelCatalogResponse:
        raise RuntimeError("gateway down")

    monkeypatch.setattr(mr, "get_catalog_cached", _boom)
    assert route_menu_model(None) is None
    assert route_agent_model(None).name == DEFAULT_AGENT_MODEL_ID


def test_route_menu_model_passes_catalog_id_through(monkeypatch: pytest.MonkeyPatch) -> None:
    """An explicit catalog id is validated and returned as-is."""
    monkeypatch.setattr(
        model_catalog, "get_catalog_cached", lambda: _catalog_with("openai/gpt-5.5")
    )
    assert route_menu_model("openai/gpt-5.5") == "openai/gpt-5.5"
    assert route_agent_model("openai/gpt-5.5").name == "openai/gpt-5.5"


def test_route_menu_model_routes_removed_model_to_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """A withdrawn model id from a stale pref runs the default instead of raising."""
    monkeypatch.setattr(mr, "get_catalog_cached", lambda: _catalog_with("openai/gpt-5.5", default=_DEFAULT_ID))
    monkeypatch.setattr(model_catalog, "get_catalog_cached", lambda: _catalog_with("openai/gpt-5.5", default=_DEFAULT_ID))
    assert route_menu_model("openrouter/x-ai/grok-build") == _DEFAULT_ID


def test_route_menu_model_rejects_unknown_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """A non-catalog id is refused before any LLM spend."""
    monkeypatch.setattr(
        model_catalog, "get_catalog_cached", lambda: _catalog_with("openai/gpt-5.5")
    )
    with pytest.raises(DomainError) as err:
        route_menu_model("openai/not-a-model")
    assert err.value.status_code == 422


def _effort_catalog() -> ModelCatalogResponse:
    """Build a catalog with one default-on thinker and one opt-in thinker."""
    return ModelCatalogResponse(
        providers=[],
        models=[
            CatalogModel(
                value="deepseek/flash", label="flash", provider="test", available=True,
                reasoning_efforts=["low", "high", "max"], default_reasoning_effort="high",
                reasoning_default_enabled=True,
            ),
            CatalogModel(
                value="deepseek/pro", label="pro", provider="test", available=True,
                reasoning_efforts=["low", "high", "max"], default_reasoning_effort="high",
                reasoning_default_enabled=False,
            ),
        ],
    )  # fmt: skip


@pytest.mark.parametrize(
    ("model", "requested", "expected"),
    [
        ("deepseek/flash", None, "high"),
        ("deepseek/pro", None, None),
        ("deepseek/flash", "max", "max"),
        ("deepseek/flash", "medium", "high"),
        ("deepseek/flash", "minimal", "low"),
        ("deepseek/flash", "xhigh", "max"),
        ("unknown/model", "medium", "medium"),
        (None, "medium", "medium"),
    ],
)
def test_effective_reasoning_effort(
    monkeypatch: pytest.MonkeyPatch, model: str | None, requested: str | None, expected: str | None
) -> None:
    """Default resolves to the catalog default; explicit picks snap onto the model's ladder."""
    monkeypatch.setattr(mr, "get_catalog_cached", _effort_catalog)
    assert effective_reasoning_effort(model, requested) == expected


def test_agent_model_id_prefers_configured_then_cached_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """An operator id wins; else the built catalog's default; else the static fallback."""
    monkeypatch.setattr(model_catalog, "_cached_response", None)
    assert model_catalog.agent_model_id("") == DEFAULT_AGENT_MODEL_ID
    monkeypatch.setattr(model_catalog, "_cached_response", _catalog_with("openai/gpt-5.5", default="openai/o-best"))
    assert model_catalog.agent_model_id("") == "openai/o-best"
    assert model_catalog.agent_model_id(" openai/gpt-5.5 ") == "openai/gpt-5.5"
