"""Tests for the DSPy optimizers behind the black-box engine protocol."""

from __future__ import annotations

from typing import Any

import dspy
import pytest
from dspy.utils.dummies import DummyLM

from core.exceptions import ServiceError
from core.models.unified import UnifiedCase
from core.service_gateway.optimization.blackbox import workspace_harness
from core.service_gateway.optimization.blackbox.protocol import (
    BudgetExhaustedError,
    EngineContext,
    EvalServer,
    Task,
)
from core.service_gateway.optimization.blackbox.registry import ENGINES, available_engine_ids
from core.service_gateway.optimization.unified import dspy_engine as engine_mod
from core.service_gateway.optimization.unified.dspy_engine import (
    DSPY_STATE_KEY,
    BudgetedMetric,
    DspyEngine,
    apply_candidate,
    build_program,
    case_example,
    normalize_metric_output,
    program_instructions,
)

RUN_CODE = """
import dspy

def build_program():
    return dspy.Predict("question -> answer")
"""

SCALAR_METRIC = """
def metric(gold, pred, trace=None):
    return float(pred.answer == gold.answer)
"""


def _never_scored(*_args: Any) -> tuple[float, dict[str, Any]]:
    """Fail when the eval server's own scorer is called: the DSPy engine scores in-process.

    Raises:
        AssertionError: Always.
    """
    raise AssertionError("the DSPy engine must not call the eval server's scorer")


def _cases(n: int, offset: int = 0) -> list[UnifiedCase]:
    """Build question/answer cases.

    Args:
        n: How many cases.
        offset: Index of the first case.

    Returns:
        Cases asking ``q<i>`` with the answer ``a``.
    """
    return [UnifiedCase(input={"question": f"q{i}"}, expected={"answer": "a"}) for i in range(offset, offset + n)]


def _ctx(tmp_path: Any) -> EngineContext:
    """Build an engine context whose reflection model is never needed.

    Args:
        tmp_path: Run directory.

    Returns:
        The context.
    """
    return EngineContext(reflection_lm=lambda prompt: "", run_dir=str(tmp_path))


def _task(train: list[UnifiedCase], val: list[UnifiedCase], *, metric_code: str = SCALAR_METRIC) -> Task:
    """Build a BootstrapFewShot task around the dummy program.

    Args:
        train: Train cases.
        val: Validation cases.
        metric_code: The user metric.

    Returns:
        The task, with a dummy task model in its private context.
    """
    return Task(
        seed_candidate={"self": "Answer the question."},
        objective="answer",
        cases=list(train),
        valset=list(val),
        context={
            "run_code": RUN_CODE,
            "metric_code": metric_code,
            "metric_shape": "dspy_scalar",
            "input_fields": ["question"],
            "models": {"reflection_model": {"name": "openai/dummy"}},
            "dspy_kwargs": {"max_bootstrapped_demos": 1, "max_labeled_demos": 1},
            "task_lm": DummyLM([{"answer": "a"}] * 50),
        },
    )


def test_build_program_and_candidate_round_trip() -> None:
    """The run code builds a program whose instructions a candidate sets."""
    program = build_program(RUN_CODE)
    apply_candidate(program, {"self": "Be terse."})
    assert program_instructions(program) == {"self": "Be terse."}


def test_build_program_requires_build_program() -> None:
    """Run code without build_program() is rejected."""
    with pytest.raises(ServiceError):
        build_program("x = 1")


def test_case_example_marks_inputs() -> None:
    """A case becomes a gold example with the declared inputs."""
    example = case_example(_cases(1)[0], ["question"])
    assert example.question == "q0"
    assert example.answer == "a"
    assert set(example.inputs().keys()) == {"question"}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (dspy.Prediction(score=0.5, feedback="ok"), (0.5, "ok")),
        ({"score": 1, "feedback": "fine"}, (1.0, "fine")),
        ((0.25, "meh"), (0.25, "meh")),
        (True, (1.0, "")),
    ],
)
def test_normalize_metric_output(raw: Any, expected: tuple[float, str]) -> None:
    """Every allowed metric return shape becomes a score and feedback.

    Args:
        raw: What the metric returned.
        expected: The normalized score and feedback.
    """
    assert normalize_metric_output(raw) == expected


def test_feedback_metric_wraps_dict_returns_and_charges_the_budget() -> None:
    """The feedback shape returns a Prediction and every call counts against the server."""
    server = EvalServer(_never_scored, max_evals=2)

    def metric(gold: Any, pred: Any, trace: Any = None, pred_name: Any = None, pred_trace: Any = None) -> Any:
        """Return a dict score with feedback."""
        return {"score": 0.75, "feedback": "close"}

    wrapped = BudgetedMetric(metric, server, feedback=True)
    first = wrapped(None, None)
    assert isinstance(first, dspy.Prediction)
    assert (first.score, first.feedback) == (0.75, "close")
    wrapped(None, None)
    assert server.used == 2
    with pytest.raises(BudgetExhaustedError):
        wrapped(None, None)
    assert wrapped.exhausted is True


