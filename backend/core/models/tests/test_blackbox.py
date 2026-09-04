"""Validate upstream engine input shapes and proposer runtime serialization."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from core.models.blackbox import BlackboxRunRequest


def _payload(**overrides: Any) -> dict[str, Any]:
    """Build a deterministic blackbox request without executing code.

    Args:
        **overrides: Fields replacing the base request values.

    Returns:
        JSON-compatible input for request validation.
    """
    return {
        "seed_candidate": "candidate",
        "scorer": {"kind": "remote", "url": "https://example.com/score"},
        "reflection_model_config": {"name": "gpt-4o"},
        "strategy": {"mode": "single", "engine": "gepa"},
        **overrides,
    }


def test_vercel_is_the_only_proposer_runtime() -> None:
    """Default new requests to the managed sandbox."""
    request = BlackboxRunRequest.model_validate(_payload())

    assert request.proposer_runtime == "vercel"


@pytest.mark.parametrize("engine", ["meta_harness", "autoresearch"])
@pytest.mark.parametrize("runtime", ["worker", "vercel"])
def test_native_engine_normalizes_legacy_runtime_without_requiring_agent_target(engine: str, runtime: str) -> None:
    """Run legacy and current inputs in Vercel while keeping evaluation independent.

    Args:
        engine: Native upstream optimizer.
        runtime: Current or retired execution value.
    """
    request = BlackboxRunRequest.model_validate(
        _payload(strategy={"mode": "single", "engine": engine}, proposer_runtime=runtime)
    )

    assert request.target.kind == "text"
    assert request.cases is None
    assert request.model_dump(by_alias=True)["proposer_runtime"] == "vercel"


def test_only_gepa_accepts_separate_named_parts() -> None:
    """Accept the upstream GEPA multipart contract."""
    request = BlackboxRunRequest.model_validate(_payload(seed_candidate={"prompt": "candidate"}))

    assert request.seed_candidate == {"prompt": "candidate"}


@pytest.mark.parametrize(
    "strategy",
    [
        {"mode": "auto"},
        {"mode": "plateau"},
        {"mode": "single", "engine": "meta_harness"},
        {"mode": "single", "engine": "autoresearch"},
        {"mode": "single", "engine": "best_of_n"},
    ],
)
def test_other_upstream_recipes_reject_multipart_seeds(strategy: dict[str, str]) -> None:
    """Reject multipart seeds when the selected upstream recipe only accepts strings.

    Args:
        strategy: Recipe without upstream multipart support.
    """
    with pytest.raises(ValidationError, match="Multi-part starting points"):
        BlackboxRunRequest.model_validate(_payload(seed_candidate={"prompt": "candidate"}, strategy=strategy))


def test_unknown_proposer_runtime_is_rejected() -> None:
    """Reject an unsupported runtime rather than silently selecting it."""
    with pytest.raises(ValidationError, match="proposer_runtime"):
        BlackboxRunRequest.model_validate(_payload(proposer_runtime="local"))


def test_agent_target_carries_one_matching_billable_task_model() -> None:
    """Preserve the full task-model billing role while retaining the harness model id."""
    request = BlackboxRunRequest.model_validate(
        _payload(
            cases=[{"task": "fix it"}],
            target={"kind": "agent", "model": "openrouter/openai/gpt-4o"},
            task_model_config={
                "name": "openrouter/openai/gpt-4o",
                "token_source": "byok",
                "byok_provider": "openrouter",
            },
        )
    )

    assert request.target.model == request.task_model_settings.name
    assert request.task_model_settings.token_source == "byok"


def test_agent_target_rejects_mismatched_task_model_role() -> None:
    """Prevent the billed task role from routing a different model than the harness names."""
    with pytest.raises(ValidationError, match="must identify the same model"):
        BlackboxRunRequest.model_validate(
            _payload(
                cases=[{"task": "fix it"}],
                target={"kind": "agent", "model": "openrouter/openai/gpt-4o"},
                task_model_config={"name": "openrouter/anthropic/claude-sonnet-4"},
            )
        )


@pytest.mark.parametrize(
    ("strategy", "supported"),
    [
        ({"mode": "single", "engine": "meta_harness"}, True),
        ({"mode": "single", "engine": "autoresearch"}, False),
        ({"mode": "single", "engine": "gepa"}, False),
        ({"mode": "single", "engine": "best_of_n"}, False),
        ({"mode": "auto"}, False),
        ({"mode": "plateau"}, False),
    ],
)
def test_iteration_limit_requires_single_meta_harness(strategy: dict[str, str], supported: bool) -> None:
    """Reject iteration limits that the selected upstream recipe cannot honor.

    Args:
        strategy: Requested upstream recipe.
        supported: Whether the recipe honors an iteration cap.
    """
    payload = _payload(strategy=strategy, budget={"max_scorer_runs": 20, "max_iterations": 3})
    if supported:
        request = BlackboxRunRequest.model_validate(payload)
        assert request.budget.max_iterations == 3
    else:
        with pytest.raises(ValidationError, match="iteration limit is only supported by single Meta-Harness"):
            BlackboxRunRequest.model_validate(payload)

    payload["budget"]["max_iterations"] = None
    assert BlackboxRunRequest.model_validate(payload).budget.max_iterations is None
