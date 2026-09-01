"""Tests for the Meta-Harness engine: the propose-evaluate loop, stop reasons and prompt shape."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest

from core.constants import PROGRESS_CANDIDATE, PROGRESS_MINIBATCH
from core.exceptions import ServiceError

from ..meta_harness import MetaHarnessEngine
from ..protocol import EvalServer, Task
from .mocks import FakeReflectionLM, make_ctx, vowel_scorer


class _ScriptedLM:
    """Reflection LM that returns a fixed reply and records the prompts it saw.

    Args:
        reply: The single completion to return every call.
    """

    def __init__(self, reply: str) -> None:
        """Create the fake."""
        self.reply = reply
        self.prompts: list[str] = []

    def __call__(self, prompt: str, *args: Any, **kwargs: Any) -> list[str]:
        """Record ``prompt`` and return the fixed reply.

        Args:
            prompt: The proposer prompt.
            *args: Ignored.
            **kwargs: Ignored.

        Returns:
            The reply as a one-element list.
        """
        self.prompts.append(prompt)
        return [self.reply]


def test_meta_harness_iterates_until_the_cap(tmp_path: Path) -> None:
    """The loop evaluates the seed and each proposal until the iteration cap stops it."""
    lm = FakeReflectionLM()
    server = EvalServer(vowel_scorer, max_evals=100)
    task = Task(seed_candidate="hello", objective="more vowels", val_set=[{"i": 0}, {"i": 1}])

    result = MetaHarnessEngine().run(task, server, make_ctx(str(tmp_path), lm, max_iterations=2))

    assert result.metadata == {"trials": 3, "proposals": 2, "stopped": "max_iterations"}
    assert result.best_candidate == "aeiou"
    assert result.best_score == 1.0
    assert result.total_evals == 6


def test_meta_harness_stops_at_target_score(tmp_path: Path) -> None:
    """A trial that meets ``stop_at_score`` ends the loop."""
    server = EvalServer(vowel_scorer, max_evals=100)
    task = Task(seed_candidate="hello", objective="vowels", val_set=[{"i": 0}])

    result = MetaHarnessEngine().run(task, server, make_ctx(str(tmp_path), stop_at_score=0.95))

    assert result.metadata["stopped"] == "target_reached"
    assert result.best_score == 1.0


def test_meta_harness_needs_cases(tmp_path: Path) -> None:
    """A task with no cases cannot run."""
    with pytest.raises(ServiceError, match="needs cases"):
        MetaHarnessEngine().run(
            Task(seed_candidate="hi"), EvalServer(vowel_scorer, max_evals=5), make_ctx(str(tmp_path))
        )


def test_meta_harness_requires_a_first_version(tmp_path: Path) -> None:
    """A seedless task whose proposer returns nothing is a typed error."""
    task = Task(seed_candidate=None, objective="vowels", val_set=[{"i": 0}])

    with pytest.raises(ServiceError, match="could not produce a first version"):
        MetaHarnessEngine().run(task, EvalServer(vowel_scorer, max_evals=5), make_ctx(str(tmp_path), _ScriptedLM("")))


def test_meta_harness_returns_a_partial_trial_when_the_budget_cannot_cover_a_pass(tmp_path: Path) -> None:
    """A budget too small for one full case-set still yields the partial trial's best."""
    server = EvalServer(vowel_scorer, max_evals=1)
    task = Task(seed_candidate="hello", val_set=[{"i": 0}, {"i": 1}])

    result = MetaHarnessEngine().run(task, server, make_ctx(str(tmp_path)))

    assert result.metadata == {"trials": 1, "proposals": 0, "stopped": "budget_exhausted"}
    assert result.best_candidate == "hello"
    assert result.best_score == pytest.approx(0.4)


def test_meta_harness_with_zero_budget_is_a_typed_error(tmp_path: Path) -> None:
    """A budget that covers no evaluation at all leaves nothing to return."""
    task = Task(seed_candidate="hello", val_set=[{"i": 0}])

    with pytest.raises(ServiceError, match="could not evaluate any version"):
        MetaHarnessEngine().run(task, EvalServer(vowel_scorer, max_evals=0), make_ctx(str(tmp_path)))