def test_scalar_metric_gets_only_its_declared_arguments() -> None:
    """A three-argument metric is called with three arguments and returns a float."""
    server = EvalServer(_never_scored, max_evals=5)

    def metric(gold: Any, pred: Any, trace: Any = None) -> bool:
        """Accept anything."""
        return True

    assert BudgetedMetric(metric, server, feedback=False)(None, None, None, "p", None) == 1.0


def test_engine_compiles_on_train_and_never_sees_other_cases(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """BootstrapFewShot compiles on train; the metric sees only the task's cases.

    Args:
        tmp_path: Run directory.
        monkeypatch: Pytest fixture recording the metric's calls.
    """
    train, val = _cases(4), _cases(2, offset=4)
    seen: list[str] = []
    real_load = engine_mod.load_metric_from_code

    def load(code: str) -> Any:
        """Wrap the real metric so every gold question it scores is recorded."""
        inner = real_load(code)

        def metric(gold: Any, pred: Any, trace: Any = None) -> Any:
            """Record and delegate."""
            seen.append(gold.question)
            return inner(gold, pred, trace)

        return metric

    monkeypatch.setattr(engine_mod, "load_metric_from_code", load)
    task = _task(train, val)
    server = EvalServer(_never_scored, max_evals=100)
    result = DspyEngine("dspy_bootstrap_fewshot").run(task, server, _ctx(tmp_path))
    assert isinstance(result.best_candidate, dict)
    assert set(result.best_candidate) == {"self", DSPY_STATE_KEY}
    assert result.artifact is not None
    assert result.metadata["selection_scope"] == "validation"
    assert server.used == result.metadata["metric_calls"] > 0
    assert server.used == result.total_evals
    assert seen
    assert set(seen) <= {case.input["question"] for case in train + val}


def test_engine_candidate_carries_the_compiled_demos(tmp_path: Any) -> None:
    """The winning candidate rebuilds the compiled program, few-shot demos included.

    Args:
        tmp_path: Run directory.
    """
    server = EvalServer(_never_scored, max_evals=100)
    result = DspyEngine("dspy_bootstrap_fewshot").run(_task(_cases(4), _cases(2, offset=4)), server, _ctx(tmp_path))

    program = build_program(RUN_CODE)
    assert program.demos == []
    apply_candidate(program, result.best_candidate)

    assert program.demos
    assert program.demos[0]["answer"] == "a"
    assert workspace_harness.DSPY_STATE_KEY == DSPY_STATE_KEY


def test_harness_scores_the_compiled_program_with_its_demos(tmp_path: Any) -> None:
    """The scorer harness loads the candidate's full state, so it runs the program that is saved.

    Args:
        tmp_path: Run directory.
    """
    server = EvalServer(_never_scored, max_evals=100)
    result = DspyEngine("dspy_bootstrap_fewshot").run(_task(_cases(4), _cases(2, offset=4)), server, _ctx(tmp_path))
    stage = workspace_harness.RunStage({"run_code": RUN_CODE, "artifact_kind": "dspy_program", "gateway": None})
    lm = DummyLM([{"answer": "a"}])

    with dspy.context(lm=lm):
        stage.run(result.best_candidate, {"question": "unseen"})

    demo_question = stage.program.demos[0]["question"]
    assert demo_question in str(lm.history[-1]["messages"])


def test_metric_llm_import_is_bound_to_the_metric_model(tmp_path: Any) -> None:
    """``from skynet import llm`` in the metric loads and calls the metered metric model.

    Args:
        tmp_path: Run directory.
    """
    metric_code = (
        "from skynet import llm\n"
        "def metric(gold, pred, trace=None):\n"
        "    return float(llm('judge: ' + pred.answer) == 'yes')\n"
    )
    task = _task(_cases(2), [], metric_code=metric_code)
    metric_lm = DummyLM([{"response": "yes"}] * 50)
    task.context["metric_lm"] = metric_lm
    server = EvalServer(_never_scored, max_evals=100)

    result = DspyEngine("dspy_bootstrap_fewshot").run(task, server, _ctx(tmp_path))

    assert result.metadata["metric_calls"] > 0
    assert metric_lm.history


def test_engine_stays_within_the_scorer_budget(tmp_path: Any) -> None:
    """A budget smaller than the optimizer wants caps its metric calls and is reported.

    Args:
        tmp_path: Run directory.
    """
    server = EvalServer(_never_scored, max_evals=1)
    task = _task(_cases(4), [])
    task.context["dspy_kwargs"] = {"max_bootstrapped_demos": 4, "max_labeled_demos": 4}
    result = DspyEngine("dspy_bootstrap_fewshot").run(task, server, _ctx(tmp_path))
    assert result.metadata["budget_exhausted"] is True
    assert result.metadata["selection_scope"] == "training"
    assert server.used == 1


def test_unknown_dspy_optimizer_is_rejected() -> None:
    """Only the three DSPy optimizer ids build an engine."""
    with pytest.raises(ServiceError):
        DspyEngine("gepa")


def test_dspy_engines_are_registered_but_hidden_from_the_catalog() -> None:
    """The DSPy engines resolve by id yet never appear in the black-box engine list."""
    for engine_id in ("dspy_gepa", "dspy_miprov2", "dspy_bootstrap_fewshot"):
        assert ENGINES[engine_id].hidden is True
        assert engine_id not in available_engine_ids()
