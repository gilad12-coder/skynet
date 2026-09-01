"""Tests for the in-process engines and the registry."""

from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from core.constants import PROGRESS_CANDIDATE, PROGRESS_MINIBATCH
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


def test_best_of_n_streams_every_scored_version(tmp_path: Path) -> None:
    """The seed and each proposal reach the sink as tree nodes hung under the best version they came from."""
    sink: list[tuple[str, dict[str, Any]]] = []
    ctx = make_ctx(str(tmp_path), progress_callback=lambda e, m: sink.append((e, m)))
    task = Task(seed_candidate="hello", objective="vowels", val_set=[{"i": 0}, {"i": 1}])

    BestOfNEngine().run(task, EvalServer(vowel_scorer, max_evals=6), ctx)

    candidates = [m for e, m in sink if e == PROGRESS_CANDIDATE]
    assert [c["candidate_id"] for c in candidates] == ["0", "1", "2"]
    assert [c["parent_id"] for c in candidates] == [None, "0", "1"]
    assert [c["generation"] for c in candidates] == [0, 1, 2]
    assert [c["iteration"] for c in candidates] == [0, 1, 2]
    assert [c["discovered_at_evals"] for c in candidates] == [2, 4, 6]
    assert candidates[0]["prompt"] == {"current_candidate": "hello"}
    assert candidates[0]["per_example"] == [{"id": "0", "score": 0.4}, {"id": "1", "score": 0.4}]
    assert candidates[1]["score"] == 1.0
    assert [(m["iteration"], m["example_id"]) for e, m in sink if e == PROGRESS_MINIBATCH] == [
        (0, "0"),
        (0, "1"),
        (1, "0"),
        (1, "1"),
        (2, "0"),
        (2, "1"),
    ]


def test_best_of_n_streams_seedless_single_task_runs(tmp_path: Path) -> None:
    """Without a seed or cases the first proposal is the root, scored as the one case ``"0"``."""
    sink: list[tuple[str, dict[str, Any]]] = []
    ctx = make_ctx(str(tmp_path), progress_callback=lambda e, m: sink.append((e, m)))

    BestOfNEngine().run(Task(seed_candidate=None, objective="vowels"), EvalServer(vowel_scorer, max_evals=2), ctx)

    candidates = [m for e, m in sink if e == PROGRESS_CANDIDATE]
    assert [(c["candidate_id"], c["parent_id"], c["generation"]) for c in candidates] == [("0", None, 0), ("1", "0", 1)]
    assert candidates[0]["per_example"] == [{"id": "0", "score": 1.0}]
    assert [m["example_id"] for e, m in sink if e == PROGRESS_MINIBATCH] == ["0", "0"]


def test_best_of_n_does_not_announce_a_version_the_budget_cut_short(tmp_path: Path) -> None:
    """Running out of budget midway streams the calls made but no node for the half-scored version."""
    sink: list[tuple[str, dict[str, Any]]] = []
    ctx = make_ctx(str(tmp_path), progress_callback=lambda e, m: sink.append((e, m)))

    with pytest.raises(BudgetExhaustedError):
        BestOfNEngine._score(
            "hello",
            [{"i": 0}, {"i": 1}],
            EvalServer(vowel_scorer, max_evals=1),
            ctx,
            version=0,
            parent=None,
            generation=0,
        )

    assert [e for e, _ in sink] == [PROGRESS_MINIBATCH]


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
        gepa_result.candidates = [{"current_candidate": "seed"}, {"current_candidate": "aaa"}]
        gepa_result.parents = [[None], [0]]
        gepa_result.discovery_eval_counts = [1, 2]
        gepa_result.total_metric_calls = 2
        return gepa_result

    monkeypatch.setattr(gepa_mod, "optimize_anything", fake_optimize)
    server = EvalServer(vowel_scorer, max_evals=7)
    task = Task(seed_candidate="seed", objective="vowels", background="bg", train_set=[{"i": 0}], val_set=[{"i": 1}])

    result = GepaEngine().run(task, server, make_ctx(str(tmp_path), seed=3, stop_at_score=0.95))

    assert result.best_candidate == "aaa"
    assert result.best_score == 1.0
    assert result.total_evals == 2
    assert result.metadata == {
        "candidates": 2,
        "gepa_metric_calls": 2,
        "candidate_tree": [
            {"candidate": "seed", "parents": [None], "val_score": 0.0, "discovery_evals": 1},
            {"candidate": "aaa", "parents": [0], "val_score": 1.0, "discovery_evals": 2},
        ],
    }
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
    tree = result.metadata["candidate_tree"]
    assert tree[0]["candidate"] == "hello world"
    assert tree[0]["parents"] == [None]
    assert all(parent is None or 0 <= parent < index for index, node in enumerate(tree) for parent in node["parents"])
    assert any(node["candidate"] == result.best_candidate for node in tree)


