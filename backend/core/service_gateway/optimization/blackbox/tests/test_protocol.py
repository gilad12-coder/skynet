"""Tests for the eval server: budgets, lanes, best tracking and crash handling."""

from __future__ import annotations

import logging
from typing import Any

import pytest

from ..protocol import (
    BudgetExhaustedError,
    EvalServer,
    PlateauReachedError,
    PlateauWatch,
    ScorerAbortError,
    Task,
    candidate_key,
)
from .mocks import vowel_scorer


def test_evaluate_counts_and_stops_at_budget() -> None:
    """The server serves exactly ``max_evals`` calls, then raises."""
    server = EvalServer(vowel_scorer, max_evals=2)

    server.evaluate("aaa")
    server.evaluate("bbb")

    assert server.used == 2
    assert server.remaining == 0
    with pytest.raises(BudgetExhaustedError, match="budget of 2"):
        server.evaluate("ccc")


def test_lane_counts_against_parent_and_is_clamped() -> None:
    """Lane evaluations spend the parent's budget; a lane can never exceed it."""
    parent = EvalServer(vowel_scorer, max_evals=5)
    lane = parent.lane(3)
    oversized = parent.lane(50)

    lane.evaluate("aaa")
    lane.evaluate("bbb")

    assert lane.used == 2
    assert parent.used == 2
    assert lane.remaining == 1
    assert oversized.max_evals == 5
    assert oversized.remaining == 3


def test_lane_exhaustion_does_not_touch_parent_remaining() -> None:
    """A spent lane raises while the parent still has budget for the next lane."""
    parent = EvalServer(vowel_scorer, max_evals=4)
    lane = parent.lane(1)
    lane.evaluate("aaa")

    with pytest.raises(BudgetExhaustedError):
        lane.evaluate("bbb")
    assert parent.remaining == 3
    assert parent.lane(parent.remaining).max_evals == 3


def test_best_candidate_uses_mean_across_cases() -> None:
    """The best version is the one with the highest mean, not the highest single score."""
    server = EvalServer(vowel_scorer, max_evals=10)

    server.evaluate("aaaa", {"i": 0})
    server.evaluate("aaaa", {"i": 1})
    server.evaluate("axxx", {"i": 0})

    assert server.best_candidate == "aaaa"
    assert server.best_score == 1.0
    assert server.mean_score("axxx") == 0.25
    assert server.mean_score("never") is None


def test_best_tracking_is_shared_with_lanes() -> None:
    """The root server sees candidates scored through a lane."""
    parent = EvalServer(vowel_scorer, max_evals=10)
    lane = parent.lane(5)

    lane.evaluate("aaa")
    lane.evaluate("xxx")

    assert parent.best_candidate == "aaa"
    assert lane.best_candidate == "aaa"


def test_scorer_crash_becomes_floor_score_with_feedback() -> None:
    """A scorer that raises marks the version bad instead of killing the run."""

    def crashing(candidate: Any, case: Any = None) -> tuple[float, dict[str, Any]]:
        """Raise for one specific version.

        Args:
            candidate: The version.
            case: Ignored.

        Returns:
            A perfect score for anything but ``"boom"``.
        """
        if candidate == "boom":
            raise ValueError("cannot score this")
        return 1.0, {}

    server = EvalServer(crashing, max_evals=5)

    score, side_info = server.evaluate("boom")

    assert score == 0.0
    assert side_info == {"error": "ValueError: cannot score this"}
    assert server.used == 1


def test_scorer_abort_is_not_floored() -> None:
    """A scorer that asks to stop the run passes through instead of becoming a zero."""

    def aborting(candidate: Any, case: Any = None) -> tuple[float, dict[str, Any]]:
        """Abort on every version.

        Args:
            candidate: Ignored.
            case: Ignored.

        Raises:
            ScorerAbortError: Always.
        """
        raise ScorerAbortError("harness is dead")

    server = EvalServer(aborting, max_evals=5)

    with pytest.raises(ScorerAbortError, match="harness is dead"):
        server.evaluate("anything")


def test_on_eval_fires_only_at_the_root() -> None:
    """The listener sees every evaluation once, whichever lane made it."""
    seen: list[tuple[int, float]] = []
    parent = EvalServer(vowel_scorer, max_evals=10, on_eval=lambda srv, score: seen.append((srv.used, score)))

    parent.evaluate("aaa")
    parent.lane(3).evaluate("xxx")

    assert seen == [(1, 1.0), (2, 0.0)]


def test_dict_candidates_have_stable_keys() -> None:
    """Named-part candidates are keyed by their sorted JSON form."""
    assert candidate_key({"b": "2", "a": "1"}) == candidate_key({"a": "1", "b": "2"})
    assert candidate_key("text") == "text"


def test_task_mode_flags() -> None:
    """``str_mode`` covers text and seedless tasks; ``has_dataset`` needs cases."""
    assert Task(seed_candidate="hi").str_mode
    assert Task(seed_candidate=None).str_mode
    assert not Task(seed_candidate={"a": "b"}).str_mode
    assert not Task(seed_candidate="hi").has_dataset
    assert Task(seed_candidate="hi", val_set=[{"x": 1}]).has_dataset