def test_meta_harness_stops_when_proposals_repeat(tmp_path: Path) -> None:
    """Duplicate proposals are retried, then the loop gives up with the best seen."""
    server = EvalServer(vowel_scorer, max_evals=10)
    task = Task(seed_candidate="aeiou", val_set=[{"i": 0}])

    result = MetaHarnessEngine().run(task, server, make_ctx(str(tmp_path), FakeReflectionLM(improving=False)))

    assert result.metadata["stopped"] == "no_new_proposal"
    assert result.metadata["proposals"] == 4
    assert result.best_candidate == "aeiou"


def test_meta_harness_writes_a_first_prompt_from_the_objective(tmp_path: Path) -> None:
    """A seedless run's first prompt names the target and says there is no version yet."""
    lm = FakeReflectionLM()
    task = Task(seed_candidate=None, objective="add vowels", val_set=[{"i": 0}])

    MetaHarnessEngine().run(
        task,
        EvalServer(vowel_scorer, max_evals=5),
        make_ctx(str(tmp_path), lm, max_iterations=0, target_label="pi · gpt-x"),
    )

    first = lm.prompts[0]
    assert "(pi · gpt-x)" in first
    assert "There is no version yet." in first
    assert "Objective: add vowels" in first


def test_meta_harness_prompt_shows_history_with_the_best_and_weak_cases(tmp_path: Path) -> None:
    """Once trials exist the proposer sees the history, the best marker and the fenced format."""
    lm = FakeReflectionLM()
    task = Task(seed_candidate="hello", objective="vowels", val_set=[{"i": 0}, {"i": 1}])

    MetaHarnessEngine().run(
        task, EvalServer(vowel_scorer, max_evals=100), make_ctx(str(tmp_path), lm, max_iterations=2)
    )

    history = "\n".join(lm.prompts)
    assert "## Versions tried so far" in history
    assert "best so far" in history
    assert "Weakest cases:" in history
    assert "Output only the new harness text inside a single ``` fenced block." in history


def test_meta_harness_edits_named_parts_through_file_blocks(tmp_path: Path) -> None:
    """A dict version is edited part-by-part; unknown paths in the reply are ignored."""
    reply = '<file path="AGENTS.md">\nnew content aeiou\n</file>\n<file path="ghost.md">\nignored\n</file>'
    lm = _ScriptedLM(reply)
    server = EvalServer(vowel_scorer, max_evals=100)
    task = Task(seed_candidate={"AGENTS.md": "base", "README.md": "r"}, val_set=[{"i": 0}])

    result = MetaHarnessEngine().run(task, server, make_ctx(str(tmp_path), lm, max_iterations=1))

    assert result.best_candidate == {"AGENTS.md": "new content aeiou", "README.md": "r"}
    assert "ghost.md" not in result.best_candidate


def test_meta_harness_makes_no_new_proposal_without_file_blocks(tmp_path: Path) -> None:
    """A dict reply with no file blocks proposes nothing and the loop gives up."""
    lm = _ScriptedLM("no blocks here")
    server = EvalServer(vowel_scorer, max_evals=100)
    task = Task(seed_candidate={"AGENTS.md": "base"}, val_set=[{"i": 0}])

    result = MetaHarnessEngine().run(task, server, make_ctx(str(tmp_path), lm))

    assert result.metadata == {"trials": 1, "proposals": 3, "stopped": "no_new_proposal"}
    assert result.best_candidate == {"AGENTS.md": "base"}


def test_meta_harness_scores_cases_concurrently(tmp_path: Path) -> None:
    """With concurrency above one the cases are scored on the meta-harness worker pool."""
    names: set[str] = set()
    lock = threading.Lock()

    def recording_scorer(candidate: Any, case: Any = None) -> tuple[float, dict[str, Any]]:
        """Record the worker thread, then score by vowels."""
        with lock:
            names.add(threading.current_thread().name)
        return vowel_scorer(candidate, case)

    server = EvalServer(recording_scorer, max_evals=20)
    task = Task(seed_candidate="hello", val_set=[{"i": 0}, {"i": 1}, {"i": 2}, {"i": 3}])

    MetaHarnessEngine().run(task, server, make_ctx(str(tmp_path), max_iterations=0, concurrency=4))

    assert server.used == 4
    assert any(name.startswith("meta-harness") for name in names)


