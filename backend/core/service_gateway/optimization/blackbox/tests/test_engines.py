"""Tests for the in-process engines and the registry."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from core.exceptions import ServiceError
from core.models.blackbox import (
    BLACKBOX_ENGINE_AUTORESEARCH,
    BLACKBOX_ENGINE_BEST_OF_N,
    BLACKBOX_ENGINE_GEPA,
    BLACKBOX_ENGINE_META_HARNESS,
)

from .. import gepa_engine as gepa_mod
from ..best_of_n import BestOfNEngine, _strip_fences
from ..gepa_engine import GepaEngine
from ..meta_harness import MetaHarnessEngine
from ..protocol import BudgetExhaustedError, EvalServer, Task
from ..registry import ENGINES, EngineCapabilities, available_engine_ids, get_engine
from .mocks import FakeReflectionLM, make_ctx, vowel_scorer

_AGENT_CAPS = EngineCapabilities(sandbox=True, agent_target=True)


def test_registry_lists_only_runnable_engines() -> None:
    """Without sandboxes only the in-process engines run; AutoResearch never does."""
    assert available_engine_ids() == [BLACKBOX_ENGINE_GEPA, BLACKBOX_ENGINE_BEST_OF_N]
    assert isinstance(get_engine(BLACKBOX_ENGINE_GEPA), GepaEngine)
    assert isinstance(get_engine(BLACKBOX_ENGINE_BEST_OF_N), BestOfNEngine)
    for engine_id in (BLACKBOX_ENGINE_AUTORESEARCH, BLACKBOX_ENGINE_META_HARNESS):
        with pytest.raises(ServiceError, match="not available"):
            get_engine(engine_id)
    with pytest.raises(ServiceError, match="not implemented yet"):
        get_engine(BLACKBOX_ENGINE_AUTORESEARCH, _AGENT_CAPS)


def test_registry_unlocks_meta_harness_for_agent_targets_with_sandboxes() -> None:
    """Meta-Harness needs both a sandbox runtime and an agent target, and each miss is explained."""
    assert available_engine_ids(_AGENT_CAPS) == [
        BLACKBOX_ENGINE_GEPA,
        BLACKBOX_ENGINE_BEST_OF_N,
        BLACKBOX_ENGINE_META_HARNESS,
    ]
    assert isinstance(get_engine(BLACKBOX_ENGINE_META_HARNESS, _AGENT_CAPS), MetaHarnessEngine)
    spec = ENGINES[BLACKBOX_ENGINE_META_HARNESS]
    no_sandbox = EngineCapabilities(sandbox=False, agent_target=True, sandbox_reason="set VERCEL_TOKEN")
    assert spec.unavailable_reason_for(no_sandbox) == "set VERCEL_TOKEN"
    assert spec.unavailable_reason_for(EngineCapabilities(sandbox=False, agent_target=True)) == (
        "Agent sandboxes are not configured on this deployment."
    )
    text_target = EngineCapabilities(sandbox=True, agent_target=False)
    assert "target must be an agent" in str(spec.unavailable_reason_for(text_target))
    with pytest.raises(ServiceError, match="target must be an agent"):
        get_engine(BLACKBOX_ENGINE_META_HARNESS, text_target)


def test_registry_filters_multi_part_engines() -> None:
    """``parts=True`` keeps the engines that take a named-parts starting point."""
    assert available_engine_ids(parts=True) == [BLACKBOX_ENGINE_GEPA]
    assert available_engine_ids(_AGENT_CAPS, parts=True) == [BLACKBOX_ENGINE_GEPA, BLACKBOX_ENGINE_META_HARNESS]


def test_registry_rejects_unknown_engine() -> None:
    """An unknown id names the engines that do exist for the job."""
    with pytest.raises(ServiceError, match=r"Unknown engine 'nope'\. Available engines: gepa, best_of_n\."):
        get_engine("nope")
    with pytest.raises(ServiceError, match=r"Available engines: gepa, best_of_n, meta_harness\."):
        get_engine("nope", _AGENT_CAPS)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("```\nhello\n```", "hello"), ("```text\nhello\n```", "hello"), ("  plain  ", "plain"), ("``````", "")],
)
def test_strip_fences(raw: str, expected: str) -> None:
    """Surrounding code fences (with or without a language tag) are removed.

    Args:
        raw: The LM output.
        expected: The unwrapped text.
    """
    assert _strip_fences(raw) == expected


def test_best_of_n_keeps_the_best_proposal_within_budget(tmp_path: Path) -> None:
    """Best-of-N scores the seed, proposes until the budget is spent, and returns the best."""
    lm = FakeReflectionLM()
    server = EvalServer(vowel_scorer, max_evals=4)
    task = Task(seed_candidate="hello world", objective="more vowels", val_set=[{"i": 0}, {"i": 1}])

    result = BestOfNEngine().run(task, server, make_ctx(str(tmp_path), lm))

    # 2 cases per candidate: the seed plus one proposal fit a budget of 4.
    assert server.used == 4
    assert result.metadata == {"proposals": 1}
    assert result.best_candidate == "aeiou"
    assert result.best_score == 1.0
    assert result.total_evals == 4
    assert "Objective: more vowels" in lm.prompts[0]


def test_best_of_n_returns_seed_when_nothing_beats_it(tmp_path: Path) -> None:
    """A seed that no proposal beats is returned with its own score."""
    server = EvalServer(vowel_scorer, max_evals=3)
    task = Task(seed_candidate="aaa")

    result = BestOfNEngine().run(task, server, make_ctx(str(tmp_path), FakeReflectionLM(improving=False)))

    assert result.best_candidate == "aaa"
    assert result.best_score == 1.0
    assert result.metadata == {"proposals": 2}


def test_best_of_n_stops_at_target_score(tmp_path: Path) -> None:
    """``stop_at_score`` ends the loop before the budget is spent."""
    server = EvalServer(vowel_scorer, max_evals=10)
    task = Task(seed_candidate="hello", objective="vowels")

    result = BestOfNEngine().run(task, server, make_ctx(str(tmp_path), stop_at_score=0.9))

    assert result.best_score == 1.0
    assert server.used < 10


def test_best_of_n_works_without_a_seed(tmp_path: Path) -> None:
    """Seedless tasks get a first version from the objective alone."""
    lm = FakeReflectionLM()
    server = EvalServer(vowel_scorer, max_evals=2)

    result = BestOfNEngine().run(Task(seed_candidate=None, objective="vowels"), server, make_ctx(str(tmp_path), lm))

    assert result.best_candidate == "aeiou"
    assert "There is no version yet" in lm.prompts[0]


def test_best_of_n_refuses_multi_part_seeds(tmp_path: Path) -> None:
    """Named-part starting points are GEPA-only."""
    with pytest.raises(ServiceError, match="text starting points only"):
        BestOfNEngine().run(
            Task(seed_candidate={"a": "b"}), EvalServer(vowel_scorer, max_evals=5), make_ctx(str(tmp_path))
        )


def test_best_of_n_fails_when_seedless_and_out_of_budget(tmp_path: Path) -> None:
    """With no seed and no budget there is nothing to return."""
    with pytest.raises(ServiceError, match="could not produce a version"):
        BestOfNEngine().run(Task(seed_candidate=None), EvalServer(vowel_scorer, max_evals=0), make_ctx(str(tmp_path)))


def test_gepa_engine_returns_seed_without_budget(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No budget means GEPA is never started."""
    optimize = MagicMock()
    monkeypatch.setattr(gepa_mod, "optimize_anything", optimize)

    result = GepaEngine().run(
        Task(seed_candidate="seed"), EvalServer(vowel_scorer, max_evals=0), make_ctx(str(tmp_path))
    )

    assert result.best_candidate == "seed"
    assert result.total_evals == 0
    optimize.assert_not_called()


