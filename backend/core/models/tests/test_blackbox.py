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


def test_worker_is_the_default_proposer_runtime() -> None:
    """Preserve compatibility for requests and drafts created before runtime selection."""
    request = BlackboxRunRequest.model_validate(_payload())

    assert request.proposer_runtime == "worker"


@pytest.mark.parametrize("engine", ["meta_harness", "autoresearch"])
@pytest.mark.parametrize("runtime", ["worker", "vercel"])
def test_native_engine_preserves_runtime_without_requiring_agent_target(engine: str, runtime: str) -> None:
    """Retain either runtime while keeping evaluation independent of native proposal generation.

    Args:
        engine: Native upstream optimizer.
        runtime: Supported execution location.
    """
    request = BlackboxRunRequest.model_validate(
        _payload(strategy={"mode": "single", "engine": engine}, proposer_runtime=runtime)
    )

    assert request.target.kind == "text"
    assert request.cases is None
    assert request.model_dump(by_alias=True)["proposer_runtime"] == runtime


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
    """Reject an unsupported runtime rather than silently selecting a worker."""
    with pytest.raises(ValidationError, match="proposer_runtime"):
        BlackboxRunRequest.model_validate(_payload(proposer_runtime="local"))


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
