"""Tests for ``DspyService.run``."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import dspy
import pytest

from core.billing.signals import BudgetReached
from core.constants import PROGRESS_SPLITS_READY
from core.exceptions import ServiceError
from core.models import (
    ColumnMapping,
    ModelConfig,
    RunRequest,
    RunResponse,
    SplitFractions,
    ToolSource,
)
from core.models.artifacts import ProgramArtifact, ReactOverlay
from core.models.results import LMActivity
from core.registry import ServiceRegistry
from core.service_gateway.optimization.core import DspyService, _resolve_max_metric_calls
from core.service_gateway.optimization.training_ground import run_react
from core.service_gateway.optimization.training_ground.run_react import _AUTO_BUDGETS
from core.service_gateway.tests.mocks import (
    fake_compiled_program,
    fake_language_model,
    fake_language_model_no_history,
    fake_original_program,
    patch_core_dependencies,
)

_VALID_SIG = """\
import dspy
class QA(dspy.Signature):
    question: str = dspy.InputField()
    answer: str = dspy.OutputField()
"""

_VALID_METRIC = "def metric(example, prediction, trace=None): return 1.0"

_DATASET = [{"q": "What is 1+1?", "a": "2"}, {"q": "What is 2+2?", "a": "4"}]

_MAPPING = ColumnMapping(inputs={"question": "q"}, outputs={"answer": "a"})

_MODEL_CFG = ModelConfig(name="openai/gpt-4o-mini")


def _service() -> DspyService:
    """Return a fresh ``DspyService`` backed by a clean registry."""
    return DspyService(registry=ServiceRegistry())


def _run_request(**overrides) -> RunRequest:
    """Build a ``RunRequest`` with all-train fractions and optional overrides."""
    base: dict = {
        "username": "tester",
        "module_name": "cot",
        "signature_code": _VALID_SIG,
        "metric_code": _VALID_METRIC,
        "optimizer_name": "dspy.BootstrapFewShot",
        "dataset": _DATASET,
        "column_mapping": _MAPPING,
        "split_fractions": SplitFractions(train=1.0, val=0.0, test=0.0),
        "model_config": _MODEL_CFG,
    }
    base.update(overrides)
    return RunRequest(**base)


def _run_request_with_test(**overrides) -> RunRequest:
    """Build a ``RunRequest`` with a 70/0/30 train/test split."""
    base: dict = {
        "username": "tester",
        "module_name": "cot",
        "signature_code": _VALID_SIG,
        "metric_code": _VALID_METRIC,
        "optimizer_name": "dspy.BootstrapFewShot",
        "dataset": _DATASET * 10,  # 20 rows for splits
        "column_mapping": _MAPPING,
        "split_fractions": SplitFractions(train=0.7, val=0.0, test=0.3),
        "model_config": _MODEL_CFG,
        "shuffle": False,
    }
    base.update(overrides)
    return RunRequest(**base)


def test_run_happy_path_returns_run_response() -> None:
    """A valid run returns a ``RunResponse`` with module/optimizer fields set."""
    service = _service()
    payload = _run_request()

    with patch_core_dependencies(fake_lm=fake_language_model()):
        result = service.run(payload)

    assert isinstance(result, RunResponse)
    assert result.module_name == "cot"
    assert result.optimizer_name == "dspy.BootstrapFewShot"


def test_run_happy_path_no_test_split_no_metrics() -> None:
    """An all-train run leaves test metrics ``None``."""
    service = _service()
    payload = _run_request()  # all-train, no test split

    with patch_core_dependencies():
        result = service.run(payload)

    assert result.baseline_test_metric is None
    assert result.optimized_test_metric is None
    assert result.metric_improvement is None


def test_run_calls_progress_callback_for_splits_ready() -> None:
    """The progress callback receives a ``PROGRESS_SPLITS_READY`` event."""
    service = _service()
    payload = _run_request()
    events: list[str] = []

    def _cb(event: str, data: dict) -> None:
        """Record each reported progress event."""
        events.append(event)

    with patch_core_dependencies():
        service.run(payload, progress_callback=_cb)

    assert PROGRESS_SPLITS_READY in events


def _run_request_with_val_and_test(**overrides) -> RunRequest:
    """Build a ``RunRequest`` with an unshuffled 60/20/20 train/val/test split."""
    return _run_request_with_test(split_fractions=SplitFractions(train=0.6, val=0.2, test=0.2), **overrides)


def _split_scorer(original_program, scores: dict[tuple[str, str], float], seen: list[tuple[str, str]]):
    """Build an ``evaluate_on_test`` stand-in scoring by (program, split) role.

    Args:
        original_program: The baseline program instance.
        scores: Score per ``("baseline"|"compiled", "selection"|"test")``.
        seen: Receives each ``(program role, split role)`` evaluated.

    Returns:
        A side effect that returns a float for selection evaluations and a
        ``(score, rows)`` tuple for per-example test evaluations.
    """

    def _evaluate(program, examples, metric, collect_per_example=False):
        """Score one program on one split by role."""
        role = "baseline" if program is original_program else "compiled"
        split = "test" if collect_per_example else "selection"
        seen.append((role, split))
        score = scores[(role, split)]
        return (score, [{"score": score}]) if collect_per_example else score

    return _evaluate


def test_run_returns_baseline_program_when_optimized_worse_on_validation() -> None:
    """The guard keeps the baseline when it wins on validation, even if it loses on test."""
    service = _service()
    payload = _run_request_with_val_and_test()
    original_program = fake_original_program()
    compiled_program = fake_compiled_program()
    seen: list[tuple[str, str]] = []
    scores = {
        ("baseline", "selection"): 0.9,
        ("compiled", "selection"): 0.5,
        ("baseline", "test"): 0.2,
        ("compiled", "test"): 0.8,
    }

    with (
        patch_core_dependencies(fake_lm=fake_language_model(), compiled_program=compiled_program) as deps,
        patch(
            "core.service_gateway.optimization.core.evaluate_on_test",
            side_effect=_split_scorer(original_program, scores, seen),
        ),
        patch.object(service, "_get_module_factory", return_value=(lambda **kw: original_program, True)),
    ):
        result = service.run(payload)

    assert deps.persist_program_mock.call_args.args[0] is original_program
    assert result.optimized_test_metric == pytest.approx(0.2)
    assert result.metric_improvement == pytest.approx(0.0)
    assert ("compiled", "test") not in seen
    assert result.optimization_metadata["selection_scope"] == "validation"


def test_run_keeps_compiled_program_when_better_on_validation_even_if_worse_on_test() -> None:
    """The test split reports the val winner's score; it never picks the winner."""
    service = _service()
    payload = _run_request_with_val_and_test()
    original_program = fake_original_program()
    compiled_program = fake_compiled_program()
    seen: list[tuple[str, str]] = []
    scores = {
        ("baseline", "selection"): 0.5,
        ("compiled", "selection"): 0.9,
        ("baseline", "test"): 0.7,
        ("compiled", "test"): 0.4,
    }

    with (
        patch_core_dependencies(fake_lm=fake_language_model(), compiled_program=compiled_program) as deps,
        patch(
            "core.service_gateway.optimization.core.evaluate_on_test",
            side_effect=_split_scorer(original_program, scores, seen),
        ),
        patch.object(service, "_get_module_factory", return_value=(lambda **kw: original_program, True)),
    ):
        result = service.run(payload)

    assert deps.persist_program_mock.call_args.args[0] is compiled_program
    assert result.baseline_test_metric == pytest.approx(0.7)
    assert result.optimized_test_metric == pytest.approx(0.4)
    assert result.metric_improvement == pytest.approx(-0.3)


