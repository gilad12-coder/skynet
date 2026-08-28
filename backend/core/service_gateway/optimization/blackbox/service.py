"""Job entry points for black-box optimization.

``run_blackbox_optimization`` is what the worker subprocess calls for a
``blackbox`` job: split the cases, score the starting point on the held-out
split, run the strategy through a budgeted eval server, score the winner
on the same split, and apply the regression guard. On an agent target the
scorer is wrapped so every scorer run first launches the harness in its
own sandbox. ``validate_blackbox_payload`` and ``dry_run_scorer`` back the
submissions router.
"""

from __future__ import annotations

import logging
import tempfile
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import dspy

from ....config import settings
from ....constants import (
    DETAIL_BASELINE,
    DETAIL_OPTIMIZED,
    DETAIL_TEST,
    DETAIL_TRAIN,
    DETAIL_VAL,
    PROGRESS_BASELINE,
    PROGRESS_OPTIMIZED,
    PROGRESS_OPTIMIZER,
    PROGRESS_SPLITS_READY,
    TQDM_DESC_KEY,
    TQDM_N_KEY,
    TQDM_PERCENT_KEY,
    TQDM_TOTAL_KEY,
)
from ....exceptions import ServiceError
from ....models.blackbox import (
    BLACKBOX_STRATEGY_AUTO,
    BLACKBOX_TARGET_AGENT,
    BlackboxEngineCatalogResponse,
    BlackboxEngineInfo,
    BlackboxLaneResult,
    BlackboxRunRequest,
    BlackboxRunResponse,
    BlackboxTarget,
    ScorerDryRunRequest,
    ScorerDryRunResponse,
)
from ....models.common import SplitCounts
from ....models.results import ModelTokenUsage
from ...language_models import (
    build_language_model,
    lm_call_count,
    total_tokens_from_history,
    usage_by_model_from_history,
)
from ...safe_exec import probe_scorer, validate_scorer_code
from ..cost_ceiling import CostCeilingCallback
from ..data import split_examples
from .agent_eval import SandboxAgentScorer, agent_target_unavailable_reason, gateway_from_settings
from .auto import run_strategy
from .llm_helper import ScorerLLM, build_scorer_llm
from .protocol import Candidate, EngineContext, EvalServer, ScorerFn, Task
from .registry import ENGINES, EngineCapabilities, get_engine
from .sandbox import sandbox_runtime_from_settings
from .scorer import RemoteScorer, build_scorer

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[str, dict[str, Any]], None]

# Progress events per run are capped near this many so a 100k-run budget
# does not flood the job log.
_PROGRESS_EVENTS = 100


def engine_capabilities(target: BlackboxTarget) -> EngineCapabilities:
    """Describe what this deployment and ``target`` offer the engines.

    Args:
        target: The job's target.

    Returns:
        Capabilities for the registry: sandboxes per the settings, agent
        target per the job.
    """
    reason = agent_target_unavailable_reason(settings)
    return EngineCapabilities(
        sandbox=reason is None, agent_target=target.kind == BLACKBOX_TARGET_AGENT, sandbox_reason=reason
    )


def engine_catalog(target_kind: str) -> BlackboxEngineCatalogResponse:
    """List every engine with its availability for a job whose target is ``target_kind``.

    Args:
        target_kind: ``text`` or ``agent`` — the target the wizard is building.

    Returns:
        The catalog in registry order, each entry carrying the user-facing
        reason it cannot run here, when it cannot.
    """
    reason = agent_target_unavailable_reason(settings)
    caps = EngineCapabilities(
        sandbox=reason is None, agent_target=target_kind == BLACKBOX_TARGET_AGENT, sandbox_reason=reason
    )
    return BlackboxEngineCatalogResponse(
        target_kind=target_kind,
        sandbox_available=caps.sandbox,
        sandbox_reason=reason,
        engines=[
            BlackboxEngineInfo(
                id=spec.id,
                label=spec.label,
                description=spec.description,
                available=spec.available_for(caps),
                unavailable_reason=spec.unavailable_reason_for(caps),
                requires_agent_target=spec.requires_agent_target,
                supports_parts=spec.supports_parts,
            )
            for spec in ENGINES.values()
        ],
    )


