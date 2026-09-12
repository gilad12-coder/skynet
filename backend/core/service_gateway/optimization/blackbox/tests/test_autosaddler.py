"""Verify the in-process AutoSaddler engine climbs, cold-starts and stops on budget."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from core.exceptions import ServiceError

from ...budget_stop import BudgetReached
from ..autosaddler import AutoSaddlerEngine
from ..protocol import EngineContext, EvalServer, Task
from .mocks import vowel_scorer


class _JsonLM:
    """Reflection model that answers every prompt with an AutoSaddler JSON patch.

    Cold-start prompts (which mention writing an initial solution) get
    ``cold_start``; every diagnose-and-rewrite prompt gets the next scripted
    version, falling back to a vowel-dense default once the script runs out.
    """

    def __init__(self, versions: list[str] | None = None, *, cold_start: str | None = "aeiou") -> None:
        """Store the scripted replies.

        Args:
            versions: Rewritten versions handed to successive patch prompts.
            cold_start: Version returned for a seedless run's first prompt, or
                ``None`` to answer it with an object carrying no version.
        """
        self._versions = list(versions or [])
        self._cold_start = cold_start
        self.prompts: list[str] = []

    def __call__(self, prompt: str) -> str:
        """Return the next scripted JSON reply for ``prompt``.

        Args:
            prompt: The engine's cold-start or patch instruction.

        Returns:
            A JSON object string in AutoSaddler's patch shape.
        """
        self.prompts.append(prompt)
        if "initial solution" in prompt:
            if self._cold_start is None:
                return "{}"
            return json.dumps({"updates": {"version": self._cold_start}})
        version = self._versions.pop(0) if self._versions else "aeiou"
        return json.dumps({"diagnosis": "needs more vowels", "updates": {"version": version}})


def _ctx(run_dir: Path, lm: _JsonLM, **overrides: Any) -> EngineContext:
    """Build an ``EngineContext`` over a JSON reflection model.

    Args:
        run_dir: Workspace for the run.
        lm: The scripted reflection model.
        **overrides: Extra ``EngineContext`` fields.

    Returns:
        The context.
    """
    return EngineContext(reflection_lm=lm, run_dir=str(run_dir), **overrides)


def test_autosaddler_accepts_a_verified_dataset_gain(tmp_path: Path) -> None:
    """Keep a rewrite that strictly beats the seed on its batch and the development set."""
    lm = _JsonLM(versions=["aeiou"])
    server = EvalServer(vowel_scorer, max_evals=50)
    task = Task(
        seed_candidate="bcdfg",
        objective="more vowels",
        train_set=[{"id": "t"}],
        val_set=[{"id": "a"}, {"id": "b"}],
    )

    result = AutoSaddlerEngine().run(task, server, _ctx(tmp_path, lm, max_iterations=1))

    assert result.best_candidate == "aeiou"
    assert result.best_score == 1.0
    assert result.metadata["iterations"] == 1
    assert result.metadata["accepted"] == 1


def test_autosaddler_climbs_a_single_task_without_a_dataset(tmp_path: Path) -> None:
    """Improve a lone text version when the task carries no cases."""
    lm = _JsonLM(versions=["aeiou"])
    server = EvalServer(vowel_scorer, max_evals=50)
    task = Task(seed_candidate="bcd")

    result = AutoSaddlerEngine().run(task, server, _ctx(tmp_path, lm, max_iterations=1))

    assert result.best_candidate == "aeiou"
    assert result.best_score == 1.0


def test_autosaddler_cold_starts_a_seedless_run(tmp_path: Path) -> None:
    """Score a reflection-authored first version when no seed was supplied."""
    lm = _JsonLM(cold_start="aeiou")
    server = EvalServer(vowel_scorer, max_evals=50)
    task = Task(seed_candidate=None, val_set=[{"id": "a"}])

    result = AutoSaddlerEngine().run(task, server, _ctx(tmp_path, lm, max_iterations=0))

    assert result.best_candidate == "aeiou"
    assert result.best_score == 1.0
    assert result.metadata["iterations"] == 0
    assert any("initial solution" in prompt for prompt in lm.prompts)


def test_autosaddler_rejects_a_seedless_run_it_cannot_cold_start(tmp_path: Path) -> None:
    """Fail loudly when a seedless run's cold start yields no version."""
    lm = _JsonLM(cold_start=None)
    server = EvalServer(vowel_scorer, max_evals=50)
    task = Task(seed_candidate=None, val_set=[{"id": "a"}])

    with pytest.raises(ServiceError, match="could not produce an initial version"):
        AutoSaddlerEngine().run(task, server, _ctx(tmp_path, lm))


