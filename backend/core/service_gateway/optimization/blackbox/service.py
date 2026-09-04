"""Job entry points for black-box optimization.

``run_blackbox_optimization`` is what the worker subprocess calls for a
``blackbox`` job: split the cases, score the starting point on the held-out
split, run the strategy through a budgeted eval server, score the winner
on the same split, and apply the regression guard. On an agent target the
scorer is wrapped so every scorer run launches the harness in a private
workspace inside the run's managed sandbox. ``validate_blackbox_payload`` and ``dry_run_scorer`` back the
submissions router.
"""

from __future__ import annotations

import json
import logging
import tempfile
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import dspy

from ....billing.budgets import BudgetError
from ....billing.model_gateway import ROUTE_KEY
from ....billing.operation_pricing import UnpricedOperationError
from ....billing.pricing import (
    CREDIT_USD_VALUE,
    MARKUP,
    PLATFORM_FEE_FRACTION,
    credits_for_usage,
    raw_cost_usd,
    usages_from_breakdown,
)
from ....billing.protected_execution import runtime_cost_profile
from ....billing.runtime import UsagePendingError
from ....config import settings
from ....constants import (
    DETAIL_BASELINE,
    DETAIL_OPTIMIZED,
    DETAIL_TEST,
    DETAIL_TRAIN,
    DETAIL_VAL,
    PROGRESS_BASELINE,
    PROGRESS_EVALUATION_STARTED,
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
    BlackboxCandidateNode,
    BlackboxEngineCatalogResponse,
    BlackboxEngineInfo,
    BlackboxLaneResult,
    BlackboxProposerRuntimeInfo,
    BlackboxRunRequest,
    BlackboxRunResponse,
    BlackboxTarget,
    BlackboxVersion,
    ScorerDryRunRequest,
    ScorerDryRunResponse,
)
from ....models.common import SplitCounts
from ....models.results import LMActivity, LMStageStats, ModelTokenUsage
from ...language_models import (
    GepaRecoverySeedBoundary,
    build_language_model,
    canonical_model_id,
    lm_call_count,
    total_tokens_from_history,
    usage_by_model_from_history,
)
from ...safe_exec import validate_scorer_code
from ..budget_stop import BudgetReached
from ..cost_ceiling import CostCeilingCallback
from ..data import split_examples
from ..timing import STAGE_TRAINING
from .agent_eval import SandboxAgentScorer, agent_target_unavailable_reason, gateway_from_settings
from .agent_runs import PHASE_BASELINE, PHASE_FINAL, AgentRunRecorder, AgentRunSink, run_scope
from .auto import LaneOutcome, run_strategy
from .feedback import without_images
from .harness import GatewayConfig
from .native_runtime import NativeOptions, native_runtime_unavailable_reason
from .protocol import Candidate, EngineContext, EvalServer, Result, ScorerFn, Task, candidate_key
from .registry import ENGINES, EngineCapabilities, get_engine
from .runner import side_info_json_default
from .sandbox import current_sandbox_runtime, sandbox_runtime_from_settings
from .sandbox_scorer import probe_scorer
from .scorer import JobScorer, RemoteScorer, build_scorer
from .upstream import AUTO_ENGINES, GEPA_REVISION

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
    reason = None if current_sandbox_runtime() is not None else agent_target_unavailable_reason(settings)
    proposer_reason = native_runtime_unavailable_reason("vercel", settings)
    return EngineCapabilities(
        sandbox=reason is None,
        agent_target=target.kind == BLACKBOX_TARGET_AGENT,
        sandbox_reason=reason,
        proposer_available=proposer_reason is None,
        proposer_reason=proposer_reason,
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
    caps = engine_capabilities(BlackboxTarget())
    auto_reason = next(
        (ENGINES[name].unavailable_reason_for(caps) for name in AUTO_ENGINES if not ENGINES[name].available_for(caps)),
        None,
    )
    unavailable = native_runtime_unavailable_reason("vercel", settings)
    runtimes = [
        BlackboxProposerRuntimeInfo(
            id="vercel",
            available=unavailable is None,
            unavailable_reason=unavailable,
            cost=runtime_cost_profile(settings, "anything", "vercel"),
            checkpoint_restore_supported=unavailable is None,
            checkpoint_restore_reason=unavailable,
        )
    ]
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
                checkpoint_recovery_supported=spec.checkpoint_recovery_supported,
                checkpoint_recovery_reason=(
                    None
                    if spec.checkpoint_recovery_supported
                    else "This pinned engine does not expose a compatible checkpoint restore contract."
                ),
            )
            for spec in ENGINES.values()
        ],
        auto_engines=list(AUTO_ENGINES),
        auto_available=auto_reason is None,
        auto_unavailable_reason=auto_reason,
        auto_checkpoint_recovery_supported=False,
        auto_checkpoint_recovery_reason="The Auto recipe cannot restore its multi-engine search from one checkpoint.",
        proposer_runtimes=runtimes,
        upstream_revision=GEPA_REVISION,
    )


