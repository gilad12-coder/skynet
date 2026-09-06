"""End-to-end tests for the job entry points with a fake reflection LM."""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from core.billing.signals import BudgetReached
from core.constants import (
    DETAIL_BASELINE,
    DETAIL_OPTIMIZED,
    PROGRESS_BASELINE,
    PROGRESS_EVALUATION_STARTED,
    PROGRESS_LANE_COMPLETED,
    PROGRESS_LANE_HANDOFF,
    PROGRESS_LANE_STARTED,
    PROGRESS_OPTIMIZED,
    PROGRESS_OPTIMIZER,
    PROGRESS_SPLITS_READY,
    TQDM_N_KEY,
    TQDM_TOTAL_KEY,
)
from core.exceptions import ServiceError
from core.models.blackbox import (
    BLACKBOX_ENGINE_BEST_OF_N,
    BLACKBOX_ENGINE_GEPA,
    BlackboxRunRequest,
    BlackboxStrategy,
    ScorerDryRunRequest,
)
from core.models.results import ModelTokenUsage

from .. import autoresearch as autoresearch_mod
from .. import meta_harness as meta_harness_mod
from .. import scorer as scorer_mod
from .. import service as service_mod
from ..agent_runs import PHASE_BASELINE, PHASE_FINAL
from ..auto import LaneOutcome
from ..harness import GatewayConfig
from ..native_runtime import NativeOptions
from ..protocol import Candidate, EngineContext, EvalServer, Result, Task, candidate_key
from ..sandbox_scorer import ScorerGateway, ScorerProbeResult
from ..service import dry_run_scorer, run_blackbox_optimization, validate_blackbox_payload
from .mocks import (
    AGENT_OUTPUT_SCORER_CODE,
    VOWEL_SCORER_CODE,
    FakeGateway,
    FakeReflectionLM,
    FakeSandboxRuntime,
    vowel_scorer,
)

_CASES = [{"target": "aeiou", "i": i} for i in range(10)]


def _payload(**overrides: Any) -> BlackboxRunRequest:
    """Build a valid request around the vowel scorer.

    Args:
        **overrides: Fields to replace in the default payload.

    Returns:
        The validated request.
    """
    data: dict[str, Any] = {
        "seed_candidate": "hello world",
        "objective": "maximize vowel density",
        "scorer": {"kind": "python", "metric_code": VOWEL_SCORER_CODE},
        "cases": _CASES,
        "seed": 1,
        "budget": {"max_scorer_runs": 12},
        "strategy": {"mode": "single", "engine": BLACKBOX_ENGINE_BEST_OF_N},
        "reflection_model_config": {"name": "fake/model"},
    }
    data.update(overrides)
    return BlackboxRunRequest.model_validate(data)


@pytest.fixture
def fake_lm(monkeypatch: pytest.MonkeyPatch) -> FakeReflectionLM:
    """Swap the reflection model for the improving fake.

    Args:
        monkeypatch: Pytest fixture.

    Returns:
        The fake the service will use.
    """
    lm = FakeReflectionLM()
    monkeypatch.setattr(service_mod, "build_language_model", lambda config, *, disable_cache=False: lm)
    return lm