def test_gepa_engine_streams_candidates_while_running(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Candidates checkpointed to ``gepa_state.bin`` reach the progress sink as live events."""

    def fake_optimize(**kwargs: Any) -> Any:
        """Checkpoint a two-candidate state the way GEPA's engine does, then finish."""
        state = {
            "program_candidates": [{"current_candidate": "seed"}, {"current_candidate": "aaa"}],
            "parent_program_for_candidate": [[None], [0]],
            "prog_candidate_val_subscores": [{"0": 0.0}, {"0": 1.0}],
            "num_metric_calls_by_discovery": [1, 2],
            "full_program_trace": [{"i": 0, "new_program_idx": 1}],
        }
        (Path(kwargs["config"].engine.run_dir) / "gepa_state.bin").write_bytes(pickle.dumps(state))
        gepa_result = MagicMock()
        gepa_result.best_candidate = {"current_candidate": "aaa"}
        gepa_result.best_idx = 1
        gepa_result.val_aggregate_scores = [0.0, 1.0]
        gepa_result.candidates = [{"current_candidate": "seed"}, {"current_candidate": "aaa"}]
        gepa_result.parents = [[None], [0]]
        gepa_result.discovery_eval_counts = [1, 2]
        gepa_result.total_metric_calls = 2
        return gepa_result

    monkeypatch.setattr(gepa_mod, "optimize_anything", fake_optimize)
    sink: list[tuple[str, dict[str, Any]]] = []
    ctx = make_ctx(str(tmp_path), progress_callback=lambda event, metrics: sink.append((event, metrics)))

    result = GepaEngine().run(Task(seed_candidate="seed"), EvalServer(vowel_scorer, max_evals=5), ctx)

    assert result.best_candidate == "aaa"
    candidates = [metrics for event, metrics in sink if event == PROGRESS_CANDIDATE]
    assert [c["candidate_id"] for c in candidates] == ["0", "1"]
    assert candidates[0]["parent_id"] is None
    assert candidates[0]["prompt"] == {"current_candidate": "seed"}
    assert candidates[1]["parent_id"] == "0"
    assert candidates[1]["generation"] == 1
    assert candidates[1]["score"] == 1.0
    assert candidates[1]["iteration"] == 0


def test_gepa_engine_streams_scorer_feedback(monkeypatch, tmp_path) -> None:
    """Each scorer call inside GEPA is forwarded as a mini-batch feedback event keyed by validation index."""
    sink: list[tuple[str, dict]] = []

    def fake_optimize_anything(**kwargs):
        """Score the seed against the second case once, then hand back a minimal result.

        Args:
            **kwargs: The engine's ``optimize_anything`` call.

        Returns:
            A result shaped like GEPA's.
        """
        kwargs["evaluator"](kwargs["seed_candidate"], kwargs["dataset"][1])
        result = MagicMock()
        result.best_candidate = {"current_candidate": "seed"}
        result.best_idx = 0
        result.val_aggregate_scores = [0.5]
        result.candidates = [{"current_candidate": "seed"}]
        result.parents = [[None]]
        result.discovery_eval_counts = [1]
        result.total_metric_calls = 1
        return result

    monkeypatch.setattr(gepa_mod, "optimize_anything", fake_optimize_anything)
    ctx = make_ctx(str(tmp_path), progress_callback=lambda event, metrics: sink.append((event, metrics)))
    cases = [{"q": 1}, {"q": 2}]

    GepaEngine().run(Task(seed_candidate="seed", train_set=cases), EvalServer(vowel_scorer, max_evals=5), ctx)

    assert [m for e, m in sink if e == PROGRESS_MINIBATCH] == [
        {"example_id": "1", "score": 0.5, "feedback": "vowels: 2", "prediction": "", "iteration": None}
    ]
