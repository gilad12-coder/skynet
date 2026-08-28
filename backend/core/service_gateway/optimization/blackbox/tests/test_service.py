"""End-to-end tests for the job entry points with a fake reflection LM."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from core.constants import (
    DETAIL_BASELINE,
    DETAIL_OPTIMIZED,
    PROGRESS_BASELINE,
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
from core.models.blackbox import BLACKBOX_ENGINE_BEST_OF_N, BlackboxRunRequest, BlackboxStrategy, ScorerDryRunRequest
from core.models.results import ModelTokenUsage
from core.service_gateway.safe_exec import ScorerProbeResult

from .. import service as service_mod
from ..harness import GatewayConfig
from ..llm_helper import ScorerLLM
from ..protocol import Result
from ..service import dry_run_scorer, run_blackbox_optimization, validate_blackbox_payload
from .mocks import AGENT_OUTPUT_SCORER_CODE, VOWEL_SCORER_CODE, FakeReflectionLM, FakeSandboxRuntime

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


def test_run_scores_baseline_and_optimized_on_the_holdout(fake_lm: FakeReflectionLM, tmp_path: Path) -> None:
    """A single best_of_n run improves the seed and reports the split, lanes and usage."""
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
    assert response.optimization_metadata["budget"] == {
        "max_scorer_runs": 12,
        "stop_at_score": None,
        "max_iterations": None,
    }
    assert response.optimization_metadata["target"]["kind"] == "text"
    assert response.details["optimizer_best_score"] == 1.0
    assert response.details["proposals"] >= 1

    events = [event for event, _ in sink]
    assert events[0] == PROGRESS_SPLITS_READY
    assert events[1] == PROGRESS_BASELINE
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


def test_auto_run_hands_off_between_engines(fake_lm: FakeReflectionLM, tmp_path: Path) -> None:
    """The default Auto strategy explores both in-process engines and continues with GEPA."""
    sink: list[tuple[str, dict[str, Any]]] = []

    response = run_blackbox_optimization(
        _payload(strategy={"mode": "auto"}, budget={"max_scorer_runs": 24}),
        artifact_id="job-2",
        progress_callback=lambda e, m: sink.append((e, m)),
        gepa_log_dir_path=str(tmp_path),
    )

    assert response.optimizer_name == "auto"
    assert response.strategy_mode == "auto"
    assert [(lane.engine, lane.phase) for lane in response.lanes] == [
        ("gepa", "explore"),
        ("best_of_n", "explore"),
        ("gepa", "continue"),
    ]
    assert response.engine_used in {"gepa", "best_of_n"}
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

    spec = runtime.specs[0]
    assert spec.name == "skynet-agent-1"
    assert spec.tags == {"skynet_job": "agent-1"}
    assert spec.env["SKYNET_MODEL"] == "m"
    assert spec.env["SKYNET_GATEWAY_URL"] == "https://gw.example/v1"
    assert spec.env["SKYNET_API_KEY"] == "secret-key"
    assert spec.lifetime_seconds == 1200

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


class _JudgeLM:
    """``dspy.LM`` double for the scorer's ``llm()``: records the messages and answers ``0.5``."""

    def __init__(self) -> None:
        """Create the double."""
        self.model = "fake/judge"
        self.history: list[dict[str, Any]] = []
        self.messages: list[list[dict[str, str]]] = []

    def __call__(
        self, prompt: str | None = None, *, messages: list[dict[str, str]] | None = None, **_: Any
    ) -> list[str]:
        """Record the call and answer a constant score.

        Args:
            prompt: Unused; the helper always sends ``messages``.
            messages: The chat the helper built.
            **_: Ignored.

        Returns:
            A single-element completion list.
        """
        self.messages.append(messages or [])
        self.history.append({"prompt": prompt, "usage": {"prompt_tokens": 3, "completion_tokens": 1}})
        return ["0.5"]


_JUDGE_SCORER_CODE = (
    "def score(candidate, case=None):\n    return float(llm(candidate, case['target'])), {'judge': 'fake'}\n"
)


def test_plateau_run_relays_between_engines(fake_lm: FakeReflectionLM, tmp_path: Path) -> None:
    """The plateau strategy relays over the engine order until a full round brings no record."""
    sink: list[tuple[str, dict[str, Any]]] = []

    response = run_blackbox_optimization(
        _payload(strategy={"mode": "plateau", "patience": 5}, budget={"max_scorer_runs": 40}),
        artifact_id="job-plateau",
        progress_callback=lambda e, m: sink.append((e, m)),
        gepa_log_dir_path=str(tmp_path),
    )

    assert response.strategy_mode == "plateau"
    assert response.lanes[0].engine == "gepa"
    assert {lane.phase for lane in response.lanes} == {"relay"}
    assert response.lanes[0].status == "plateaued"
    assert len(response.lanes) >= 2
    assert response.total_scorer_runs <= 40
    assert response.optimized_test_metric >= response.baseline_test_metric
    handoffs = [m for e, m in sink if e == PROGRESS_LANE_HANDOFF]
    assert handoffs[0] == {"from_engine": "gepa", "to_engine": "best_of_n", "best_score": 1.0, "reason": "plateaued"}


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
    """A scorer that calls ``llm()`` gets the chosen model, and its tokens land in the run's usage."""
    judge = _JudgeLM()
    chosen: list[str] = []
    monkeypatch.setattr(service_mod, "build_scorer_llm", lambda config: chosen.append(config.name) or ScorerLLM(judge))

    response = run_blackbox_optimization(
        _payload(scorer={"kind": "python", "metric_code": _JUDGE_SCORER_CODE, "model": {"name": "fake/judge"}}),
        artifact_id="job-judge",
        gepa_log_dir_path=str(tmp_path),
    )

    assert chosen == ["fake/judge"]
    assert judge.messages
    assert judge.messages[0] == [{"role": "system", "content": "hello world"}, {"role": "user", "content": "aeiou"}]
    assert all(
        chat[0]["role"] == "system" and chat[1] == {"role": "user", "content": "aeiou"} for chat in judge.messages
    )
    assert response.baseline_test_metric == 0.5
    usage = {u.model: (u.input_tokens, u.output_tokens) for u in response.usage_by_model}
    assert usage["fake/judge"] == (3 * len(judge.history), len(judge.history))
    assert usage["fake/model"] == (10 * len(fake_lm.history), 5 * len(fake_lm.history))
    assert response.num_lm_calls == len(fake_lm.history) + len(judge.history)
    assert response.total_tokens == 15 * len(fake_lm.history) + 4 * len(judge.history)


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
    calls: list[tuple[Any, Any]] = []

    class LM:
        def __call__(self, prompt: Any = None, *, messages: Any = None) -> list[str]:
            calls.append((prompt, messages))
            return ["reflected"]

    reflection_lm = service_mod._reflection_caller(LM())  # type: ignore[arg-type]
    assert reflection_lm("plain text") == "reflected"
    multimodal = [{"role": "user", "content": [{"type": "text", "text": "look"}]}]
    assert reflection_lm(multimodal) == "reflected"
    assert calls == [("plain text", None), (None, multimodal)]