def test_plateau_watch_counts_runs_since_the_last_record() -> None:
    """Only a score above the bar resets the count; the lane trips at ``patience`` and stops."""
    parent = EvalServer(vowel_scorer, max_evals=10)
    watch = PlateauWatch(2, best_score=0.5)
    lane = parent.lane(10, watch=watch)

    lane.evaluate("xxa")
    assert watch.stalled == 1
    lane.evaluate("aaa")
    assert (watch.best_score, watch.stalled) == (1.0, 0)
    lane.evaluate("xxx")
    lane.evaluate("xxa")

    assert watch.exhausted
    assert lane.plateaued
    assert lane.remaining == 0
    assert (parent.plateaued, parent.remaining) == (False, 6)
    with pytest.raises(PlateauReachedError, match="no improvement in the last 2 scorer runs"):
        lane.evaluate("aaaa")
    assert watch.tripped
    assert parent.used == 4
    assert issubclass(PlateauReachedError, BudgetExhaustedError)


def test_plateau_watch_is_per_lane() -> None:
    """A later lane on the same parent starts its own count against the run's record."""
    parent = EvalServer(vowel_scorer, max_evals=10)
    first = parent.lane(10, watch=PlateauWatch(1))
    first.evaluate("aaa")
    first.evaluate("xxx")
    assert first.remaining == 0

    second = parent.lane(parent.remaining, watch=PlateauWatch(1, best_score=parent.best_score))

    assert second.remaining == 8
    second.evaluate("aaaa")
    assert second.plateaued
    assert parent.best_candidate == "aaa"


def test_history_lists_distinct_versions_in_first_seen_order() -> None:
    """Every distinct version is recorded once, with its mean score and latest side info."""
    server = EvalServer(vowel_scorer, max_evals=10)
    lane = server.lane(10)

    lane.evaluate("aaa", "case-1")
    lane.evaluate("xyz", "case-1")
    lane.evaluate("aaa", "case-2")

    assert [record.candidate for record in server.history] == ["aaa", "xyz"]
    first, second = server.history
    assert (first.count, first.first_eval, first.mean_score) == (2, 1, 1.0)
    assert first.side_info == {"vowels": 3}
    assert (second.count, second.first_eval, second.mean_score) == (1, 2, 0.0)
    assert [record.candidate for record in lane.history] == ["aaa", "xyz"]


def test_evaluate_logs_a_debug_heartbeat_per_scorer_call(caplog: pytest.LogCaptureFixture) -> None:
    """Each scorer call leaves a DEBUG line with its budget position and score for the verbose log view."""
    server = EvalServer(lambda candidate, example: (0.25 * len(candidate), {}), max_evals=5)
    lane = server.lane(3)

    with caplog.at_level(logging.DEBUG, logger="core.service_gateway.optimization.blackbox.protocol"):
        server.evaluate("aa")
        lane.evaluate("aaa")

    heartbeats = [r for r in caplog.records if r.levelno == logging.DEBUG]
    assert [r.getMessage() for r in heartbeats] == [
        "scorer eval 1/5 score=0.500",
        "scorer eval 2/5 score=0.750",
    ]


def test_primed_score_serves_the_first_evaluation_without_a_scorer_run() -> None:
    """A primed (version, case) pair is returned once for free, then measured afresh."""
    server = EvalServer(vowel_scorer, max_evals=2)
    server.prime("aaa", {"i": 0}, 0.25, {"note": "measured outside the budget"})

    assert server.recorded("aaa", {"i": 0}) == 0.25
    assert server.recorded("aaa", {"i": 1}) is None
    assert server.evaluate("aaa", {"i": 0}) == (0.25, {"note": "measured outside the budget"})
    assert server.used == 0
    assert server.mean_score("aaa") == 0.25
    assert server.recorded("aaa", {"i": 0}) == 0.25

    assert server.evaluate("aaa", {"i": 0}) == (1.0, {"vowels": 3})
    assert server.used == 1
    assert server.recorded("aaa", {"i": 0}) == 1.0
    assert server.recorded("aaa") is None


def test_primed_scores_reach_lanes_but_not_the_listener_or_plateau_watch() -> None:
    """A free evaluation counts for best tracking only: no budget, no listener tick, no patience spent."""
    seen: list[float] = []
    parent = EvalServer(vowel_scorer, max_evals=4, on_eval=lambda server, score: seen.append(score))
    watch = PlateauWatch(1, best_score=0.9)
    lane = parent.lane(4, watch=watch)
    parent.prime("xxa", None, 0.5, {})

    assert lane.evaluate("xxa") == (0.5, {})

    assert (lane.used, parent.used, seen, watch.stalled) == (0, 0, [], 0)
    assert lane.best_score == parent.best_score == 0.5
    assert lane.evaluate("aaa") == (1.0, {"vowels": 3})
    assert (lane.used, parent.used, seen) == (1, 1, [1.0])


def test_recorded_scores_are_kept_per_case_at_the_root() -> None:
    """Scores are remembered per (version, case) across lanes, keyed by the case's content."""
    parent = EvalServer(vowel_scorer, max_evals=4)
    lane = parent.lane(4)

    lane.evaluate("axxx", {"i": 0, "target": "aeiou"})

    assert parent.recorded("axxx", {"target": "aeiou", "i": 0}) == 0.25
    assert lane.recorded("axxx", {"i": 0, "target": "aeiou"}) == 0.25
    assert parent.recorded("axxx", {"i": 1}) is None
    assert parent.recorded({"a": "axxx"}, {"i": 0, "target": "aeiou"}) is None