def validate_blackbox_payload(payload: BlackboxRunRequest) -> None:
    """Reject a job before it is queued when it can never run.

    Args:
        payload: The submitted job.

    Raises:
        ServiceError: When the job has an agent target but this deployment
            cannot run agents, the chosen engine is unknown/unavailable, or
            the python scorer code does not load.
    """
    caps = engine_capabilities(payload.target)
    if caps.agent_target and not caps.sandbox:
        raise ServiceError(f"Agent targets cannot run on this deployment: {caps.sandbox_reason}")
    if payload.strategy.mode == "single":
        get_engine(str(payload.strategy.engine), caps)
    if payload.scorer.kind == "python":
        validate_scorer_code(str(payload.scorer.metric_code))


def _agent_scorer(scorer: ScorerFn, target: BlackboxTarget, *, job_id: str) -> SandboxAgentScorer:
    """Wrap ``scorer`` so every call runs the harness in a fresh sandbox first.

    Args:
        scorer: The user's scorer.
        target: The job's agent target.
        job_id: Tags the sandboxes with the job.

    Returns:
        The wrapped scorer.

    Raises:
        ServiceError: When this deployment has no sandbox runtime or gateway.
    """
    runtime = sandbox_runtime_from_settings(settings)
    gateway = gateway_from_settings(settings)
    if runtime is None or gateway is None:
        raise ServiceError(f"Agent targets cannot run on this deployment: {agent_target_unavailable_reason(settings)}")
    return SandboxAgentScorer(scorer, runtime=runtime, target=target, gateway=gateway, job_id=job_id)


def _score_holdout(
    scorer: ScorerFn, candidate: Candidate, holdout: list[Any] | None, *, label: str, concurrency: int = 1
) -> float | None:
    """Score ``candidate`` on the held-out cases, outside the optimization budget.

    Args:
        scorer: The run's scorer.
        candidate: The version to score.
        holdout: Held-out cases, or ``None`` in single-task mode.
        label: What the candidate is, for the error message.
        concurrency: How many cases to score at once (agent targets run one
            sandbox per case, so this is the number of sandboxes in flight).

    Returns:
        The mean held-out score, or ``None`` when there are no held-out cases.

    Raises:
        ServiceError: When the scorer fails on the candidate.
    """
    try:
        if holdout is None:
            return scorer(candidate, None)[0]
        if not holdout:
            return None
        workers = max(1, min(concurrency, len(holdout)))
        if workers == 1:
            scores = [scorer(candidate, case)[0] for case in holdout]
        else:
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="holdout") as pool:
                scores = [score for score, _ in pool.map(lambda case: scorer(candidate, case), holdout)]
        return sum(scores) / len(scores)
    except ServiceError:
        raise
    except Exception as exc:
        raise ServiceError(f"scorer failed on the {label}: {type(exc).__name__}: {exc}") from exc