@pytest.fixture
def fake_native_proposers(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, EngineContext]]:
    """Replace paid native proposal generation while retaining upstream ensemble scheduling.

    Args:
        monkeypatch: Pytest fixture for native runtime and gateway replacements.

    Returns:
        Native invocations with the execution context received from the service.
    """
    invocations: list[tuple[str, EngineContext]] = []
    monkeypatch.setattr(service_mod, "native_runtime_unavailable_reason", lambda _runtime, _settings: None)
    monkeypatch.setattr(
        service_mod,
        "gateway_from_settings",
        lambda _settings: GatewayConfig(url="https://unused.example/v1", api_key="test-key"),
    )

    def run_native(engine: str, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Score a deterministic native proposal against the real budgeted evaluator.

        Args:
            engine: Native engine selected by the upstream composition.
            task: Actual slice task passed by upstream.
            server: Slice budget and scorer bridge.
            ctx: Model, runtime and proposer budget passed by the service.

        Returns:
            Candidate-level aggregate evidence from the fake proposal.
        """
        invocations.append((engine, ctx))
        candidate = "aeioua" if engine == "autoresearch" else "aeiouaa"
        scores = []
        for example in task.train_set or task.val_set or [None]:
            if server.remaining <= 0:
                break
            score, _ = server.evaluate(candidate, example)
            scores.append(score)
        return Result(
            best_candidate=candidate,
            best_score=sum(scores) / len(scores) if scores else 1.0,
            total_evals=server.used,
            metadata={"engine": engine},
        )

    monkeypatch.setattr(autoresearch_mod, "run_native_engine", run_native)
    monkeypatch.setattr(meta_harness_mod, "run_native_engine", run_native)
    return invocations


def test_run_scores_baseline_and_optimized_on_the_holdout(fake_lm: FakeReflectionLM, tmp_path: Path) -> None:
    """A single best_of_n run improves the seed and reports the split, lanes, usage and reflection timing."""
    sink: list[tuple[str, dict[str, Any]]] = []

    response = run_blackbox_optimization(
        _payload(),
        artifact_id="job-1",
        progress_callback=lambda e, m: sink.append((e, m)),
        gepa_log_dir_path=str(tmp_path),
    )

    assert response.optimizer_name == BLACKBOX_ENGINE_BEST_OF_N
    assert response.engine_used == BLACKBOX_ENGINE_BEST_OF_N
    assert response.strategy_mode == "single"
    assert response.split_counts.train + response.split_counts.val + response.split_counts.test == 10
    assert response.seed_candidate == "hello world"
    assert response.best_candidate == "aeiou"
    assert response.baseline_test_metric == pytest.approx(3 / 11)
    assert response.optimized_test_metric == 1.0
    assert response.metric_improvement == pytest.approx(1 - 3 / 11)
    assert response.regression_guard_applied is False
    assert response.total_scorer_runs <= 12
    assert [(lane.engine, lane.phase, lane.status) for lane in response.lanes] == [
        (BLACKBOX_ENGINE_BEST_OF_N, "single", "completed")
    ]
    assert response.num_lm_calls == len(fake_lm.history) > 0
    assert response.total_tokens == 15 * len(fake_lm.history)
    assert [(u.model, u.input_tokens, u.output_tokens) for u in response.usage_by_model] == [
        ("fake/model", 10 * len(fake_lm.history), 5 * len(fake_lm.history))
    ]
    assert response.lm_activity is not None
    assert response.lm_activity.generation == {}
    reflection_stats = response.lm_activity.reflection["training"]
    assert reflection_stats.calls == len(fake_lm.history)
    assert reflection_stats.avg_response_time_ms is not None
    assert response.optimization_metadata["budget"] == {
        "max_scorer_runs": 12,
        "stop_at_score": None,
        "max_iterations": None,
    }
    assert response.optimization_metadata["target"]["kind"] == "text"
    assert response.details["optimizer_best_score"] == 1.0
    assert response.details["n_samples"] == len(fake_lm.history)
    assert response.details["n_parse_failures"] == 0

    events = [event for event, _ in sink]
    assert events[0] == PROGRESS_SPLITS_READY
    assert events[1] == PROGRESS_BASELINE
    assert events[-2] == PROGRESS_EVALUATION_STARTED
    assert events[-1] == PROGRESS_OPTIMIZED
    assert PROGRESS_LANE_STARTED in events
    assert PROGRESS_LANE_COMPLETED in events
    assert PROGRESS_LANE_HANDOFF not in events
    baseline_event = next(m for e, m in sink if e == PROGRESS_BASELINE)
    assert baseline_event[DETAIL_BASELINE] == pytest.approx(3 / 11)
    optimized_event = next(m for e, m in sink if e == PROGRESS_OPTIMIZED)
    assert optimized_event[DETAIL_OPTIMIZED] == 1.0
    optimizer_events = [m for e, m in sink if e == PROGRESS_OPTIMIZER]
    assert optimizer_events
    assert optimizer_events[-1][TQDM_TOTAL_KEY] == 12
    assert optimizer_events[-1][TQDM_N_KEY] == response.total_scorer_runs


def test_auto_run_hands_off_between_engines(
    fake_lm: FakeReflectionLM, tmp_path: Path, fake_native_proposers: list[tuple[str, EngineContext]]
) -> None:
    """Run the exact upstream three-engine exploration recipe before GEPA continuation.

    Args:
        fake_lm: Metered model fake used by the real GEPA implementation.
        tmp_path: Per-test artifact directory.
        fake_native_proposers: Captured native invocations without paid model calls.
    """
    sink: list[tuple[str, dict[str, Any]]] = []

    response = run_blackbox_optimization(
        _payload(strategy={"mode": "auto"}, budget={"max_scorer_runs": 24}, max_cost_credits=100),
        artifact_id="job-2",
        progress_callback=lambda e, m: sink.append((e, m)),
        gepa_log_dir_path=str(tmp_path),
    )

    assert response.optimizer_name == "auto"
    assert response.strategy_mode == "auto"
    assert {(lane.engine, lane.phase) for lane in response.lanes[:3]} == {
        ("gepa", "explore"),
        ("autoresearch", "explore"),
        ("meta_harness", "explore"),
    }
    assert (response.lanes[-1].engine, response.lanes[-1].phase) == ("gepa", "continue")
    assert response.engine_used == "gepa"
    assert {engine for engine, _ in fake_native_proposers} == {"autoresearch", "meta_harness"}
    assert all(ctx.native_options.model == "fake/model" for _, ctx in fake_native_proposers)
    assert all(ctx.native_options.runtime == "vercel" for _, ctx in fake_native_proposers)
    assert all(ctx.native_options.max_token_cost > 0 for _, ctx in fake_native_proposers)
    assert response.total_scorer_runs <= 24
    assert response.optimized_test_metric >= response.baseline_test_metric
    handoffs = [m for e, m in sink if e == PROGRESS_LANE_HANDOFF]
    assert len(handoffs) == 1
    assert handoffs[0]["to_engine"] == "gepa"


def test_regression_guard_restores_the_seed(
    fake_lm: FakeReflectionLM, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A winner that scores below the starting point on the held-out cases is discarded."""
    monkeypatch.setattr(
        service_mod,
        "run_strategy",
        lambda strategy, task, server, ctx, cb=None, *, caps=None: (
            Result(best_candidate="xyz", best_score=0.0, total_evals=0),
            [],
        ),
    )

    response = run_blackbox_optimization(_payload(), artifact_id="job-3", gepa_log_dir_path=str(tmp_path))

    assert response.regression_guard_applied is True
    assert response.best_candidate == "hello world"
    assert response.optimized_test_metric == response.baseline_test_metric
    assert response.metric_improvement == 0.0
    assert response.engine_used == BLACKBOX_ENGINE_BEST_OF_N


def test_seedless_run_without_cases_scores_the_version_alone(fake_lm: FakeReflectionLM, tmp_path: Path) -> None:
    """Without a starting point or cases there is no baseline and the scorer sees ``case=None``."""
    response = run_blackbox_optimization(
        _payload(seed_candidate=None, cases=None, budget={"max_scorer_runs": 3}),
        artifact_id="job-4",
        gepa_log_dir_path=str(tmp_path),
    )

    assert response.seed_candidate is None
    assert response.baseline_test_metric is None
    assert response.metric_improvement is None
    assert response.split_counts.model_dump() == {"train": 0, "val": 0, "test": 0}
    assert response.best_candidate == "aeiou"
    assert response.optimized_test_metric == 1.0


def test_run_fails_when_the_scorer_rejects_the_starting_point(fake_lm: FakeReflectionLM, tmp_path: Path) -> None:
    """A scorer that raises on the seed fails the job with a clear message."""
    payload = _payload(scorer={"kind": "python", "metric_code": "def score(c, case=None): raise KeyError('nope')"})

    with pytest.raises(ServiceError, match="scorer failed on the starting point: KeyError: 'nope'"):
        run_blackbox_optimization(payload, artifact_id="job-5", gepa_log_dir_path=str(tmp_path))


def test_validate_payload_checks_engine_and_scorer_code(monkeypatch: pytest.MonkeyPatch) -> None:
    """Validation rejects unavailable engines and unloadable scorer code, and passes clean payloads."""
    checked: list[str] = []
    monkeypatch.setattr(service_mod, "validate_scorer_code", checked.append)
    monkeypatch.setattr(service_mod, "native_runtime_unavailable_reason", lambda _runtime, _settings: "missing runtime")

    validate_blackbox_payload(_payload())
    assert checked == [VOWEL_SCORER_CODE]

    with pytest.raises(ServiceError, match="not available"):
        validate_blackbox_payload(_payload(strategy={"mode": "single", "engine": "autoresearch"}))

    remote = _payload(scorer={"kind": "remote", "url": "https://scorer.example"})
    checked.clear()
    validate_blackbox_payload(remote)
    assert checked == []


def test_validate_payload_surfaces_sandbox_errors() -> None:
    """Broken scorer code is caught by the real sandbox before the job is queued."""
    with pytest.raises(ServiceError, match="must define a function named 'score"):
        validate_blackbox_payload(_payload(scorer={"kind": "python", "metric_code": "x = 1"}))


def test_protected_contract_validation_never_loads_authored_scorer(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep executable scorer verification inside the protected runtime's actual readiness check."""

    def forbid(_code: str) -> None:
        """Reject scorer execution in contract-only validation."""
        pytest.fail("The protected parent must not execute authored scorer code.")

    monkeypatch.setattr(service_mod, "validate_scorer_code", forbid)
    validate_blackbox_payload(_payload(scorer={"kind": "python", "metric_code": "x = 1"}), verify_scorer=False)


def test_dry_run_scores_python_scorer_in_the_sandbox() -> None:
    """A python dry run returns the score and side info from the sandboxed scorer."""
    request = ScorerDryRunRequest(
        scorer={"kind": "python", "metric_code": VOWEL_SCORER_CODE}, candidate="aeiou", case={"x": 1}
    )

    response = dry_run_scorer(request)

    assert response.ok is True
    assert response.score == 1.0
    assert response.side_info == {"vowels": 5}
    assert response.error is None
    assert response.elapsed_ms >= 0


def test_dry_run_reports_scorer_exceptions_without_raising() -> None:
    """A scorer that raises on the candidate is reported, not propagated."""
    request = ScorerDryRunRequest(
        scorer={"kind": "python", "metric_code": "def score(c, case=None): raise ValueError('bad candidate')"},
        candidate="x",
    )

    response = dry_run_scorer(request)

    assert response.ok is False
    assert response.score is None
    assert response.error == "ValueError: bad candidate"


def test_dry_run_reports_unloadable_code() -> None:
    """Load failures come back as ``ok=False`` with the sandbox's message."""
    response = dry_run_scorer(ScorerDryRunRequest(scorer={"kind": "python", "metric_code": "def !!!"}, candidate="x"))

    assert response.ok is False
    assert "syntax error" in str(response.error)


def test_dry_run_bounds_python_scorers_by_the_spec_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """The dry run probes with the scorer's own ``timeout_seconds``, not a fixed default."""
    seen: dict[str, Any] = {}

    def fake_probe(**kwargs: Any) -> ScorerProbeResult:
        """Capture scorer settings and return a successful probe.

        Args:
            **kwargs: Settings forwarded by the dry-run service.

        Returns:
            A deterministic successful scorer result.
        """
        seen.update(kwargs)
        return ScorerProbeResult(score=1.0, side_info={}, error=None)

    monkeypatch.setattr(service_mod, "probe_scorer", fake_probe)
    request = ScorerDryRunRequest(
        scorer={"kind": "python", "metric_code": VOWEL_SCORER_CODE, "timeout_seconds": 12.5}, candidate="x"
    )

    response = dry_run_scorer(request)

    assert response.ok is True
    assert seen["timeout_seconds"] == 12.5


def test_dry_run_reports_a_scorer_that_outruns_its_timeout() -> None:
    """A python scorer slower than its timeout is stopped and reported, not left hanging."""
    request = ScorerDryRunRequest(
        scorer={
            "kind": "python",
            "metric_code": "import time\ndef score(c, case=None):\n    time.sleep(30)\n    return 1.0\n",
            "timeout_seconds": 1,
        },
        candidate="x",
    )

    response = dry_run_scorer(request)

    assert response.ok is False
    assert response.score is None
    assert "exceeded the 1s" in str(response.error)


def test_dry_run_calls_remote_scorer(monkeypatch: pytest.MonkeyPatch) -> None:
    """A remote dry run makes one request through the remote adapter."""
    calls: list[tuple[Any, Any]] = []

    class _FakeRemote:
        """Records construction and returns a fixed score."""

        def __init__(self, url: str, *, secret: str | None, timeout_seconds: float) -> None:
            """Record the endpoint settings."""
            calls.append((url, (secret, timeout_seconds)))

        def __call__(self, candidate: Any, case: Any = None) -> tuple[float, dict[str, Any]]:
            """Return a fixed score."""
            calls.append((candidate, case))
            return 0.5, {"remote": True}

    monkeypatch.setattr(service_mod, "RemoteScorer", _FakeRemote)
    request = ScorerDryRunRequest(
        scorer={"kind": "remote", "url": "https://scorer.example", "secret": "s", "timeout_seconds": 5},
        candidate={"part": "v"},
    )

    response = dry_run_scorer(request)

    assert response.ok is True
    assert response.score == 0.5
    assert response.side_info == {"remote": True}
    assert calls == [("https://scorer.example", ("s", 5.0)), ({"part": "v"}, None)]


def test_dry_run_reports_remote_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remote adapter errors come back as ``ok=False``."""

    class _Broken:
        """Remote adapter whose call fails."""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            """Accept any settings."""

        def __call__(self, candidate: Any, case: Any = None) -> tuple[float, dict[str, Any]]:
            """Fail like a dead endpoint."""
            raise ServiceError("remote scorer request failed: refused")

    monkeypatch.setattr(service_mod, "RemoteScorer", _Broken)

    response = dry_run_scorer(ScorerDryRunRequest(scorer={"kind": "remote", "url": "https://x.example"}, candidate="x"))

    assert response.ok is False
    assert response.error == "remote scorer request failed: refused"


_AGENT_TARGET = {
    "kind": "agent",
    "harness": "custom",
    "model": "m",
    "run_command": "run-agent",
    "timeout_seconds": 600,
    "concurrency": 2,
}


def test_validate_payload_rejects_agent_targets_this_deployment_cannot_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """An agent target on a deployment with no sandbox is refused before it is queued."""
    monkeypatch.setattr(service_mod, "current_sandbox_runtime", lambda: None)
    monkeypatch.setattr(
        service_mod, "agent_target_unavailable_reason", lambda settings: "Agent sandboxes are not configured."
    )

    with pytest.raises(ServiceError, match="Agent targets cannot run on this deployment: Agent sandboxes are not"):
        validate_blackbox_payload(_payload(target=_AGENT_TARGET))


def test_agent_target_runs_every_scorer_call_in_its_own_sandbox(
    fake_lm: FakeReflectionLM, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each scorer run opens a fresh, tagged sandbox, runs the harness, and the scorer judges its answer."""
    runtime = FakeSandboxRuntime()
    monkeypatch.setattr(service_mod, "agent_target_unavailable_reason", lambda settings: None)
    monkeypatch.setattr(service_mod, "sandbox_runtime_from_settings", lambda settings: runtime)
    monkeypatch.setattr(
        service_mod,
        "gateway_from_settings",
        lambda settings: GatewayConfig(url="https://gw.example/v1", api_key="secret-key"),
    )

    response = run_blackbox_optimization(
        _payload(
            seed_candidate="be a helpful agent",
            cases=[{"prompt": f"solve {i}", "i": i} for i in range(10)],
            budget={"max_scorer_runs": 4},
            scorer={"kind": "python", "metric_code": AGENT_OUTPUT_SCORER_CODE},
            target=_AGENT_TARGET,
        ),
        artifact_id="agent-1",
        gepa_log_dir_path=str(tmp_path),
    )

    assert runtime.sessions, "no sandbox was opened for the agent target"
    assert len(runtime.sessions) == len(runtime.specs)
    assert all(session.closed for session in runtime.sessions)
    assert all(session.commands == ["run-agent"] for session in runtime.sessions)

    assert len({spec.name for spec in runtime.specs}) == len(runtime.specs)
    spec = runtime.specs[0]
    assert spec.name.startswith("skynet-agent-1-")
    assert spec.tags == {"skynet_job": "agent-1"}
    assert spec.env["SKYNET_MODEL"] == "m"
    assert spec.env["SKYNET_GATEWAY_URL"] == "https://gw.example/v1"
    assert spec.env["SKYNET_API_KEY"] == "secret-key"
    assert spec.lifetime_seconds == 60 + 600 + 15

    # The default fake answers ``done`` (two vowels of four) for every run, so
    # the scorer that reads the answer file scores every version at 0.5.
    assert response.baseline_test_metric == pytest.approx(0.5)
    assert response.optimized_test_metric == pytest.approx(0.5)
    assert response.regression_guard_applied is False

    target_meta = response.optimization_metadata["target"]
    assert target_meta["kind"] == "agent"
    assert target_meta["harness"] == "custom"
    assert target_meta["model"] == "m"
    assert target_meta["concurrency"] == 2


_JUDGE_SCORER_CODE = (
    "def score(candidate, case=None):\n    return float(llm(candidate, case['target'])), {'judge': 'fake'}\n"
)


def test_plateau_run_relays_between_engines(
    fake_lm: FakeReflectionLM, tmp_path: Path, fake_native_proposers: list[tuple[str, EngineContext]]
) -> None:
    """Preserve upstream adaptive scheduling and its shared evaluation budget.

    Args:
        fake_lm: Metered model fake used by GEPA slices.
        tmp_path: Per-test artifact directory.
        fake_native_proposers: Captured native invocations without paid model calls.
    """
    sink: list[tuple[str, dict[str, Any]]] = []

    response = run_blackbox_optimization(
        _payload(strategy={"mode": "plateau", "patience": 5}, budget={"max_scorer_runs": 40}, max_cost_credits=100),
        artifact_id="job-plateau",
        progress_callback=lambda e, m: sink.append((e, m)),
        gepa_log_dir_path=str(tmp_path),
    )

    assert response.strategy_mode == "plateau"
    assert response.lanes[0].engine == "gepa"
    assert {lane.phase for lane in response.lanes} == {"relay"}
    assert len(response.lanes) >= 2
    assert {engine for engine, _ in fake_native_proposers} == {"autoresearch", "meta_harness"}
    assert response.total_scorer_runs <= 40
    assert response.optimized_test_metric >= response.baseline_test_metric
    assert response.details["adaptive_switches"] >= 2
    assert response.details["adaptive_schedule"][0]["engine_idx"] == 0
    assert all(step["eval_delta"] <= 5 for step in response.details["adaptive_schedule"])
    assert "stage_results" not in response.details
    assert len([event for event, _ in sink if event == PROGRESS_LANE_STARTED]) == len(response.lanes)
    assert len([event for event, _ in sink if event == PROGRESS_LANE_COMPLETED]) == len(response.lanes)
    response.model_dump_json()


@pytest.mark.parametrize(
    "strategy",
    [
        {"mode": "auto"},
        {"mode": "plateau"},
        {"mode": "single", "engine": "autoresearch"},
        {"mode": "single", "engine": "meta_harness"},
    ],
)
def test_unavailable_native_recipe_fails_before_building_a_scorer(
    monkeypatch: pytest.MonkeyPatch, strategy: dict[str, str]
) -> None:
    """Reject unavailable native execution before a baseline or any paid setup starts.

    Args:
        monkeypatch: Pytest fixture for deterministic runtime capabilities.
        strategy: Recipe requiring native proposals.
    """
    monkeypatch.setattr(service_mod, "native_runtime_unavailable_reason", lambda _runtime, _settings: "missing runtime")

    def unexpected_scorer(*args: Any, **kwargs: Any) -> None:
        """Fail if scorer construction starts for a rejected recipe.

        Args:
            *args: Unexpected scorer arguments.
            **kwargs: Unexpected scorer options.
        """
        pytest.fail("Scorer was constructed before native execution was validated")

    monkeypatch.setattr(service_mod, "build_scorer", unexpected_scorer)

    with pytest.raises(ServiceError, match="missing runtime"):
        run_blackbox_optimization(_payload(strategy=strategy, max_cost_credits=100), artifact_id="invalid-native")


@pytest.mark.parametrize(
    ("strategy", "requires_train"),
    [
        ({"mode": "auto"}, True),
        ({"mode": "plateau"}, True),
        ({"mode": "single", "engine": "meta_harness"}, True),
        ({"mode": "single", "engine": "gepa"}, False),
        ({"mode": "single", "engine": "autoresearch"}, False),
    ],
)
def test_empty_training_split_rejected_only_for_meta_harness_recipes(
    monkeypatch: pytest.MonkeyPatch, strategy: dict[str, str], requires_train: bool
) -> None:
    """Protect Meta-Harness from dropping validation-only data without relocating any cases.

    Args:
        monkeypatch: Pytest fixture for deterministic runtime capabilities.
        strategy: Upstream recipe being validated.
        requires_train: Whether the recipe includes Meta-Harness.
    """
    monkeypatch.setattr(service_mod, "native_runtime_unavailable_reason", lambda _runtime, _settings: None)
    monkeypatch.setattr(service_mod, "validate_scorer_code", lambda _code: None)
    payload = _payload(
        strategy=strategy,
        max_cost_credits=100,
        split_fractions={"train": 0.0, "val": 0.8, "test": 0.2},
    )
    before = payload.model_dump()

    def unexpected_scorer(*args: Any, **kwargs: Any) -> None:
        """Fail if an invalid training split reaches scorer construction.

        Args:
            *args: Unexpected scorer arguments.
            **kwargs: Unexpected scorer options.
        """
        pytest.fail("Invalid training split reached scorer construction")

    monkeypatch.setattr(service_mod, "build_scorer", unexpected_scorer)
    if requires_train:
        with pytest.raises(ServiceError, match="at least one training case"):
            run_blackbox_optimization(payload, artifact_id="empty-training")
    else:
        validate_blackbox_payload(payload)

    assert payload.model_dump() == before


def test_smallest_training_share_keeps_one_case_for_meta_harness(monkeypatch: pytest.MonkeyPatch) -> None:
    """Give a training share too small to round to a case one case, so Meta-Harness accepts it.

    Args:
        monkeypatch: Pytest fixture for deterministic runtime capabilities.
    """
    monkeypatch.setattr(service_mod, "native_runtime_unavailable_reason", lambda _runtime, _settings: None)
    monkeypatch.setattr(service_mod, "validate_scorer_code", lambda _code: None)
    payload = _payload(
        strategy={"mode": "single", "engine": "meta_harness"},
        max_cost_credits=100,
        split_fractions={"train": 0.01, "val": 0.8, "test": 0.19},
    )
    before = payload.model_dump()

    validate_blackbox_payload(payload)

    assert payload.model_dump() == before


def test_combined_usage_preserves_distinct_native_model_keys() -> None:
    """Merge shared model usage while retaining tokens from other native model identities."""
    lm = FakeReflectionLM(model="fake/model")
    lm("reflection")
    native = NativeOptions(
        runtime="vercel",
        model="fake/model",
        gateway=GatewayConfig(url="https://unused.example/v1", api_key="test-key"),
        max_token_cost=1.0,
        usage_by_model={
            "fake/model": {"prompt_tokens": 3, "completion_tokens": 1},
            "native/other-model": {"prompt_tokens": 7, "completion_tokens": 2},
        },
    )

    assert service_mod._combined_usage([lm], native) == {
        "fake/model": (13, 6),
        "native/other-model": (7, 2),
    }
    assert native.usage_by_model["fake/model"] == {"prompt_tokens": 3, "completion_tokens": 1}


@pytest.mark.parametrize(
    ("strategy", "native"),
    [
        ({"mode": "auto"}, True),
        ({"mode": "plateau"}, True),
        ({"mode": "single", "engine": "meta_harness"}, True),
        ({"mode": "single", "engine": "autoresearch"}, True),
        ({"mode": "single", "engine": "gepa"}, False),
        ({"mode": "single", "engine": "best_of_n"}, False),
    ],
)
@pytest.mark.parametrize(
    "model_options",
    [
        {"temperature": 0.2},
        {"max_tokens": 4096},
        {"base_url": "https://models.example/v1"},
        {"extra": {"reasoning_effort": "high"}},
    ],
    ids=["temperature", "max-tokens", "base-url", "extra"],
)
def test_native_model_controls_are_rejected_without_restricting_direct_engines(
    monkeypatch: pytest.MonkeyPatch, strategy: dict[str, str], native: bool, model_options: dict[str, Any]
) -> None:
    """Reject native model knobs that upstream cannot honor while retaining direct engine controls.

    Args:
        monkeypatch: Pytest fixture for deterministic runtime capabilities.
        strategy: Recipe whose model controls are validated.
        native: Whether the recipe includes an upstream native proposer.
        model_options: Explicit sampler or routing options on the submitted model.
    """
    monkeypatch.setattr(service_mod, "native_runtime_unavailable_reason", lambda _runtime, _settings: None)
    payload = _payload(
        strategy=strategy,
        max_cost_credits=100,
        scorer={"kind": "remote", "url": "https://scorer.example"},
        reflection_model_config={"name": "fake/model", **model_options},
    )

    if native:
        with pytest.raises(ServiceError, match="custom sampling and routing settings are unsupported"):
            validate_blackbox_payload(payload)
    else:
        validate_blackbox_payload(payload)


def test_strategy_patience_has_bounds() -> None:
    """Patience below five runs or above ten thousand is rejected at validation."""
    assert BlackboxStrategy(mode="plateau").patience == 40
    with pytest.raises(ValidationError):
        BlackboxStrategy(mode="plateau", patience=4)
    with pytest.raises(ValidationError):
        BlackboxStrategy(mode="plateau", patience=10_001)


def test_scorer_llm_usage_is_billed_with_the_run(
    fake_lm: FakeReflectionLM, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A scorer's ``llm()`` reaches the chosen model through the gateway, and its tokens land in the run's usage."""
    chosen: list[str] = []
    with FakeGateway(reply="0.5", usage=(3, 1)) as judge:

        def fake_gateway(config: Any, settings: Any) -> ScorerGateway:
            """Point the scorer at the fake judge, remembering which model was asked for."""
            chosen.append(config.name)
            return ScorerGateway(url=judge.url, model="judge", api_key="k", billing_model=config.name)

        monkeypatch.setattr(scorer_mod, "scorer_gateway", fake_gateway)
        response = run_blackbox_optimization(
            _payload(scorer={"kind": "python", "metric_code": _JUDGE_SCORER_CODE, "model": {"name": "fake/judge"}}),
            artifact_id="job-judge",
            gepa_log_dir_path=str(tmp_path),
        )

    assert chosen == ["fake/judge"]
    chats = [request["body"]["messages"] for request in judge.requests]
    assert chats
    assert chats[0] == [{"role": "system", "content": "hello world"}, {"role": "user", "content": "aeiou"}]
    assert all(chat[0]["role"] == "system" and chat[1] == {"role": "user", "content": "aeiou"} for chat in chats)
    assert all(r["authorization"] == "Bearer k" and r["body"]["model"] == "judge" for r in judge.requests)
    assert response.baseline_test_metric == 0.5
    calls = len(judge.requests)
    usage = {u.model: (u.input_tokens, u.output_tokens) for u in response.usage_by_model}
    assert usage["fake/judge"] == (3 * calls, calls)
    assert usage["fake/model"] == (10 * len(fake_lm.history), 5 * len(fake_lm.history))
    assert response.num_lm_calls == len(fake_lm.history) + calls
    assert response.total_tokens == 15 * len(fake_lm.history) + 4 * calls


def test_gateway_prefixed_reflection_usage_merges_with_the_scorer_row(
    fake_lm: FakeReflectionLM, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A reflection LM on the managed gateway and a scorer on the same model report one usage row."""
    fake_lm.model = "litellm_proxy/fake/judge"
    with FakeGateway(reply="0.5", usage=(3, 1)) as judge:
        monkeypatch.setattr(
            scorer_mod,
            "scorer_gateway",
            lambda config, settings: ScorerGateway(
                url=judge.url, model="judge", api_key="k", billing_model=config.name
            ),
        )
        response = run_blackbox_optimization(
            _payload(scorer={"kind": "python", "metric_code": _JUDGE_SCORER_CODE, "model": {"name": "fake/judge"}}),
            artifact_id="job-judge-merged",
            gepa_log_dir_path=str(tmp_path),
        )
    calls = len(judge.requests)
    assert response.usage_by_model == [
        ModelTokenUsage(
            model="fake/judge",
            input_tokens=10 * len(fake_lm.history) + 3 * calls,
            output_tokens=5 * len(fake_lm.history) + calls,
        )
    ]


def test_dry_run_binds_the_scorer_model_and_returns_its_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dry run hands the scorer's model to the sandbox and reports what ``llm()`` consumed."""
    seen: dict[str, Any] = {}

    def fake_probe(**kwargs: Any) -> ScorerProbeResult:
        """Capture the probe arguments and answer with usage."""
        seen.update(kwargs)
        return ScorerProbeResult(score=0.5, side_info={}, error=None, usage_by_model={"fake/judge": (12, 3)})

    monkeypatch.setattr(service_mod, "probe_scorer", fake_probe)
    request = ScorerDryRunRequest(
        scorer={"kind": "python", "metric_code": _JUDGE_SCORER_CODE, "model": {"name": "fake/judge"}},
        candidate="aeiou",
        case={"target": "aeiou"},
    )

    response = dry_run_scorer(request)

    assert seen["scorer_model"]["name"] == "fake/judge"
    assert response.ok is True
    assert response.score == 0.5
    assert response.usage_by_model == [ModelTokenUsage(model="fake/judge", input_tokens=12, output_tokens=3)]


def test_reflection_caller_hands_chat_messages_to_the_model() -> None:
    """Text prompts pass positionally, chat messages via ``messages=``, and every call is timed."""
    calls: list[tuple[Any, Any]] = []

    class LM:
        def __call__(self, prompt: Any = None, *, messages: Any = None) -> list[str]:
            """Record whether reflection uses a text prompt or chat messages.

            Args:
                prompt: Positional reflection text.
                messages: Structured reflection messages.

            Returns:
                A deterministic reflection response.
            """
            calls.append((prompt, messages))
            return ["reflected"]

    reflection_lm, durations_ms = service_mod._reflection_caller(LM())  # type: ignore[arg-type]
    assert reflection_lm("plain text") == "reflected"
    multimodal = [{"role": "user", "content": [{"type": "text", "text": "look"}]}]
    assert reflection_lm(multimodal) == "reflected"
    assert calls == [("plain text", None), (None, multimodal)]
    assert len(durations_ms) == 2
    assert all(d >= 0 for d in durations_ms)


def test_run_persists_every_version_it_scored(fake_lm: FakeReflectionLM, tmp_path: Path) -> None:
    """Record search evaluations in order and keep the baseline in its dedicated result fields.

    Args:
        fake_lm: Metered model fake used by upstream Best-of-N.
        tmp_path: Per-test artifact directory.
    """
    response = run_blackbox_optimization(_payload(), artifact_id="job-v", gepa_log_dir_path=str(tmp_path))

    assert response.versions
    assert response.seed_candidate == "hello world"
    assert response.baseline_test_metric == pytest.approx(3 / 11)
    assert response.versions[0].candidate == "aeiou"
    assert [version.first_run for version in response.versions] == sorted(
        version.first_run for version in response.versions
    )
    assert all(version.evals >= 1 and version.score is not None for version in response.versions)
    assert response.versions[0].side_info == {"vowels": 5}
    assert max(response.versions, key=lambda version: version.score or 0.0).candidate == "aeiou"


def test_run_carries_gepa_lineage_as_a_candidate_tree(fake_lm: FakeReflectionLM, tmp_path: Path) -> None:
    """A GEPA run's parent lineage arrives as a tree rooted at the seed, kept out of ``details``."""
    payload = _payload(strategy={"mode": "single", "engine": BLACKBOX_ENGINE_GEPA})
    response = run_blackbox_optimization(payload, artifact_id="job-tree", gepa_log_dir_path=str(tmp_path))

    assert response.candidate_tree
    assert response.candidate_tree[0].candidate == "hello world"
    assert response.candidate_tree[0].parents == [None]
    assert all(
        parent is None or 0 <= parent < index
        for index, node in enumerate(response.candidate_tree)
        for parent in node.parents
    )
    assert any(node.candidate == response.best_candidate for node in response.candidate_tree)
    assert "candidate_tree" not in response.details


def test_version_history_sheds_images_from_the_weakest_versions_first(monkeypatch: pytest.MonkeyPatch) -> None:
    """Over the byte cap, weak versions lose their renders but keep their text; the best keeps everything."""
    image = "data:image/png;base64," + "A" * 400

    def rendering_scorer(candidate: Any, case: Any = None) -> tuple[float, dict[str, Any]]:
        """Score by length and attach a render plus feedback.

        Args:
            candidate: The version.
            case: Ignored.

        Returns:
            The length score and side info with one image.
        """
        return float(len(candidate)), {"feedback": f"len {len(candidate)}", "render": image, "frames": [image]}

    server = service_mod.EvalServer(rendering_scorer, max_evals=10)
    for candidate in ("a", "ccc", "bb"):
        server.evaluate(candidate)
    monkeypatch.setattr(service_mod, "VERSION_SIDE_INFO_BYTE_CAP", 1_000)

    versions = service_mod._version_history(server)

    assert [version.candidate for version in versions] == ["a", "ccc", "bb"]
    weakest, best, middle = versions
    assert weakest.side_info == {"feedback": "len 1", "frames": []}
    assert middle.side_info == {"feedback": "len 2", "frames": []}
    assert best.side_info == {"feedback": "len 3", "render": image, "frames": [image]}


def test_service_hands_the_progress_sink_to_the_engine_context(
    fake_lm: FakeReflectionLM, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The job's progress sink rides into the engine context so trajectory events stream live."""
    captured: dict[str, Any] = {}

    def fake_run_strategy(strategy: Any, task: Any, server: Any, ctx: Any, cb: Any = None, *, caps: Any = None) -> Any:
        """Capture the engine context and finish immediately."""
        captured["ctx"] = ctx
        return Result(best_candidate="hello world", best_score=1.0, total_evals=0), []

    monkeypatch.setattr(service_mod, "run_strategy", fake_run_strategy)

    def sink(event: str, metrics: dict[str, Any]) -> None:
        """Discard events."""

    run_blackbox_optimization(_payload(), artifact_id="job-cb", progress_callback=sink, gepa_log_dir_path=str(tmp_path))

    assert captured["ctx"].progress_callback is sink


@pytest.mark.parametrize("concurrency", [1, 2])
def test_score_holdout_logs_a_debug_heartbeat_per_case(caplog: pytest.LogCaptureFixture, concurrency: int) -> None:
    """Held-out passes log one DEBUG line per case for the verbose log view, whichever pool serves them."""
    cases = [{"n": 1}, {"n": 2}]

    with caplog.at_level(logging.DEBUG, logger="core.service_gateway.optimization.blackbox.service"):
        mean = service_mod._score_holdout(
            lambda candidate, case: (case["n"] / 4, {}),
            "v",
            cases,
            label="optimized version",
            phase=PHASE_FINAL,
            concurrency=concurrency,
        )

    assert mean == pytest.approx(0.375)
    heartbeats = sorted(r.getMessage() for r in caplog.records if r.levelno == logging.DEBUG)
    assert heartbeats == [
        "optimized version holdout eval 1/2 score=0.250",
        "optimized version holdout eval 2/2 score=0.500",
    ]


def test_score_holdout_stops_scheduling_cases_once_one_fails() -> None:
    """A failing case fails the pass at once and the cases still queued are never scored."""
    started: list[int] = []
    lock = threading.Lock()

    def scorer(candidate: Candidate, case: Any) -> tuple[float, dict[str, Any]]:
        """Fail the first case quickly; every other case takes long enough for the cancel to land."""
        with lock:
            started.append(case["n"])
        if case["n"] == 1:
            time.sleep(0.01)
            raise ValueError("boom")
        time.sleep(0.2)
        return 1.0, {}

    cases = [{"n": n} for n in range(1, 7)]
    with pytest.raises(ServiceError, match="scorer failed on the optimized version: ValueError: boom"):
        service_mod._score_holdout(scorer, "v", cases, label="optimized version", phase=PHASE_FINAL, concurrency=2)

    assert set(started) <= {1, 2, 3}


def test_score_holdout_logs_the_score_in_single_task_mode(caplog: pytest.LogCaptureFixture) -> None:
    """Without cases the held-out pass still says what it scores and what it scored."""
    with caplog.at_level(logging.INFO, logger="core.service_gateway.optimization.blackbox.service"):
        score = service_mod._score_holdout(
            lambda candidate, case: (0.8, {}), "v", None, label="starting point", phase=PHASE_BASELINE
        )

    assert score == 0.8
    assert [r.getMessage() for r in caplog.records if r.levelno == logging.INFO] == [
        "scoring the starting point",
        "starting point scored 0.800 in 0s",
    ]


def test_version_history_shows_the_validation_score_and_keeps_the_running_mean() -> None:
    """A version the engine scored on the validation set shows that score; the running mean rides along."""
    server = EvalServer(vowel_scorer, max_evals=4)
    server.evaluate("aaa")
    server.evaluate("aaa")
    server.evaluate("bcd")

    versions = service_mod._version_history(server, {"aaa": 0.75})

    assert [(v.candidate, v.score, v.mean_score, v.evals) for v in versions] == [
        ("aaa", 0.75, server.mean_score("aaa"), 2),
        ("bcd", server.mean_score("bcd"), server.mean_score("bcd"), 1),
    ]


def test_validation_scores_come_from_every_lane_with_the_later_lane_winning() -> None:
    """Lineage from every lane feeds the map; a candidate seen again takes the later lane's score."""
    explore = LaneOutcome(
        engine="gepa",
        phase="explore",
        status="completed",
        metadata={
            "candidate_tree": [
                {"candidate": "seed", "val_score": 0.2},
                {"candidate": {"system": "x"}, "val_score": 0.5},
                {"candidate": "never swept", "val_score": None},
            ]
        },
    )
    bare = LaneOutcome(engine="best_of_n", phase="explore", status="completed")
    continued = LaneOutcome(
        engine="gepa",
        phase="continue",
        status="completed",
        metadata={"candidate_tree": [{"candidate": "seed", "val_score": 0.4}]},
    )

    assert service_mod._validation_scores([explore, bare, continued]) == {
        "seed": 0.4,
        candidate_key({"system": "x"}): 0.5,
    }


def test_run_versions_show_the_tree_score_as_their_headline(fake_lm: FakeReflectionLM, tmp_path: Path) -> None:
    """Every version the candidate tree knows shows the tree's validation score, with its running mean alongside."""
    payload = _payload(strategy={"mode": "single", "engine": BLACKBOX_ENGINE_GEPA})
    response = run_blackbox_optimization(payload, artifact_id="job-headline", gepa_log_dir_path=str(tmp_path))

    by_candidate = {version.candidate: version for version in response.versions}
    swept = [node for node in response.candidate_tree if node.val_score is not None]
    assert swept
    for node in swept:
        version = by_candidate[node.candidate]
        assert version.score == node.val_score
        assert version.mean_score is not None
        assert version.evals >= 1


def test_holdout_passes_share_measurements_with_the_eval_server(caplog: pytest.LogCaptureFixture) -> None:
    """The baseline pass feeds the engine's look at the seed; the final pass reuses the engine's scores."""
    calls: list[tuple[Candidate, Any]] = []

    def scorer(candidate: Candidate, case: Any) -> tuple[float, dict[str, Any]]:
        """Score by case number, remembering every call.

        Args:
            candidate: The version.
            case: The case.

        Returns:
            A score that depends on the case only.
        """
        calls.append((candidate, case))
        return case["n"] / 4, {"case": case["n"]}

    cases = [{"n": 1}, {"n": 2}]
    server = EvalServer(scorer, max_evals=10)

    baseline = service_mod._score_holdout(
        scorer, "seed", cases, label="starting point", phase=PHASE_BASELINE, server=server
    )
    assert baseline == pytest.approx(0.375)
    assert len(calls) == 2
    assert server.evaluate("seed", cases[0]) == (0.25, {"case": 1})
    assert server.evaluate("seed", cases[1]) == (0.5, {"case": 2})
    assert (server.used, len(calls)) == (0, 2)

    server.evaluate("best", cases[0])
    server.evaluate("best", cases[1])
    assert (server.used, len(calls)) == (2, 4)
    with caplog.at_level(logging.INFO, logger="core.service_gateway.optimization.blackbox.service"):
        optimized = service_mod._score_holdout(
            scorer, "best", cases, label="optimized version", phase=PHASE_FINAL, server=server
        )

    assert optimized == pytest.approx(0.375)
    assert len(calls) == 4
    assert any("(2 reused from the run)" in r.getMessage() for r in caplog.records)


def test_run_without_a_test_split_measures_each_pair_once(fake_lm: FakeReflectionLM, tmp_path: Path) -> None:
    """Reuse a completed candidate's training scores while charging partial subsequent proposals.

    Args:
        fake_lm: Metered model fake used by upstream Best-of-N.
        tmp_path: Per-test artifact directory.
    """
    response = run_blackbox_optimization(
        _payload(split_fractions={"train": 1.0, "val": 0.0, "test": 0.0}),
        artifact_id="job-1",
        gepa_log_dir_path=str(tmp_path),
    )

    assert (response.split_counts.train, response.split_counts.val, response.split_counts.test) == (10, 0, 0)
    assert response.baseline_test_metric == pytest.approx(3 / 11)
    assert response.versions[0].mean_score == 1.0
    assert response.versions[0].evals == 10
    assert response.best_candidate == "aeiou"
    assert response.optimized_test_metric == response.details["optimizer_best_score"] == 1.0
    assert response.total_scorer_runs == 12
    assert response.versions[1].evals == 2


@pytest.mark.parametrize("evaluated", [False, True])
def test_budget_stop_preserves_only_evaluated_incumbent_and_skips_final_test(fake_lm, tmp_path, monkeypatch, evaluated):
    """Keep a completed selection without starting a final paid holdout pass.

    Args:
        fake_lm: Deterministic reflection model.
        tmp_path: Private optimizer workspace.
        monkeypatch: Dependency replacement fixture.
        evaluated: Whether upstream has published a completed aggregate selection.
    """
    holdouts = []

    def holdout(*args, **kwargs):
        """Record which holdout passes were actually requested."""
        holdouts.append(kwargs["phase"])
        return 0.3

    def strategy(*args, **kwargs):
        """Stop after the upstream incumbent publication boundary."""
        stop = BudgetReached()
        if evaluated:
            stop.result = Result(
                best_candidate="tested candidate",
                best_score=0.7,
                total_evals=3,
                metadata={"selection_source": "upstream_fixture"},
            )
            stop.evidence["selection_scope"] = "validation"
        raise stop

    monkeypatch.setattr(service_mod, "_score_holdout", holdout)
    monkeypatch.setattr(service_mod, "run_strategy", strategy)
    with pytest.raises(BudgetReached) as caught:
        run_blackbox_optimization(_payload(), artifact_id="budget-fixture", gepa_log_dir_path=str(tmp_path))
    assert holdouts == [PHASE_BASELINE]
    if evaluated:
        response = caught.value.result
        assert response.best_candidate == "tested candidate"
        assert response.optimized_test_metric is None
        assert response.details["optimizer_best_score"] == 0.7
        assert caught.value.evidence["candidate_origin"] == "optimized"
    else:
        response = caught.value.result
        assert response.best_candidate == "hello world"
        assert response.baseline_test_metric == 0.3
        assert response.optimized_test_metric is None
        assert response.details["optimizer_best_score"] == 0.3
        assert caught.value.evidence["candidate_origin"] == "seed"
        assert caught.value.evidence["selection_scope"] == "heldout"
    assert caught.value.evidence["final_evaluation_completed"] is False


def test_budget_stop_before_completed_baseline_has_no_result(fake_lm, tmp_path, monkeypatch):
    """Leave result absent when the baseline holdout did not finish.

    Args:
        fake_lm: Deterministic reflection model.
        tmp_path: Private optimizer workspace.
        monkeypatch: Dependency replacement fixture.
    """

    def holdout(*_args, **_kwargs):
        """Stop before returning any complete baseline score."""
        raise BudgetReached()

    monkeypatch.setattr(service_mod, "_score_holdout", holdout)
    with pytest.raises(BudgetReached) as caught:
        run_blackbox_optimization(_payload(), artifact_id="budget-fixture", gepa_log_dir_path=str(tmp_path))

    assert caught.value.result is None
