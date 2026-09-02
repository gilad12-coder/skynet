"""Tests for the strategy layer: single lanes, the Auto explore → continue flow, and lane events."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from core.constants import PROGRESS_LANE_COMPLETED, PROGRESS_LANE_HANDOFF, PROGRESS_LANE_STARTED
from core.exceptions import ServiceError
from core.models.blackbox import BLACKBOX_ENGINE_GEPA, BlackboxStrategy
from core.service_gateway.optimization.cost_ceiling import CostCeilingExceededError

from .. import auto as auto_mod
from ..auto import run_lane, run_strategy
from ..protocol import EvalServer, Result, ScorerAbortError, Task
from ..registry import NO_CAPABILITIES, EngineCapabilities
from .mocks import ScriptedEngine, make_ctx, vowel_scorer


def _install_registry(
    monkeypatch: pytest.MonkeyPatch,
    engines: dict[str, Any],
    *,
    available: list[str],
    parts: list[str] | None = None,
    seen_caps: list[EngineCapabilities] | None = None,
) -> None:
    """Point the strategy layer at a fake engine catalog.

    Args:
        monkeypatch: Pytest fixture.
        engines: Engine instances by id; ids missing here are "unavailable".
        available: What ``available_engine_ids`` reports.
        parts: The subset of ``available`` that takes multi-part seeds; all of it when unset.
        seen_caps: Collects the capabilities every registry call was given.
    """

    def fake_available(caps: EngineCapabilities = NO_CAPABILITIES, *, parts_only: bool = False) -> list[str]:
        """List the fake catalog, narrowing to multi-part engines on request."""
        if seen_caps is not None:
            seen_caps.append(caps)
        return [e for e in available if not parts_only or e in (available if parts is None else parts)]

    def fake_get_engine(engine_id: str, caps: EngineCapabilities = NO_CAPABILITIES) -> Any:
        """Return the fake engine or raise like the real registry."""
        if seen_caps is not None:
            seen_caps.append(caps)
        if engine_id not in engines:
            raise ServiceError(f"Engine '{engine_id}' is not available: fake")
        return engines[engine_id]

    monkeypatch.setattr(
        auto_mod,
        "available_engine_ids",
        lambda caps=NO_CAPABILITIES, *, parts=False: fake_available(caps, parts_only=parts),
    )
    monkeypatch.setattr(auto_mod, "get_engine", fake_get_engine)


def _events(sink: list[tuple[str, dict[str, Any]]], name: str) -> list[dict[str, Any]]:
    """Return the payloads of every ``name`` event in ``sink``.

    Args:
        sink: Collected ``(event, metrics)`` pairs.
        name: Event name to filter on.

    Returns:
        The matching payloads in order.
    """
    return [metrics for event, metrics in sink if event == name]


def test_single_mode_runs_one_lane_on_the_full_budget(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """``single`` hands the whole budget to the named engine and reports one lane."""
    engine = ScriptedEngine("alpha", ["xxa", "aaa"])
    _install_registry(monkeypatch, {"alpha": engine}, available=["alpha"])
    sink: list[tuple[str, dict[str, Any]]] = []
    server = EvalServer(vowel_scorer, max_evals=10)

    result, lanes = run_strategy(
        BlackboxStrategy(mode="single", engine="alpha"),
        Task(seed_candidate="seed"),
        server,
        make_ctx(str(tmp_path)),
        lambda event, metrics: sink.append((event, metrics)),
    )

    assert result.best_candidate == "aaa"
    assert result.metadata == {"engine": "alpha", "phase": "single"}
    assert [(lane.engine, lane.phase, lane.status, lane.scorer_runs) for lane in lanes] == [
        ("alpha", "single", "completed", 2)
    ]
    assert _events(sink, PROGRESS_LANE_STARTED) == [{"engine": "alpha", "phase": "single", "budget": 10}]
    assert _events(sink, PROGRESS_LANE_COMPLETED)[0]["best_score"] == 1.0
    assert _events(sink, PROGRESS_LANE_HANDOFF) == []


def test_auto_explores_every_engine_then_continues_with_gepa(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Auto splits the explore share evenly, hands the winner to GEPA, and keeps the better of the two."""
    alpha = ScriptedEngine("alpha", ["xxa"])
    beta = ScriptedEngine("beta", ["aax"])
    gepa = ScriptedEngine(BLACKBOX_ENGINE_GEPA, ["aaaa"])
    _install_registry(
        monkeypatch, {"alpha": alpha, "beta": beta, BLACKBOX_ENGINE_GEPA: gepa}, available=["alpha", "beta"]
    )
    sink: list[tuple[str, dict[str, Any]]] = []
    server = EvalServer(vowel_scorer, max_evals=20)

    result, lanes = run_strategy(
        BlackboxStrategy(mode="auto"),
        Task(seed_candidate="seed"),
        server,
        make_ctx(str(tmp_path)),
        lambda e, m: sink.append((e, m)),
    )

    # 75% of 20 = 15 explore evals, split 7 / 7; the continue lane gets what is left.
    started = _events(sink, PROGRESS_LANE_STARTED)
    assert started[:2] == [
        {"engine": "alpha", "phase": "explore", "budget": 7},
        {"engine": "beta", "phase": "explore", "budget": 7},
    ]
    assert started[2] == {"engine": BLACKBOX_ENGINE_GEPA, "phase": "continue", "budget": 18}
    assert _events(sink, PROGRESS_LANE_HANDOFF) == [
        {"from_engine": "beta", "to_engine": BLACKBOX_ENGINE_GEPA, "best_score": pytest.approx(2 / 3)}
    ]
    assert gepa.calls[0].seed_candidate == "aax"
    assert result.best_candidate == "aaaa"
    assert result.metadata == {"engine": BLACKBOX_ENGINE_GEPA, "phase": "continue"}
    assert [(lane.engine, lane.phase, lane.status) for lane in lanes] == [
        ("alpha", "explore", "completed"),
        ("beta", "explore", "completed"),
        (BLACKBOX_ENGINE_GEPA, "continue", "completed"),
    ]
    assert result.total_evals == 3


