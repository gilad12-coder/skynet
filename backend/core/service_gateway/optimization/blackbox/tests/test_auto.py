"""Compare platform composition with the pinned upstream scheduling helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from gepa.oa.config import OptimizeAnythingConfig
from gepa.oa.engine import Result as UpstreamResult
from gepa.oa.ensemble import optimize_best_of

from core.exceptions import ServiceError
from core.models.blackbox import BlackboxStrategy

from .. import auto
from ..protocol import EngineContext, EvalServer, Result, ScorerAbortError, Task
from ..registry import EngineCapabilities
from ..upstream import AUTO_ENGINES, GEPA_SOURCE
from .mocks import make_ctx

CAPS = EngineCapabilities(proposer_available=True)


class FixtureEngine:
    """Preserve real upstream scheduling while making engine work deterministic."""

    def __init__(self, name: str) -> None:
        """Set the engine identifier.

        Args:
            name: Engine identifier.
        """
        self.name = name

    def run(self, task: Any, server: Any, ctx: EngineContext | None = None) -> Any:
        """Score the same fixture directly upstream or through the platform adapter.

        Args:
            task: Task with the scheduler's chosen seed.
            server: Upstream or platform evaluation allowance.
            ctx: Platform context when invoked through the adapter.

        Returns:
            The corresponding engine result with its aggregate score.
        """
        candidate = f"{task.seed_candidate}:{self.name}"
        remaining = server.remaining if ctx is not None else server.budget.remaining
        scores = [server.evaluate(candidate, {"i": i})[0] for i in range(remaining)]
        result_type = Result if ctx is not None else UpstreamResult
        return result_type(candidate, sum(scores) / len(scores), len(scores))

    def process_result(self, result: Any, output_dir: Any) -> None:
        """Leave fixture artifacts empty.

        Args:
            result: Completed result.
            output_dir: Artifact directory.
        """


def score(candidate: str, example: Any = None) -> tuple[float, dict[str, Any]]:
    """Rank fixture engines with negative scores to catch truthiness-based ranking.

    Args:
        candidate: Candidate containing the engine identifier.
        example: Ignored dataset example.

    Returns:
        Deterministic score and empty feedback.
    """
    return (-1.0 if "meta_harness" in candidate else -2.0), {}


@pytest.fixture
def fixture_engines(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace engine work while preserving real upstream scheduling.

    Args:
        monkeypatch: Patch fixture.
    """
    monkeypatch.setattr(auto, "get_engine", lambda name, caps: FixtureEngine(name))


def test_auto_matches_direct_pinned_recipe(tmp_path: Path, fixture_engines: None) -> None:
    """Match upstream's three-lane winner and seed a fresh GEPA continuation.

    Args:
        tmp_path: Artifact directory.
        fixture_engines: Deterministic fixture.
    """
    direct = optimize_best_of(
        "seed",
        evaluator=score,
        configs=[
            OptimizeAnythingConfig(engine=FixtureEngine(name), max_evals=2, output_dir=tmp_path / f"direct-{name}")
            for name in AUTO_ENGINES
        ],
    )
    server = EvalServer(score, max_evals=8)
    result, lanes = auto.run_strategy(BlackboxStrategy(), Task("seed"), server, make_ctx(str(tmp_path)), caps=CAPS)
    assert result.best_candidate == f"{direct.best_candidate}:gepa"
    assert result.best_score == direct.best_score == -1.0
    assert server.used == result.total_evals == 8
    assert sorted(lane.engine for lane in lanes[:3]) == sorted(AUTO_ENGINES)
    assert [lane.phase for lane in lanes] == ["explore", "explore", "explore", "continue"]
    assert result.metadata["upstream_source"] == GEPA_SOURCE
    assert result.metadata["upstream_recipe"] == "omni-gepa"
    assert "all_results" not in result.metadata


def test_single_uses_entire_budget(tmp_path: Path, fixture_engines: None) -> None:
    """Run exactly one requested engine without implicit exploration.

    Args:
        tmp_path: Artifact directory.
        fixture_engines: Deterministic fixture.
    """
    server = EvalServer(score, max_evals=5)
    result, lanes = auto.run_strategy(
        BlackboxStrategy(mode="single", engine="gepa"), Task("seed"), server, make_ctx(str(tmp_path)), caps=CAPS
    )
    assert result.best_candidate == "seed:gepa"
    assert server.used == 5
    assert len(lanes) == 1
    assert lanes[0].phase == "single"


