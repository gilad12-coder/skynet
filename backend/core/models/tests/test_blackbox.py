"""Validate upstream engine input shapes and proposer runtime serialization."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from core.models.blackbox import BlackboxRepoSecret, BlackboxRepoSource, BlackboxRunRequest, BlackboxTarget


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


def test_autosaddler_accepts_separate_named_parts() -> None:
    """Accept a multipart seed for AutoSaddler, which the engine catalog advertises."""
    request = BlackboxRunRequest.model_validate(
        _payload(seed_candidate={"prompt": "x"}, strategy={"mode": "single", "engine": "autosaddler"})
    )

    assert request.seed_candidate == {"prompt": "x"}


@pytest.mark.parametrize(
    "strategy",
    [
        {"mode": "auto"},
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


def test_run_needs_neither_an_objective_nor_a_starting_point() -> None:
    """The scorer alone drives the climb, so a blank run starts from empty text."""
    request = BlackboxRunRequest.model_validate(_payload(seed_candidate=None, objective=None))
    assert request.seed_candidate == ""


def test_objective_without_a_starting_point_leaves_the_seed_to_be_drafted() -> None:
    """With an objective the seed stays unset so the engine can draft one from it."""
    request = BlackboxRunRequest.model_validate(_payload(seed_candidate=None, objective="Be concise"))
    assert request.seed_candidate is None


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
        ({"mode": "single", "engine": "autosaddler"}, True),
        ({"mode": "single", "engine": "autoresearch"}, False),
        ({"mode": "single", "engine": "gepa"}, False),
        ({"mode": "single", "engine": "best_of_n"}, False),
        ({"mode": "auto"}, False),
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


def _repo_request(**overrides: object) -> dict:
    """Build a valid repository run payload, with ``overrides`` applied.

    Args:
        **overrides: Top-level request fields to replace.

    Returns:
        The request payload.
    """
    payload = {
        "recipe": "anything",
        "scorer": {"kind": "python", "metric_code": "def score(repo_path):\n    return 1.0\n"},
        "reflection_model_config": {"name": "gpt-4o"},
        "budget": {"max_evals": 10},
        "strategy": {"mode": "single", "engine": "autoresearch"},
        "target": {
            "kind": "repo",
            "repo": {"repository": "octo/hello", "branch": "main", "editable_paths": ["src/"]},
        },
    }
    payload.update(overrides)
    return payload


def test_repo_run_starts_from_the_empty_patch() -> None:
    """A repository run needs no seed or objective; its seed is the empty patch."""
    request = BlackboxRunRequest.model_validate(_repo_request())
    assert request.seed_candidate == ""
    assert request.target.repo is not None
    assert request.target.repo.editable_paths == ["src"]


def test_repo_run_rejects_auto_mode() -> None:
    """Auto mode never takes a repository; a repository run picks one engine."""
    with pytest.raises(ValidationError, match="repository target"):
        BlackboxRunRequest.model_validate(_repo_request(strategy={"mode": "auto"}))


@pytest.mark.parametrize("engine", ["gepa", "best_of_n", "meta_harness", "autosaddler"])
def test_repo_run_accepts_every_checkout_editing_engine(engine: str) -> None:
    """Every single engine drives a coding agent through the checkout."""
    request = BlackboxRunRequest.model_validate(_repo_request(strategy={"mode": "single", "engine": engine}))
    assert request.strategy.engine == engine


def test_repo_run_rejects_a_multi_part_seed() -> None:
    """The starting point of a repository run is its commit, never named parts."""
    with pytest.raises(ValidationError, match="multi-part"):
        BlackboxRunRequest.model_validate(_repo_request(seed_candidate={"a": "b"}))


@pytest.mark.parametrize("path", ["/etc", "../up", "src/../../x", ".git", ".git/hooks", "", "a//b"])
def test_editable_paths_must_stay_inside_the_repository(path: str) -> None:
    """Absolute paths, parent walks, empty segments and .git are refused."""
    with pytest.raises(ValidationError):
        BlackboxRepoSource(repository="octo/hello", editable_paths=[path])


def test_editable_paths_are_normalized_and_deduplicated() -> None:
    """Backslashes and trailing slashes normalize; duplicates collapse; ``.`` means everything."""
    source = BlackboxRepoSource(repository="octo/hello", editable_paths=["src\\lib/", "src/lib", "./"])
    assert source.editable_paths == ["src/lib", "."]


def test_repo_secret_needs_exactly_one_source() -> None:
    """A secret is either typed for this run or picked from the account."""
    with pytest.raises(ValidationError):
        BlackboxRepoSecret(name="TOKEN")
    with pytest.raises(ValidationError):
        BlackboxRepoSecret(name="TOKEN", value="v", saved_secret_id="abc")
    assert BlackboxRepoSecret(name="TOKEN", saved_secret_id="abc").value is None
    assert BlackboxRepoSecret(name="TOKEN", credential_ref="ref", credential_revision=1).value is None
    with pytest.raises(ValidationError):
        BlackboxRepoSecret(name="TOKEN", value="v", credential_ref="ref", credential_revision=1)


def test_repo_secret_names_are_unique() -> None:
    """Two secrets cannot set the same environment variable."""
    with pytest.raises(ValidationError, match="once"):
        BlackboxRepoSource(
            repository="octo/hello",
            editable_paths=["src"],
            secrets=[{"name": "T", "value": "a"}, {"name": "T", "value": "b"}],
        )


def test_repo_field_only_on_repository_targets() -> None:
    """A repo kind needs a repo, and other kinds cannot carry one."""
    with pytest.raises(ValidationError):
        BlackboxTarget(kind="repo")
    with pytest.raises(ValidationError):
        BlackboxTarget(kind="text", repo={"repository": "octo/hello", "editable_paths": ["src"]})


@pytest.mark.parametrize("repository", ["octo", "octo/hello/extra", "octo/hel lo", "https://github.com/octo/hello"])
def test_repository_must_be_owner_slash_name(repository: str) -> None:
    """Only the ``owner/name`` form is accepted."""
    with pytest.raises(ValidationError):
        BlackboxRepoSource(repository=repository, editable_paths=["src"])


def test_repo_run_needs_a_python_scorer() -> None:
    """A remote endpoint never sees the checkout, so a repository run is scored by Python code."""
    with pytest.raises(ValidationError, match="scored by Python code"):
        BlackboxRunRequest.model_validate(
            _repo_request(scorer={"kind": "remote", "url": "https://scorer.example.com/score"})
        )