def test_run_guard_selects_on_train_when_no_validation_split() -> None:
    """Without a validation split the guard compares on train, never on test."""
    service = _service()
    payload = _run_request_with_test()
    original_program = fake_original_program()
    compiled_program = fake_compiled_program()
    seen: list[tuple[str, str]] = []
    selection_sizes: list[int] = []
    scores = {
        ("baseline", "selection"): 0.3,
        ("compiled", "selection"): 0.6,
        ("baseline", "test"): 0.9,
        ("compiled", "test"): 0.1,
    }
    scorer = _split_scorer(original_program, scores, seen)

    def _evaluate(program, examples, metric, collect_per_example=False):
        """Record the selection split size, then score by role."""
        if not collect_per_example:
            selection_sizes.append(len(examples))
        return scorer(program, examples, metric, collect_per_example=collect_per_example)

    with (
        patch_core_dependencies(fake_lm=fake_language_model(), compiled_program=compiled_program) as deps,
        patch("core.service_gateway.optimization.core.evaluate_on_test", side_effect=_evaluate),
        patch.object(service, "_get_module_factory", return_value=(lambda **kw: original_program, True)),
    ):
        result = service.run(payload)

    assert deps.persist_program_mock.call_args.args[0] is compiled_program
    assert selection_sizes == [14, 14]
    assert result.optimized_test_metric == pytest.approx(0.1)
    assert result.optimization_metadata["selection_scope"] == "training"