def test_gepa_engine_routes_evaluations_and_unwraps_text_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """GEPA scores only through the server and its dict-shaped text winner is unwrapped."""
    seen: dict[str, Any] = {}

    def fake_optimize(**kwargs: Any) -> Any:
        """Score two versions through the evaluator and report the better one."""
        seen.update(kwargs)
        kwargs["evaluator"]("aaa", kwargs["dataset"][0])
        kwargs["evaluator"]("xxx", kwargs["dataset"][0])
        gepa_result = MagicMock()
        gepa_result.best_candidate = {"current_candidate": "aaa"}
        gepa_result.best_idx = 1
        gepa_result.val_aggregate_scores = [0.0, 1.0]
        gepa_result.candidates = [{}, {}]
        gepa_result.total_metric_calls = 2
        return gepa_result

    monkeypatch.setattr(gepa_mod, "optimize_anything", fake_optimize)
    server = EvalServer(vowel_scorer, max_evals=7)
    task = Task(seed_candidate="seed", objective="vowels", background="bg", train_set=[{"i": 0}], val_set=[{"i": 1}])

    result = GepaEngine().run(task, server, make_ctx(str(tmp_path), seed=3, stop_at_score=0.95))

    assert result.best_candidate == "aaa"
    assert result.best_score == 1.0
    assert result.total_evals == 2
    assert result.metadata == {"candidates": 2, "gepa_metric_calls": 2}
    assert seen["seed_candidate"] == "seed"
    assert seen["objective"] == "vowels"
    assert seen["background"] == "bg"
    assert seen["valset"] == [{"i": 1}]
    config = seen["config"]
    assert config.engine.max_metric_calls == 7
    assert config.engine.seed == 3
    assert config.engine.parallel is False
    assert config.engine.run_dir == str(tmp_path / "gepa")
    assert config.stop_callbacks is not None
    assert len(config.stop_callbacks) == 1
    assert Path(config.engine.run_dir).is_dir()