def test_autosaddler_rejects_named_parts(tmp_path: Path) -> None:
    """Reject multi-part starting points the text engine cannot optimize."""
    lm = _JsonLM()
    server = EvalServer(vowel_scorer, max_evals=50)
    task = Task(seed_candidate={"version": "bcd"})

    with pytest.raises(ServiceError, match="text starting points only"):
        AutoSaddlerEngine().run(task, server, _ctx(tmp_path, lm))


def test_autosaddler_stops_once_the_seed_meets_the_target(tmp_path: Path) -> None:
    """Run no diagnosis rounds when the seed already clears ``stop_at_score``."""
    lm = _JsonLM()
    server = EvalServer(vowel_scorer, max_evals=50)
    task = Task(seed_candidate="aeiou", val_set=[{"id": "a"}])

    result = AutoSaddlerEngine().run(task, server, _ctx(tmp_path, lm, stop_at_score=0.5))

    assert result.best_candidate == "aeiou"
    assert result.metadata["iterations"] == 0
    assert result.metadata["accepted"] == 0
    assert lm.prompts == []


def test_autosaddler_returns_the_seed_unscored_without_budget(tmp_path: Path) -> None:
    """Hand the seed back unscored when no scorer runs remain."""
    lm = _JsonLM()
    server = EvalServer(vowel_scorer, max_evals=0)
    task = Task(seed_candidate="bcd", val_set=[{"id": "a"}])

    result = AutoSaddlerEngine().run(task, server, _ctx(tmp_path, lm))

    assert result.best_candidate == "bcd"
    assert result.best_score is None
    assert result.total_evals == 0
    assert lm.prompts == []


def test_autosaddler_budget_stop_after_seed_attaches_the_incumbent(tmp_path: Path) -> None:
    """Carry the confirmed incumbent on a budget stop taken during a diagnosis round."""
    lm = _JsonLM(versions=["aeiou"])
    server = EvalServer(vowel_scorer, max_evals=50)
    task = Task(seed_candidate="bcd", train_set=[{"id": "t"}], val_set=[{"id": "a"}])

    calls = {"n": 0}

    def check_budget() -> None:
        """Trip the budget once the seed has been scored, before the first patch.

        Raises:
            BudgetReached: On the third guard call, inside the diagnosis round.
        """
        calls["n"] += 1
        if calls["n"] >= 3:
            raise BudgetReached()

    with pytest.raises(BudgetReached) as excinfo:
        AutoSaddlerEngine().run(task, server, _ctx(tmp_path, lm, check_budget=check_budget))

    exc = excinfo.value
    assert exc.result is not None
    assert exc.result.best_candidate == "bcd"
    assert exc.result.best_score == 0.0
    assert exc.result.metadata["selection_source"] == "autosaddler_incumbent"
    assert exc.evidence["selection_scope"] == "development"
    assert exc.evidence["final_evaluation_completed"] is False


def test_autosaddler_budget_stop_during_seed_scoring_reports_the_seed(tmp_path: Path) -> None:
    """Report the seed, unscored, when the budget trips on its very first evaluation."""
    lm = _JsonLM()
    server = EvalServer(vowel_scorer, max_evals=50)
    task = Task(seed_candidate="bcd", val_set=[{"id": "a"}])

    def check_budget() -> None:
        """Trip the budget on the seed's first guarded evaluation.

        Raises:
            BudgetReached: Immediately, before any score is confirmed.
        """
        raise BudgetReached()

    with pytest.raises(BudgetReached) as excinfo:
        AutoSaddlerEngine().run(task, server, _ctx(tmp_path, lm, check_budget=check_budget))

    exc = excinfo.value
    assert exc.result is not None
    assert exc.result.best_candidate == "bcd"
    assert exc.result.best_score is None
