"""High-level :class:`DspyService` facade for running optimization jobs.

Glues together signature/metric loading, dataset splitting, optimizer
instantiation, baseline-vs-optimized evaluation, artifact persistence,
and progress callbacks for single-run payloads.
The companion modules in this package handle the individual concerns;
this file orchestrates them.
"""

import logging
from collections.abc import Callable, Iterable
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any

import dspy
from dspy.teleprompt.gepa.gepa_utils import DspyAdapter

from ...config import settings as app_settings
from ...constants import (
    DETAIL_BASELINE,
    DETAIL_OPTIMIZED,
    DETAIL_TEST,
    DETAIL_TRAIN,
    DETAIL_VAL,
    META_COMPILE_KWARGS,
    META_MODEL_IDENTIFIER,
    META_MODULE_KWARGS,
    META_OPTIMIZER,
    META_OPTIMIZER_KWARGS,
    OPTIMIZER_NAME_GEPA,
    PROGRESS_BASELINE,
    PROGRESS_EVALUATION_STARTED,
    PROGRESS_OPTIMIZED,
    PROGRESS_SPLITS_READY,
)
from ...exceptions import ServiceError
from ...models import (
    WORKFLOW_MODULE_NAME,
    LMActivity,
    LMStageStats,
    RunRequest,
    RunResponse,
    SplitCounts,
)
from ...models.artifacts import ProgramArtifact, ReactOverlay
from ...models.results import ModelTokenUsage
from ...registry import (
    ResolverError,
    ServiceRegistry,
    UnknownRegistrationError,
    resolve_module_factory,
    resolve_optimizer_factory,
)
from ..language_models import (
    apply_model_reasoning_config,
    build_language_model,
    lm_call_count,
    model_usages_from_history,
    total_tokens_from_history,
)
from ..safe_exec import validate_metric_code, validate_signature_code
from .artifacts import persist_program
from .budget_stop import BudgetReached
from .cost_ceiling import CostCeilingCallback
from .data import (
    extract_signature_fields,
    image_input_field_names,
    load_metric_from_code,
    load_signature_from_code,
    rows_to_examples,
    split_examples,
)
from .incumbent import completed_gepa_result
from .logged_scores import aggregate_logged_metrics
from .optimizers import (
    compile_program,
    evaluate_on_test,
    instantiate_optimizer,
    preflight_metric_check,
    validate_optimizer_kwargs,
    validate_optimizer_signature,
)
from .progress import capture_tqdm
from .timing import (
    STAGE_BASELINE,
    STAGE_EVALUATION,
    STAGE_TRAINING,
    GenLMTimingCallback,
    ReflectionLMTimingCallback,
    track_stage,
)
from .training_ground import run_react
from .training_ground.run_react import _AUTO_BUDGETS, tool_severity
from .trajectory import (
    capture_proposal_prompts,
    emit_valset_event,
    gepa_log_dir,
    maybe_wrap_minibatch_recorder,
    trajectory_watch,
)
from .validators import (
    require_mapping_columns_in_dataset,
    require_mapping_matches_signature,
)
from .workflow import build_workflow_program, validate_workflow

logger = logging.getLogger(__name__)


def _usage_by_model_rows(*language_models: object) -> list[ModelTokenUsage]:
    """Build a result's per-model usage rows from the run's LM histories.

    Wraps :func:`model_usages_from_history`, turning its per-model usage (tokens
    plus any provider-reported cost) into the :class:`ModelTokenUsage` rows the billing worker
    charges from and the UI reconciles against. Returns an empty list when usage
    is untracked (e.g. mocked LMs), mirroring the ``total_tokens`` companion.

    Args:
        *language_models: The run's LMs — generation and, when present, reflection.

    Returns:
        One row per distinct model that recorded usage.
    """
    usages = model_usages_from_history(*language_models)
    if not usages:
        return []
    return [ModelTokenUsage(**asdict(usage)) for usage in usages]


def _resolve_max_metric_calls(optimizer_kwargs: dict[str, Any]) -> int:
    """Resolve the GEPA metric-call budget from a react submission's kwargs.

    Mirrors the precedence the generic GEPA path gets for free from
    ``instantiate_optimizer``: an explicit ``max_metric_calls`` wins, otherwise
    the ``auto`` preset ("light"/"medium"/"heavy") is translated through
    ``_AUTO_BUDGETS``. Only when neither is supplied do we fall back to the
    medium budget. Previously this site read ``max_metric_calls`` alone and
    hardcoded medium, so the ``auto`` preset chosen in the wizard was silently
    ignored for react jobs (a "light" run got the 2000-call medium budget).

    Args:
        optimizer_kwargs: The raw optimizer kwargs from the run payload.

    Returns:
        The metric-call ceiling to hand GEPA.
    """
    if "max_metric_calls" in optimizer_kwargs:
        return int(optimizer_kwargs["max_metric_calls"])
    auto = optimizer_kwargs.get("auto")
    if auto is not None:
        return _AUTO_BUDGETS[auto]
    return _AUTO_BUDGETS["medium"]


