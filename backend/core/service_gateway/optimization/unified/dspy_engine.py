"""Run the DSPy optimizers behind the black-box engine protocol.

A unified ``dspy_program`` run defines ``build_program() -> dspy.Module`` in
its run code. :class:`DspyEngine` builds that program in-process (the worker
already runs inside the run's outer sandbox), applies the starting
instructions, compiles it with the chosen DSPy optimizer on the train cases
(selecting on the validation cases) and hands back the per-predictor
instructions as the winning candidate plus the compiled program as an
artifact. The candidate also carries the compiled program's full state (its
few-shot demos included) under :data:`DSPY_STATE_KEY`, so the final runs, the
regression guard and the reported scores measure exactly the program that is
saved. Every metric call is charged to the run's eval server so the
scorer-run budget holds exactly as it does for the black-box engines.

The run code and the metric import their ``llm`` from a ``skynet`` helper
module, as they do in the sandbox harness: the run code's calls go to the
task model and the metric's to the metric model, both metered by the job.

The metric source stays here: the DSPy reflection model only ever sees the
feedback text the metric returns.
"""

from __future__ import annotations

import inspect
import json
import logging
import sys
import threading
import types
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import dspy

from ....exceptions import ServiceError
from ....models.common import ModelConfig
from ....models.unified import DSPY_OPTIMIZER_NAMES
from ....registry import ResolverError, resolve_optimizer_factory
from ...language_models import build_language_model
from ..artifacts import persist_program
from ..blackbox import runner as helper_runtime
from ..blackbox.protocol import BudgetExhaustedError, Candidate, EngineContext, EvalServer, Result, Task
from ..data import DatasetSplits, load_metric_from_code
from ..optimizers import compile_program, instantiate_optimizer

logger = logging.getLogger(__name__)

_GEPA_BUDGET_KEYS = ("auto", "max_full_evals", "max_metric_calls")
_FEEDBACK_SHAPE = "dspy_feedback"
# Only GEPA has a resolver alias; the other DSPy names resolve by dotted path.
_FACTORY_PATHS = {"miprov2": "dspy.MIPROv2", "bootstrapfewshot": "dspy.BootstrapFewShot"}
# A candidate is ``dict[str, str]``; this key holds the compiled program's
# state as JSON next to the per-predictor instructions.
DSPY_STATE_KEY = "__dspy_state__"


def program_state(program: dspy.Module) -> str:
    """Serialize a program's full state (instructions and demos), without per-predictor LMs.

    Args:
        program: A DSPy module.

    Returns:
        The state as JSON text.
    """
    state = program.dump_state()
    for entry in state.values():
        if isinstance(entry, dict) and "lm" in entry:
            # The predictor's own LM would override the metered one the scorer binds.
            entry["lm"] = None
    return json.dumps(state, default=str)


def lm_helper(lm: Any) -> Callable[..., str]:
    """Wrap a metered DSPy LM as the ``llm`` helper user code calls.

    Args:
        lm: A ``dspy.LM``, or ``None`` when no model was configured.

    Returns:
        ``llm(prompt=None, input=None, *, images=None, messages=None) -> str``.
    """
    if lm is None:
        return helper_runtime.missing_llm

    def llm(prompt: Any = None, input: Any = None, *, images: Any = None, messages: Any = None) -> str:
        """Complete one request through the metered LM and return its text."""
        if messages is None:
            if prompt is None:
                raise helper_runtime.ScorerError("llm() needs a prompt, or messages=[...].")
            messages = helper_runtime.scorer_messages(prompt, input, images)
        outputs = lm(messages=messages)
        first = outputs[0] if outputs else ""
        return str(first.get("text") or "") if isinstance(first, dict) else str(first)

    return llm


def helper_module(lm: Any) -> types.ModuleType:
    """Build the ``skynet`` module one piece of user code imports from.

    Args:
        lm: The metered DSPy LM this code's ``llm`` calls, or ``None``.

    Returns:
        The helper module.
    """
    return helper_runtime.helper_module(
        {
            helper_runtime.LLM_HELPER_NAME: lm_helper(lm),
            helper_runtime.IMAGE_HELPER_NAME: helper_runtime.Image,
            helper_runtime.LOG_HELPER_NAME: helper_runtime.log,
        }
    )