def test_run_budget_stop_after_baseline_preserves_original_program() -> None:
    """Return the fully evaluated seed when the first optimizer call cannot start."""
    service = _service()
    payload = _run_request_with_test()
    original_program = fake_original_program()
    evaluations: list[object] = []

    def _evaluate(program, *_args, collect_per_example=False, **_kwargs):
        """Record and complete only the original program's baseline."""
        evaluations.append(program)
        if collect_per_example:
            return (0.4, [{"score": 0.4}])
        return 0.6

    with (
        patch_core_dependencies(fake_lm=fake_language_model()),
        patch("core.service_gateway.optimization.core.evaluate_on_test", side_effect=_evaluate),
        patch("core.service_gateway.optimization.core.compile_program", side_effect=BudgetReached()),
        patch.object(service, "_get_module_factory", return_value=(lambda **kw: original_program, True)),
        pytest.raises(BudgetReached) as caught,
    ):
        service.run(payload)

    response = caught.value.result
    assert response.baseline_test_metric == pytest.approx(0.4)
    assert response.optimized_test_metric is None
    assert response.baseline_test_results == [{"score": 0.4}]
    assert evaluations == [original_program, original_program]
    assert caught.value.evidence == {
        "selection_scope": "training",
        "selection_score": 0.6,
        "candidate_origin": "seed",
        "final_evaluation_completed": False,
        "final_evaluation_reason": "budget_reached",
    }


def test_run_budget_stop_during_baseline_has_no_result() -> None:
    """Do not publish the seed when its test evaluation did not complete."""
    service = _service()
    payload = _run_request_with_test()

    with (
        patch_core_dependencies() as dependencies,
        patch("core.service_gateway.optimization.core.evaluate_on_test", side_effect=BudgetReached()),
        pytest.raises(BudgetReached) as caught,
    ):
        service.run(payload)

    assert caught.value.result is None
    dependencies.compile_program_mock.assert_not_called()


def test_run_avg_response_time_is_none_when_lm_has_no_history() -> None:
    """An LM lacking ``history`` reports ``num_lm_calls`` and ``avg_response_time_ms`` as ``None``."""
    service = _service()
    payload = _run_request()

    with patch_core_dependencies(fake_lm=fake_language_model_no_history()):
        result = service.run(payload)

    assert result.num_lm_calls is None
    assert result.avg_response_time_ms is None


def test_run_avg_response_time_is_none_when_no_real_lm_calls() -> None:
    """avg_response_time_ms is None when no actual dspy.LM __call__ fires.

    Mocks replace compile/evaluate, so the LM is never invoked through dspy —
    the timing callback records zero calls and avg_response_time_ms stays None
    even though language_model.history is pre-populated.
    """
    service = _service()
    payload = _run_request()

    # history_len=4 is intentional: the test asserts num_lm_calls == 4 exactly
    with patch_core_dependencies(fake_lm=fake_language_model(history_len=4)):
        result = service.run(payload)

    assert result.num_lm_calls == 4
    assert result.avg_response_time_ms is None


def test_get_module_factory_resolver_error_raises_service_error() -> None:
    """An unresolvable module name raises ``ServiceError``."""
    service = _service()

    with pytest.raises(ServiceError):
        service._get_module_factory("totally_unknown_module_xyz_abc")


def test_get_optimizer_factory_resolver_error_raises_service_error() -> None:
    """An unresolvable optimizer name raises ``ServiceError``."""
    service = _service()

    with pytest.raises(ServiceError):
        service._get_optimizer_factory("totally_unknown_optimizer_xyz_abc")


def test_get_module_factory_registry_lookup_succeeds_before_resolver() -> None:
    """Registry lookups precede the resolver fallback."""
    registry = ServiceRegistry()
    sentinel = MagicMock(name="my_cot_factory")
    registry.register_module("my_cot", sentinel)
    service = DspyService(registry=registry)

    factory, auto_sig = service._get_module_factory("my_cot")

    assert factory is sentinel
    assert auto_sig is False