def _require_metric_compatible_with_optimizer(optimizer_name: str, param_names: list[str]) -> None:
    """Reject metrics whose arity is incompatible with the chosen optimizer.

    GEPA hands the metric 5 positional args during reflection —
    ``(gold, pred, trace, pred_name, pred_trace)``. Any shorter signature
    raises ``TypeError`` on every iteration, leaving GEPA unable to propose
    a new candidate and the optimized score pinned to the baseline. The
    API ``/validate-code`` route already enforces this, but submissions
    bypassing the wizard (the generalist agent, direct ``POST /run``)
    used to slip through to a "successful" no-op run.

    Args:
        optimizer_name: The optimizer key from the run payload.
        param_names: Metric parameter names returned by ``validate_metric_code``.

    Raises:
        ServiceError: When the metric signature is incompatible with the optimizer.
    """
    if optimizer_name == OPTIMIZER_NAME_GEPA and len(param_names) < 5:
        raise ServiceError(
            "GEPA metric must accept 5 arguments: "
            "(gold, pred, trace, pred_name, pred_trace). "
            f"Found {len(param_names)}: ({', '.join(param_names)}). "
            "See https://dspy.ai/api/optimizers/GEPA for details."
        )


def _validate_target_score(target_score: float | None, optimizer_name: str, val_fraction: float) -> None:
    """Validate that a target score can use GEPA's validation stopper.

    Args:
        target_score: Optional UI percentage target.
        optimizer_name: Registered optimizer name from the submission.
        val_fraction: Validation split fraction selected for the run.

    Raises:
        ServiceError: When a target is requested for a non-GEPA optimizer or
            when no validation split is available to score it.
    """
    if target_score is None:
        return
    if optimizer_name.lower() != OPTIMIZER_NAME_GEPA:
        raise ServiceError("target_score is only supported for GEPA optimization.")
    if val_fraction <= 0:
        raise ServiceError("target_score requires a non-empty validation split.")


def _tool_to_snapshot_spec(tool: Any) -> dict[str, Any]:
    """Serialize a ``dspy.Tool`` into a dataset-snapshot spec.

    The spec round-trips through ``run_react._snapshot_tool`` at serve time, so
    the rebuilt roster keeps the same ``name``/``desc``/``args`` — and therefore
    the same schema hash — as the roster the run was optimized against.

    Args:
        tool: The resolved ``dspy.Tool`` from the run's roster.

    Returns:
        A ``{"name", "description", "args"}`` spec mirroring the tool's schema,
        plus ``"severity"`` when the live roster carried an approval hint.
    """
    spec: dict[str, Any] = {
        "name": tool.name,
        "description": tool.desc or "",
        "args": dict(tool.args) if isinstance(tool.args, dict) else {},
    }
    severity = tool_severity(tool)
    if severity is not None:
        spec["severity"] = severity
    return spec


def _react_prediction_outputs(prediction: Any, output_fields: Iterable[str]) -> dict[str, Any]:
    """Pull a react rollout's per-field answer off its ``Prediction``.

    Mirrors the on-demand ``evaluate-examples`` endpoint's extraction
    (``getattr(prediction, sig_field)`` keyed by signature output field) so the
    stored test-result ``outputs`` match the shape the DataTab already reads.
    Non-scalar field values are stringified so the result stays JSON-serializable
    for persistence.

    Args:
        prediction: The rollout ``Prediction``, or ``None`` for a failed rollout.
        output_fields: Signature output field names (``column_mapping.outputs``
            keys) to surface.

    Returns:
        ``{output_field: value}``; empty when ``prediction`` is ``None``.
    """
    if prediction is None:
        return {}
    outputs: dict[str, Any] = {}
    for field_name in output_fields:
        value = getattr(prediction, field_name, None)
        if value is None or isinstance(value, str | int | float | bool):
            outputs[field_name] = value
        else:
            outputs[field_name] = str(value)
    return outputs


def _build_lm_activity(
    gen_timing: GenLMTimingCallback,
    refl_timing: ReflectionLMTimingCallback | None,
) -> LMActivity:
    """Compose an ``LMActivity`` payload from per-stage callback summaries.

    Only stages that recorded at least one call get a ``LMStageStats``
    entry; the frontend renders zero-call stages from :data:`STAGE_ORDER`
    on its own, so we keep the wire payload sparse.

    Args:
        gen_timing: Generation-LM timing callback, always present.
        refl_timing: Reflection-LM timing callback, or ``None`` when the
            run did not use a reflection LM (non-GEPA optimizer).

    Returns:
        An ``LMActivity`` whose ``generation`` and ``reflection`` dicts
        contain one entry per stage with calls > 0.
    """
    generation: dict[str, LMStageStats] = {}
    for stage, (calls, avg_ms) in gen_timing.stage_summary().items():
        generation[stage] = LMStageStats(calls=calls, avg_response_time_ms=avg_ms)
    reflection: dict[str, LMStageStats] = {}
    if refl_timing is not None:
        for stage, (calls, avg_ms) in refl_timing.stage_summary().items():
            reflection[stage] = LMStageStats(calls=calls, avg_response_time_ms=avg_ms)
    return LMActivity(generation=generation, reflection=reflection)