@contextmanager
def bound_helpers(module: types.ModuleType | None) -> Iterator[None]:
    """Make ``import skynet`` resolve to ``module`` while user code loads.

    Args:
        module: The helper module, or ``None`` to leave ``skynet`` as it is.

    Yields:
        Nothing; the previous binding is restored on exit.
    """
    if module is None:
        yield
        return
    name = helper_runtime.HELPER_MODULE_NAME
    previous = sys.modules.get(name)
    sys.modules[name] = module
    try:
        yield
    finally:
        if previous is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = previous


def build_program(run_code: str, helpers: types.ModuleType | None = None) -> dspy.Module:
    """Execute the run code and return the program its ``build_program()`` makes.

    Args:
        run_code: The workspace run code.
        helpers: The ``skynet`` module the run code imports from, if any.

    Returns:
        A fresh DSPy module.

    Raises:
        ServiceError: When the code does not compile, defines no
            ``build_program`` or it does not return a ``dspy.Module``.
    """
    namespace: dict[str, Any] = {"dspy": dspy, "__name__": "skynet_run"}
    with bound_helpers(helpers):
        try:
            # exec: user run code, inside the per-job worker that already runs in
            # the run's outer sandbox. dont_inherit keeps this module's future
            # import from stringizing the user's annotations.
            exec(compile(run_code, "<run_code>", "exec", dont_inherit=True), namespace)
        except SyntaxError as exc:
            raise ServiceError(f"run_code has a syntax error: {exc}") from exc
        factory = namespace.get("build_program")
        if not callable(factory):
            raise ServiceError("run_code must define build_program() returning a dspy.Module.")
        program = factory()
    if not isinstance(program, dspy.Module):
        raise ServiceError(f"build_program() returned {type(program).__name__}, not a dspy.Module.")
    return program


def program_instructions(program: dspy.Module) -> dict[str, str]:
    """Read each predictor's instruction, keyed by predictor name.

    Args:
        program: A DSPy module.

    Returns:
        ``{predictor name: instruction}`` in the program's predictor order.
    """
    return {name: str(predictor.signature.instructions) for name, predictor in program.named_predictors()}


def apply_candidate(program: dspy.Module, candidate: Candidate) -> None:
    """Set the program's predictor instructions from a candidate.

    Args:
        program: The DSPy module to update in place.
        candidate: ``{predictor name: instruction}``, optionally with the full
            program state under :data:`DSPY_STATE_KEY`; a plain string sets
            every predictor's instruction.
    """
    if isinstance(candidate, dict) and candidate.get(DSPY_STATE_KEY):
        program.load_state(json.loads(candidate[DSPY_STATE_KEY]))
    for name, predictor in program.named_predictors():
        text = candidate if isinstance(candidate, str) else candidate.get(name)
        if text is not None:
            predictor.signature = predictor.signature.with_instructions(str(text))


def case_example(case: Any, input_fields: list[str]) -> dspy.Example:
    """Turn one unified case into the ``gold`` example a DSPy metric reads.

    Args:
        case: ``{"input": {...}, "expected": {...}}`` (or a ``UnifiedCase``).
        input_fields: The program's input field names; the case's input keys when empty.

    Returns:
        ``dspy.Example(**input, **expected).with_inputs(*input_fields)``.
    """
    data = case.model_dump() if hasattr(case, "model_dump") else dict(case)
    inputs = dict(data.get("input") or {})
    expected = data.get("expected")
    outputs = expected if isinstance(expected, dict) else ({} if expected is None else {"expected": expected})
    return dspy.Example(**inputs, **outputs).with_inputs(*(input_fields or list(inputs)))