def test_run_raises_service_error_when_module_factory_unavailable() -> None:
    """``run`` raises ``ServiceError`` when the module factory is unavailable."""
    service = _service()
    payload = _run_request(module_name="completely_nonexistent_module_xyz")

    with pytest.raises(ServiceError):
        service.run(payload)


def test_run_populates_lm_activity_with_empty_buckets_when_no_real_calls() -> None:
    """``RunResponse.lm_activity`` is present with empty stage buckets when patched mocks fire no real LM calls."""
    # The patched evaluate_on_test / compile_program never invoke the LM through
    # dspy, so the timing callbacks record zero per-stage durations. The shape
    # of the payload is still correct: ``lm_activity`` is a valid LMActivity
    # with no per-stage entries (frontend renders zero rows from STAGE_ORDER).
    service = _service()
    payload = _run_request()

    with patch_core_dependencies():
        result = service.run(payload)

    assert isinstance(result.lm_activity, LMActivity)
    assert result.lm_activity.generation == {}
    assert result.lm_activity.reflection == {}


def test_run_lm_activity_reflection_empty_when_no_reflection_model() -> None:
    """When the run has no reflection model, ``lm_activity.reflection`` stays empty."""
    service = _service()
    payload = _run_request()  # no reflection_model_settings

    with patch_core_dependencies():
        result = service.run(payload)

    assert result.lm_activity is not None
    assert result.lm_activity.reflection == {}


_REACT_DATASET = [
    {"q": "hi", "a": "yo"},
    {"q": "ok", "a": "sure"},
]

_REACT_TOOL_SOURCE = ToolSource(kind="live_mcp", mcp_url="http://localhost:9000/mcp")

# React is generic: rollouts are scored with the same standard 5-arg GEPA metric
# the predict/cot path uses.
_REACT_METRIC = (
    "import dspy\n"
    "def metric(gold, pred, trace, pred_name, pred_trace):\n"
    "    return dspy.Prediction(score=1.0, feedback='ok')\n"
)


def _react_run_request(**overrides) -> RunRequest:
    """Build a react ``RunRequest`` backed by a standard 5-arg GEPA metric."""
    base: dict = {
        "username": "tester",
        "module_name": "react",
        "signature_code": _VALID_SIG,
        "metric_code": _REACT_METRIC,
        "optimizer_name": "gepa",
        "dataset": _REACT_DATASET,
        "column_mapping": _MAPPING,
        "split_fractions": SplitFractions(train=1.0, val=0.0, test=0.0),
        "model_config": _MODEL_CFG,
        "reflection_model_config": _MODEL_CFG,
        "tool_source": _REACT_TOOL_SOURCE,
    }
    base.update(overrides)
    return RunRequest(**base)


def test_run_react_branch_resolves_tools_and_returns_overlay() -> None:
    """``run`` dispatches react payloads through ``_run_react`` and persists the overlay.

    Patches ``resolve_react_tools``/``run_react_optimization`` with canned
    returns so the branch wiring is exercised without a live MCP or GEPA: the
    test asserts the react path resolved tools, surfaced the canned
    baseline/optimized scalars on the ``RunResponse``, and attached a
    ``ReactOverlay`` to the persisted ``ProgramArtifact``.
    """
    service = _service()
    payload = _react_run_request()

    noop_tool = dspy.Tool(lambda **_kw: None, name="noop", desc="noop tool", args={"x": {"type": "string"}})
    resolved_tools = [noop_tool]
    resolved_hashes = {"noop": "deadbeef"}

    resolve_mock = MagicMock(return_value=(resolved_tools, resolved_hashes))

    def _fake_optimize(
        *, signature_cls, tools, schema_hashes, max_iters=run_react.DEFAULT_MAX_ITERS, **_kwargs
    ) -> dict:
        """Return a deterministic ReAct optimization result."""
        seed = dspy.ReActV2(signature_cls, tools=tools, max_iters=max_iters)
        return {
            "program_state": seed.dump_state(),
            "baseline_scalar": 0.4,
            "optimized_scalar": 0.7,
            "tool_overlay": {
                "tool_descriptions": {"noop": "optimized noop"},
                "tool_arg_descriptions": {"noop": {"x": "the x arg"}},
                "tool_names": {"noop": "noop"},
                "tool_schema_hashes": schema_hashes,
                "max_iters": max_iters,
            },
        }

    optimize_mock = MagicMock(side_effect=_fake_optimize)
    persisted = ProgramArtifact(path="/tmp/react-artifact")

    with (
        patch("core.service_gateway.optimization.core.build_language_model", return_value=fake_language_model()),
        patch("core.service_gateway.optimization.core.persist_program", return_value=persisted),
        patch.object(run_react, "resolve_react_tools", resolve_mock),
        patch.object(run_react, "run_react_optimization", optimize_mock),
    ):
        result = service.run(payload)

    assert resolve_mock.called
    assert optimize_mock.called
    assert isinstance(result, RunResponse)
    assert result.module_name == "react"
    assert result.baseline_test_metric == 0.4
    assert result.optimized_test_metric == 0.7
    assert result.metric_improvement == pytest.approx(0.3)
    assert result.program_artifact is persisted
    overlay = result.program_artifact.react_overlay
    assert isinstance(overlay, ReactOverlay)
    assert overlay.tool_descriptions == {"noop": "optimized noop"}
    assert overlay.tool_arg_descriptions == {"noop": {"x": "the x arg"}}
    assert overlay.tool_schema_hashes == resolved_hashes
    assert overlay.max_iters == 8