def test_meta_harness_streams_each_trial_as_a_candidate(tmp_path: Path) -> None:
    """Every scorer call goes out as feedback and every complete trial as a tree node, while the loop runs."""
    sink: list[tuple[str, dict[str, Any]]] = []
    server = EvalServer(vowel_scorer, max_evals=100)
    task = Task(seed_candidate="hello", objective="more vowels", val_set=[{"i": 0}, {"i": 1}])
    ctx = make_ctx(str(tmp_path), max_iterations=2, progress_callback=lambda e, m: sink.append((e, m)))

    MetaHarnessEngine().run(task, server, ctx)

    candidates = [m for e, m in sink if e == PROGRESS_CANDIDATE]
    assert [c["candidate_id"] for c in candidates] == ["0", "1", "2"]
    assert [c["parent_id"] for c in candidates] == [None, "0", "1"]
    assert [c["generation"] for c in candidates] == [0, 1, 2]
    assert [c["iteration"] for c in candidates] == [0, 1, 2]
    assert [c["discovered_at_evals"] for c in candidates] == [2, 4, 6]
    assert candidates[0]["prompt"] == {"current_candidate": "hello"}
    assert candidates[0]["per_example"] == [{"id": "0", "score": 0.4}, {"id": "1", "score": 0.4}]
    assert candidates[1]["score"] == 1.0
    assert candidates[2]["prompt"] == {"current_candidate": "aeiou aeiou"}
    assert [(m["iteration"], m["example_id"], m["feedback"]) for e, m in sink if e == PROGRESS_MINIBATCH] == [
        (0, "0", "vowels: 2"),
        (0, "1", "vowels: 2"),
        (1, "0", "vowels: 5"),
        (1, "1", "vowels: 5"),
        (2, "0", "vowels: 10"),
        (2, "1", "vowels: 10"),
    ]
    assert all(m["prediction"] == "" for e, m in sink if e == PROGRESS_MINIBATCH)


def test_meta_harness_streams_from_worker_threads(tmp_path: Path) -> None:
    """Scoring in parallel keeps the events tagged with their trial (nothing leans on thread-local context)."""
    sink: list[tuple[str, dict[str, Any]]] = []
    lock = threading.Lock()

    def collect(event: str, metrics: dict[str, Any]) -> None:
        """Append an event under a lock, since worker threads emit concurrently.

        Args:
            event: The event name.
            metrics: Its payload.
        """
        with lock:
            sink.append((event, metrics))

    server = EvalServer(vowel_scorer, max_evals=100)
    task = Task(seed_candidate="hello", val_set=[{"i": 0}, {"i": 1}, {"i": 2}])
    ctx = make_ctx(str(tmp_path), max_iterations=1, concurrency=3, progress_callback=collect)

    MetaHarnessEngine().run(task, server, ctx)

    assert [c["candidate_id"] for e, c in sink if e == PROGRESS_CANDIDATE] == ["0", "1"]
    feedback = sorted((m["iteration"], m["example_id"]) for e, m in sink if e == PROGRESS_MINIBATCH)
    assert feedback == [(0, "0"), (0, "1"), (0, "2"), (1, "0"), (1, "1"), (1, "2")]


def test_meta_harness_announces_only_complete_trials(tmp_path: Path) -> None:
    """A trial the budget cuts short streams its scorer calls but never becomes a node."""
    sink: list[tuple[str, dict[str, Any]]] = []
    ctx = make_ctx(str(tmp_path), progress_callback=lambda e, m: sink.append((e, m)))
    server = EvalServer(vowel_scorer, max_evals=1)

    trial = MetaHarnessEngine._evaluate("hello", [{"i": 0}, {"i": 1}], server, ctx, index=0, parent=None)

    assert not trial.complete
    assert [e for e, _ in sink] == [PROGRESS_MINIBATCH]


def test_meta_harness_streams_multi_part_versions_as_their_parts(tmp_path: Path) -> None:
    """A harness made of files is announced with one prompt entry per file."""
    sink: list[tuple[str, dict[str, Any]]] = []
    ctx = make_ctx(str(tmp_path), progress_callback=lambda e, m: sink.append((e, m)))
    candidate = {"AGENTS.md": "hello", "README.md": "xyz"}

    MetaHarnessEngine._evaluate(candidate, [{"i": 0}], EvalServer(vowel_scorer, max_evals=5), ctx, index=0, parent=None)

    assert [m["prompt"] for e, m in sink if e == PROGRESS_CANDIDATE] == [candidate]