def _positional_arity(func: Callable[..., Any]) -> int | None:
    """Count how many positional arguments ``func`` takes.

    Args:
        func: The user metric.

    Returns:
        The positional parameter count, or ``None`` when it takes ``*args``.
    """
    try:
        params = list(inspect.signature(func).parameters.values())
    except (TypeError, ValueError):
        return None
    if any(param.kind is inspect.Parameter.VAR_POSITIONAL for param in params):
        return None
    return sum(
        param.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD) for param in params
    )


def normalize_metric_output(raw: Any) -> tuple[float, str]:
    """Read a score and feedback from any metric return shape the contract allows.

    Args:
        raw: ``dspy.Prediction(score, feedback)``, ``{"score", "feedback"}``,
            ``(score, feedback)``, or a bare float/bool.

    Returns:
        The score as a float and the feedback text (empty when none).

    Raises:
        ServiceError: When the return value carries no numeric score.
    """
    if isinstance(raw, dspy.Prediction | dict):
        score, feedback = raw.get("score"), raw.get("feedback")
    elif isinstance(raw, tuple) and len(raw) == 2:
        score, feedback = raw
    else:
        score, feedback = raw, None
    try:
        return float(score), "" if feedback is None else str(feedback)
    except (TypeError, ValueError) as exc:
        raise ServiceError(f"metric returned {type(raw).__name__} without a numeric score.") from exc


class BudgetedMetric:
    """Wrap the user metric so every call is charged to the run's eval server.

    For the feedback shape the wrapper returns ``dspy.Prediction(score,
    feedback)`` whatever the user returned, so DSPy GEPA reflects on the text;
    for the scalar shape it returns the float.
    """

    def __init__(self, metric: Callable[..., Any], server: EvalServer, *, feedback: bool) -> None:
        """Bind the user metric to the run's budget.

        Args:
            metric: The user's metric callable.
            server: The run's eval server.
            feedback: Whether the optimizer consumes feedback text.
        """
        self._metric = metric
        self._server = server
        self._feedback = feedback
        self._arity = _positional_arity(metric)
        self._lock = threading.Lock()
        self.exhausted = False
        self.calls = 0

    def __call__(self, gold: Any, pred: Any, trace: Any = None, pred_name: Any = None, pred_trace: Any = None) -> Any:
        """Score one prediction and charge it to the budget.

        Args:
            gold: The case as a ``dspy.Example``.
            pred: The program's prediction.
            trace: DSPy's trace, when the optimizer passes one.
            pred_name: The predictor GEPA asks feedback for, if any.
            pred_trace: That predictor's trace, if any.

        Returns:
            ``dspy.Prediction(score, feedback)`` for the feedback shape,
            otherwise the score.

        Raises:
            BudgetExhaustedError: When the scorer-run budget is spent.
        """
        if self.exhausted or self._server.remaining <= 0:
            self.exhausted = True
            raise BudgetExhaustedError("scorer-run budget exhausted")
        args = (gold, pred, trace, pred_name, pred_trace)
        raw = self._metric(*(args if self._arity is None else args[: max(2, self._arity)]))
        score, feedback = normalize_metric_output(raw)
        try:
            self._server.charge(None, score, {"feedback": feedback})
        except BudgetExhaustedError:
            self.exhausted = True
            raise
        with self._lock:
            self.calls += 1
        return dspy.Prediction(score=score, feedback=feedback) if self._feedback else score


def _model_config(raw: Any) -> ModelConfig | None:
    """Read a model config from the task context.

    Args:
        raw: A ``ModelConfig``, its dump, or ``None``.

    Returns:
        The model config, or ``None``.
    """
    if raw is None or isinstance(raw, ModelConfig):
        return raw
    return ModelConfig.model_validate(raw)