def test_gepa_engine_falls_back_to_server_best_when_budget_runs_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the budget dies mid-run and no state was checkpointed, the server's best wins."""

    def fake_optimize(**kwargs: Any) -> Any:
        """Score until the server cuts the run off."""
        kwargs["evaluator"]("xxa")
        kwargs["evaluator"]("aaa")
        kwargs["evaluator"]("never scored")

    monkeypatch.setattr(gepa_mod, "optimize_anything", fake_optimize)
    monkeypatch.setattr(gepa_mod, "_load_result_from_state", lambda run_dir, *, seed, str_mode: None)

    result = GepaEngine().run(
        Task(seed_candidate="seed"), EvalServer(vowel_scorer, max_evals=2), make_ctx(str(tmp_path))
    )

    assert result.best_candidate == "aaa"
    assert result.best_score == 1.0
    assert result.total_evals == 2


def test_gepa_engine_recovers_checkpointed_state_after_budget_exhaustion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A checkpointed GEPA state is preferred over the raw server best."""

    def fake_optimize(**kwargs: Any) -> Any:
        """Die on the budget immediately."""
        raise BudgetExhaustedError("spent")

    recovered = MagicMock()
    recovered.best_candidate = "from-state"
    recovered.best_idx = 0
    recovered.val_aggregate_scores = [0.4]
    recovered.candidates = [{}]
    recovered.total_metric_calls = 9
    monkeypatch.setattr(gepa_mod, "optimize_anything", fake_optimize)
    monkeypatch.setattr(gepa_mod, "_load_result_from_state", lambda run_dir, *, seed, str_mode: recovered)

    result = GepaEngine().run(
        Task(seed_candidate="seed"), EvalServer(vowel_scorer, max_evals=2), make_ctx(str(tmp_path))
    )

    assert result.best_candidate == "from-state"
    assert result.best_score == 0.4


def test_gepa_engine_real_run_improves_the_seed(tmp_path: Path) -> None:
    """The real ``optimize_anything`` loop runs against the eval server and stays within budget."""
    server = EvalServer(vowel_scorer, max_evals=12)
    task = Task(
        seed_candidate="hello world", objective="more vowels", train_set=[{"i": 0}, {"i": 1}], val_set=[{"i": 2}]
    )

    result = GepaEngine().run(task, server, make_ctx(str(tmp_path)))

    assert server.used <= 12
    assert result.best_score is not None
    assert vowel_scorer(result.best_candidate)[0] >= vowel_scorer("hello world")[0]
    assert (tmp_path / "gepa").is_dir()