def test_resolve_max_metric_calls_honors_auto_preset() -> None:
    """An ``auto`` preset (without explicit ``max_metric_calls``) maps through ``_AUTO_BUDGETS``.

    Regression: the react submit path used to read ``max_metric_calls`` alone
    and hardcode the medium (2000) budget, so an ``auto="light"`` run silently
    got 4x its intended budget.
    """
    assert _resolve_max_metric_calls({"auto": "light"}) == _AUTO_BUDGETS["light"] == 500
    assert _resolve_max_metric_calls({"auto": "medium"}) == _AUTO_BUDGETS["medium"]
    assert _resolve_max_metric_calls({"auto": "heavy"}) == _AUTO_BUDGETS["heavy"]


def test_resolve_max_metric_calls_explicit_wins_over_auto() -> None:
    """An explicit ``max_metric_calls`` overrides any ``auto`` preset."""
    assert _resolve_max_metric_calls({"max_metric_calls": 123, "auto": "light"}) == 123


def test_resolve_max_metric_calls_defaults_to_medium_when_unset() -> None:
    """With neither key supplied the budget falls back to the medium preset."""
    assert _resolve_max_metric_calls({}) == _AUTO_BUDGETS["medium"]


def test_run_react_branch_passes_auto_budget_to_optimizer() -> None:
    """``run`` resolves the react budget from ``auto`` and forwards it to GEPA.

    Regression for the call site that ignored the ``auto`` preset: an
    ``auto="light"`` react payload must reach ``run_react_optimization`` with
    ``max_metric_calls=500``, not the hardcoded medium 2000.
    """
    service = _service()
    payload = _react_run_request(optimizer_kwargs={"auto": "light"})

    noop_tool = dspy.Tool(lambda **_kw: None, name="noop", desc="noop tool", args={"x": {"type": "string"}})
    resolve_mock = MagicMock(return_value=([noop_tool], {"noop": "deadbeef"}))

    captured: dict = {}

    def _fake_optimize(*, signature_cls, tools, schema_hashes, max_iters=run_react.DEFAULT_MAX_ITERS, **kwargs) -> dict:
        """Capture the budget and return a deterministic ReAct result."""
        captured["max_metric_calls"] = kwargs.get("max_metric_calls")
        seed = dspy.ReActV2(signature_cls, tools=tools, max_iters=max_iters)
        return {
            "program_state": seed.dump_state(),
            "baseline_scalar": 0.4,
            "optimized_scalar": 0.7,
            "tool_overlay": {
                "tool_descriptions": {"noop": "optimized noop"},
                "tool_arg_descriptions": {"noop": {"x": "the x arg"}},
                "tool_names": {"noop": "noop"},
                "tool_schema_hashes": schema_hashes,
                "max_iters": max_iters,
            },
        }

    with (
        patch("core.service_gateway.optimization.core.build_language_model", return_value=fake_language_model()),
        patch("core.service_gateway.optimization.core.persist_program", return_value=ProgramArtifact(path="/tmp/x")),
        patch.object(run_react, "resolve_react_tools", resolve_mock),
        patch.object(run_react, "run_react_optimization", MagicMock(side_effect=_fake_optimize)),
    ):
        service.run(payload)

    assert captured["max_metric_calls"] == 500