def test_auto_keeps_explore_winner_when_continue_does_not_beat_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A continue lane that scores lower than the explore winner does not replace it."""
    alpha = ScriptedEngine("alpha", ["aaa"])
    beta = ScriptedEngine("beta", ["xxx"])
    gepa = ScriptedEngine(BLACKBOX_ENGINE_GEPA, ["axx"])
    _install_registry(
        monkeypatch, {"alpha": alpha, "beta": beta, BLACKBOX_ENGINE_GEPA: gepa}, available=["alpha", "beta"]
    )

    result, _lanes = run_strategy(
        BlackboxStrategy(mode="auto"),
        Task(seed_candidate="seed"),
        EvalServer(vowel_scorer, max_evals=20),
        make_ctx(str(tmp_path)),
    )

    assert result.best_candidate == "aaa"
    assert result.metadata == {"engine": "alpha", "phase": "explore"}


def test_auto_tolerates_failed_and_unavailable_lanes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """One engine crashing or missing does not stop the others or the hand-off."""
    alpha = ScriptedEngine("alpha", ["aax"], error=RuntimeError("engine died"))
    gepa = ScriptedEngine(BLACKBOX_ENGINE_GEPA, ["aaaa"])
    _install_registry(monkeypatch, {"alpha": alpha, BLACKBOX_ENGINE_GEPA: gepa}, available=["alpha", "ghost"])

    result, lanes = run_strategy(
        BlackboxStrategy(mode="auto"),
        Task(seed_candidate="seed"),
        EvalServer(vowel_scorer, max_evals=20),
        make_ctx(str(tmp_path)),
    )

    by_engine = {lane.engine: lane for lane in lanes}
    assert by_engine["alpha"].status == "failed"
    assert by_engine["alpha"].error == "RuntimeError: engine died"
    # The failed lane still contributes the best version it scored before dying.
    assert by_engine["alpha"].best_score == pytest.approx(2 / 3)
    assert by_engine["ghost"].status == "unavailable"
    assert "not available" in str(by_engine["ghost"].error)
    assert by_engine[BLACKBOX_ENGINE_GEPA].phase == "continue"
    assert gepa.calls[0].seed_candidate == "aax"
    assert result.best_candidate == "aaaa"


def test_lane_reports_budget_exhaustion_with_the_best_seen(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An engine that overruns its slice ends as ``budget_exhausted`` and keeps its best version."""
    engine = ScriptedEngine("greedy", ["xxa", "aaa", "one too many"])
    _install_registry(monkeypatch, {"greedy": engine}, available=["greedy"])
    server = EvalServer(vowel_scorer, max_evals=5)

    outcome = run_lane("greedy", "explore", Task(seed_candidate="seed"), server.lane(2), make_ctx(str(tmp_path)))

    assert outcome.status == "budget_exhausted"
    assert outcome.best_candidate == "aaa"
    assert outcome.scorer_runs == 2
    assert server.remaining == 3