def _progress_listener(progress_callback: ProgressCallback | None) -> Callable[[EvalServer, float], None]:
    """Build the eval-server listener that reports scorer-run progress.

    Args:
        progress_callback: The job's progress sink, if any.

    Returns:
        A listener for ``EvalServer(on_eval=...)``.
    """

    def on_eval(server: EvalServer, score: float) -> None:
        """Emit a throttled ``optimizer_progress`` event.

        Args:
            server: The run's root eval server.
            score: The score just recorded.
        """
        step = max(1, server.max_evals // _PROGRESS_EVENTS)
        if progress_callback is None or (server.used % step and server.used != server.max_evals):
            return
        progress_callback(
            PROGRESS_OPTIMIZER,
            {
                TQDM_DESC_KEY: "scorer runs",
                TQDM_TOTAL_KEY: server.max_evals,
                TQDM_N_KEY: server.used,
                TQDM_PERCENT_KEY: round(100.0 * server.used / server.max_evals, 1),
                "last_score": score,
                "best_score": server.best_score,
            },
        )

    return on_eval


def _reflection_caller(lm: dspy.LM) -> Callable[[str | list[dict[str, Any]]], str]:
    """Wrap the reflection model in the callable the engines drive.

    GEPA hands over chat messages instead of text when the scorer's side
    information carries rendered images (``Image``), so a vision-capable
    reflection model sees what it is improving.

    Args:
        lm: The reflection model.

    Returns:
        A callable returning the model's first completion as text.
    """

    def reflection_lm(prompt: str | list[dict[str, Any]]) -> str:
        """Call the reflection model on ``prompt`` and return its first completion.

        Args:
            prompt: The engine's reflection prompt — text, or chat messages
                with image parts.

        Returns:
            The completion text.
        """
        completions = lm(messages=prompt) if isinstance(prompt, list) else lm(prompt)
        return str(completions[0])

    return reflection_lm


def run_blackbox_optimization(
    payload: BlackboxRunRequest,
    *,
    artifact_id: str,
    progress_callback: ProgressCallback | None = None,
    gepa_log_dir_path: str | None = None,
) -> BlackboxRunResponse:
    """Run one black-box job end to end.

    Args:
        payload: The submitted job.
        artifact_id: Job id, used to name the workspace.
        progress_callback: The job's progress sink, if any.
        gepa_log_dir_path: Workspace for engine state; a temp dir when unset.

    Returns:
        The best version with baseline vs optimized held-out scores.

    Raises:
        ServiceError: When the scorer cannot be built, the job has an agent
            target this deployment cannot run, the scorer fails on the
            starting point, or no engine produced a version for a seedless job.
    """
    started = time.perf_counter()
    scorer_llm: ScorerLLM | None = build_scorer_llm(payload.scorer.model) if payload.scorer.model else None
    scorer = build_scorer(payload.scorer, llm=scorer_llm)
    target = payload.target
    caps = engine_capabilities(target)
    if caps.agent_target:
        scorer = _agent_scorer(scorer, target, job_id=artifact_id)
    concurrency = target.concurrency if caps.agent_target else 1
    cases = list(payload.cases or [])
    splits = split_examples(cases, payload.split_fractions, shuffle=payload.shuffle, seed=payload.seed)
    split_counts = SplitCounts(train=len(splits.train), val=len(splits.val), test=len(splits.test))
    if progress_callback is not None:
        progress_callback(
            PROGRESS_SPLITS_READY,
            {DETAIL_TRAIN: split_counts.train, DETAIL_VAL: split_counts.val, DETAIL_TEST: split_counts.test},
        )
    # Without cases the scorer judges the version on its own; with cases the
    # held-out split is the yardstick, falling back to val/train for tiny sets.
    holdout: list[Any] | None = (splits.test or splits.val or splits.train) if cases else None

    seed_candidate = payload.seed_candidate
    baseline = None
    if seed_candidate is not None:
        baseline = _score_holdout(scorer, seed_candidate, holdout, label="starting point", concurrency=concurrency)
        if progress_callback is not None:
            progress_callback(PROGRESS_BASELINE, {DETAIL_BASELINE: baseline})

    lm = build_language_model(payload.reflection_model_settings, disable_cache=True)
    reflection_lm = _reflection_caller(lm)

    server = EvalServer(scorer, max_evals=payload.budget.max_scorer_runs, on_eval=_progress_listener(progress_callback))
    task = Task(
        seed_candidate=seed_candidate,
        objective=payload.objective,
        background=payload.background,
        train_set=list(splits.train),
        val_set=list(splits.val),
    )
    ctx = EngineContext(
        reflection_lm=reflection_lm,
        run_dir=gepa_log_dir_path or tempfile.mkdtemp(prefix=f"skynet-blackbox-{artifact_id}-"),
        seed=payload.seed or 0,
        stop_at_score=payload.budget.stop_at_score,
        max_iterations=payload.budget.max_iterations,
        concurrency=concurrency,
        target_label=f"{target.harness} · {target.model}" if caps.agent_target else None,
    )
    # The scorer's own model calls are part of the run: they count toward
    # the credit ceiling and the usage the worker bills.
    lms = [lm] if scorer_llm is None else [lm, scorer_llm.lm]
    callbacks = [CostCeilingCallback(payload.max_cost_credits, *lms)] if payload.max_cost_credits is not None else []
    with dspy.context(callbacks=callbacks):
        result, lanes = run_strategy(payload.strategy, task, server, ctx, progress_callback, caps=caps)

    best_candidate = result.best_candidate
    optimized = _score_holdout(scorer, best_candidate, holdout, label="optimized version", concurrency=concurrency)
    regression_guard_applied = False
    if seed_candidate is not None and baseline is not None and optimized is not None and optimized < baseline:
        best_candidate, optimized, regression_guard_applied = seed_candidate, baseline, True
    if progress_callback is not None:
        progress_callback(PROGRESS_OPTIMIZED, {DETAIL_OPTIMIZED: optimized})

    usage = usage_by_model_from_history(*lms) or {}
    engine_used = str(result.metadata.get("engine") or payload.strategy.engine or BLACKBOX_STRATEGY_AUTO)
    return BlackboxRunResponse(
        optimizer_name=payload.strategy.engine or payload.strategy.mode,
        strategy_mode=payload.strategy.mode,
        engine_used=engine_used,
        split_counts=split_counts,
        baseline_test_metric=baseline,
        optimized_test_metric=optimized,
        metric_improvement=None if baseline is None or optimized is None else optimized - baseline,
        seed_candidate=seed_candidate,
        best_candidate=best_candidate,
        regression_guard_applied=regression_guard_applied,
        lanes=[
            BlackboxLaneResult(
                engine=lane.engine,
                phase=lane.phase,
                status=lane.status,
                best_score=lane.best_score,
                scorer_runs=lane.scorer_runs,
                error=lane.error,
            )
            for lane in lanes
        ],
        total_scorer_runs=server.used,
        runtime_seconds=time.perf_counter() - started,
        num_lm_calls=sum(lm_call_count(model) or 0 for model in lms),
        total_tokens=total_tokens_from_history(*lms),
        usage_by_model=[
            ModelTokenUsage(model=model, input_tokens=in_out[0], output_tokens=in_out[1])
            for model, in_out in usage.items()
        ],
        optimization_metadata={
            "strategy": payload.strategy.model_dump(),
            "budget": payload.budget.model_dump(),
            "target": target.model_dump(),
        },
        details={"optimizer_best_score": result.best_score, **result.metadata},
    )


def dry_run_scorer(request: ScorerDryRunRequest) -> ScorerDryRunResponse:
    """Score one candidate with a scorer spec, never raising.

    Python scorers run in the validation sandbox; remote scorers are called
    in-process (a single outbound request).

    Args:
        request: The scorer spec, candidate and optional case.

    Returns:
        The score and side information, or the error that stopped it, plus
        what the scorer's ``llm()`` calls consumed.
    """
    started = time.perf_counter()
    score: float | None = None
    side_info: dict[str, Any] = {}
    error: str | None = None
    usage: dict[str, tuple[int, int]] = {}
    try:
        if request.scorer.kind == "remote":
            remote = RemoteScorer(
                str(request.scorer.url), secret=request.scorer.secret, timeout_seconds=request.scorer.timeout_seconds
            )
            score, side_info = remote(request.candidate, request.case)
        else:
            probe = probe_scorer(
                scorer_code=str(request.scorer.metric_code),
                candidate=request.candidate,
                case=request.case,
                scorer_model=request.scorer.model.model_dump(mode="json") if request.scorer.model else None,
            )
            score, side_info, error, usage = probe.score, probe.side_info, probe.error, probe.usage_by_model
    except ServiceError as exc:
        error = str(exc)
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    return ScorerDryRunResponse(
        ok=error is None,
        score=score,
        side_info=side_info,
        error=error,
        elapsed_ms=(time.perf_counter() - started) * 1000.0,
        usage_by_model=[
            ModelTokenUsage(model=model, input_tokens=in_out[0], output_tokens=in_out[1])
            for model, in_out in usage.items()
        ],
    )