class DspyService:
    """High-level coordinator between FastAPI payloads and DSPy runtimes."""

    def __init__(
        self,
        registry: ServiceRegistry,
        default_seed: int | None = None,
    ):
        """Initialize DspyService with a module/optimizer registry and optional default seed.

        Args:
            registry: Module/optimizer registry used to resolve named factories.
            default_seed: Optional default split seed when a payload omits one.
        """
        self.registry = registry
        self.default_seed = default_seed

    def run(
        self,
        payload: RunRequest,
        *,
        artifact_id: str | None = None,
        progress_callback: Callable[[str, dict[str, Any]], None] | None = None,
        gepa_log_dir_path: str | None = None,
    ) -> RunResponse:
        """Execute a single DSPy optimization run and return a structured response.

        Loads the signature, module, metric, and optimizer from the payload,
        splits the dataset, runs baseline evaluation, compiles the program, then
        evaluates the optimized result.  The baseline and the compiled program
        are compared on the validation split (the train split when there is no
        validation split); if the compiled program scores lower there, the
        baseline program is returned instead.  The test split only reports the
        chosen program's score — it never takes part in the choice.

        Args:
            payload: The validated run request to execute.
            artifact_id: Optional identifier carried into artifact storage.
            progress_callback: Optional callback receiving ``(event, detail)`` updates.
            gepa_log_dir_path: Worker-owned directory for GEPA's ``gepa_state.bin``.
                When the directory already holds a prior state file the GEPA
                engine resumes from it; when ``None`` an ephemeral tempdir is
                used and the run starts fresh.

        Returns:
            A populated :class:`RunResponse` summarising the run.
        """
        run_start = datetime.now(UTC)
        logger.info(
            "Starting DSPy run: module=%s optimizer=%s dataset_rows=%d",
            payload.module_name,
            payload.optimizer_name,
            len(payload.dataset),
        )

        workflow_mode = payload.module_name.lower() == WORKFLOW_MODULE_NAME
        if workflow_mode:
            signature_cls = None
            signature_inputs = payload.workflow.input_field_names()
            signature_outputs = payload.workflow.output_field_names()
            program, _workflow_tool_hashes = build_workflow_program(
                payload.workflow,
                tool_source=payload.tool_source,
                dataset=payload.dataset,
            )
            logger.info(
                "Built workflow program: nodes=%d edges=%d inputs=%s outputs=%s",
                len(payload.workflow.nodes),
                len(payload.workflow.edges),
                signature_inputs,
                signature_outputs,
            )
        else:
            signature_cls = load_signature_from_code(payload.signature_code)
            signature_inputs, signature_outputs = extract_signature_fields(signature_cls)
            logger.info(
                "Loaded signature %s with inputs=%s outputs=%s",
                signature_cls.__name__,
                signature_inputs,
                signature_outputs,
            )
        require_mapping_matches_signature(payload.column_mapping, signature_inputs, signature_outputs)
        if payload.module_name.lower() == "react":
            return self._run_react(
                payload,
                signature_cls=signature_cls,
                run_start=run_start,
                artifact_id=artifact_id,
                progress_callback=progress_callback,
                gepa_log_dir_path=gepa_log_dir_path,
            )
        if not workflow_mode:
            module_factory, auto_signature = self._get_module_factory(payload.module_name)
            module_kwargs = dict(payload.module_kwargs)
            if auto_signature or "signature" not in module_kwargs:
                module_kwargs["signature"] = signature_cls
            program = module_factory(**module_kwargs)
            # Breadcrumb for the dspy.* escape hatch: a non-aliased path gets
            # auto_signature=False and trusts a user-supplied signature, so an
            # opaque constructor error is otherwise indistinguishable from an
            # aliased-module failure in job_logs.
            logger.info(
                "Instantiated module %s (auto_signature=%s signature_injected=%s)",
                payload.module_name,
                auto_signature,
                "signature" in module_kwargs,
            )

        metric = load_metric_from_code(payload.metric_code)
        metric_identifier = getattr(metric, "__name__", "inline_metric")

        # Caching stays ON here: forcing cache off across the GEPA
        # training/eval region suppresses GEPA's recognized valset
        # ``Evaluate`` / rollouts tqdm bar, which is the only bar the
        # progress proxy emits from (regression from #23/#24). Per-stage
        # activity tracking does not need cache-off — it works through the
        # timing callbacks' stage state, independent of the LM cache.
        language_model = build_language_model(payload.model_settings)
        # Build the reflection LM up front (when supplied) so the timing
        # callback can be bound to its identity. ``instantiate_optimizer``
        # would otherwise build it internally, leaving us no handle.
        reflection_lm = (
            build_language_model(payload.reflection_model_settings)
            if payload.reflection_model_settings is not None
            else None
        )
        optimizer_factory = self._get_optimizer_factory(payload.optimizer_name)

        examples = rows_to_examples(
            payload.dataset,
            payload.column_mapping,
            image_input_fields=image_input_field_names(signature_cls) if signature_cls is not None else frozenset(),
        )
        logger.info("Converted dataset to %d DSPy examples", len(examples))

        splits = split_examples(
            examples,
            payload.split_fractions,
            shuffle=payload.shuffle,
            seed=payload.seed or self.default_seed,
        )
        logger.info(
            "Split dataset -> train=%d val=%d test=%d",
            len(splits.train),
            len(splits.val),
            len(splits.test),
        )
        if progress_callback:
            progress_callback(
                PROGRESS_SPLITS_READY,
                {
                    DETAIL_TRAIN: len(splits.train),
                    DETAIL_VAL: len(splits.val),
                    DETAIL_TEST: len(splits.test),
                },
            )
            emit_valset_event(splits.val, progress_callback)

        gen_timing = GenLMTimingCallback(language_model)
        refl_timing = ReflectionLMTimingCallback(reflection_lm) if reflection_lm is not None else None
        # Only the timing callbacks carry per-stage state (set_stage/_current_stage),
        # so track_stage must be splatted with these alone. The cost-ceiling callback
        # is a plain on_lm_end listener and would raise AttributeError inside track_stage.
        timing_callbacks: list[Any] = [gen_timing]
        if refl_timing is not None:
            timing_callbacks.append(refl_timing)
        callbacks: list[Any] = list(timing_callbacks)
        # Hard-stop the run once token spend exceeds the user's Max Cost Ceiling.
        # Registered alongside the timing callbacks so it sees every LM call on
        # every worker thread; a trip raises out of the run and the worker leaves
        # the job failed (and unbilled — debiting only fires on success).
        if payload.max_cost_cents is not None and payload.execution_budget_id is None:
            callbacks.append(CostCeilingCallback(payload.max_cost_cents, language_model, reflection_lm))
        with gepa_log_dir(payload.optimizer_name, gepa_log_dir_path) as trajectory_log_dir:
            training_metric = maybe_wrap_minibatch_recorder(
                metric,
                splits.val,
                payload.optimizer_name,
                progress_callback,
                payload.module_name,
            )
            stop_state: dict[str, Any] = {}
            optimizer = instantiate_optimizer(
                optimizer_factory,
                payload.optimizer_name,
                payload.optimizer_kwargs,
                training_metric,
                payload.reflection_model_settings,
                reflection_lm=reflection_lm,
                log_dir=trajectory_log_dir,
                target_score=payload.target_score,
                stop_state=stop_state,
            )
            with dspy.context(lm=language_model, callbacks=callbacks):
                baseline_test_metric = None
                baseline_test_results: list[dict] = []
                if splits.test:
                    with track_stage(STAGE_BASELINE, *timing_callbacks):
                        baseline_test_metric, baseline_test_results = evaluate_on_test(
                            program,
                            splits.test,
                            metric,
                            collect_per_example=True,
                        )
                    logger.info("%s baseline test metric: %s", payload.module_name, baseline_test_metric)
                    if progress_callback and baseline_test_metric is not None:
                        progress_callback(
                            PROGRESS_BASELINE,
                            {DETAIL_BASELINE: baseline_test_metric},
                        )
                # The regression guard compares on validation (train without
                # one) so the test split stays an unbiased report of the winner.
                selection_set = splits.val or splits.train
                selection_scope = "validation" if splits.val else "training"
                baseline_selection_metric = None
                if selection_set:
                    with track_stage(STAGE_BASELINE, *timing_callbacks):
                        baseline_selection_metric = evaluate_on_test(
                            program, selection_set, metric, collect_per_example=False
                        )
                    logger.info(
                        "%s baseline %s metric: %s", payload.module_name, selection_scope, baseline_selection_metric
                    )
                # Fail fast on a structurally broken metric (e.g. wrong field
                # names or isinstance(gold, dict) gating) before spending the
                # optimizer budget grinding at 0%. A correct metric always
                # scores a perfect prediction > 0, so legitimately hard tasks
                # are never blocked.
                preflight_metric_check(metric, splits.train, signature_outputs)

                logger.info(
                    "Compiling %s program via optimizer=%s",
                    payload.module_name,
                    payload.optimizer_name,
                )
                budget_stop: BudgetReached | None = None
                try:
                    with (
                        capture_tqdm(progress_callback),
                        track_stage(STAGE_TRAINING, *timing_callbacks),
                        capture_proposal_prompts(payload.optimizer_name),
                        trajectory_watch(trajectory_log_dir, progress_callback),
                    ):
                        compiled_program = compile_program(
                            optimizer=optimizer,
                            program=program,
                            splits=splits,
                            metric=metric,
                            compile_kwargs=payload.compile_kwargs,
                        )
                except BudgetReached as exc:
                    recovered = (
                        completed_gepa_result(trajectory_log_dir, seed=payload.seed)
                        if payload.optimizer_name.lower() == "gepa"
                        else None
                    )
                    if recovered is None and baseline_selection_metric is not None:
                        budget_stop = exc
                        compiled_program = program
                        exc.evidence.update(
                            selection_scope=selection_scope,
                            selection_score=baseline_selection_metric,
                            candidate_origin="seed",
                        )
                    elif recovered is None:
                        raise
                    else:
                        budget_stop = exc
                        compiled_program = DspyAdapter(program, metric, {}).build_program(recovered.best_candidate)
                        exc.evidence.update(
                            selection_scope="validation" if splits.val else "training",
                            selection_score=recovered.val_aggregate_scores[recovered.best_idx],
                            candidate_origin="seed" if recovered.best_idx == 0 else "optimized",
                        )
                logger.info("Optimizer compile completed successfully")

                optimized_test_metric = None
                optimized_test_results: list[dict] = []
                best_program = compiled_program
                try:
                    if budget_stop is None and progress_callback and (selection_set or splits.test):
                        progress_callback(PROGRESS_EVALUATION_STARTED, {})
                    if selection_set and budget_stop is None and compiled_program is not program:
                        with track_stage(STAGE_EVALUATION, *timing_callbacks):
                            optimized_selection_metric = evaluate_on_test(
                                compiled_program, selection_set, metric, collect_per_example=False
                            )
                        logger.info("Optimized %s metric: %s", selection_scope, optimized_selection_metric)
                        if (
                            baseline_selection_metric is not None
                            and optimized_selection_metric is not None
                            and optimized_selection_metric < baseline_selection_metric
                        ):
                            logger.warning(
                                "Optimized program (%.4f) is worse than baseline (%.4f) on %s — "
                                "returning baseline program",
                                optimized_selection_metric,
                                baseline_selection_metric,
                                selection_scope,
                            )
                            best_program = program
                    if splits.test and budget_stop is None:
                        if best_program is program:
                            optimized_test_metric = baseline_test_metric
                            optimized_test_results = baseline_test_results
                        else:
                            with track_stage(STAGE_EVALUATION, *timing_callbacks):
                                optimized_test_metric, optimized_test_results = evaluate_on_test(
                                    best_program,
                                    splits.test,
                                    metric,
                                    collect_per_example=True,
                                )
                        logger.info("Optimized test metric: %s", optimized_test_metric)
                        if progress_callback and optimized_test_metric is not None:
                            progress_callback(
                                PROGRESS_OPTIMIZED,
                                {DETAIL_OPTIMIZED: optimized_test_metric},
                            )

                except BudgetReached as exc:
                    budget_stop = exc
                    exc.evidence.setdefault("candidate_origin", "optimized")

        program_artifact = persist_program(best_program, artifact_id)
        if program_artifact:
            logger.info("Program artifact created: %s", program_artifact.path)

        split_counts = SplitCounts(train=len(splits.train), val=len(splits.val), test=len(splits.test))

        details: dict[str, Any] = {
            DETAIL_TRAIN: split_counts.train,
            DETAIL_VAL: split_counts.val,
            DETAIL_TEST: split_counts.test,
            DETAIL_BASELINE: baseline_test_metric,
            DETAIL_OPTIMIZED: optimized_test_metric,
        }

        optimization_metadata = {
            META_OPTIMIZER: payload.optimizer_name,
            META_OPTIMIZER_KWARGS: payload.optimizer_kwargs,
            META_COMPILE_KWARGS: payload.compile_kwargs,
            META_MODULE_KWARGS: payload.module_kwargs,
            META_MODEL_IDENTIFIER: payload.model_settings.normalized_identifier(),
            "selection_scope": selection_scope,
        }
        if payload.target_score is not None:
            target_reached = bool(getattr(stop_state.get("target_score_stopper"), "reached", False))
            optimization_metadata.update(
                {
                    "target_score": payload.target_score,
                    "target_score_reached": target_reached,
                    "stop_reason": "target_score" if target_reached else "metric_call_budget",
                }
            )

        metric_improvement = None
        if baseline_test_metric is not None and optimized_test_metric is not None:
            metric_improvement = optimized_test_metric - baseline_test_metric

        runtime_seconds = (datetime.now(UTC) - run_start).total_seconds()
        # num_lm_calls prefers the metered aggregate (history stays for mocked LMs);
        # avg is wall-clock time spent inside the generation LM only, via the callback.
        num_lm_calls = lm_call_count(language_model)
        _, avg_response_time_ms = gen_timing.summary()
        lm_activity = _build_lm_activity(gen_timing, refl_timing)
        response = RunResponse(
            module_name=payload.module_name,
            optimizer_name=payload.optimizer_name,
            metric_name=metric_identifier,
            split_counts=split_counts,
            baseline_test_metric=baseline_test_metric,
            optimized_test_metric=optimized_test_metric,
            metric_improvement=metric_improvement,
            optimization_metadata=optimization_metadata,
            details=details,
            program_artifact_path=program_artifact.path if program_artifact else None,
            program_artifact=program_artifact,
            runtime_seconds=runtime_seconds,
            num_lm_calls=num_lm_calls,
            total_tokens=total_tokens_from_history(language_model, reflection_lm),
            usage_by_model=_usage_by_model_rows(language_model, reflection_lm),
            avg_response_time_ms=avg_response_time_ms,
            lm_activity=lm_activity,
            baseline_test_results=baseline_test_results,
            optimized_test_results=optimized_test_results,
            baseline_logged_metrics=aggregate_logged_metrics(baseline_test_results),
            optimized_logged_metrics=aggregate_logged_metrics(optimized_test_results),
        )

        if budget_stop is not None:
            budget_stop.result = response
            budget_stop.evidence.update(final_evaluation_completed=False, final_evaluation_reason="budget_reached")
            raise budget_stop

        logger.info(
            "DSPy run finished: module=%s optimizer=%s status=success",
            payload.module_name,
            payload.optimizer_name,
        )
        return response

    def _run_react(
        self,
        payload: RunRequest,
        *,
        signature_cls: type,
        run_start: datetime,
        artifact_id: str | None,
        progress_callback: Callable[[str, dict[str, Any]], None] | None,
        gepa_log_dir_path: str | None = None,
    ) -> RunResponse:
        """Optimize a generic react program over a live tool roster and assemble the response.

        React is a generic module like predict/cot that additionally carries a
        tool roster, so this mirrors :meth:`run` end-to-end: it resolves the
        roster from ``payload.tool_source``, converts the dataset into plain
        ``dspy.Example`` rows, splits them, then delegates ``gepa.optimize`` to
        :func:`run_react.run_react_optimization`, which scores the seed and the
        optimized candidate against the *live* MCP tools with the same standard
        ``(gold, pred, trace, pred_name, pred_trace)`` metric the scalar path
        uses. There is no replay: rollouts execute the live tools, so the
        optimized program behaves at eval time exactly as it will when served.
        The servable program state is persisted into a :class:`ProgramArtifact`
        carrying the react tool overlay.

        The scalar (non-react) ``run`` path never reaches here — the branch in
        :meth:`run` returns early — so this method owns the react contract
        end-to-end without disturbing the existing flow.

        Args:
            payload: The validated react run request.
            signature_cls: The signature resolved from ``payload.signature_code``.
            run_start: Wall-clock start stamped by :meth:`run`, reused for the
                reported runtime.
            artifact_id: Optional identifier carried into artifact storage.
            progress_callback: Optional ``(event, detail)`` progress sink.
            gepa_log_dir_path: Worker-owned directory for GEPA's state file; a
                prior state file in it resumes the run, ``None`` starts fresh.

        Returns:
            A populated :class:`RunResponse` whose scalar metrics mirror the
            baseline/optimized means and whose ``program_artifact`` carries the
            react tool overlay.
        """
        tools, schema_hashes = run_react.resolve_react_tools(
            payload.tool_source,
            signature_cls,
            app_settings,
            dataset=payload.dataset,
        )

        metric = load_metric_from_code(payload.metric_code)
        metric_identifier = getattr(metric, "__name__", "inline_metric")

        examples = rows_to_examples(
            payload.dataset,
            payload.column_mapping,
            image_input_fields=image_input_field_names(signature_cls),
        )
        splits = split_examples(
            examples,
            payload.split_fractions,
            shuffle=payload.shuffle,
            seed=payload.seed or self.default_seed,
        )
        if progress_callback:
            progress_callback(
                PROGRESS_SPLITS_READY,
                {
                    DETAIL_TRAIN: len(splits.train),
                    DETAIL_VAL: len(splits.val),
                    DETAIL_TEST: len(splits.test),
                },
            )
            # Pareto cells in the candidate tree are indexed by valset position;
            # GEPA scores against the replay valset built from splits.val in the
            # same order, so emitting splits.val here lines the cells up 1:1.
            emit_valset_event(splits.val, progress_callback)

        # Normalize through the reasoning-config helper so a minimax/reasoning
        # student model gets a safe max_tokens floor + extras automatically;
        # without it a bare minimax ModelConfig truncates into malformed
        # tool_calls (a dspy ToolCalls ValidationError) during the react loop.
        student_lm = build_language_model(apply_model_reasoning_config(payload.model_settings))
        reflection_lm = (
            build_language_model(apply_model_reasoning_config(payload.reflection_model_settings))
            if payload.reflection_model_settings is not None
            else student_lm
        )
        max_metric_calls = _resolve_max_metric_calls(payload.optimizer_kwargs)
        # Same parallel-eval default the scalar GEPA path gets via
        # build_optimizer; the react adapter's own default is sequential.
        num_threads = int(payload.optimizer_kwargs.get("num_threads") or app_settings.gepa_eval_num_threads)
        seed = payload.seed if payload.seed is not None else (self.default_seed or 0)

        gen_timing = GenLMTimingCallback(student_lm)
        # Registered so reflection calls carry their stage and candidate tags like the scalar path's.
        stage_timings: tuple[Any, ...] = (
            (gen_timing,) if reflection_lm is student_lm else (gen_timing, ReflectionLMTimingCallback(reflection_lm))
        )
        react_callbacks: list[Any] = list(stage_timings)
        # Same Max Cost Ceiling hard-stop the scalar path registers. React routes
        # both the student and the reflection LM through ``gepa.optimize``; the
        # ceiling totals usage across both so the cap covers the whole run.
        if payload.max_cost_cents is not None and payload.execution_budget_id is None:
            react_callbacks.append(CostCeilingCallback(payload.max_cost_cents, student_lm, reflection_lm))
        # Mirror the scalar run's trajectory wiring so react gets the same
        # candidate tree: GEPA persists state into trajectory_log_dir,
        # trajectory_watch streams candidate/rejected events, capture_proposal_prompts
        # records rejected proposal prompts, and capture_tqdm drives the live bar.
        with (
            gepa_log_dir(payload.optimizer_name, gepa_log_dir_path) as trajectory_log_dir,
            dspy.context(lm=student_lm, callbacks=react_callbacks),
            capture_tqdm(progress_callback),
            capture_proposal_prompts(payload.optimizer_name),
            trajectory_watch(trajectory_log_dir, progress_callback),
        ):
            # Same minibatch recorder the scalar path wraps its metric in, so the
            # per-example reflection feedback and the
            # valset candidate outputs populate the trajectory drawer for react too.
            training_metric = maybe_wrap_minibatch_recorder(
                metric,
                splits.val,
                payload.optimizer_name,
                progress_callback,
                payload.module_name,
            )
            budget_stop: BudgetReached | None = None
            try:
                result = run_react.run_react_optimization(
                    signature_cls=signature_cls,
                    tools=tools,
                    schema_hashes=schema_hashes,
                    metric=training_metric,
                    train=splits.train,
                    val=splits.val,
                    test=splits.test,
                    student_lm=student_lm,
                    reflection_lm=reflection_lm,
                    max_metric_calls=max_metric_calls,
                    target_score=payload.target_score,
                    seed=seed,
                    num_threads=num_threads,
                    run_dir=trajectory_log_dir,
                    progress_callback=progress_callback,
                    timing_callbacks=stage_timings,
                )
            except BudgetReached as exc:
                if not isinstance(exc.result, dict) or "program_state" not in exc.result:
                    raise
                budget_stop, result = exc, exc.result

        overlay = result["tool_overlay"]
        program_artifact = self._persist_react_program(
            signature_cls=signature_cls,
            tools=tools,
            program_state=result["program_state"],
            overlay=overlay,
            tool_source=payload.tool_source,
            artifact_id=artifact_id,
        )

        baseline_scalar = result["baseline_scalar"]
        optimized_scalar = result["optimized_scalar"]
        metric_improvement = None if optimized_scalar is None else optimized_scalar - baseline_scalar

        if progress_callback:
            # baseline_evaluated is emitted early inside run_react_optimization
            # (before the GEPA loop) so the live score card renders mid-run;
            # here we only surface the optimized score after the best candidate
            # is scored on the held-out test set.
            progress_callback(PROGRESS_OPTIMIZED, {DETAIL_OPTIMIZED: optimized_scalar})

        split_counts = SplitCounts(train=len(splits.train), val=len(splits.val), test=len(splits.test))
        details: dict[str, Any] = {
            DETAIL_TRAIN: split_counts.train,
            DETAIL_VAL: split_counts.val,
            DETAIL_TEST: split_counts.test,
            DETAIL_BASELINE: baseline_scalar,
            DETAIL_OPTIMIZED: optimized_scalar,
        }
        optimization_metadata = {
            META_OPTIMIZER: payload.optimizer_name,
            META_OPTIMIZER_KWARGS: payload.optimizer_kwargs,
            META_COMPILE_KWARGS: payload.compile_kwargs,
            META_MODULE_KWARGS: payload.module_kwargs,
            META_MODEL_IDENTIFIER: payload.model_settings.normalized_identifier(),
            "max_metric_calls": max_metric_calls,
        }
        if payload.target_score is not None:
            target_reached = bool(result.get("target_score_reached"))
            optimization_metadata.update(
                {
                    "target_score": payload.target_score,
                    "target_score_reached": target_reached,
                    "stop_reason": "target_score" if target_reached else "metric_call_budget",
                }
            )

        runtime_seconds = (datetime.now(UTC) - run_start).total_seconds()
        num_lm_calls = lm_call_count(student_lm)
        _, avg_response_time_ms = gen_timing.summary()

        # Map per-example scalars into the standard EvalExampleResult shape so the
        # DataTab score overlay + Compare per-row diff render for react.
        # ``outputs`` carries the rollout's per-field answer (keyed by signature
        # output field, matching the evaluate-examples endpoint) so the data view
        # can show *what* the agent produced per example, not just the score;
        # ``pass`` mirrors the scalar-run convention (score > 0).
        output_fields = list(payload.column_mapping.outputs.keys())
        baseline_outputs = result.get("baseline_outputs_per_example") or []
        optimized_outputs = result.get("optimized_outputs_per_example") or []
        baseline_test_results = [
            {
                "index": i,
                "outputs": _react_prediction_outputs(
                    baseline_outputs[i] if i < len(baseline_outputs) else None,
                    output_fields,
                ),
                "score": float(s),
                "pass": float(s) > 0,
            }
            for i, s in enumerate(result.get("baseline_scalars_per_example") or [])
        ]
        optimized_test_results = [
            {
                "index": i,
                "outputs": _react_prediction_outputs(
                    optimized_outputs[i] if i < len(optimized_outputs) else None,
                    output_fields,
                ),
                "score": float(s),
                "pass": float(s) > 0,
            }
            for i, s in enumerate(result.get("optimized_scalars_per_example") or [])
        ]

        logger.info(
            "React run finished: baseline=%s optimized=%s delta=%s",
            baseline_scalar,
            optimized_scalar,
            metric_improvement,
        )
        response = RunResponse(
            module_name=payload.module_name,
            optimizer_name=payload.optimizer_name,
            metric_name=metric_identifier,
            split_counts=split_counts,
            baseline_test_metric=baseline_scalar,
            optimized_test_metric=optimized_scalar,
            metric_improvement=metric_improvement,
            optimization_metadata=optimization_metadata,
            details=details,
            program_artifact_path=program_artifact.path if program_artifact else None,
            program_artifact=program_artifact,
            runtime_seconds=runtime_seconds,
            num_lm_calls=num_lm_calls,
            total_tokens=total_tokens_from_history(student_lm, reflection_lm),
            usage_by_model=_usage_by_model_rows(student_lm, reflection_lm),
            avg_response_time_ms=avg_response_time_ms,
            # Generation-stage activity: student rollouts are bucketed into
            # baseline/training/evaluation via the timing_callbacks passed into
            # run_react_optimization. The reflection LM runs inside gepa.optimize
            # off the dspy callback path, so it stays untracked (None) and its
            # column is hidden by the activity panel.
            lm_activity=_build_lm_activity(gen_timing, None),
            baseline_test_results=baseline_test_results,
            optimized_test_results=optimized_test_results,
        )
        if budget_stop is not None:
            budget_stop.result = response
            raise budget_stop
        return response

    @staticmethod
    def _persist_react_program(
        *,
        signature_cls: type,
        tools: list[Any],
        program_state: dict[str, Any],
        overlay: dict[str, Any],
        tool_source: Any,
        artifact_id: str | None,
    ) -> ProgramArtifact | None:
        """Rebuild the optimized react program from state and persist it with its overlay.

        The optimized candidate is realized by loading ``program_state`` onto a
        fresh ``ReActV2`` shell (same signature + tool roster the seed used), so
        ``persist_program`` writes the canonical state JSON and extracts the
        prompt exactly as the scalar path does. The react tool overlay is then
        attached so a served bundle can reconstruct the tool surface: a
        ``live_mcp`` source persists ``{kind, mcp_url, tool_filter}`` (never the
        secret ``mcp_auth_header``), while a ``dataset_snapshot`` source persists
        ``{kind, tool_filter, tool_snapshot}`` so serve rebuilds the roster
        without the original dataset.

        Args:
            signature_cls: Signature the program was built around.
            tools: Tool roster resolved for the run.
            program_state: State dict returned by ``run_react_optimization``.
            overlay: ``tool_overlay`` dict from ``run_react_optimization``.
            tool_source: The originating ``ToolSource`` (or ``None``).
            artifact_id: Optional identifier carried into artifact storage.

        Returns:
            The persisted :class:`ProgramArtifact` with ``react_overlay`` set,
            or ``None`` when persistence produced no artifact.
        """
        program = dspy.ReActV2(signature_cls, tools=tools, max_iters=overlay["max_iters"])
        program.load_state(program_state)
        artifact = persist_program(program, artifact_id)
        if artifact is None:
            return None
        source_meta: dict[str, Any] = {}
        if tool_source is not None:
            source_meta["kind"] = tool_source.kind
            if tool_source.tool_filter is not None:
                source_meta["tool_filter"] = list(tool_source.tool_filter)
            if tool_source.kind == "live_mcp":
                if tool_source.mcp_url is not None:
                    source_meta["mcp_url"] = tool_source.mcp_url
                # mcp_auth_header is intentionally never persisted — it is a
                # secret; serve re-sources the live MCP with auth None.
            elif tool_source.kind == "dataset_snapshot":
                # Persist the resolved roster as snapshot specs so serve can
                # rebuild the tool surface without the original dataset.
                source_meta["tool_snapshot"] = [_tool_to_snapshot_spec(tool) for tool in tools]
        tool_names = overlay.get("tool_names")
        tool_severities = {tool.name: severity for tool in tools if (severity := tool_severity(tool)) is not None}
        artifact.react_overlay = ReactOverlay(
            tool_descriptions=dict(overlay["tool_descriptions"]),
            tool_arg_descriptions={name: dict(args) for name, args in overlay["tool_arg_descriptions"].items()},
            tool_schema_hashes=dict(overlay["tool_schema_hashes"]),
            max_iters=int(overlay["max_iters"]),
            tool_source=source_meta,
            tool_names=dict(tool_names) if tool_names else None,
            tool_severities=tool_severities,
        )
        return artifact

    def validate_payload(self, payload: RunRequest) -> None:
        """Validate a RunRequest without executing any optimization.

        User-authored signature and metric code is exec'd inside isolated
        subprocesses via ``safe_exec`` — this runs in the API/worker-engine
        process, so we cannot trust the exec to live here.

        Args:
            payload: The run request to validate.

        Raises:
            ServiceError: When any field fails validation (mapping mismatch,
                unknown module/optimizer, malformed kwargs, etc.).
        """
        logger.info(
            "Validating payload for module=%s optimizer=%s dataset_rows=%d",
            payload.module_name,
            payload.optimizer_name,
            len(payload.dataset),
        )
        _validate_target_score(payload.target_score, payload.optimizer_name, payload.split_fractions.val)

        if payload.module_name.lower() == WORKFLOW_MODULE_NAME:
            introspection = validate_workflow(payload.workflow)
            require_mapping_matches_signature(
                payload.column_mapping, introspection.input_fields, introspection.output_fields
            )
            require_mapping_columns_in_dataset(payload.column_mapping, payload.dataset)
            metric_info = validate_metric_code(payload.metric_code)
            _require_metric_compatible_with_optimizer(payload.optimizer_name, metric_info.param_names)
        else:
            intro = validate_signature_code(payload.signature_code)
            require_mapping_matches_signature(payload.column_mapping, intro.input_fields, intro.output_fields)
            require_mapping_columns_in_dataset(payload.column_mapping, payload.dataset)
            if payload.module_name.lower() == "react":
                self._validate_react_payload(payload)
            else:
                metric_info = validate_metric_code(payload.metric_code)
                _require_metric_compatible_with_optimizer(payload.optimizer_name, metric_info.param_names)
            self._get_module_factory(payload.module_name)
        optimizer_factory = self._get_optimizer_factory(payload.optimizer_name)
        validate_optimizer_signature(optimizer_factory, payload.optimizer_name)
        validate_optimizer_kwargs(optimizer_factory, payload.optimizer_kwargs, payload.optimizer_name)

    def _validate_react_payload(self, payload: RunRequest) -> None:
        """Validate the react-specific portion of a run payload.

        React is a generic module that scores rollouts with the same standard
        ``(gold, pred, trace, pred_name, pred_trace)`` metric the predict/cot
        path uses, so the 5-arg arity gate applies identically. The only
        react-specific requirement is a ``tool_source`` naming the live MCP
        roster (or the persisted snapshot) the rollouts execute against.

        Args:
            payload: The react run request to validate.

        Raises:
            ServiceError: When ``tool_source`` or ``metric_code`` is missing, or
                when the metric is arity-incompatible with the optimizer.
        """
        if payload.tool_source is None:
            raise ServiceError("react runs require tool_source.")
        if payload.metric_code is None:
            raise ServiceError("react runs require metric_code.")
        metric_info = validate_metric_code(payload.metric_code)
        _require_metric_compatible_with_optimizer(payload.optimizer_name, metric_info.param_names)

    def _get_module_factory(self, name: str) -> tuple[Callable[..., Any], bool]:
        """Resolve a module factory by name from registry or built-in resolver.

        Args:
            name: The module factory name to resolve.

        Returns:
            A tuple ``(factory, auto_signature)`` where ``auto_signature``
            is False for registry entries and True for resolver-provided ones.

        Raises:
            ServiceError: When ``name`` cannot be resolved.
        """
        try:
            factory = self.registry.get_module(name)
        except UnknownRegistrationError:
            try:
                resolved = resolve_module_factory(name)
            except ResolverError as exc:
                raise ServiceError(str(exc)) from exc
            logger.info(
                "Module '%s' not in ServiceRegistry; resolved via built-in resolver",
                name,
            )
            return resolved
        logger.info("Resolved module '%s' from ServiceRegistry (user-registered)", name)
        return factory, False

    def _get_optimizer_factory(self, name: str) -> Callable[..., Any]:
        """Resolve an optimizer factory by name from registry or built-in resolver.

        Args:
            name: The optimizer factory name to resolve.

        Returns:
            The resolved optimizer factory callable.

        Raises:
            ServiceError: When ``name`` cannot be resolved.
        """
        try:
            return self.registry.get_optimizer(name)
        except UnknownRegistrationError:
            try:
                return resolve_optimizer_factory(name)
            except ResolverError as exc:
                raise ServiceError(str(exc)) from exc