def test_lane_gets_its_own_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Each lane runs under ``<run_dir>/<phase>-<engine>``."""
    seen: list[str] = []

    class _Engine:
        """Engine that records the workspace it was given."""

        name = "spy"

        def run(self, task: Task, server: EvalServer, ctx: Any) -> Any:
            """Record ``ctx.run_dir`` and score the seed."""
            seen.append(ctx.run_dir)
            server.evaluate("aaa")
            return auto_mod.Result(best_candidate="aaa", best_score=1.0, total_evals=1)

    _install_registry(monkeypatch, {"spy": _Engine()}, available=["spy"])

    run_lane(
        "spy", "explore", Task(seed_candidate="seed"), EvalServer(vowel_scorer, max_evals=3), make_ctx(str(tmp_path))
    )

    assert seen == [str(tmp_path / "explore-spy")]


def test_cost_ceiling_stops_the_whole_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The credit ceiling is not a lane failure — it propagates out of the strategy."""
    engine = ScriptedEngine("alpha", ["aaa"], error=CostCeilingExceededError("ceiling hit"))
    _install_registry(monkeypatch, {"alpha": engine}, available=["alpha"])

    with pytest.raises(CostCeilingExceededError):
        run_strategy(
            BlackboxStrategy(mode="auto"),
            Task(seed_candidate="seed"),
            EvalServer(vowel_scorer, max_evals=5),
            make_ctx(str(tmp_path)),
        )


def test_scorer_abort_stops_the_whole_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A scorer abort is a run-level stop, not a lane failure to tolerate."""
    engine = ScriptedEngine("alpha", ["aaa"], error=ScorerAbortError("harness is dead"))
    _install_registry(monkeypatch, {"alpha": engine}, available=["alpha"])

    with pytest.raises(ScorerAbortError):
        run_strategy(
            BlackboxStrategy(mode="auto"),
            Task(seed_candidate="seed"),
            EvalServer(vowel_scorer, max_evals=5),
            make_ctx(str(tmp_path)),
        )


def test_auto_narrows_to_multi_part_engines_for_multi_part_seeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Named-part starting points only explore the engines that take them; alone, GEPA runs single."""
    gepa = ScriptedEngine(BLACKBOX_ENGINE_GEPA, ["aaa"])
    _install_registry(
        monkeypatch,
        {"alpha": ScriptedEngine("alpha", ["x"]), BLACKBOX_ENGINE_GEPA: gepa},
        available=["alpha", "gepa"],
        parts=["gepa"],
    )

    _result, lanes = run_strategy(
        BlackboxStrategy(mode="auto"),
        Task(seed_candidate={"p": "seed"}),
        EvalServer(vowel_scorer, max_evals=5),
        make_ctx(str(tmp_path)),
    )

    assert [(lane.engine, lane.phase) for lane in lanes] == [(BLACKBOX_ENGINE_GEPA, "single")]