class DspyEngine:
    """One DSPy optimizer (``dspy_gepa``, ``dspy_miprov2``, ``dspy_bootstrap_fewshot``) as an engine."""

    def __init__(self, optimizer_id: str) -> None:
        """Pick the DSPy optimizer this engine runs.

        Args:
            optimizer_id: A key of :data:`DSPY_OPTIMIZER_NAMES`.

        Raises:
            ServiceError: When the id is not a DSPy optimizer.
        """
        if optimizer_id not in DSPY_OPTIMIZER_NAMES:
            raise ServiceError(f"Unknown DSPy optimizer '{optimizer_id}'.")
        self.name = optimizer_id

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Compile the workspace program on the train cases, selecting on the validation cases.

        Args:
            task: Train cases, validation cases and the private run context.
            server: The run's eval server; every metric call is charged to it.
            ctx: Reflection model and workspace.

        Returns:
            The compiled program's instructions as the best candidate and the
            program itself as ``artifact``; the starting point when the
            budget ran out before the optimizer finished.

        Raises:
            ServiceError: When the program, metric or optimizer cannot be built.
        """
        context = task.context
        optimizer_name = DSPY_OPTIMIZER_NAMES[self.name]
        models = context.get("models") or {}
        reflection_model = _model_config(models.get("reflection_model"))
        task_lm = context.get("task_lm")
        if task_lm is None:
            task_model = _model_config(models.get("task_model")) or reflection_model
            if task_model is None:
                raise ServiceError("A DSPy program needs a task model.")
            task_lm = build_language_model(task_model)
        program = build_program(str(context["run_code"]), helper_module(task_lm))
        if task.seed_candidate is not None:
            apply_candidate(program, task.seed_candidate)
        seed_candidate = program_instructions(program)
        input_fields = list(context.get("input_fields") or [])
        splits = DatasetSplits(
            train=[case_example(case, input_fields) for case in task.cases],
            val=[case_example(case, input_fields) for case in task.valset],
            test=[],
        )
        # Module-level ``from skynet import llm`` binds when the code loads, so
        # each piece of code keeps the model it was loaded with.
        with bound_helpers(helper_module(context.get("metric_lm"))):
            user_metric = load_metric_from_code(str(context["metric_code"]))
        metric = BudgetedMetric(
            user_metric,
            server,
            feedback=context.get("metric_shape") == _FEEDBACK_SHAPE,
        )
        try:
            factory = resolve_optimizer_factory(_FACTORY_PATHS.get(optimizer_name, optimizer_name))
        except ResolverError as exc:
            raise ServiceError(str(exc)) from exc
        kwargs = dict(context.get("dspy_kwargs") or {})
        if self.name == "dspy_gepa" and not any(key in kwargs for key in _GEPA_BUDGET_KEYS):
            kwargs["max_metric_calls"] = server.remaining
        reflection_lm = getattr(ctx.reflection_lm, "lm", None)
        if optimizer_name == "miprov2" and reflection_lm is not None:
            kwargs.setdefault("prompt_model", reflection_lm)
        optimizer = instantiate_optimizer(
            factory,
            optimizer_name,
            kwargs,
            metric,
            reflection_model,
            reflection_lm=reflection_lm,
            log_dir=ctx.run_dir,
        )
        logger.info(
            "DSPy %s: %d train / %d validation case(s), budget %d metric call(s)",
            optimizer_name,
            len(splits.train),
            len(splits.val),
            server.remaining,
        )
        try:
            with dspy.context(lm=task_lm):
                compiled = compile_program(
                    optimizer=optimizer, program=program, splits=splits, metric=metric, compile_kwargs={}
                )
        except BudgetExhaustedError:
            compiled = None
        except Exception:
            if not metric.exhausted:
                raise
            compiled = None
        selection = "validation" if splits.val else "training"
        if compiled is None:
            logger.info("DSPy %s ran out of scorer runs; keeping the starting point", optimizer_name)
            return Result(
                best_candidate=seed_candidate,
                best_score=None,
                total_evals=server.used,
                metadata={"selection_scope": selection, "metric_calls": metric.calls, "budget_exhausted": True},
            )
        artifact = persist_program(compiled, None)
        return Result(
            best_candidate={**program_instructions(compiled), DSPY_STATE_KEY: program_state(compiled)},
            best_score=None,
            total_evals=server.used,
            metadata={
                "selection_scope": selection,
                "metric_calls": metric.calls,
                "budget_exhausted": metric.exhausted,
                "dspy_optimizer": optimizer_name,
            },
            artifact=artifact.model_dump(mode="json") if artifact is not None else None,
        )