def test_missing_recipe_engine_rejects_before_scoring(tmp_path: Path) -> None:
    """Never replace a missing native engine with Best-of-N or a GEPA-only run.

    Args:
        tmp_path: Artifact directory.
    """
    server = EvalServer(score, max_evals=8)
    with pytest.raises(ServiceError, match="not available"):
        auto.run_strategy(BlackboxStrategy(), Task("seed"), server, make_ctx(str(tmp_path)))
    assert server.used == 0


def test_auto_rejects_too_small_budget(tmp_path: Path, fixture_engines: None) -> None:
    """Reject before work when all four recipe allocations cannot fit.

    Args:
        tmp_path: Artifact directory.
        fixture_engines: Deterministic fixture.
    """
    with pytest.raises(ServiceError, match="four scorer"):
        auto.run_strategy(
            BlackboxStrategy(), Task("seed"), EvalServer(score, max_evals=3), make_ctx(str(tmp_path)), caps=CAPS
        )


def test_compositions_refuse_named_parts(tmp_path: Path) -> None:
    """Enforce upstream's string-only native proposer contract.

    Args:
        tmp_path: Artifact directory.
    """
    for mode in ("auto", "plateau"):
        with pytest.raises(ServiceError, match="text starting point"):
            auto.run_strategy(
                BlackboxStrategy(mode=mode),
                Task({"a": "seed"}),
                EvalServer(score, max_evals=8),
                make_ctx(str(tmp_path)),
                caps=CAPS,
            )


def test_engine_failure_never_falls_back_to_seed(tmp_path: Path, fixture_engines: None) -> None:
    """Propagate run-level failure without reporting a successful alternative run.

    Args:
        tmp_path: Artifact directory.
        fixture_engines: Deterministic fixture.
    """

    def fail(candidate: Any, example: Any = None) -> Any:
        """Stop the fixture at the scoring boundary.

        Args:
            candidate: Proposed candidate.
            example: Dataset example.
        """
        raise ScorerAbortError("scorer unavailable")

    with pytest.raises(ScorerAbortError, match="scorer unavailable"):
        auto.run_strategy(
            BlackboxStrategy(), Task("seed"), EvalServer(fail, max_evals=8), make_ctx(str(tmp_path)), caps=CAPS
        )


def test_plateau_uses_upstream_shared_budget(tmp_path: Path, fixture_engines: None) -> None:
    """Bound relay slices using upstream's aggregate-score scheduler.

    Args:
        tmp_path: Artifact directory.
        fixture_engines: Deterministic fixture.
    """
    server = EvalServer(score, max_evals=20)
    result, lanes = auto.run_strategy(
        BlackboxStrategy(mode="plateau", patience=5), Task("seed"), server, make_ctx(str(tmp_path)), caps=CAPS
    )
    assert 0 < server.used <= 20
    assert all(lane.phase == "relay" for lane in lanes)
    assert result.total_evals == server.used
    assert result.best_score == -1.0
    assert "all_results" not in result.metadata


def test_relay_stops_after_cumulative_spend(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Prevent repeated native slices from each receiving a fresh total allowance.

    Args:
        tmp_path: Artifact directory.
        monkeypatch: Patch fixture.
    """
    spent = [0.0]
    starts: list[str] = []

    class SpendingEngine(FixtureEngine):
        """Attach reconciled usage to the deterministic scoring fixture."""

        def run(self, task: Any, server: Any, ctx: EngineContext | None = None) -> Any:
            """Record completed proposer spend before the next slice is considered.

            Args:
                task: Scheduler-selected task.
                server: Scoring allowance.
                ctx: Run accounting context.

            Returns:
                Deterministic candidate result.
            """
            starts.append(self.name)
            result = super().run(task, server, ctx)
            spent[0] += 4.0
            return result

    monkeypatch.setattr(auto, "get_engine", lambda name, caps: SpendingEngine(name))
    context = make_ctx(
        str(tmp_path), remaining_cost_usd=lambda: max(0.0, 8.0 - spent[0]), proposer_token_budget_usd=8.0
    )
    with pytest.raises(auto.CostCeilingExceededError, match="budget"):
        auto.run_strategy(
            BlackboxStrategy(mode="plateau", patience=5),
            Task("seed"),
            EvalServer(score, max_evals=100),
            context,
            caps=CAPS,
        )
    assert spent[0] == 8.0
    assert len(starts) == 2