def test_capabilities_reach_every_registry_call(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The job's capabilities decide what Auto explores and are handed to every engine lookup."""
    seen: list[EngineCapabilities] = []
    _install_registry(
        monkeypatch,
        {
            "alpha": ScriptedEngine("alpha", ["aax"]),
            BLACKBOX_ENGINE_GEPA: ScriptedEngine(BLACKBOX_ENGINE_GEPA, ["aaa"]),
        },
        available=["alpha", BLACKBOX_ENGINE_GEPA],
        seen_caps=seen,
    )
    caps = EngineCapabilities(sandbox=True, agent_target=True)

    _result, lanes = run_strategy(
        BlackboxStrategy(mode="auto"),
        Task(seed_candidate="seed"),
        EvalServer(vowel_scorer, max_evals=20),
        make_ctx(str(tmp_path)),
        caps=caps,
    )

    # One listing plus one lookup per lane (two explore lanes and the continue lane).
    assert len(lanes) == 3
    assert seen == [caps] * 4


def test_auto_with_one_available_engine_runs_a_single_lane(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """With nothing to explore across, Auto degrades to a single lane."""
    _install_registry(monkeypatch, {"only": ScriptedEngine("only", ["aaa"])}, available=["only"])

    _result, lanes = run_strategy(
        BlackboxStrategy(mode="auto"),
        Task(seed_candidate="seed"),
        EvalServer(vowel_scorer, max_evals=5),
        make_ctx(str(tmp_path)),
    )

    assert [(lane.engine, lane.phase, lane.status) for lane in lanes] == [("only", "single", "completed")]


def test_all_lanes_failing_falls_back_to_the_seed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """When no lane scored anything the seed is returned untouched."""
    _install_registry(monkeypatch, {}, available=["alpha", "beta"])

    result, lanes = run_strategy(
        BlackboxStrategy(mode="auto"),
        Task(seed_candidate="seed"),
        EvalServer(vowel_scorer, max_evals=5),
        make_ctx(str(tmp_path)),
    )

    assert result.best_candidate == "seed"
    assert result.best_score is None
    assert result.metadata == {"engine": None}
    assert all(lane.status == "unavailable" for lane in lanes)


def test_all_lanes_failing_without_a_seed_is_an_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Seedless runs have nothing to fall back to, so the run fails with every lane's error."""
    _install_registry(monkeypatch, {}, available=["alpha", "beta"])

    with pytest.raises(ServiceError, match=r"No engine produced a version\. alpha: .*; beta: "):
        run_strategy(
            BlackboxStrategy(mode="auto"),
            Task(seed_candidate=None, objective="x"),
            EvalServer(vowel_scorer, max_evals=5),
            make_ctx(str(tmp_path)),
        )


def test_plateau_relays_over_the_engine_order_and_reseeds_from_the_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Plateau hands the whole remaining budget to each engine in turn and stops after a round without a record."""
    alpha = ScriptedEngine("alpha", ["xxa", *["xxx"] * 5, "aaa"])
    beta = ScriptedEngine("beta", ["aax", *["xxx"] * 5, "aaaa"])
    _install_registry(monkeypatch, {"alpha": alpha, "beta": beta}, available=["alpha", "beta"])
    sink: list[tuple[str, dict[str, Any]]] = []
    server = EvalServer(vowel_scorer, max_evals=100)

    result, lanes = run_strategy(
        BlackboxStrategy(mode="plateau", patience=5),
        Task(seed_candidate="seed"),
        server,
        make_ctx(str(tmp_path)),
        lambda e, m: sink.append((e, m)),
    )

    # Each lane trips five runs after its last record; the third and fourth never set one.
    assert _events(sink, PROGRESS_LANE_STARTED) == [
        {"engine": "alpha", "phase": "relay", "budget": 100},
        {"engine": "beta", "phase": "relay", "budget": 94},
        {"engine": "alpha", "phase": "relay", "budget": 88},
        {"engine": "beta", "phase": "relay", "budget": 83},
    ]
    assert _events(sink, PROGRESS_LANE_HANDOFF) == [
        {"from_engine": "alpha", "to_engine": "beta", "best_score": pytest.approx(1 / 3), "reason": "plateaued"},
        {"from_engine": "beta", "to_engine": "alpha", "best_score": pytest.approx(2 / 3), "reason": "plateaued"},
        {"from_engine": "alpha", "to_engine": "beta", "best_score": pytest.approx(2 / 3), "reason": "plateaued"},
    ]
    assert [call.seed_candidate for call in alpha.calls] == ["seed", "aax"]
    assert [call.seed_candidate for call in beta.calls] == ["xxa", "aax"]
    assert result.best_candidate == "aax"
    assert result.metadata == {"engine": "beta", "phase": "relay"}
    assert [(lane.engine, lane.status, lane.scorer_runs) for lane in lanes] == [
        ("alpha", "plateaued", 6),
        ("beta", "plateaued", 6),
        ("alpha", "plateaued", 5),
        ("beta", "plateaued", 5),
    ]
    assert all(lane.error is None for lane in lanes)
    assert result.total_evals == 22
    assert server.remaining == 78


def test_plateau_stops_at_the_target_score(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A lane that reaches ``stop_at_score`` ends the relay without a handoff."""
    alpha = ScriptedEngine("alpha", ["aaa"])
    beta = ScriptedEngine("beta", ["aaaa"])
    _install_registry(monkeypatch, {"alpha": alpha, "beta": beta}, available=["alpha", "beta"])
    sink: list[tuple[str, dict[str, Any]]] = []

    result, lanes = run_strategy(
        BlackboxStrategy(mode="plateau"),
        Task(seed_candidate="seed"),
        EvalServer(vowel_scorer, max_evals=50),
        make_ctx(str(tmp_path), stop_at_score=1.0),
        lambda e, m: sink.append((e, m)),
    )

    assert [(lane.engine, lane.phase, lane.status) for lane in lanes] == [("alpha", "relay", "completed")]
    assert _events(sink, PROGRESS_LANE_HANDOFF) == []
    assert beta.calls == []
    assert result.best_candidate == "aaa"


def test_plateau_ends_when_the_budget_runs_out(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An engine that spends the whole budget before plateauing ends the relay as ``budget_exhausted``."""
    alpha = ScriptedEngine("alpha", ["xxa", "aaa", "aaaa", "one too many"])
    _install_registry(monkeypatch, {"alpha": alpha}, available=["alpha"])

    result, lanes = run_strategy(
        BlackboxStrategy(mode="plateau"),
        Task(seed_candidate="seed"),
        EvalServer(vowel_scorer, max_evals=3),
        make_ctx(str(tmp_path)),
        None,
    )

    assert [(lane.engine, lane.status, lane.scorer_runs) for lane in lanes] == [("alpha", "budget_exhausted", 3)]
    assert result.best_candidate == "aaa"
    assert result.total_evals == 3


def test_run_lane_stamps_the_lane_index_on_engine_events(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Trajectory events an engine emits through its context carry the lane's index."""

    class NarratingEngine:
        """Engine that reports one candidate through the context sink."""

        name = "alpha"

        def run(self, task: Task, server: EvalServer, ctx: Any) -> Result:
            """Emit a candidate event and return a fixed result."""
            ctx.progress_callback("candidate", {"candidate_id": "0"})
            return Result(best_candidate="aaa", best_score=1.0, total_evals=0)

    _install_registry(monkeypatch, {"alpha": NarratingEngine()}, available=["alpha"])
    sink: list[tuple[str, dict[str, Any]]] = []
    ctx = make_ctx(str(tmp_path), progress_callback=lambda event, metrics: sink.append((event, metrics)))

    run_lane("alpha", "explore", Task(seed_candidate="seed"), EvalServer(vowel_scorer, max_evals=2), ctx, lane_index=2)

    assert sink == [("candidate", {"candidate_id": "0", "lane_index": 2})]