def validate_blackbox_payload(payload: BlackboxRunRequest, *, verify_scorer: bool = True) -> None:
    """Reject a job before it is queued when it can never run.

    Args:
        payload: The submitted job.
        verify_scorer: Run legacy scorer loading; protected callers verify
            executable code inside the managed runtime.

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
    else:
        for name in AUTO_ENGINES:
            get_engine(name, caps)
    needs_native = payload.strategy.mode != "single" or payload.strategy.engine in {"meta_harness", "autoresearch"}
    if needs_native:
        model = payload.reflection_model_settings
        if (
            model.temperature is not None
            or model.max_tokens is not None
            or model.base_url
            or any(key != ROUTE_KEY for key in model.extra)
        ):
            raise ServiceError(
                "Native proposers accept a model selection; custom sampling and routing settings are unsupported."
            )
        if payload.max_cost_credits is None:
            raise ServiceError("Set a total credit budget before starting an upstream agent proposer.")
        includes_meta_harness = payload.strategy.mode != "single" or payload.strategy.engine == "meta_harness"
        if includes_meta_harness and payload.cases:
            splits = split_examples(
                list(payload.cases), payload.split_fractions, shuffle=payload.shuffle, seed=payload.seed
            )
            if not splits.train:
                raise ServiceError("Meta-Harness and compositions containing it require at least one training case.")
    if payload.strategy.mode == "auto" and payload.budget.max_scorer_runs < 4:
        raise ServiceError("Auto needs at least four scorer runs.")
    if verify_scorer and payload.scorer.kind == "python":
        validate_scorer_code(str(payload.scorer.metric_code))


def _agent_scorer(
    scorer: ScorerFn,
    target: BlackboxTarget,
    *,
    job_id: str,
    progress_callback: ProgressCallback | None,
    agent_run_sink: AgentRunSink | None,
    target_route: dict[str, str] | None = None,
) -> SandboxAgentScorer:
    """Wrap ``scorer`` so every call runs the harness in a fresh sandbox first.

    Args:
        scorer: The user's scorer.
        target: The job's agent target.
        job_id: Tags the sandboxes with the job.
        progress_callback: The job's progress sink, told when each run starts and ends.
        agent_run_sink: Receives each run's full record and live transcript.
        target_route: Opaque parent route for the target model, when protected.

    Returns:
        The wrapped scorer.

    Raises:
        ServiceError: When this deployment has no sandbox runtime or gateway.
    """
    runtime = sandbox_runtime_from_settings(settings)
    if getattr(runtime, "protected", False) and not target_route:
        raise ServiceError("Protected agent targets require an opaque model route from the trusted parent.")
    gateway = (
        GatewayConfig(url=target_route["url"], api_key=target_route["token"])
        if target_route
        else gateway_from_settings(settings)
    )
    if runtime is None or gateway is None:
        raise ServiceError(f"Agent targets cannot run on this deployment: {agent_target_unavailable_reason(settings)}")
    recorder = AgentRunRecorder(
        progress_callback=progress_callback, run_sink=agent_run_sink, secrets=(gateway.api_key,)
    )
    return SandboxAgentScorer(scorer, runtime=runtime, target=target, gateway=gateway, job_id=job_id, recorder=recorder)


def _score_holdout(
    scorer: ScorerFn,
    candidate: Candidate,
    holdout: list[Any] | None,
    *,
    label: str,
    phase: str,
    concurrency: int = 1,
    server: EvalServer | None = None,
) -> float | None:
    """Score ``candidate`` on the held-out cases, outside the optimization budget.

    Args:
        scorer: The run's scorer.
        candidate: The version to score.
        holdout: Held-out cases, or ``None`` in single-task mode.
        label: What the candidate is, for the error message.
        phase: Which pass this is, for the agent run records: ``PHASE_BASELINE`` or ``PHASE_FINAL``.
        concurrency: How many cases to score at once (agent targets run one
            sandbox per case, so this is the number of sandboxes in flight).
        server: The run's eval server, when the held-out cases overlap the
            engine's own. A pair it already measured is reused rather than
            scored again, and a pair scored here is handed to it so the
            engine's first look at that pair costs no budget.

    Returns:
        The mean held-out score, or ``None`` when there are no held-out cases.

    Raises:
        ServiceError: When the scorer fails on the candidate.
    """

    def score_one(case: Any, position: int = 0) -> tuple[float, bool]:
        """Score ``candidate`` on one case, or reuse the engine's measurement.

        Args:
            case: The held-out case, or ``None`` in single-task mode.
            position: The case's 0-based position, naming it in the agent run records.

        Returns:
            The score and whether it was reused from the eval server.
        """
        known = None if server is None else server.recorded(candidate, case)
        if known is not None:
            return known, True
        with run_scope(phase, str(position)):
            score, side_info = scorer(candidate, case)
        if server is not None:
            server.prime(candidate, case, score, side_info)
        return score, False

    # Per-case heartbeats at DEBUG so they surface only in the Logs tab's
    # verbose view: these passes sit outside the eval server, so its own
    # heartbeat never fires for them. Normal mode keeps the single aggregate
    # metric; verbose adds the live per-case progress, as for DSPy test evals.
    def score_case(numbered: tuple[int, Any]) -> tuple[float, bool]:
        """Score ``candidate`` on one held-out case and log the result.

        Args:
            numbered: The case's 1-based position and the case itself.

        Returns:
            The score for that case and whether it was reused.
        """
        position, case = numbered
        score, reused = score_one(case, position - 1)
        origin = " (reused)" if reused else ""
        logger.debug("%s holdout eval %d/%d score=%.3f%s", label, position, len(holdout or ()), score, origin)
        return score, reused

    started = time.perf_counter()
    try:
        if holdout is None:
            logger.info("scoring the %s", label)
            score, _ = score_one(None)
            logger.info("%s scored %.3f in %.0fs", label, score, time.perf_counter() - started)
            return score
        if not holdout:
            return None
        workers = max(1, min(concurrency, len(holdout)))
        logger.info("scoring the %s on %d held-out case(s), %d at a time", label, len(holdout), workers)
        if workers == 1:
            scored = [score_case(numbered) for numbered in enumerate(holdout, start=1)]
        else:
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="holdout") as pool:
                scored = list(pool.map(score_case, enumerate(holdout, start=1)))
        scores = [score for score, _ in scored]
        reused = sum(1 for _, was_reused in scored if was_reused)
        mean = sum(scores) / len(scores)
        logger.info(
            "%s scored %.3f over %d case(s) (%d reused from the run) in %.0fs",
            label,
            mean,
            len(scores),
            reused,
            time.perf_counter() - started,
        )
        return mean
    except (BudgetError, UsagePendingError, UnpricedOperationError):
        raise
    except ServiceError as exc:
        raise ServiceError(f"scorer failed on the {label}: {exc}") from exc
    except Exception as exc:
        raise ServiceError(f"scorer failed on the {label}: {type(exc).__name__}: {exc}") from exc


# Side info persisted with the version history is capped so a run whose scorer
# returns renders for every version cannot bloat the job row; images are shed
# from the weakest versions first and the best version always keeps its own.
VERSION_SIDE_INFO_BYTE_CAP = 3_000_000


def _validation_scores(lanes: list[LaneOutcome]) -> dict[str, float]:
    """Collect each candidate's validation-set score from the lanes that recorded lineage.

    A candidate seen by more than one lane (the continue lane re-scores the
    winner's best as its seed) takes the later lane's score, matching the
    lane the Overview tree shows.

    Args:
        lanes: Every lane the strategy ran, in execution order.

    Returns:
        Validation score per :func:`candidate_key`; empty when no lane kept lineage.
    """
    scores: dict[str, float] = {}
    for lane in lanes:
        for node in lane.metadata.get("candidate_tree", []):
            if node.get("val_score") is not None:
                scores[candidate_key(node["candidate"])] = float(node["val_score"])
    return scores


def _version_history(server: EvalServer, val_scores: dict[str, float] | None = None) -> list[BlackboxVersion]:
    """Turn the eval server's records into the persisted version history.

    Args:
        server: The run's root eval server.
        val_scores: Validation-set score per :func:`candidate_key` from the
            engines that recorded lineage; a version with one shows it as its
            ``score`` instead of the running mean.

    Returns:
        One entry per distinct version in first-seen order, side info made
        JSON-safe and trimmed to :data:`VERSION_SIDE_INFO_BYTE_CAP` in total.
    """
    val_scores = val_scores or {}
    versions = [
        BlackboxVersion(
            candidate=record.candidate,
            score=val_scores.get(candidate_key(record.candidate), record.mean_score),
            mean_score=record.mean_score,
            evals=record.count,
            first_run=record.first_eval,
            side_info=json.loads(json.dumps(record.side_info, default=side_info_json_default)),
        )
        for record in server.history
    ]
    sizes = [len(json.dumps(version.side_info)) for version in versions]
    total = sum(sizes)
    weakest_first = sorted(range(len(versions)), key=lambda i: (versions[i].score or 0.0, versions[i].first_run))
    for i in weakest_first[:-1]:
        if total <= VERSION_SIDE_INFO_BYTE_CAP:
            break
        versions[i].side_info = without_images(versions[i].side_info)
        total -= sizes[i] - len(json.dumps(versions[i].side_info))
    return versions


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


def _reflection_caller(lm: dspy.LM) -> tuple[Callable[[str | list[dict[str, Any]]], str], list[float]]:
    """Wrap the reflection model in the callable the engines drive.

    GEPA hands over chat messages instead of text when the scorer's side
    information carries rendered images (``Image``), so a vision-capable
    reflection model sees what it is improving. Every call is timed here —
    the one choke point all engines go through — rather than via DSPy
    callbacks, which would not fire for non-``dspy.LM`` doubles and depend
    on context propagation into lane workers.

    Args:
        lm: The reflection model.

    Returns:
        A callable returning the model's first completion as text, and the
        list its per-call wall-clock durations (ms) accumulate into.
    """
    durations_ms: list[float] = []

    class ReflectionCaller:
        """Expose measured proposer spend to upstream's native cost stopper."""

        @property
        def total_cost(self) -> float:
            """Return the provider cost represented by the model's usage history."""
            return raw_cost_usd(usages_from_breakdown(usage_by_model_from_history(lm) or {}))

        def __call__(self, prompt: str | list[dict[str, Any]]) -> str:
            """Call the selected optimization model and record its duration.

            Args:
                prompt: Text or multimodal messages generated by upstream.

            Returns:
                The first completion text.
            """
            started = time.monotonic()
            try:
                completions = lm(messages=prompt) if isinstance(prompt, list) else lm(prompt)
            finally:
                durations_ms.append((time.monotonic() - started) * 1000.0)
            return str(completions[0])

    return ReflectionCaller(), durations_ms


def _reflection_activity(durations_ms: list[float]) -> LMActivity | None:
    """Fold reflection-call timings into the shared ``LMActivity`` shape.

    Black-box engines only drive the reflection model inside the
    optimization loop, so every call lands in the ``training`` stage and the
    ``generation`` matrix stays empty; the run view renders the same stage
    table as DSPy runs.

    Args:
        durations_ms: Wall-clock duration of each reflection call.

    Returns:
        A one-stage activity matrix, or ``None`` when the engine never
        called the reflection model.
    """
    if not durations_ms:
        return None
    avg_ms = round(sum(durations_ms) / len(durations_ms), 1)
    return LMActivity(reflection={STAGE_TRAINING: LMStageStats(calls=len(durations_ms), avg_response_time_ms=avg_ms)})


def run_blackbox_optimization(
    payload: BlackboxRunRequest,
    *,
    artifact_id: str,
    progress_callback: ProgressCallback | None = None,
    gepa_log_dir_path: str | None = None,
    agent_run_sink: AgentRunSink | None = None,
    target_route: dict[str, str] | None = None,
    evaluator_route: dict[str, str] | None = None,
) -> BlackboxRunResponse:
    """Run one black-box job end to end.

    Args:
        payload: The submitted job.
        artifact_id: Job id, used to name the workspace.
        progress_callback: The job's progress sink, if any.
        gepa_log_dir_path: Workspace for engine state; a temp dir when unset.
        agent_run_sink: Receives each sandboxed agent run's record and live transcript, if any.
        target_route: Opaque parent route for the optimized task model.
        evaluator_route: Opaque parent route for the selected external evaluator.

    Returns:
        The best version with baseline vs optimized held-out scores.

    Raises:
        ServiceError: When the scorer cannot be built, the job has an agent
            target this deployment cannot run, the scorer fails on the
            starting point, or no engine produced a version for a seedless job.
    """
    started = time.perf_counter()
    validate_blackbox_payload(
        payload,
        verify_scorer=payload.execution_budget_id is None and ROUTE_KEY not in payload.reflection_model_settings.extra,
    )
    protected = payload.execution_budget_id is not None or ROUTE_KEY in payload.reflection_model_settings.extra
    if payload.scorer.kind == "remote" and protected and not evaluator_route:
        raise ServiceError("Protected remote evaluation requires its parent-issued capability.")
    base_scorer = build_scorer(payload.scorer, job_id=artifact_id, protected_route=evaluator_route)
    try:
        return _run_job(
            payload,
            base_scorer,
            artifact_id=artifact_id,
            started=started,
            progress_callback=progress_callback,
            gepa_log_dir_path=gepa_log_dir_path,
            agent_run_sink=agent_run_sink,
            target_route=target_route,
        )
    except BudgetReached as exc:
        exc.evidence.setdefault("candidate_origin", None)
        exc.evidence.setdefault("final_evaluation_completed", False)
        exc.evidence.setdefault("final_evaluation_reason", "budget_reached")
        raise
    finally:
        try:
            base_scorer.close()
        except UsagePendingError:
            # The parent ledger retains this hold and publishes pending billing.
            # Do not replace an evaluated result or its original control signal.
            logger.info("Scorer sandbox final usage is pending reconciliation")


def _combined_usage(lms: list[Any], native: NativeOptions | None) -> dict[str, tuple[int, int]]:
    """Preserve each native model's identity when combining token accounting.

    Args:
        lms: Metered DSPy models and scorer ledgers.
        native: Shared native usage collector, if the recipe uses one.

    Returns:
        Model-specific input/output counts across both transports.
    """
    usage = dict(usage_by_model_from_history(*lms) or {})
    if native is not None:
        with native.usage_lock:
            snapshot = {model: dict(counts) for model, counts in native.usage_by_model.items()}
        for model, counts in snapshot.items():
            previous = usage.get(model, (0, 0))
            usage[model] = (
                previous[0] + counts.get("prompt_tokens", 0),
                previous[1] + counts.get("completion_tokens", 0),
            )
    return usage


def _run_job(
    payload: BlackboxRunRequest,
    base_scorer: JobScorer,
    *,
    artifact_id: str,
    started: float,
    progress_callback: ProgressCallback | None,
    gepa_log_dir_path: str | None,
    agent_run_sink: AgentRunSink | None,
    target_route: dict[str, str] | None = None,
) -> BlackboxRunResponse:
    """Run the job over an already-built scorer; see :func:`run_blackbox_optimization`.

    Args:
        payload: The submitted job.
        base_scorer: The job's scorer, closed by the caller.
        artifact_id: Job id, used to name the workspace.
        started: When the run began, for the elapsed time.
        progress_callback: The job's progress sink, if any.
        gepa_log_dir_path: Workspace for engine state; a temp dir when unset.
        agent_run_sink: Receives each sandboxed agent run's record and live transcript, if any.
        target_route: Opaque parent route for the optimized task model.

    Returns:
        The best version with baseline vs optimized held-out scores.
    """
    scorer: ScorerFn = base_scorer
    target = payload.target
    caps = engine_capabilities(target)
    if caps.agent_target:
        scorer = _agent_scorer(
            scorer,
            target,
            job_id=artifact_id,
            progress_callback=progress_callback,
            agent_run_sink=agent_run_sink,
            target_route=target_route,
        )
    concurrency = target.concurrency if caps.agent_target else 1
    cases = list(payload.cases or [])
    splits = split_examples(cases, payload.split_fractions, shuffle=payload.shuffle, seed=payload.seed)
    split_counts = SplitCounts(train=len(splits.train), val=len(splits.val), test=len(splits.test))
    if cases:
        logger.info(
            "%d case(s) split into %d train / %d val / %d test",
            len(cases),
            split_counts.train,
            split_counts.val,
            split_counts.test,
        )
    if progress_callback is not None:
        progress_callback(
            PROGRESS_SPLITS_READY,
            {DETAIL_TRAIN: split_counts.train, DETAIL_VAL: split_counts.val, DETAIL_TEST: split_counts.test},
        )
    # Without cases the scorer judges the version on its own; with cases the
    # held-out split is the yardstick, falling back to val/train for tiny sets.
    # Those fallbacks are the engine's own cases, so the held-out passes share
    # measurements with the eval server: the baseline feeds the engine's first
    # look at the seed, and the final pass reuses the engine's scores of the
    # winner instead of measuring the same pairs a second time.
    holdout: list[Any] | None = (splits.test or splits.val or splits.train) if cases else None
    server = EvalServer(scorer, max_evals=payload.budget.max_scorer_runs, on_eval=_progress_listener(progress_callback))

    seed_candidate = payload.seed_candidate
    baseline = None
    if seed_candidate is not None:
        baseline = _score_holdout(
            scorer,
            seed_candidate,
            holdout,
            label="starting point",
            phase=PHASE_BASELINE,
            concurrency=concurrency,
            server=server,
        )
        if progress_callback is not None:
            progress_callback(PROGRESS_BASELINE, {DETAIL_BASELINE: baseline})

    lm = build_language_model(payload.reflection_model_settings, disable_cache=True)
    reflection_lm, reflection_durations_ms = _reflection_caller(lm)
    token_budget = None
    if payload.max_cost_credits is not None:
        source_fraction = (
            PLATFORM_FEE_FRACTION if payload.reflection_model_settings.token_source == "byok" else 1.0
        )
        token_budget = payload.max_cost_credits * CREDIT_USD_VALUE / (MARKUP * source_fraction)
    needs_native = payload.strategy.mode != "single" or payload.strategy.engine in {"meta_harness", "autoresearch"}
    native_options = None
    if needs_native:
        budget_route = payload.reflection_model_settings.extra.get(ROUTE_KEY)
        validate_blackbox_payload(payload, verify_scorer=payload.execution_budget_id is None and not budget_route)
        gateway = (
            GatewayConfig(url=budget_route["url"], api_key=budget_route["token"])
            if budget_route
            else gateway_from_settings(settings)
        )
        if gateway is None or token_budget is None:
            raise ServiceError("The upstream proposer needs a gateway and a total credit budget.")
        active_runtime = current_sandbox_runtime()
        native_options = NativeOptions(
            runtime=payload.proposer_runtime,
            sandbox_runtime=active_runtime,
            model=budget_route["model"] if budget_route else payload.reflection_model_settings.name,
            gateway=gateway,
            budget_route=budget_route,
            max_token_cost=token_budget,
        )

    task = Task(
        seed_candidate=seed_candidate,
        objective=payload.objective,
        background=payload.background,
        train_set=list(splits.train),
        val_set=list(splits.val),
    )
    ctx = EngineContext(
        reflection_lm=reflection_lm,
        recovery_seed_boundary=(
            GepaRecoverySeedBoundary(lm)
            if payload.strategy.mode == "single" and payload.strategy.engine == "gepa"
            else None
        ),
        native_options=native_options,
        proposer_token_budget_usd=token_budget,
        run_dir=gepa_log_dir_path or tempfile.mkdtemp(prefix=f"skynet-blackbox-{artifact_id}-"),
        seed=payload.seed or 0,
        stop_at_score=payload.budget.stop_at_score,
        max_iterations=payload.budget.max_iterations,
        concurrency=concurrency,
        target_label=f"{target.harness} · {target.model}" if caps.agent_target else None,
        progress_callback=progress_callback,
    )
    # The scorer's own model calls are part of the run: they count toward
    # the credit ceiling and the usage the worker bills.
    lms = [lm] if base_scorer.usage is None else [lm, base_scorer.usage]
    callbacks = (
        [CostCeilingCallback(payload.max_cost_credits, *lms)]
        if payload.max_cost_credits is not None and payload.execution_budget_id is None
        else []
    )
    if callbacks:

        def check_budget() -> None:
            """Stop engine boundaries even when DSPy has caught a callback exception."""
            usage = usages_from_breakdown(_combined_usage(lms, native_options))
            if credits_for_usage(usage) >= payload.max_cost_credits:
                raise BudgetReached("The run's total credit budget has been reached.")

        ctx.check_budget = check_budget

        def remaining_cost_usd() -> float:
            """Return the run allowance after measured model usage across every lane."""
            spent = raw_cost_usd(usages_from_breakdown(_combined_usage(lms, native_options)))
            return max(0.0, float(token_budget) - spent)

        ctx.remaining_cost_usd = remaining_cost_usd
    iterations = f", up to {payload.budget.max_iterations} iteration(s)" if payload.budget.max_iterations else ""
    logger.info(
        "optimizing: mode=%s engine=%s, budget %d scorer run(s)%s",
        payload.strategy.mode,
        payload.strategy.engine or BLACKBOX_STRATEGY_AUTO,
        payload.budget.max_scorer_runs,
        iterations,
    )
    stop: BudgetReached | None = None
    try:
        with dspy.context(callbacks=callbacks):
            result, lanes = run_strategy(payload.strategy, task, server, ctx, progress_callback, caps=caps)
    except BudgetReached as exc:
        stop = exc
        result = exc.result
        lanes = exc.evidence.pop("_lanes", [])
        if result is None and seed_candidate is not None and baseline is not None:
            result = Result(
                best_candidate=seed_candidate,
                best_score=baseline,
                total_evals=server.used,
                metadata={"selection_source": "completed_baseline"},
            )
            exc.evidence.update(
                selection_scope="heldout",
                selection_score=baseline,
                candidate_origin="seed",
            )
        elif result is None:
            raise

    best_candidate = result.best_candidate
    logger.info("optimization finished after %d scorer run(s): best score %s", server.used, server.best_score)
    if progress_callback is not None:
        progress_callback(PROGRESS_EVALUATION_STARTED, {})
    optimized = None
    if stop is None:
        try:
            optimized = _score_holdout(
                scorer,
                best_candidate,
                holdout,
                label="optimized version",
                phase=PHASE_FINAL,
                concurrency=concurrency,
                server=server,
            )
        except BudgetReached as exc:
            stop = exc
    regression_guard_applied = False
    if seed_candidate is not None and baseline is not None and optimized is not None and optimized < baseline:
        logger.info("the optimized version scored below the starting point; keeping the starting point")
        best_candidate, optimized, regression_guard_applied = seed_candidate, baseline, True
    if progress_callback is not None:
        progress_callback(PROGRESS_OPTIMIZED, {DETAIL_OPTIMIZED: optimized})

    # The reflection LM reports the gateway transport id (``litellm_proxy/…``)
    # while the scorer ledger keys by catalog id; fold them so one model is one row.
    usage: dict[str, tuple[int, int]] = {}
    for model, in_out in _combined_usage(lms, native_options).items():
        key = canonical_model_id(model)
        prior = usage.get(key, (0, 0))
        usage[key] = (prior[0] + in_out[0], prior[1] + in_out[1])
    engine_used = str(result.metadata.get("engine") or payload.strategy.engine or BLACKBOX_STRATEGY_AUTO)
    candidate_tree = [BlackboxCandidateNode(**node) for node in result.metadata.pop("candidate_tree", [])]
    response = BlackboxRunResponse(
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
        versions=_version_history(server, _validation_scores(lanes)),
        candidate_tree=candidate_tree,
        total_scorer_runs=server.used,
        runtime_seconds=time.perf_counter() - started,
        num_lm_calls=sum(lm_call_count(model) or 0 for model in lms),
        lm_activity=_reflection_activity(reflection_durations_ms),
        total_tokens=sum(sum(in_out) for in_out in usage.values()) or total_tokens_from_history(*lms),
        usage_by_model=[
            ModelTokenUsage(model=model, input_tokens=in_out[0], output_tokens=in_out[1])
            for model, in_out in usage.items()
        ],
        optimization_metadata={
            "strategy": payload.strategy.model_dump(),
            "budget": payload.budget.model_dump(),
            "target": target.model_dump(),
            "proposer_runtime": payload.proposer_runtime,
            "upstream_revision": GEPA_REVISION,
        },
        details={"optimizer_best_score": result.best_score, **result.metadata},
    )
    if stop is not None:
        stop.result = response
        stop.evidence.update(
            candidate_origin="seed" if best_candidate == seed_candidate else "optimized",
            final_evaluation_completed=False,
            final_evaluation_reason="budget_reached",
            selection_score=result.best_score,
        )
        raise stop
    return response


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
                timeout_seconds=request.scorer.timeout_seconds,
                install_command=request.scorer.install_command,
            )
            score, side_info, error, usage = probe.score, probe.side_info, probe.error, probe.usage_by_model
    except (BudgetError, UsagePendingError, UnpricedOperationError):
        raise
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
