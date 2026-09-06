"""Background worker for DSPy optimization jobs.

Threaded worker that claims pending jobs from a shared job store and processes
them with configurable concurrency. Multi-pod safety is delegated to the store:
:meth:`JobStore.claim_next_job` performs an atomic claim (Postgres uses
``SELECT ... FOR UPDATE SKIP LOCKED``) so two pods running side by side cannot
race on the same row.
"""

from __future__ import annotations

import contextlib
import json
import logging
import multiprocessing as mp
import os
import queue
import shutil
import socket
import sys
import tempfile
import threading
import time
import traceback
from dataclasses import asdict
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from ..billing import (
    OpenRouterKeyProvisioner,
    ProviderKeyVault,
    StripeBillingService,
    inject_byok_connections,
    inject_provisioned_openrouter_key,
    payload_uses_token_source,
)
from ..billing.budgets import BudgetService
from ..billing.model_gateway import ModelGateway
from ..billing.pricing import ModelUsage
from ..billing.protected_credentials import (
    ProtectedCredentialVault,
    has_exposed_execution_credentials,
    resolve_execution_credentials,
)
from ..billing.protected_execution import bind_protected_sandbox
from ..billing.recovery_admission import validate_recovery_plan
from ..billing.runtime import BudgetRuntime, UsagePendingError
from ..config import settings
from ..constants import (
    OPTIMIZATION_TYPE_BLACKBOX,
    OPTIMIZATION_TYPE_GRID_SEARCH,
    OPTIMIZATION_TYPE_RUN,
    OPTIMIZATION_TYPE_TAGGING,
    PAYLOAD_OVERVIEW_ESTIMATED_HIGH,
    PAYLOAD_OVERVIEW_ESTIMATED_LOW,
    PAYLOAD_OVERVIEW_MODEL_NAME,
    PAYLOAD_OVERVIEW_NAME,
    PAYLOAD_OVERVIEW_OPTIMIZATION_TYPE,
    PAYLOAD_OVERVIEW_OPTIMIZER_NAME,
    PAYLOAD_OVERVIEW_TOKEN_SOURCE,
    PAYLOAD_OVERVIEW_TOKEN_SOURCES_BY_MODEL,
    PAYLOAD_OVERVIEW_USERNAME,
    PROGRESS_GRID_PAIR_COMPLETED,
    PROGRESS_GRID_PAIR_FAILED,
    TOKEN_SOURCE_BYOK,
    TOKEN_SOURCE_MANAGED,
)
from ..exceptions import INFRASTRUCTURE_INTERRUPTION, InfrastructureInterruptionError
from ..i18n import CANCELLATION_REASON, PAUSE_REASON
from ..models import BlackboxRunRequest, GridSearchRequest, GridSearchResponse, PairResult, RunRequest, SplitCounts
from ..models.results import TerminalOutcome
from ..notifications import notify_job_completed
from ..registry import ServiceRegistry
from ..service_gateway import DspyService
from ..service_gateway.embedding_pipeline import embed_finished_job
from ..service_gateway.optimization.blackbox.sandbox import sandbox_runtime_from_settings
from ..service_gateway.optimization.blackbox.service import validate_blackbox_payload
from ..service_gateway.optimization.core import _merge_usage_rows
from ..service_gateway.optimization.trajectory import GEPA_STATE_FILENAME, GRID_PAIR_RESULT_FILENAME
from ..storage import JobStore
from ..telemetry import record_server_event
from .budget_probe import (
    STOP_REASON_BUDGET_PROJECTED,
    planned_calls_from_progress,
    probe_ready,
    project_total_credits,
    projection_evidence,
)
from .checkpoint_compat import (
    CheckpointCompatibilityError,
    checkpoint_manifest,
    evaluated_incumbent_from_progress,
    supports_checkpoint,
    validate_checkpoint,
)
from .constants import EVENT_AGENT_RUN, EVENT_ERROR, EVENT_LOG, EVENT_PROGRESS, EVENT_RESULT, EVENT_TERMINAL
from .memory_guard import memory_usage_fraction
from .subprocess_runner import run_service_in_subprocess, set_fork_service
from .tagging_job import TaggingAutotagPayload, run_autotag_job
from .vercel_dspy import run_vercel_dspy

logger = logging.getLogger(__name__)

# Sentinel pair index for the grid "envelope" row a distributed pair child
# stores alongside its PairResult: split counts and metric/module names the
# finalizer needs but individual pair results don't carry. Real pair indices
# are >= 0, and the resume path ignores out-of-range keys, so the sentinel can
# never collide with a pair.
GRID_ENVELOPE_PAIR_INDEX = -1

# A pair child is terminal only in one of these; ``paused`` never applies to
# grid children (grids are not pausable).
_PAIR_TERMINAL_STATUSES = ("success", "failed", "cancelled", "stopped")


def _usages_from_result(result_dict: dict[str, Any] | None, fallback_model: str | None) -> list[ModelUsage]:
    """Build per-model :class:`ModelUsage` from a serialized run/grid result.

    Reads the result's ``usage_by_model`` rows (stamped by the optimizer from the
    LM histories). A result that predates the per-model split — or an in-flight
    job spanning the deploy — has no rows; it falls back to pricing the whole
    ``total_tokens`` on ``fallback_model``, attributing it to input (the cheaper
    side) so the legacy path under-charges rather than over-charges.

    Args:
        result_dict: The serialized run/grid result, or ``None``.
        fallback_model: Model id to price a rows-less legacy result against.

    Returns:
        Per-model usage rows with positive token counts, or ``[]`` when the run
        reported no usage at all.
    """
    if not isinstance(result_dict, dict):
        return []
    usages: list[ModelUsage] = []
    rows = result_dict.get("usage_by_model")
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            model = row.get("model")
            in_tokens = row.get("input_tokens", 0)
            out_tokens = row.get("output_tokens", 0)
            if not isinstance(model, str) or not isinstance(in_tokens, int) or not isinstance(out_tokens, int):
                continue
            if in_tokens > 0 or out_tokens > 0:
                usages.append(ModelUsage(model=model, input_tokens=in_tokens, output_tokens=out_tokens))
    if usages:
        return usages
    total_tokens = result_dict.get("total_tokens")
    if isinstance(total_tokens, int) and total_tokens > 0:
        return [ModelUsage(model=fallback_model or "unknown", input_tokens=total_tokens, output_tokens=0)]
    return []


class CancellationError(Exception):
    """Raised inside a job thread when the job is cancelled by the user."""


class JobStalledError(InfrastructureInterruptionError):
    """Identify a bounded supervisor stall as a temporary infrastructure interruption."""


class WorkerShutdownError(InfrastructureInterruptionError):
    """Identify a worker shutdown that interrupted an already-running job."""


def _raise_if_cancelled(cancel_event: threading.Event | None, optimization_id: str) -> None:
    """Raise ``CancellationError`` when the caller's cancel flag is set; ``None`` is treated as not cancelled.

    Args:
        cancel_event: The cooperative cancel flag (``None`` skips the check).
        optimization_id: ID embedded in the raised error message.

    Raises:
        CancellationError: When ``cancel_event`` is set.
    """
    if cancel_event and cancel_event.is_set():
        raise CancellationError(f"Optimization {optimization_id} cancelled by user")


class BackgroundWorker:
    """Multi-threaded worker that polls a job store and runs optimization jobs.

    Each worker thread calls ``_worker_loop``, which polls ``_pending_jobs`` and
    dispatches work to ``_process_job``.  Jobs run inside a child process created
    with the configured multiprocessing start method (fork or spawn); events
    (progress, logs, result, error) are streamed back through a ``mp.Queue``
    and persisted by ``_drain_subprocess_events``.  Cancellation is cooperative:
    each job has a ``threading.Event``; ``_raise_if_cancelled`` polls it between
    subprocess join timeouts so the child can be terminated promptly on request.
    """

    def __init__(
        self,
        job_store: JobStore,
        num_workers: int = 2,
        poll_interval: float = 2.0,
        service: DspyService | None = None,
        pod_name: str | None = None,
        lease_seconds: float = 60.0,
        _allow_unprotected_test_execution: bool = False,
    ) -> None:
        """Initialize the worker with a job store and concurrency settings.

        Args:
            job_store: Backend used to load and persist job state.
            num_workers: Number of worker threads to spawn on ``start``.
            poll_interval: Seconds the loop sleeps between empty-queue checks.
            service: Optional pre-built ``DspyService``; one is built lazily otherwise.
            pod_name: Identifier written to ``jobs.claimed_by`` so claim
                ownership survives a process restart and is observable across
                the fleet. Defaults to ``$POD_NAME`` (set via the Kubernetes
                downward API in the Helm chart) or, failing that, the
                hostname.
            lease_seconds: Initial lease window granted by ``claim_next_job``.
                The worker loop renews it via ``_touch_activity`` on every
                cancel-poll tick; should comfortably exceed
                ``cancel_poll_interval × 3``.
            _allow_unprotected_test_execution: Permit direct child-process
                execution only for isolated worker unit tests. Production
                callers must keep the default managed-sandbox requirement.
        """
        self._job_store = job_store
        self._num_workers = num_workers
        self._poll_interval = poll_interval
        self._running = False
        self._threads: list[threading.Thread] = []
        self._service: DspyService | None = service
        self._pod_name = pod_name or os.environ.get("POD_NAME") or socket.gethostname()
        self._lease_seconds = max(float(lease_seconds), 5.0)
        self._allow_unprotected_test_execution = _allow_unprotected_test_execution

        # In-memory queue is retained as a backwards-compat seam: tests and
        # any legacy single-pod callers can still call ``enqueue_job`` directly
        # and the worker loop will drain that list before falling back to the
        # shared ``claim_next_job`` queue.
        self._pending_jobs: list[str] = []
        self._processing_jobs: set[str] = set()
        self._claimed_jobs: set[str] = set()
        self._cancel_events: dict[str, threading.Event] = {}
        self._queue_lock = threading.Lock()
        poll_raw = str(settings.cancel_poll_interval)
        try:
            self._cancel_poll_interval = max(float(poll_raw), 0.05)
        except ValueError:
            logger.warning("Invalid CANCEL_POLL_INTERVAL=%r; using 1.0", poll_raw)
            self._cancel_poll_interval = 1.0
        self._mp_ctx = self._resolve_mp_context()
        self._mp_start_method = self._mp_ctx.get_start_method()

        self._last_activity: dict[int, float] = {}
        self._activity_lock = threading.Lock()
        # Per-thread current job for lease heartbeats.
        self._thread_current_job: dict[int, str] = {}
        # Rate-limits the memory-pressure deferral warning across all threads.
        self._admission_last_log = 0.0

    @staticmethod
    def _resolve_mp_context() -> mp.context.BaseContext:
        """Resolve multiprocessing start method from JOB_RUN_START_METHOD, falling back to system default.

        Returns:
            A multiprocessing context honoring the configured start method.
        """
        requested = settings.job_run_start_method
        try:
            ctx = mp.get_context(requested)
        except ValueError:
            logger.warning(
                "Invalid JOB_RUN_START_METHOD=%r; using default start method.",
                requested,
            )
            ctx = mp.get_context()
        if ctx.get_start_method() != "fork":
            logger.warning(
                "Multiprocessing start method is '%s'. "
                "Custom registry callables may not be available in subprocess jobs.",
                ctx.get_start_method(),
            )
        return ctx

    def _get_service(self) -> DspyService:
        """Get or lazily build the shared DspyService instance.

        Returns:
            The shared ``DspyService`` used by all worker threads.
        """
        if self._service is None:
            self._service = DspyService(ServiceRegistry())
        return self._service

    def enqueue_job(self, optimization_id: str) -> None:
        """Register a cancel event for ``optimization_id`` and pre-stage it locally.

        With the DB-backed claim queue, the canonical hand-off is the row's
        ``status='pending'`` flag, which any pod can claim on its next poll
        tick. The local in-memory queue is kept only so tests and legacy
        single-pod callers continue to work — the worker loop drains it
        before falling back to ``claim_next_job``.

        Args:
            optimization_id: ID of the job to register.
        """
        with self._queue_lock:
            self._cancel_events.setdefault(optimization_id, threading.Event())
            if optimization_id not in self._pending_jobs and optimization_id not in self._processing_jobs:
                self._pending_jobs.append(optimization_id)
                logger.info("Optimization %s enqueued (local hint)", optimization_id)

    def submit_job(
        self,
        optimization_id: str,
        payload: RunRequest | GridSearchRequest | BlackboxRunRequest | TaggingAutotagPayload,
        payload_dump: dict[str, Any] | None = None,
    ) -> None:
        """Persist payload to the job store; rely on DB claim for pickup.

        Writes the payload onto the existing ``pending`` row and registers a
        cancel event; the next worker tick (on this pod or a peer) picks the
        job up via :meth:`JobStore.claim_next_job`. Latency-to-pickup is
        bounded by the worker poll interval.

        Args:
            optimization_id: ID of the job being submitted.
            payload: Pydantic model whose ``model_dump`` is stored on the job.
            payload_dump: Optional pre-built ``model_dump(mode="json",
                by_alias=True)`` of ``payload``. The submit routers already
                serialize it for the storage-quota gate; passing it here
                avoids a second full copy of the dataset per request.
        """
        if payload_dump is None:
            payload_dump = payload.model_dump(mode="json", by_alias=True)
        self._job_store.update_job(
            optimization_id,
            payload=payload_dump,
            code_version=settings.code_version,
        )
        with self._queue_lock:
            self._cancel_events[optimization_id] = threading.Event()
        logger.info("Optimization %s submitted (awaiting claim)", optimization_id)

    def _claim_job_from_store(self) -> str | None:
        """Try to claim a pending job from the shared store.

        Returns:
            The claimed optimization ID, or ``None`` when no work is available.
        """
        try:
            record = self._job_store.claim_next_job(self._pod_name, self._lease_seconds)
        except AttributeError:
            # Older JobStore implementation without claim support — fall back
            # to legacy in-memory only behaviour.
            return None
        except Exception:
            logger.exception("claim_next_job raised; backing off")
            return None
        if record is None:
            return None
        optimization_id = record.get("optimization_id") if isinstance(record, dict) else None
        if not optimization_id:
            return None
        with self._queue_lock:
            self._cancel_events.setdefault(optimization_id, threading.Event())
            self._processing_jobs.add(optimization_id)
            self._claimed_jobs.add(optimization_id)
        return optimization_id

    def _update_owned_job(self, optimization_id: str, generation: int | None, **fields: Any) -> None:
        """Advance an active job only while this worker owns its publication generation.

        Args:
            optimization_id: Claimed job identity.
            generation: Generation captured at claim time.
            **fields: Status and timing fields to update.

        Raises:
            CancellationError: When cancellation or another owner has already won.
        """
        cas = getattr(self._job_store, "update_job_if_status", None)
        if generation is not None and callable(cas):
            if not cas(optimization_id, ("pending", "validating", "running"), expected_generation=generation, **fields):
                raise CancellationError("The execution generation is no longer active.")
        else:
            self._job_store.update_job(optimization_id, **fields)

    def _persisted_status(self, optimization_id: str) -> str | None:
        """Read a job's stored status without materializing its payload or result.

        Prefers the store's skinny status projection; store doubles without it
        fall back to the full row read.

        Args:
            optimization_id: ID of the job to read.

        Returns:
            The persisted status string, or ``None`` when the row has none.

        Raises:
            KeyError: When the job no longer exists.
        """
        read_status = getattr(self._job_store, "get_job_status_fields", None)
        if callable(read_status):
            return read_status(optimization_id).get("status")
        return self._job_store.get_job(optimization_id).get("status")

    def _raise_if_interrupted(
        self,
        cancel_event: threading.Event | None,
        optimization_id: str,
    ) -> None:
        """Distinguish user cancellation from shutdown of active worker execution.

        Args:
            cancel_event: Cooperative flag shared with cancellation and worker stop.
            optimization_id: Existing run identity.

        Raises:
            WorkerShutdownError: When worker shutdown interrupts an active job.
            CancellationError: When the user or another owner ended the run.
        """
        if cancel_event is None or not cancel_event.is_set():
            return
        status = None
        with contextlib.suppress(Exception):
            status = self._persisted_status(optimization_id)
        if not self._running and status in {"pending", "validating", "running"}:
            raise WorkerShutdownError("Optimization was interrupted by worker shutdown.")
        _raise_if_cancelled(cancel_event, optimization_id)

    def _recover_temporary_interruption(
        self,
        optimization_id: str,
        *,
        generation: int | None,
        attempts: int,
    ) -> tuple[bool, str]:
        """Attempt one checkpoint recovery under the same fenced budget.

        Args:
            optimization_id: Existing interrupted run.
            generation: Publication generation owned by the interrupted worker.
            attempts: Persisted recovery-attempt count before this interruption.

        Returns:
            Whether recovery owns the lifecycle now, plus a precise unavailable reason.
        """
        if attempts + 1 >= settings.job_max_attempts:
            return False, "The interruption recovery attempt limit has been reached."
        requeue = getattr(self._job_store, "requeue_for_resume", None)
        engine = getattr(self._job_store, "engine", None)
        if not callable(requeue) or engine is None:
            return False, "This worker cannot establish authoritative checkpoint recovery admission."
        try:
            resumed_attempt = requeue(
                optimization_id,
                automatic=True,
                expected_generation=generation,
                budget_service=BudgetService(engine=engine),
            )
        except CheckpointCompatibilityError as error:
            return False, str(error)
        refreshed = self._job_store.get_job(optimization_id)
        recovery = refreshed.get("recovery")
        handled = resumed_attempt is not None or (
            isinstance(recovery, dict) and recovery.get("state") in {"recovering", "unavailable"}
        )
        if not handled:
            return False, "Another lifecycle change prevented automatic checkpoint recovery."
        logger.warning(
            "Optimization %s infrastructure interruption; recovery %s",
            optimization_id,
            f"queued at attempt {resumed_attempt}"
            if resumed_attempt is not None
            else str((recovery or {}).get("phase") or refreshed.get("status") or "pending"),
        )
        return True, ""

    def _active_recovery_plan(self, optimization_id: str, job: dict[str, Any]) -> dict[str, Any] | None:
        """Reload the single checkpoint plan selected by automatic recovery.

        Args:
            optimization_id: Existing run identity.
            job: Claimed persisted job row.

        Returns:
            Validated recovery admission evidence, or None for an initial/manual run.

        Raises:
            CheckpointCompatibilityError: When selected recovery evidence disappeared or changed.
        """
        recovery = job.get("recovery")
        if not isinstance(recovery, dict) or recovery.get("phase") != "resuming":
            return None
        checkpoints = self._job_store.list_gepa_checkpoints(optimization_id)
        if len(checkpoints) != 1:
            raise CheckpointCompatibilityError("Automatic recovery no longer has one independently bounded checkpoint.")
        manifest = checkpoints[0].manifest or {}
        if recovery.get("checkpoint_revision") != manifest.get("checkpoint_sha256"):
            raise CheckpointCompatibilityError("The checkpoint selected for recovery changed before execution.")
        return validate_recovery_plan(manifest.get("recovery_admission"), manifest)

    def _get_next_job(self) -> str | None:
        """Return the next claimable job, picking up through the atomic claim.

        ``_pending_jobs`` is only a low-latency *hint* that work may exist
        (populated by the in-process ``enqueue_job`` path and the startup
        recovery backfill). It must never be the pickup itself: popping a hinted
        id and returning it directly skips the DB claim, so a second worker
        thread can re-claim the same still-``pending`` row via
        :meth:`JobStore.claim_next_job` and spawn the job twice — the boot-race
        double-spawn that hit any job left pending across a restart. When the
        store supports atomic claims we drain the hint only to skip the idle
        sleep and then pick up through ``claim_next_job`` (which owns the row
        exclusively via ``FOR UPDATE SKIP LOCKED``). A claim-less legacy/test
        store has no such path, so there we honour the hinted id directly —
        single-pod, no race.

        Returns:
            The optimization ID to process next, or ``None`` when idle.
        """
        if self._defer_for_memory_pressure():
            return None
        with self._queue_lock:
            hinted = self._pending_jobs.pop(0) if self._pending_jobs else None
        if hinted is not None and not hasattr(self._job_store, "claim_next_job"):
            with self._queue_lock:
                self._processing_jobs.add(hinted)
            return hinted
        return self._claim_job_from_store()

    def _defer_for_memory_pressure(self) -> bool:
        """Report whether claiming a new job should wait for memory headroom.

        Running jobs are never touched — this only keeps an idle worker thread
        from adding one more forked child to a pod already near its cgroup
        limit. The row waits in the shared queue for this pod (or a peer) to
        free up, instead of the whole container being OOM-killed mid-run.

        Returns:
            True when container memory usage exceeds the admission threshold.
        """
        threshold = settings.job_admission_max_memory_fraction
        if threshold <= 0:
            return False
        usage = memory_usage_fraction()
        if usage is None or usage < threshold:
            return False
        now = time.monotonic()
        with self._activity_lock:
            should_log = now - self._admission_last_log >= 60.0
            if should_log:
                self._admission_last_log = now
        if should_log:
            logger.warning(
                "Deferring job claim: container memory at %.0f%% of limit (threshold %.0f%%)",
                usage * 100,
                threshold * 100,
            )
        return True

    def _mark_job_done(self, optimization_id: str) -> None:
        """Release the claim and clean up per-job worker state.

        Args:
            optimization_id: ID of the job that just finished.
        """
        was_claimed = False
        with self._queue_lock:
            self._processing_jobs.discard(optimization_id)
            self._cancel_events.pop(optimization_id, None)
            if optimization_id in self._claimed_jobs:
                self._claimed_jobs.discard(optimization_id)
                was_claimed = True
        if was_claimed:
            try:
                self._job_store.release_job(optimization_id, self._pod_name)
            except AttributeError:
                pass
            except Exception:
                logger.exception("release_job failed for %s", optimization_id)

    def _worker_loop(self, worker_id: int) -> None:
        """Poll for jobs and process them until stopped.

        Args:
            worker_id: Index identifying this thread for logging.
        """
        logger.info("Worker %d started (pod=%s)", worker_id, self._pod_name)

        # Top-level guard: a fatal exception inside the loop must not let
        # the worker thread die silently — health checks would still report
        # the thread alive while no jobs got picked up.
        try:
            idle_cycles = 0
            self._touch_activity(worker_id)
            while self._running:
                optimization_id = self._get_next_job()

                if optimization_id is None:
                    time.sleep(self._poll_interval)
                    idle_cycles += 1
                    # Heartbeat every ~5 min so observability dashboards
                    # can distinguish "idle but alive" from "stuck". Worker 0
                    # also backstops distributed grids whose last finisher
                    # died before assembling the parent result.
                    if idle_cycles % 150 == 0:
                        logger.info("Worker %d heartbeat, idle cycles: %d", worker_id, idle_cycles)
                        self._touch_activity(worker_id)
                        if worker_id == 0:
                            self._finalize_stuck_grids()
                    continue

                idle_cycles = 0
                with self._activity_lock:
                    self._thread_current_job[worker_id] = optimization_id
                self._touch_activity(worker_id)
                try:
                    self._process_job(optimization_id, worker_id)
                except Exception:  # isolation boundary: one bad job must not kill the worker thread
                    logger.exception("Worker %d failed processing job %s", worker_id, optimization_id)
                finally:
                    with self._activity_lock:
                        self._thread_current_job.pop(worker_id, None)
                    self._mark_job_done(optimization_id)
        except Exception:
            logger.exception("Worker %d died unexpectedly", worker_id)

        logger.info("Worker %d stopped", worker_id)

    def _process_job(self, optimization_id: str, worker_id: int) -> None:
        """Run one optimization job to completion, handling all error and cancel paths.

        Loads the payload from the job store, validates its schema, dispatches it
        through the selected execution boundary, and drains the event queue until
        the child exits. The ``BaseException`` handler at the bottom covers cancellation,
        shutdown signals (``SystemExit``/``KeyboardInterrupt``), and ordinary errors —
        each path writes the correct terminal status and fires a notification.
        Shutdown signals are re-raised after cleanup so the process can exit;
        every other exception is translated into a ``failed``/``cancelled``
        terminal status instead of propagating.

        Args:
            optimization_id: ID of the job to process.
            worker_id: Index of the calling worker thread (for activity tracking).

        Raises:
            SystemExit: Propagated after status is written, to allow shutdown.
            KeyboardInterrupt: Propagated after status is written.
        """
        logger.info("Processing job %s", optimization_id)

        overview: dict[str, Any] = {}  # pre-init so BaseException handler has a defined value even if early error
        # Pair-child context, resolved after the payload loads; the exception
        # handler reads these to route notifications and finalize the parent.
        pair_parent_id: str | None = None
        pair_index_val = 0
        execution_generation: int | None = None
        execution_budget_snapshot: dict[str, Any] | None = None
        recovery_attempts = 0

        with self._queue_lock:
            cancel_event = self._cancel_events.get(optimization_id)

        try:
            self._raise_if_interrupted(cancel_event, optimization_id)

            job_data = self._job_store.get_job(optimization_id)
            execution_generation = job_data.get("execution_generation")
            recovery_attempts = int(job_data.get("attempts") or 0)
            payload_dict = job_data.get("payload")

            if not payload_dict:
                raise ValueError(f"Optimization {optimization_id} has no payload")
            recovery_plan = self._active_recovery_plan(optimization_id, job_data)

            overview = job_data.get("payload_overview", {})
            if isinstance(overview, str):
                try:
                    overview = json.loads(overview)
                except (json.JSONDecodeError, TypeError):
                    overview = {}
            if not isinstance(overview, dict):
                overview = {}
            optimization_type = overview.get(PAYLOAD_OVERVIEW_OPTIMIZATION_TYPE, OPTIMIZATION_TYPE_RUN)

            if optimization_type == OPTIMIZATION_TYPE_TAGGING:
                self._process_tagging_job(optimization_id, worker_id, cancel_event, payload_dict)
                return

            pair_parent_id = job_data.get("parent_optimization_id")
            pair_index_val = int(job_data.get("pair_index") or 0)

            if optimization_type == OPTIMIZATION_TYPE_GRID_SEARCH and pair_parent_id is not None:
                # Distributed pair child: its stored payload is a tiny
                # reference; the real single-pair payload (dataset included)
                # derives from the parent row at claim time.
                derived = self._derive_pair_payload(pair_parent_id, pair_index_val)
                if derived is None:
                    # Parent deleted or no longer running (cancelled, failed,
                    # already finalized): this pair must not spend anything.
                    with contextlib.suppress(Exception):
                        self._job_store.update_job(
                            optimization_id,
                            status="cancelled",
                            message="Parent grid is no longer running",
                            completed_at=datetime.now(UTC).isoformat(),
                        )
                    self._maybe_finalize_grid(pair_parent_id)
                    return
                payload_dict, grid_payload = derived
            elif optimization_type == OPTIMIZATION_TYPE_GRID_SEARCH:
                grid_payload = GridSearchRequest.model_validate(payload_dict)
                if self._should_distribute_grid(optimization_id, grid_payload):
                    self._fan_out_grid(optimization_id, grid_payload, overview)
                    return
            elif optimization_type == OPTIMIZATION_TYPE_BLACKBOX:
                blackbox_payload = BlackboxRunRequest.model_validate(payload_dict)
            else:
                run_payload = RunRequest.model_validate(payload_dict)

            self._update_owned_job(
                optimization_id,
                execution_generation,
                status="validating",
                message="Validating payload",
            )

            # Renew the lease before the validate/restore phase: a slow validate
            # or checkpoint-restore must not let the claim expire and get the row
            # orphan-recovered + double-run by a peer pod.
            self._touch_activity(worker_id)

            protected_execution = job_data.get("execution_budget_id") is not None
            if not protected_execution and not self._allow_unprotected_test_execution:
                raise ValueError(
                    "This stored job predates protected execution. Submit it again to create a funded Vercel run."
                )
            service = self._get_service()
            # Current preflight evidence already proves semantic validity inside
            # this job's selected sandbox. The legacy validators exec authored
            # modules in a broader subprocess, before that boundary exists.
            if (
                optimization_type == OPTIMIZATION_TYPE_GRID_SEARCH
                and not protected_execution
                and hasattr(service, "validate_grid_search_payload")
            ):
                service.validate_grid_search_payload(grid_payload)
            elif optimization_type == OPTIMIZATION_TYPE_BLACKBOX:
                validate_blackbox_payload(
                    blackbox_payload,
                    verify_scorer=not protected_execution,
                )
            elif optimization_type == OPTIMIZATION_TYPE_RUN and not protected_execution:
                service.validate_payload(run_payload)

            self._touch_activity(worker_id)
            self._raise_if_interrupted(cancel_event, optimization_id)

            self._update_owned_job(
                optimization_id,
                execution_generation,
                status="running",
                message="Running optimization",
                started_at=datetime.now(UTC).isoformat(),
            )

            budget_gateway: ModelGateway | None = None
            run_process: mp.process.BaseProcess | None = None
            event_queue: Any | None = None
            result_dict: dict[str, Any] | None = None
            subprocess_error: dict[str, Any] | None = None

            # Resume support: the worker owns a per-job base directory it seeds
            # from saved checkpoints (resume) and reads ``gepa_state.bin`` back
            # from to persist each iteration. A single run keeps its state in the
            # base; a grid keeps one ``pair_<i>`` subdir per pair. ``None`` when the
            # run is not resumable (non-GEPA, or a store without checkpoint
            # support), keeping every other path unchanged.
            is_grid = optimization_type == OPTIMIZATION_TYPE_GRID_SEARCH
            gepa_dir: Path | None = None
            checkpoint_tracker: dict[str, Any] = {
                "payload": dict(payload_dict),
                "code_version": job_data.get("code_version"),
                "generation": execution_generation,
            }
            if self._checkpoints_enabled(optimization_type) and supports_checkpoint(payload_dict):
                gepa_dir = self._prepare_gepa_dir(optimization_id, is_grid=is_grid)
                # Restoring checkpoint blobs from the DB can be slow; renew the
                # lease so the upcoming subprocess spawn starts with a full window.
                self._touch_activity(worker_id)

            # Preserve registry-backed service in child when using fork.
            if self._mp_start_method == "fork":
                set_fork_service(service)

            try:
                # Inject job type so subprocess can dispatch without duck-typing.
                # Pydantic ignores this unknown key during model_validate.
                payload_dict["_optimization_type"] = optimization_type
                payload_dict["_job_id"] = optimization_id
                if gepa_dir is not None:
                    payload_dict["_gepa_log_dir"] = str(gepa_dir)
                    if is_grid:
                        # Resume: hand the child the pairs that already finished so
                        # it keeps them and runs only the rest. For a pair child
                        # this reads the CHILD's own store — global-indexed, so a
                        # requeued pair resumes exactly like a requeued grid.
                        payload_dict["_completed_pairs"] = {
                            index: result
                            for index, result in self._job_store.get_grid_pair_results(optimization_id).items()
                            if result.get("stop_reason") != "budget_reached"
                        }

                # Events (progress, logs, latest metrics) from a pair child land
                # on the PARENT id the user watches; the child row keeps only
                # scheduling state. The subprocess reports global pair indices
                # via the base/total keys so those events line up.
                events_target = optimization_id
                if pair_parent_id is not None:
                    events_target = pair_parent_id
                    payload_dict["_pair_index_base"] = pair_index_val
                    payload_dict["_grid_total_pairs"] = payload_dict.pop("_parent_total_pairs", 1)

                # BYOK bridge: for a run that bills the user's own provider key,
                # resolve each model's key from the vault and stamp it onto the
                # payload's ModelConfigs in memory — the only seam where the key
                # crosses into the run subprocess (and the grid threads it fans
                # out). Never persisted: the stored overview already dropped any
                # client-supplied key.
                token_source = overview.get(PAYLOAD_OVERVIEW_TOKEN_SOURCE) or TOKEN_SOURCE_MANAGED
                byok_engine = getattr(self._job_store, "engine", None)
                if byok_engine is not None:
                    if is_grid:
                        execution_payload = grid_payload
                    elif optimization_type == OPTIMIZATION_TYPE_BLACKBOX:
                        execution_payload = blackbox_payload
                    else:
                        execution_payload = run_payload
                    if payload_uses_token_source(
                        payload_dict,
                        TOKEN_SOURCE_BYOK,
                        default_token_source=token_source,
                    ):
                        inject_byok_connections(
                            payload_dict,
                            username=execution_payload.username,
                            vault=ProviderKeyVault(engine=byok_engine),
                            default_token_source=token_source,
                        )
                # Managed-run mirror of the BYOK seam: when key provisioning is
                # configured, dispatch under a per-user OpenRouter runtime key
                # whose spend limit was just synced to the account's balance —
                # a provider-side backstop on top of the ledger clamp. Any
                # failure leaves the payload untouched and the run falls back
                # to the shared gateway key.
                if byok_engine is not None and payload_uses_token_source(
                    payload_dict,
                    TOKEN_SOURCE_MANAGED,
                    default_token_source=token_source,
                ):
                    provisioner = OpenRouterKeyProvisioner(engine=byok_engine)
                    if provisioner.enabled:
                        spendable = StripeBillingService(engine=byok_engine).spendable_credits(
                            execution_payload.username
                        )
                        runtime_key = provisioner.ensure_runtime_key(execution_payload.username, spendable)
                        if runtime_key is not None:
                            inject_provisioned_openrouter_key(
                                payload_dict,
                                api_key=runtime_key,
                                default_token_source=token_source,
                            )

                if job_data.get("execution_budget_id") is not None:
                    execution_runtime = "vercel"
                    if byok_engine is None:
                        raise ValueError("Protected execution requires the authoritative ledger.")
                    uses_managed_models = payload_uses_token_source(
                        payload_dict,
                        TOKEN_SOURCE_MANAGED,
                        default_token_source=token_source,
                    )
                    if uses_managed_models and settings.openrouter_api_key is None:
                        raise ValueError("Managed model roles require the configured provider route.")
                    recovery = job_data.get("recovery") if recovery_plan is not None else None
                    headroom_id = recovery.get("headroom_operation_id") if isinstance(recovery, dict) else None
                    if recovery_plan is not None and not isinstance(headroom_id, str):
                        raise CheckpointCompatibilityError(
                            "Automatic recovery lost its pre-authorized budget headroom."
                        )
                    execution_headroom = (
                        (
                            Decimal(str(recovery_plan["execution_max_credits"])),
                            Decimal(str(recovery_plan["execution_max_wallet_credits"])),
                        )
                        if recovery_plan is not None
                        else None
                    )
                    budget_gateway = ModelGateway(
                        BudgetRuntime(
                            BudgetService(engine=byok_engine),
                            username=execution_payload.username,
                            budget_id=job_data["execution_budget_id"],
                            generation=job_data["execution_budget_generation"],
                            phase="run",
                            recovery_headroom_operation_id=headroom_id,
                            recovery_execution_headroom=execution_headroom,
                        ),
                        recovery_plan=recovery_plan,
                    )
                    bind_protected_sandbox(
                        budget_gateway,
                        settings,
                        workflow="anything" if optimization_type == OPTIMIZATION_TYPE_BLACKBOX else "dspy",
                        owner_id=optimization_id,
                    )
                    budget_gateway.validate_recovery_runtime(execution_runtime)
                    checkpoint_tracker.update(
                        recovery_plan_builder=budget_gateway.checkpoint_recovery_plan,
                        execution_runtime=execution_runtime,
                    )
                    parent_payload = resolve_execution_credentials(
                        payload_dict,
                        username=execution_payload.username,
                        binding_id=job_data["execution_budget_id"],
                        vault=ProtectedCredentialVault(engine=byok_engine),
                    )
                    payload_dict = budget_gateway.protect_payload(
                        parent_payload,
                        managed_key=(
                            settings.openrouter_api_key.get_secret_value()
                            if settings.openrouter_api_key is not None
                            else ""
                        ),
                        allow_private_tools=settings.discover_allow_private,
                    )
                if has_exposed_execution_credentials(
                    payload_dict,
                    allow_parent_model_routes=budget_gateway is not None,
                ):
                    raise ValueError(
                        "The stored job contains credentials outside the trusted relay; clone and test setup again."
                    )

                execution_start_method = "spawn" if budget_gateway is not None else self._mp_start_method
                execution_context = mp.get_context("spawn") if budget_gateway is not None else self._mp_ctx
                event_queue = execution_context.Queue()
                run_process = execution_context.Process(  # type: ignore[attr-defined]
                    target=run_vercel_dspy if budget_gateway is not None else run_service_in_subprocess,
                    args=(
                        payload_dict,
                        f"{optimization_id}-g{execution_generation}"
                        if execution_generation is not None
                        else optimization_id,
                        event_queue,
                        execution_start_method,
                    ),
                    name=f"dspy-run-{optimization_id[:8]}",
                    daemon=True,
                )
                assert run_process is not None
                run_process.start()

                # From here the child owns its copy of the payload. The
                # validated request model is a second full copy of the
                # dataset that would otherwise sit in this process for the
                # whole multi-hour run — and be duplicated into every
                # sibling job's fork image. ``payload_dict`` itself stays
                # pinned by ``run_process``'s args tuple; only ``attempts``
                # is read from ``job_data`` after this point.
                job_data = {
                    key: job_data.get(key)
                    for key in (
                        "attempts",
                        "execution_budget_id",
                        "execution_budget_generation",
                        "execution_generation",
                    )
                }
                run_payload = grid_payload = blackbox_payload = None

                # Stall watchdog: the lease heartbeat (_touch_activity) renews
                # on every tick regardless of progress, so a child wedged on a
                # timeout-less blocking call (e.g. a hung LLM socket read) would
                # otherwise be kept "running" forever. Track the last time the
                # child emitted any event and fail the run if it goes silent past
                # the configured window. The per-request LM timeout normally trips
                # first; this only catches genuine wedges that produce nothing.
                stall_timeout = settings.job_stall_timeout_seconds
                last_event_at = time.monotonic()
                progress_rewrite = self._pair_progress_rewrite(pair_parent_id) if pair_parent_id else None
                while run_process.is_alive():
                    self._raise_if_interrupted(cancel_event, optimization_id)
                    self._touch_activity(worker_id)
                    self._raise_if_store_cancelled(optimization_id)
                    run_process.join(timeout=self._cancel_poll_interval)
                    drained_result, drained_error, drained_count = self._drain_subprocess_events(
                        events_target,
                        event_queue,
                        progress_rewrite=progress_rewrite,
                        source_optimization_id=optimization_id,
                        generation=execution_generation,
                        checkpoint_tracker=checkpoint_tracker,
                    )
                    if drained_result is not None:
                        result_dict = drained_result
                    if drained_error is not None:
                        subprocess_error = drained_error
                    if drained_count > 0:
                        last_event_at = time.monotonic()
                    elif stall_timeout > 0 and time.monotonic() - last_event_at > stall_timeout:
                        raise JobStalledError(
                            f"Optimization stalled: no progress for {stall_timeout:.0f}s. "
                            "The run was terminated; a model call or other operation likely "
                            "hung without making progress."
                        )
                    if gepa_dir is not None:
                        self._persist_gepa_checkpoint(optimization_id, gepa_dir, checkpoint_tracker, is_grid=is_grid)
                        if budget_gateway is not None and not is_grid:
                            self._pause_if_over_projection(
                                optimization_id, budget_gateway, checkpoint_tracker, execution_generation
                            )

                drained_result, drained_error, _ = self._drain_subprocess_events(
                    events_target,
                    event_queue,
                    progress_rewrite=progress_rewrite,
                    source_optimization_id=optimization_id,
                    generation=execution_generation,
                    checkpoint_tracker=checkpoint_tracker,
                )
                if drained_result is not None:
                    result_dict = drained_result
                if drained_error is not None:
                    subprocess_error = drained_error
                if gepa_dir is not None:
                    self._persist_gepa_checkpoint(optimization_id, gepa_dir, checkpoint_tracker, is_grid=is_grid)

                if budget_gateway is not None:
                    closing_gateway, budget_gateway = budget_gateway, None
                    execution_budget_snapshot, settlement_error = self._close_budget_gateway(
                        optimization_id, closing_gateway, execution_generation
                    )
                    if settlement_error is not None and subprocess_error is None:
                        raise settlement_error

                if subprocess_error:
                    traceback_text = subprocess_error.get("traceback")
                    if traceback_text:
                        logger.error("Optimization %s subprocess traceback:\n%s", optimization_id, traceback_text)
                        # Persist traceback so users can see it via GET /jobs/{id}/logs
                        # (a pair child's traceback belongs on the parent the user reads).
                        with contextlib.suppress(Exception):
                            self._job_store.append_log(
                                events_target,
                                level="ERROR",
                                logger_name="dspy.subprocess",
                                message=traceback_text,
                            )
                    error_message = str(subprocess_error.get("error", "Unknown subprocess error"))
                    if subprocess_error.get("failure_kind") == INFRASTRUCTURE_INTERRUPTION:
                        raise InfrastructureInterruptionError(error_message)
                    raise RuntimeError(error_message)

                if run_process.exitcode not in (0, None) and result_dict is None:
                    if run_process.exitcode == -9:
                        raise InfrastructureInterruptionError(
                            "The optimizer process was terminated by temporary infrastructure pressure."
                        )
                    raise RuntimeError(f"Optimization subprocess exited with code {run_process.exitcode}")

                terminal = None
                if isinstance(result_dict, dict) and "_terminal_outcome" in result_dict:
                    terminal = TerminalOutcome.model_validate(result_dict["_terminal_outcome"])
                    result_dict = terminal.result
                if result_dict is None and terminal is None:
                    raise RuntimeError("Optimization subprocess finished without a result payload")

                # Check cancel one last time: service.run() may have completed
                # during a long phase with no progress callbacks, after the
                # cancel endpoint already marked the job as cancelled.
                self._raise_if_interrupted(cancel_event, optimization_id)

                # Grid search with all pairs failed is a failure, not a success.
                # A pair child's 1-pair grid rides the same check: its single
                # failed pair marks the CHILD row failed.
                final_status = terminal.status if terminal is not None else "success"
                final_message = terminal.message if terminal is not None else "Optimization completed successfully"
                if optimization_type == OPTIMIZATION_TYPE_GRID_SEARCH and isinstance(result_dict, dict):
                    completed = result_dict.get("completed_pairs", 0)
                    total = result_dict.get("total_pairs", 0)
                    if result_dict.get("failed_pairs", 0) and result_dict.get("stopped_pairs", 0):
                        final_status = "failed"
                        final_message = "Some model pairs failed before the budget stop."
                    elif completed == 0 and total > 0 and terminal is None:
                        final_status = "failed"
                        final_message = f"All {total} model pairs failed"
                        pair_results = result_dict.get("pair_results") or []
                        first_error = next(
                            (p["error"] for p in pair_results if isinstance(p, dict) and p.get("error")),
                            None,
                        )
                        if first_error:
                            final_message = f"{final_message}: {first_error}"

                # A pair child durably records its PairResult (and the grid
                # envelope) onto the PARENT before its own terminal write, so
                # the finalizer can assemble the grid even if this process
                # dies right after the status lands.
                if pair_parent_id is not None and isinstance(result_dict, dict):
                    self._record_pair_outcome(pair_parent_id, result_dict)

                try:
                    if self._persisted_status(optimization_id) in ("cancelled", "paused"):
                        # Cancel/pause endpoint raced us past the last
                        # _raise_if_cancelled() and already wrote its terminal status
                        # to the DB. Stop cooperatively so we persist the checkpoint
                        # and never overwrite "cancelled"/"paused" with success/failed.
                        raise CancellationError()
                    # Compare-and-set the terminal write against the active
                    # statuses so a pause/cancel that landed after the status read
                    # just above isn't clobbered by this success/failed write; on a
                    # lost race we yield cooperatively. Stores without the CAS
                    # method keep last-writer-wins.
                    completion_fields: dict[str, Any] = {
                        "status": final_status,
                        "message": final_message,
                        "completed_at": datetime.now(UTC).isoformat(),
                        # A pair child's result already lives in the parent's
                        # pair-result store; storing it again on the hidden
                        # child row would triple the artifact bytes.
                        "result": None if pair_parent_id is not None else result_dict,
                    }
                    if terminal is not None:
                        completion_fields.update(
                            stop_reason=terminal.stop_reason,
                            result_availability=terminal.result_availability,
                            terminal_evidence={
                                **terminal.evidence,
                                **(
                                    {"execution_budget": execution_budget_snapshot} if execution_budget_snapshot else {}
                                ),
                            },
                        )
                    cas = getattr(self._job_store, "update_job_if_status", None)
                    if cas is not None:
                        fence = {} if execution_generation is None else {"expected_generation": execution_generation}
                        if not cas(optimization_id, ("running", "validating"), **fence, **completion_fields):
                            raise CancellationError()
                    else:
                        self._job_store.update_job(optimization_id, **completion_fields)
                    logger.info("Optimization %s completed with status=%s", optimization_id, final_status)
                    # Success retires resume state and frees its bytes. A single
                    # run drops its one checkpoint. A grid keeps each *failed*
                    # pair's checkpoint so that pair stays per-pair resumable even
                    # though the grid as a whole succeeded — successful pairs'
                    # checkpoints were already dropped when their result.json was
                    # recorded, and the transient pair-result store is redundant
                    # once the final result holds every pair, so clear it.
                    if gepa_dir is not None and final_status == "success":
                        with contextlib.suppress(Exception):
                            if is_grid:
                                self._job_store.delete_grid_pair_results(optimization_id)
                            else:
                                self._job_store.delete_gepa_checkpoint(optimization_id)
                    if pair_parent_id is not None:
                        # Parent-level side effects (user notification, credit
                        # debit, billing stamp, embedding) happen ONCE at grid
                        # finalization — a pair child only checks whether it
                        # was the last sibling standing.
                        self._maybe_finalize_grid(pair_parent_id)
                        return
                    _username = overview.get(PAYLOAD_OVERVIEW_USERNAME, "")
                    _baseline = result_dict.get("baseline_test_metric") if isinstance(result_dict, dict) else None
                    _optimized = result_dict.get("optimized_test_metric") if isinstance(result_dict, dict) else None
                    if self._job_store.claim_completion_notification(optimization_id):
                        notify_job_completed(
                            optimization_id=optimization_id,
                            username=_username,
                            status=final_status,
                            message=final_message,
                            baseline_score=_baseline,
                            optimized_score=_optimized,
                        )
                        self._record_run_outcome(optimization_id, _username, final_status, overview)
                        # The credit debit shares the once-only completion claim so
                        # a redelivered/re-run job is never double-billed. Success
                        # only — a failed (e.g. all-pairs-failed) run is not billed.
                        if final_status == "success" and not job_data.get("execution_budget_id"):
                            billed = self._debit_run_credits(
                                _username,
                                result_dict,
                                optimization_id=optimization_id,
                                run_name=overview.get(PAYLOAD_OVERVIEW_NAME) or "",
                                model=overview.get(PAYLOAD_OVERVIEW_MODEL_NAME),
                                token_source=overview.get(PAYLOAD_OVERVIEW_TOKEN_SOURCE) or TOKEN_SOURCE_MANAGED,
                                token_sources_by_model=overview.get(PAYLOAD_OVERVIEW_TOKEN_SOURCES_BY_MODEL),
                            )
                            # Stamp the billing outcome onto the persisted result so
                            # the result screen can show what the run cost.
                            # Re-persisted because the debit runs after the first
                            # completion write.
                            self._stamp_billing_outcome(
                                optimization_id,
                                result_dict,
                                billed=billed,
                                estimated_low=overview.get(PAYLOAD_OVERVIEW_ESTIMATED_LOW),
                                estimated_high=overview.get(PAYLOAD_OVERVIEW_ESTIMATED_HIGH),
                            )
                    if final_status == "success":
                        self._schedule_embedding_indexing(optimization_id)
                except KeyError:
                    logger.info(
                        "Optimization %s was deleted during execution (likely cancelled), skipping result",
                        optimization_id,
                    )
            # cleanup-and-reraise: ensure the subprocess is killed on ANY exit
            # path (including shutdown signals) before the exception propagates.
            except BaseException:
                # Capture the last completed iteration's state before killing the
                # child, so a 504/stall/cancel leaves a resume point on disk.
                if gepa_dir is not None:
                    with contextlib.suppress(Exception):
                        self._persist_gepa_checkpoint(optimization_id, gepa_dir, checkpoint_tracker, is_grid=is_grid)
                if run_process is not None and run_process.is_alive():
                    self._terminate_run_process(run_process, optimization_id)
                    if optimization_type == OPTIMIZATION_TYPE_BLACKBOX:
                        self._stop_blackbox_sandboxes(optimization_id)
                raise
            finally:
                if budget_gateway is not None:
                    execution_budget_snapshot, settlement_error = self._close_budget_gateway(
                        optimization_id, budget_gateway, execution_generation
                    )
                    budget_gateway = None
                    if settlement_error is not None:
                        logger.error(
                            "Optimization %s runtime cleanup needs attention: %s", optimization_id, settlement_error
                        )
                # The DB holds the checkpoint bytes for a resumable failure; the
                # local working copy is always removed.
                if gepa_dir is not None:
                    shutil.rmtree(gepa_dir, ignore_errors=True)
                if event_queue is not None:
                    with contextlib.suppress(Exception):
                        event_queue.close()
                    with contextlib.suppress(Exception):
                        event_queue.join_thread()

        # BaseException catches SystemExit/KeyboardInterrupt during graceful shutdown
        # so we still record a terminal status for the in-flight job before propagating.
        except BaseException as exc:
            is_shutdown = isinstance(exc, SystemExit | KeyboardInterrupt)
            is_cancelled = isinstance(exc, CancellationError)
            is_temporary = isinstance(exc, InfrastructureInterruptionError) or is_shutdown
            recovery_unavailable_reason = ""
            if is_temporary and not is_cancelled:
                recovered, recovery_unavailable_reason = self._recover_temporary_interruption(
                    optimization_id,
                    generation=execution_generation,
                    attempts=recovery_attempts,
                )
                if recovered:
                    if is_shutdown:
                        raise
                    return
            if is_cancelled:
                final_status, error_message = "cancelled", CANCELLATION_REASON
                logger.info("Optimization %s cancelled", optimization_id)
            elif is_shutdown:
                final_status = "failed"
                error_message = f"Optimization interrupted by service shutdown: {exc}"
                logger.exception("Optimization %s failed: %s", optimization_id, error_message)
            else:
                final_status = "failed"
                error_message = str(exc)
                if is_temporary and recovery_unavailable_reason:
                    error_message = f"{error_message} Recovery unavailable: {recovery_unavailable_reason}"
                logger.exception("Optimization %s failed: %s", optimization_id, error_message)
            _username = overview.get(PAYLOAD_OVERVIEW_USERNAME, "") if isinstance(overview, dict) else ""
            if is_cancelled:
                # The cancel/pause endpoint already wrote the terminal status
                # ("cancelled" or "paused"); the worker adds no DB write here. A
                # pause is a suspend-to-resume, not a completion, so it skips the
                # finished-job notification that a real cancel sends.
                persisted_status = None
                with contextlib.suppress(Exception):
                    persisted_status = self._persisted_status(optimization_id)
                if (
                    pair_parent_id is None
                    and persisted_status == "cancelled"
                    and self._job_store.claim_completion_notification(optimization_id)
                ):
                    notify_job_completed(optimization_id=optimization_id, username=_username, status="cancelled")
                    self._record_run_outcome(
                        optimization_id, _username, "cancelled", overview if isinstance(overview, dict) else {}
                    )
            else:
                # Failed jobs are retained so users can inspect the error
                now = datetime.now(UTC).isoformat()
                try:
                    fields = {"status": final_status, "message": error_message, "completed_at": now}
                    if is_temporary:
                        fields.update(
                            stop_reason="interrupted",
                            recovery={
                                "state": "unavailable",
                                "phase": "admission",
                                "reason": recovery_unavailable_reason or error_message,
                            },
                        )
                    cas = getattr(self._job_store, "update_job_if_status", None)
                    if cas is not None:
                        fence = {} if execution_generation is None else {"expected_generation": execution_generation}
                        if not cas(optimization_id, ("pending", "running", "validating"), **fence, **fields):
                            return
                    else:
                        self._job_store.update_job(optimization_id, **fields)
                except Exception:  # isolation boundary: a DB hiccup must not prevent the notification below
                    logger.exception("Optimization %s: failed to update status to %s", optimization_id, final_status)
                if pair_parent_id is None and self._job_store.claim_completion_notification(optimization_id):
                    notify_job_completed(
                        optimization_id=optimization_id,
                        username=_username,
                        status=final_status,
                        message=error_message,
                    )
                    self._record_run_outcome(
                        optimization_id, _username, final_status, overview if isinstance(overview, dict) else {}
                    )
            # A pair child's terminal state may have been the grid's last:
            # run the finalize check on every exit path (it no-ops unless all
            # siblings are terminal and the parent is still running).
            if pair_parent_id is not None and not is_shutdown:
                with contextlib.suppress(Exception):
                    self._maybe_finalize_grid(pair_parent_id)
            if is_shutdown:
                raise

    def _close_budget_gateway(
        self, optimization_id: str, gateway: ModelGateway, generation: int | None
    ) -> tuple[dict[str, Any] | None, BaseException | None]:
        """Settle owned runtimes before terminal publication while retaining uncertain usage.

        Args:
            optimization_id: Stable job owning all covered work.
            gateway: Trusted parent transport and its cumulative budget.
            generation: Worker epoch allowed to publish the settlement snapshot.

        Returns:
            Authoritative snapshot and a genuine cleanup error, if one occurred.
        """
        error: BaseException | None = None
        snapshot: dict[str, Any] | None = None
        try:
            gateway.close()
        except UsagePendingError:
            logger.info("Optimization %s finished with usage awaiting reconciliation", optimization_id)
        except BaseException as exc:
            error = exc
        try:
            raw = asdict(gateway.runtime.service.get(gateway.runtime.budget_id, gateway.runtime.username))
            raw.pop("username", None)
            raw.pop("account_available_credits", None)
            snapshot = json.loads(json.dumps(raw, default=str))
            job = self._job_store.get_job(optimization_id)
            evidence = {**(job.get("terminal_evidence") or {}), "execution_budget": snapshot}
            cas = getattr(self._job_store, "update_job_if_status", None)
            if cas is not None:
                kwargs = {} if generation is None else {"expected_generation": generation}
                cas(
                    optimization_id,
                    ("pending", "validating", "running", "success", "failed", "stopped", "paused", "cancelled"),
                    terminal_evidence=evidence,
                    **kwargs,
                )
            else:
                self._job_store.update_job(optimization_id, terminal_evidence=evidence)
        except Exception:
            logger.exception("Optimization %s could not publish its budget snapshot", optimization_id)
        return snapshot, error

    def _process_tagging_job(
        self,
        optimization_id: str,
        worker_id: int,
        cancel_event: threading.Event | None,
        payload_dict: dict[str, Any],
    ) -> None:
        """Run a bulk auto-tag job in the worker thread (no subprocess).

        The batch loop lives in :mod:`core.worker.tagging_job`; this wrapper
        owns the job-row lifecycle: the ``running`` transition, the heartbeat
        the loop's monitor thread calls to renew the claim lease, and the
        terminal write. A user cancel is observed cooperatively (the route
        wrote the terminal ``cancelled`` status already, so no write happens
        here); a lease lost to a peer pod abandons silently. Failures
        propagate to ``_process_job``'s generic handler.

        Args:
            optimization_id: ID of the claimed job.
            worker_id: Index of the calling worker thread (lease renewal).
            cancel_event: The job's cooperative cancel flag.
            payload_dict: The stored ``TaggingAutotagPayload`` dict.
        """
        payload = TaggingAutotagPayload.model_validate(payload_dict)
        self._job_store.update_job(
            optimization_id,
            status="running",
            message="Auto-tagging dataset rows",
            started_at=datetime.now(UTC).isoformat(),
        )
        self._touch_activity(worker_id)
        outcome = run_autotag_job(
            self._job_store,
            optimization_id,
            payload.session_id,
            username=payload.username,
            cancel_event=cancel_event or threading.Event(),
            heartbeat=lambda: self._touch_activity(worker_id),
        )
        if outcome.get("status") != "done":
            logger.info("Tagging job %s ended without completion: %s", optimization_id, outcome)
            return
        completion_fields: dict[str, Any] = {
            "status": "success",
            "message": f"Tagged {outcome.get('rows_tagged', 0)} rows",
            "completed_at": datetime.now(UTC).isoformat(),
            "result": outcome,
        }
        cas = getattr(self._job_store, "update_job_if_status", None)
        if cas is not None:
            if not cas(optimization_id, ("running", "validating"), **completion_fields):
                # A cancel raced the finish; its terminal status stands.
                return
        else:
            self._job_store.update_job(optimization_id, **completion_fields)
        logger.info("Tagging job %s completed", optimization_id)

    def start(self) -> None:
        """Start the background worker threads and begin polling.

        Idempotent: a second call while ``_running`` is true is a no-op.
        """
        if self._running:
            return

        self._running = True
        # Boot backstop: a fleet restart may have interrupted the last pair
        # finisher of a distributed grid mid-handoff; sweep once before the
        # idle-loop cadence takes over.
        with contextlib.suppress(Exception):
            self._finalize_stuck_grids()
        for i in range(self._num_workers):
            # Non-daemon: the SIGTERM handler joins these threads explicitly so
            # in-flight subprocesses get a chance to terminate cleanly.
            thread = threading.Thread(
                target=self._worker_loop,
                args=(i,),
                name=f"dspy-worker-{i}",
            )
            thread.start()
            self._threads.append(thread)

        logger.info("Started %d background workers", self._num_workers)

    def stop(self, timeout: float = 30.0) -> None:
        """Signal all workers to stop and wait for them to finish.

        Clears the pending queue, sets the cancel event for every tracked job so
        in-flight subprocesses terminate promptly, and joins each worker thread
        with a share of the total ``timeout``.

        Args:
            timeout: Total seconds shared across all worker thread joins.
        """
        if not self._running:
            return

        self._running = False

        # Request cooperative cancellation for pending/running jobs so workers
        # can terminate subprocess execution promptly during shutdown.
        with self._queue_lock:
            self._pending_jobs.clear()
            for event in self._cancel_events.values():
                event.set()

        if not self._threads:
            return
        # Worker threads run concurrently, so a single shared deadline lets any
        # one in-flight job use up to the full ``timeout`` to finish its current
        # DSPy/LLM call — instead of a fixed ``timeout / N`` slice that reaps a
        # slow child early — while still bounding total shutdown to ``timeout``.
        deadline = time.monotonic() + timeout
        for thread in self._threads:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            thread.join(timeout=remaining)

        self._threads.clear()
        logger.info("Stopped background workers")

    def is_running(self) -> bool:
        """Return True if the worker has been started.

        Returns:
            ``True`` while ``start`` has been called and ``stop`` has not.
        """
        return self._running

    def _touch_activity(self, worker_id: int) -> None:
        """Record liveness and renew the lease on this worker's current job.

        Renewing the lease here keeps the lease window short (so a dead pod
        is reclaimed quickly) without us having to schedule a separate
        heartbeat thread — the same call sites that prove this thread is
        alive also prove that its claim is still valid.

        Args:
            worker_id: Index of the worker thread reporting liveness.
        """
        with self._activity_lock:
            self._last_activity[worker_id] = time.monotonic()
            current_job = self._thread_current_job.get(worker_id)
        if current_job is not None and current_job in self._claimed_jobs:
            try:
                still_owned = self._job_store.extend_lease(current_job, self._pod_name, self._lease_seconds)
            except AttributeError:
                still_owned = True
            except Exception:
                logger.exception("extend_lease failed for %s", current_job)
                still_owned = True
            if not still_owned:
                # Another pod stole the lease (we hung past the window). Cancel
                # ourselves so we abandon the run instead of double-processing.
                logger.warning(
                    "Lease for %s was stolen from %s — cancelling local run",
                    current_job,
                    self._pod_name,
                )
                with self._queue_lock:
                    event = self._cancel_events.get(current_job)
                if event is not None:
                    event.set()

    def _pause_if_over_projection(
        self,
        optimization_id: str,
        gateway: ModelGateway,
        tracker: dict[str, Any],
        generation: int | None,
    ) -> None:
        """Pause a run whose measured burn projects past its spending limit.

        Evaluated once per newly persisted checkpoint, so a pause always has a
        checkpoint to resume from. The credits settled so far are scaled to the
        optimizer's planned evaluation count; a projection above the limit
        closes paid admission, parks the row as ``paused`` with the projection
        as evidence, and unwinds the run exactly like a user pause, so raising
        the limit continues from the checkpoint instead of the hard stop at the
        limit discarding the remaining work.

        Args:
            optimization_id: The running job.
            gateway: Trusted parent transport whose runtime owns the budget.
            tracker: Checkpoint cursor holding the planned count reported by
                the optimizer and the metric calls of the last saved state.
            generation: Worker epoch allowed to publish the pause.

        Raises:
            CancellationError: After the pause is published, to unwind the run.
        """
        planned = tracker.get("planned_calls")
        done = tracker.get(-1, {}).get("metric_calls")
        if planned is None or done is None or done == tracker.get("_probed_calls"):
            return
        tracker["_probed_calls"] = done
        if not probe_ready(done, planned):
            return
        runtime = gateway.runtime
        snapshot = runtime.service.get(runtime.budget_id, runtime.username)
        projected = project_total_credits(snapshot.setup_spent_credits, snapshot.run_spent_credits, done, planned)
        if projected <= snapshot.total_credits:
            return
        logger.info(
            "Optimization %s: %s/%s evaluations project %s credits against a %s-credit limit; pausing",
            optimization_id,
            done,
            planned,
            projected,
            snapshot.total_credits,
        )
        runtime.service.stop_admission(runtime.budget_id, runtime.username, reason=STOP_REASON_BUDGET_PROJECTED)
        existing = (self._job_store.get_job(optimization_id) or {}).get("terminal_evidence") or {}
        fields = {
            "status": "paused",
            "message": PAUSE_REASON,
            "completed_at": datetime.now(UTC).isoformat(),
            "stop_reason": STOP_REASON_BUDGET_PROJECTED,
            "terminal_evidence": {
                **existing,
                "budget_projection": projection_evidence(
                    snapshot, done_calls=done, planned_calls=planned, projected_credits=projected
                ),
            },
        }
        cas = getattr(self._job_store, "update_job_if_status", None)
        if callable(cas):
            fence = {} if generation is None else {"expected_generation": generation}
            cas(optimization_id, ("running", "validating"), **fence, **fields)
        else:
            self._job_store.update_job(optimization_id, **fields)
        raise CancellationError()

    def _raise_if_store_cancelled(self, optimization_id: str) -> None:
        """Raise ``CancellationError`` when a peer pod has cancelled/paused the job.

        A cancel or pause that lands on a different replica only flips the DB
        status — it can't reach this pod's in-memory cancel event. Polling the
        lightweight status column on each lease-heartbeat tick makes cancellation
        cross-pod, so a running subprocess stops promptly instead of burning its
        full LLM budget to completion. A store without the lightweight read
        (legacy/in-memory) is a no-op.

        Args:
            optimization_id: ID of the job whose persisted status to check.

        Raises:
            CancellationError: When the persisted status is cancelled/paused.
        """
        status_fields = getattr(self._job_store, "get_job_status_fields", None)
        if status_fields is None:
            return
        try:
            status = status_fields(optimization_id).get("status")
        except Exception:
            # A transient read failure must not abort an otherwise-healthy run;
            # the next tick retries.
            return
        if status in ("cancelled", "paused"):
            raise CancellationError()

    def _schedule_embedding_indexing(self, optimization_id: str) -> None:
        """Fire-and-forget embed the finished job for the explore search index.

        Runs on a daemon thread so a slow LLM call or a missing pgvector
        extension can never block the worker's hot path. Failures are
        swallowed — the job itself is already marked success; the index
        is best-effort and the startup backfill heals any gaps.

        Args:
            optimization_id: ID of the just-finished job to index.
        """
        threading.Thread(
            target=self._embed_finished_job_best_effort,
            args=(optimization_id,),
            name=f"embed-{optimization_id[:8]}",
            daemon=True,
        ).start()

    def _embed_finished_job_best_effort(self, optimization_id: str) -> None:
        """Embed a finished job, swallowing failures so they never reach the worker.

        A missing pgvector extension or LLM credentials issue only surfaces
        on the indexing thread, never on the worker hot path.

        Args:
            optimization_id: ID of the finished job to embed.
        """
        try:
            embed_finished_job(optimization_id, job_store=self._job_store)
        except Exception as exc:  # isolation boundary: best-effort indexing must never impact job status
            logger.debug("Embedding indexing for %s failed: %s", optimization_id, exc)

    def _record_run_outcome(
        self,
        optimization_id: str,
        username: str,
        status: str,
        overview: dict[str, Any],
    ) -> None:
        """Emit the ``run_completed`` / ``run_failed`` / ``run_cancelled`` milestone.

        Called next to :func:`notify_job_completed` (inside the same exactly-once
        completion claim) so each run yields one outcome event, mirroring the
        browser's ``run_submitted``. Only structural descriptors are recorded —
        no error text, no run name — and a telemetry failure never touches the
        run's status.

        Args:
            optimization_id: Finished job id (logged only, never exported).
            username: Owner of the run.
            status: Terminal status (``success``, ``failed`` or ``cancelled``).
            overview: The job's ``payload_overview`` mapping.
        """
        name = {"success": "run_completed", "cancelled": "run_cancelled", "stopped": "run_stopped"}.get(
            status, "run_failed"
        )
        try:
            record_server_event(
                getattr(self._job_store, "engine", None),
                username=username or None,
                name=name,
                properties={
                    "status": status,
                    "optimization_type": overview.get(PAYLOAD_OVERVIEW_OPTIMIZATION_TYPE),
                    "optimizer": overview.get(PAYLOAD_OVERVIEW_OPTIMIZER_NAME),
                    "model": overview.get(PAYLOAD_OVERVIEW_MODEL_NAME),
                    "token_source": overview.get(PAYLOAD_OVERVIEW_TOKEN_SOURCE),
                },
            )
        except Exception:  # isolation boundary: telemetry must never affect a run outcome
            logger.debug("Optimization %s: run outcome telemetry failed", optimization_id, exc_info=True)

    def _debit_run_credits(
        self,
        username: str,
        result_dict: dict[str, Any] | None,
        *,
        run_name: str,
        model: str | None,
        optimization_id: str | None = None,
        token_source: str = TOKEN_SOURCE_MANAGED,
        token_sources_by_model: dict[str, str] | None = None,
    ) -> int:
        """Debit a finished run's credit cost from the account's local ledger.

        Writes a signed ``run`` row and decrements the account's grant/balance via
        :meth:`StripeBillingService.debit_run`. Runs inline (not on a daemon
        thread) so the wallet visibly reflects the spend the moment the run lands,
        but wrapped so a billing-DB hiccup can never flip job status — the local
        ledger is the credit source of truth, independent of whether Stripe is
        configured. A managed run is charged its full per-token cost; a BYOK run is
        charged only Skynet's platform fee (the provider tokens were paid on the
        user's own key), so credits still meter a BYOK run without double-charging
        for inference. A no-op when the store exposes no SQL engine (legacy/in-memory),
        the caller is anonymous, or the run reported no token usage.

        Args:
            username: Account the run is billed to.
            result_dict: The serialized run/grid result; its ``usage_by_model`` is
                priced per-model into the charge (falling back to ``total_tokens``).
            run_name: Run name for the ledger row's human label.
            model: Model id stamped on the ledger row, or ``None``.
            optimization_id: Finished legacy job whose own wallet commitment is consumed.
            token_source: ``"managed"`` (full cost) or ``"byok"`` (platform fee
                only); defaults to managed.
            token_sources_by_model: Optional model-to-source map for mixed jobs.

        Returns:
            The credits charged (``0`` when nothing was billed or the debit was
            skipped/failed).
        """
        engine = getattr(self._job_store, "engine", None)
        if engine is None or not username:
            return 0
        usages = _usages_from_result(result_dict, model)
        if not usages:
            return 0
        try:
            billing_kwargs: dict[str, Any] = {
                "model": model,
                "description": run_name or "Run",
                "token_source": token_source,
            }
            if token_sources_by_model is not None:
                billing_kwargs["token_sources_by_model"] = token_sources_by_model
            if optimization_id is not None:
                billing_kwargs["optimization_id"] = optimization_id
            return StripeBillingService(engine=engine).debit_run(
                username,
                usages,
                **billing_kwargs,
            )
        except Exception as exc:  # isolation boundary: a debit failure must never impact job status
            logger.debug("Credit debit for %s failed: %s", username, exc)
            return 0

    def _stamp_billing_outcome(
        self,
        optimization_id: str,
        result_dict: dict[str, Any] | None,
        *,
        billed: int,
        estimated_low: int | None = None,
        estimated_high: int | None = None,
    ) -> None:
        """Record the run's billed cost on its result for the result screen.

        Writes ``result['details']['billing']`` — ``{outcome: "billed", credits}``
        where ``credits`` is the amount charged. When the run was submitted with a
        projected bracket, ``estimated_low``/``estimated_high`` are echoed
        alongside so the estimate can be reconciled against the actual charge.
        Only stamps single-run results (a grid envelope has no per-run
        ``details``) and only when a credit amount exists, so a free-grant run
        that cost nothing adds no row. Re-persists the result via the job store
        because the debit runs after the first completion write; wrapped so a
        store hiccup can never flip job status.

        Args:
            optimization_id: The finished run whose result is updated.
            result_dict: The serialized run result; mutated in place and re-saved.
            billed: Credits charged by :meth:`_debit_run_credits`.
            estimated_low: Low end of the projected credit bracket, or None when
                the run carried no estimate.
            estimated_high: High end of the projected credit bracket, or None.
        """
        if not isinstance(result_dict, dict) or "pair_results" in result_dict:
            return
        outcome = "billed"
        credits = billed
        if credits <= 0:
            return
        try:
            details = result_dict.get("details")
            if not isinstance(details, dict):
                details = {}
                result_dict["details"] = details
            billing: dict[str, Any] = {"outcome": outcome, "credits": credits}
            if estimated_low is not None and estimated_high is not None:
                billing["estimated_low"] = estimated_low
                billing["estimated_high"] = estimated_high
            details["billing"] = billing
            self._job_store.update_job(optimization_id, result=result_dict)
        except Exception as exc:  # isolation boundary: stamping must never impact job status
            logger.debug("Billing-outcome stamp for %s failed: %s", optimization_id, exc)

    def _terminate_run_process(self, run_process: mp.process.BaseProcess, optimization_id: str) -> None:
        """Terminate a still-running job subprocess, escalating to SIGKILL after a 3-second grace period.

        Sends SIGTERM, waits up to 3 s, then calls ``kill()`` if the process is
        still alive and the platform supports it.  A final 2-second join follows
        before logging the outcome.  Never raises regardless of process state.

        Args:
            run_process: The job subprocess to terminate.
            optimization_id: ID embedded in the resulting log lines.
        """
        run_process.terminate()
        run_process.join(timeout=3.0)
        if run_process.is_alive() and hasattr(run_process, "kill"):
            run_process.kill()
            run_process.join(timeout=2.0)
        if run_process.is_alive():
            logger.error("Optimization %s subprocess did not terminate cleanly", optimization_id)
        else:
            logger.info("Optimization %s subprocess terminated", optimization_id)

    def _stop_blackbox_sandboxes(self, optimization_id: str) -> None:
        """Stop the sandboxes a killed black-box job left running on Vercel.

        The child closes its boxes on a normal exit, but a cancel, a stall or
        a shutdown kills it before its ``finally`` blocks run, and a scorer
        box would otherwise stay up until the lifetime ceiling. Never raises.

        Args:
            optimization_id: The job whose boxes to stop.
        """
        runtime = sandbox_runtime_from_settings(settings)
        if runtime is None:
            return
        try:
            stopped = runtime.stop_job_sandboxes(optimization_id)
        except Exception as exc:  # isolation boundary: a failed sweep must not mask the job's outcome
            logger.warning("Optimization %s: sandbox sweep failed: %s", optimization_id, exc)
            return
        if stopped == 0:
            return
        logger.info("Optimization %s: stopped %d sandbox(es) the job left running", optimization_id, stopped)
        with contextlib.suppress(Exception):
            self._job_store.append_log(
                optimization_id,
                level="INFO",
                logger_name="core.worker",
                message=f"Stopped {stopped} sandbox(es) the job left running",
            )

    def _drain_subprocess_events(
        self,
        optimization_id: str,
        event_queue: Any,
        *,
        progress_rewrite: Any | None = None,
        source_optimization_id: str | None = None,
        generation: int | None = None,
        checkpoint_tracker: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, int]:
        """Drain all pending events from the subprocess queue, routing each by type.

        Handles the event types emitted by ``run_service_in_subprocess``:
        ``EVENT_PROGRESS`` → ``job_store.record_progress``; ``EVENT_LOG`` →
        ``job_store.append_log``; ``EVENT_AGENT_RUN`` → ``job_store.save_agent_run``
        or ``append_agent_run_transcript`` (on stores that keep agent runs);
        ``EVENT_RESULT`` → captured as the return value; ``EVENT_ERROR`` →
        captured as the error return value.  Store errors are swallowed so a DB
        hiccup cannot abort an otherwise-healthy optimization.

        Args:
            optimization_id: ID the events are persisted under — the job itself,
                or a pair child's PARENT grid (the id the user watches).
            event_queue: The shared multiprocessing queue to drain.
            progress_rewrite: Optional ``(event_name, metrics) -> metrics`` hook
                applied before persisting a progress event; pair children use it
                to correct grid-wide counters their single-pair view can't know.
            source_optimization_id: Leased source row when events target a parent grid.
            generation: Source worker publication epoch.
            checkpoint_tracker: Mutable checkpoint cursor that receives the best
                completed candidate for each GEPA pair.

        Returns:
            ``(result_dict, error_dict, drained_count)`` — the first two may be
            ``None`` if the corresponding event was not present; ``drained_count``
            is the number of events consumed, used by the stall watchdog as the
            liveness signal (any event proves the child is still doing work).
        """
        result_payload: dict[str, Any] | None = None
        error_payload: dict[str, Any] | None = None
        drained_count = 0
        while True:
            try:
                event = event_queue.get_nowait()
            except queue.Empty:
                break
            except Exception:  # isolation boundary: a broken queue must not crash the job-processing loop
                logger.exception("Optimization %s: event queue read failed; stopping drain", optimization_id)
                break

            drained_count += 1
            event_type = event.get("type")
            if event_type == EVENT_PROGRESS:
                try:
                    metrics = event.get("metrics") or {}
                    if progress_rewrite is not None:
                        metrics = progress_rewrite(event.get("event"), metrics)
                    if checkpoint_tracker is not None:
                        planned_calls = planned_calls_from_progress(metrics)
                        if planned_calls is not None:
                            checkpoint_tracker["planned_calls"] = planned_calls
                        incumbent = evaluated_incumbent_from_progress(
                            event.get("event"),
                            metrics,
                            checkpoint_tracker.get("payload", {}),
                        )
                        if incumbent is not None:
                            pair_index = metrics.get("pair_index")
                            pair_key = (
                                pair_index
                                if isinstance(pair_index, int) and not isinstance(pair_index, bool)
                                else -1
                            )
                            incumbents = checkpoint_tracker.setdefault("_incumbents", {})
                            previous = incumbents.get(pair_key)
                            if previous is None or incumbent["selection_score"] > previous["selection_score"]:
                                incumbents[pair_key] = incumbent
                    fenced_progress = getattr(self._job_store, "record_progress_for_generation", None)
                    if generation is not None and callable(fenced_progress):
                        fenced_progress(
                            optimization_id,
                            event.get("event"),
                            metrics,
                            source_optimization_id=source_optimization_id or optimization_id,
                            generation=generation,
                        )
                    else:
                        self._job_store.record_progress(optimization_id, event.get("event"), metrics)
                except Exception:
                    logger.exception("Optimization %s: failed to persist subprocess progress event", optimization_id)
            elif event_type == EVENT_LOG:
                timestamp = None
                timestamp_raw = event.get("timestamp")
                if isinstance(timestamp_raw, str):
                    try:
                        timestamp = datetime.fromisoformat(timestamp_raw)
                    except ValueError:
                        timestamp = None
                pair_index_raw = event.get("pair_index")
                pair_index = int(pair_index_raw) if isinstance(pair_index_raw, int) else None
                try:
                    self._job_store.append_log(
                        optimization_id,
                        level=str(event.get("level", "INFO")),
                        logger_name=str(event.get("logger", "dspy")),
                        message=str(event.get("message", "")),
                        timestamp=timestamp,
                        pair_index=pair_index,
                    )
                except Exception:
                    logger.exception("Optimization %s: failed to persist subprocess log entry", optimization_id)
            elif event_type == EVENT_AGENT_RUN:
                self._persist_agent_run_event(optimization_id, event.get("run"))
            elif event_type == EVENT_RESULT:
                payload = event.get("result")
                if isinstance(payload, dict):
                    result_payload = payload
            elif event_type == EVENT_TERMINAL:
                payload = event.get("outcome")
                if isinstance(payload, dict):
                    result_payload = {"_terminal_outcome": payload}
            elif event_type == EVENT_ERROR:
                payload = {
                    "error": str(event.get("error", "Unknown subprocess error")),
                    "traceback": str(event.get("traceback", "")),
                    "error_type": str(event.get("error_type", "")),
                    "failure_kind": str(event.get("failure_kind", "")),
                }
                error_payload = payload

        return result_payload, error_payload, drained_count

    def _persist_agent_run_event(self, optimization_id: str, run: Any) -> None:
        """Store one agent run record or transcript delta, on stores that keep agent runs.

        Args:
            optimization_id: The job the run belongs to.
            run: The event's ``run`` payload.
        """
        if not isinstance(run, dict) or not isinstance(run.get("run_id"), int):
            return
        save_run = getattr(self._job_store, "save_agent_run", None)
        append_transcript = getattr(self._job_store, "append_agent_run_transcript", None)
        if save_run is None or append_transcript is None:
            return
        try:
            delta = run.get("transcript_delta")
            if isinstance(delta, str):
                append_transcript(optimization_id, run["run_id"], delta)
            else:
                save_run(optimization_id, run)
        except Exception:
            logger.exception("Optimization %s: failed to persist agent run %s", optimization_id, run.get("run_id"))

    def _checkpoints_enabled(self, optimization_type: str) -> bool:
        """Return whether this job is a GEPA run/grid on a checkpoint-capable store.

        Covers both a single GEPA run and a grid search — each grid pair is its
        own GEPA run that resumes from its own checkpoint. A store without
        checkpoint support falls through to the existing restart path.

        Args:
            optimization_type: The job's optimization type.

        Returns:
            ``True`` when the run should persist and restore GEPA checkpoints.
        """
        return optimization_type in (
            OPTIMIZATION_TYPE_RUN,
            OPTIMIZATION_TYPE_GRID_SEARCH,
            OPTIMIZATION_TYPE_BLACKBOX,
        ) and hasattr(self._job_store, "save_gepa_checkpoint")

    def _prepare_gepa_dir(self, optimization_id: str, *, is_grid: bool) -> Path:
        """Allocate a clean worker-owned GEPA base dir, seeding saved checkpoints for resume.

        The dir is wiped first so a stale state file from an earlier attempt of
        the same id can never trigger an unintended resume. A single run's seed
        lands at ``<base>/gepa_state.bin``; a grid's in-flight pairs each restore
        to ``<base>/pair_<i>/gepa_state.bin`` so they continue mid-GEPA. Completed
        grid pairs have no checkpoint (it was dropped when their result was
        stored) — they are skipped from the stored results instead.

        Args:
            optimization_id: The job whose directory is prepared.
            is_grid: Whether the job is a grid search (per-pair restore).

        Returns:
            The base path handed to the child as ``_gepa_log_dir``.
        """
        job = self._job_store.get_job(optimization_id)
        payload = job.get("payload") or {}
        base = Path(tempfile.gettempdir()) / "skynet-gepa" / f"{optimization_id}-g{job.get('execution_generation', 0)}"
        shutil.rmtree(base, ignore_errors=True)
        base.mkdir(parents=True, exist_ok=True)
        if is_grid:
            checkpoints = self._job_store.list_gepa_checkpoints(optimization_id)
            for cp in checkpoints:
                validate_checkpoint(cp.data, cp.manifest, payload, job.get("code_version"))
                pair_dir = base / f"pair_{cp.pair_index}"
                pair_dir.mkdir(parents=True, exist_ok=True)
                (pair_dir / GEPA_STATE_FILENAME).write_bytes(cp.data)
            if not checkpoints and (job.get("recovery") or {}).get("phase") == "resuming":
                raise ValueError("The checkpoint selected for recovery is no longer available.")
            if checkpoints:
                logger.info(
                    "Optimization %s: restored %d in-flight grid pair checkpoint(s) — resuming",
                    optimization_id,
                    len(checkpoints),
                )
        else:
            checkpoint = self._job_store.get_gepa_checkpoint(optimization_id)
            if checkpoint is None and (job.get("recovery") or {}).get("phase") == "resuming":
                raise ValueError("The checkpoint selected for recovery is no longer available.")
            if checkpoint is not None:
                validate_checkpoint(checkpoint.data, checkpoint.manifest, payload, job.get("code_version"))
                state_base = base / "gepa" if "strategy" in payload else base
                state_base.mkdir(parents=True, exist_ok=True)
                (state_base / GEPA_STATE_FILENAME).write_bytes(checkpoint.data)
                logger.info(
                    "Optimization %s: restored GEPA checkpoint (#%s, %d bytes) — resuming",
                    optimization_id,
                    checkpoint.iteration,
                    checkpoint.stored_bytes,
                )
        return base

    def _persist_gepa_checkpoint(
        self, optimization_id: str, gepa_dir: Path, tracker: dict[str, Any], *, is_grid: bool
    ) -> None:
        """Persist advanced GEPA state to the store (single run, or every grid pair).

        Single run: the one ``<dir>/gepa_state.bin`` (pair index -1). Grid: scan
        each ``<dir>/pair_<i>`` — a ``result.json`` means that pair finished, so its
        result is stored durably and its checkpoint dropped; otherwise its state
        file is persisted when it advances. mtime-gated so the multi-MB blob is
        written only on genuinely new state. Failures are swallowed.

        Args:
            optimization_id: The running job.
            gepa_dir: The worker-owned base directory.
            tracker: Per-key cursor (``pair_index -> {"mtime","n"}`` plus a
                ``"_results"`` set of finished pairs), carried across calls.
            is_grid: Whether to scan per-pair subdirs.
        """
        if not is_grid:
            state_base = gepa_dir / "gepa" if "strategy" in tracker.get("payload", {}) else gepa_dir
            self._persist_one_checkpoint(optimization_id, state_base / GEPA_STATE_FILENAME, -1, tracker)
            return
        results_done: set[int] = tracker.setdefault("_results", set())
        try:
            pair_dirs = sorted(gepa_dir.glob("pair_*"))
        except OSError:
            return
        for pair_dir in pair_dirs:
            try:
                idx = int(pair_dir.name.split("_", 1)[1])
            except (ValueError, IndexError):
                continue
            if idx in results_done:
                continue
            if (pair_dir / GRID_PAIR_RESULT_FILENAME).exists():
                if self._store_grid_pair_result(
                    optimization_id,
                    idx,
                    pair_dir / GRID_PAIR_RESULT_FILENAME,
                    expected_generation=tracker.get("generation"),
                ):
                    self._persist_one_checkpoint(optimization_id, pair_dir / GEPA_STATE_FILENAME, idx, tracker)
                    results_done.add(idx)
                continue
            self._persist_one_checkpoint(optimization_id, pair_dir / GEPA_STATE_FILENAME, idx, tracker)

    def _persist_one_checkpoint(
        self, optimization_id: str, state_path: Path, pair_index: int, tracker: dict[str, Any]
    ) -> None:
        """Persist one run/pair's ``gepa_state.bin`` when its mtime has advanced.

        Args:
            optimization_id: The running job.
            state_path: Path to this run/pair's state file.
            pair_index: ``-1`` for a single run, else the grid pair index.
            tracker: Shared cursor; this pair's ``{"mtime","n","metric_calls"}``
                sub-entry is created and updated in place.
        """
        try:
            mtime = state_path.stat().st_mtime
        except OSError:
            return
        cursor = tracker.setdefault(pair_index, {"mtime": None, "n": 0})
        if mtime == cursor.get("mtime"):
            return
        try:
            data = state_path.read_bytes()
        except OSError:
            return
        if not data:
            return
        try:
            manifest = checkpoint_manifest(data, tracker.get("payload", {}), tracker.get("code_version"))
            incumbent = tracker.get("_incumbents", {}).get(pair_index)
            if incumbent is not None:
                manifest["evaluated_incumbent"] = incumbent
            plan_builder = tracker.get("recovery_plan_builder")
            if callable(plan_builder):
                manifest["recovery_admission"] = plan_builder(
                    manifest,
                    runtime=str(tracker.get("execution_runtime", "vercel")),
                )
            next_n = manifest["iteration"]
            self._job_store.save_gepa_checkpoint(
                optimization_id,
                data,
                next_n,
                pair_index,
                manifest=manifest,
                expected_generation=tracker.get("generation"),
            )
        except Exception:
            logger.exception("Optimization %s pair %s: failed to persist GEPA checkpoint", optimization_id, pair_index)
            return
        cursor["mtime"] = mtime
        cursor["n"] = next_n
        cursor["metric_calls"] = manifest["metric_calls"]

    def _store_grid_pair_result(
        self, optimization_id: str, pair_index: int, result_path: Path, *, expected_generation: int | None = None
    ) -> bool:
        """Durably store a finished grid pair's result and drop its checkpoint.

        Args:
            optimization_id: The running grid job.
            pair_index: The finished pair's index.
            result_path: The pair's ``result.json`` written by the child.
            expected_generation: Current worker publication generation.

        Returns:
            ``True`` when the result was stored (so the caller stops re-reading it).
        """
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        try:
            self._job_store.save_grid_pair_result(
                optimization_id, pair_index, result, expected_generation=expected_generation
            )
        except Exception:
            logger.exception("Optimization %s pair %s: failed to persist pair result", optimization_id, pair_index)
            return False
        return True

    def _should_distribute_grid(self, optimization_id: str, grid_payload: GridSearchRequest) -> bool:
        """Decide whether a claimed grid fans out into per-pair jobs.

        Multi-pair grids distribute when the flag is on and the store supports
        pair rows. A parent that ALREADY has children takes the distributed
        path regardless of the flag — flipping the flag mid-flight must never
        strand or double-run a grid that started distributed.

        Args:
            optimization_id: The claimed grid parent.
            grid_payload: Its validated payload.

        Returns:
            ``True`` when the grid should run as distributed pair jobs.
        """
        if grid_payload.execution_budget_id is not None:
            return False
        if not hasattr(self._job_store, "create_grid_pair_jobs"):
            return False
        total = len(grid_payload.generation_models) * len(grid_payload.reflection_models)
        if total <= 1:
            return False
        if settings.grid_distributed_pairs:
            return True
        try:
            return bool(self._job_store.get_grid_pair_children(optimization_id))
        except Exception:
            return False

    def _fan_out_grid(self, optimization_id: str, grid_payload: GridSearchRequest, overview: dict[str, Any]) -> None:
        """Fan a claimed grid parent out into claimable per-pair jobs.

        First claim: creates one child row per (generation, reflection) pair
        and parks the parent at ``running`` (atomically, in the store). Reclaim
        after a resume/crash: re-pends every child that hasn't succeeded —
        their own checkpoints give per-pair resume — then re-parks the parent.
        The child-requeue happens BEFORE the parent flip so a crash between
        the two leaves the parent claimable and the sequence simply re-runs.

        Args:
            optimization_id: The claimed grid parent.
            grid_payload: Its validated payload.
            overview: The parent's payload overview (token source, username).
        """
        store = self._job_store
        total = len(grid_payload.generation_models) * len(grid_payload.reflection_models)
        children = store.get_grid_pair_children(optimization_id)
        requeued = 0
        if children:
            for child in children:
                if child.get("status") != "success":
                    store.requeue_for_resume(child["optimization_id"], bump_attempts=False)
                    requeued += 1
        child_overview = {
            PAYLOAD_OVERVIEW_OPTIMIZATION_TYPE: OPTIMIZATION_TYPE_GRID_SEARCH,
            PAYLOAD_OVERVIEW_USERNAME: overview.get(PAYLOAD_OVERVIEW_USERNAME) or grid_payload.username or "",
            PAYLOAD_OVERVIEW_TOKEN_SOURCE: overview.get(PAYLOAD_OVERVIEW_TOKEN_SOURCE) or TOKEN_SOURCE_MANAGED,
            PAYLOAD_OVERVIEW_NAME: overview.get(PAYLOAD_OVERVIEW_NAME) or "",
        }
        child_ids = store.create_grid_pair_jobs(
            optimization_id,
            total,
            username=grid_payload.username,
            payload_overview=child_overview,
        )
        if children:
            logger.info(
                "Grid %s resumed as distributed pairs: %d/%d children re-queued",
                optimization_id,
                requeued,
                len(children),
            )
        else:
            logger.info("Grid %s distributed into %d pair jobs", optimization_id, len(child_ids))

    def _derive_pair_payload(
        self, parent_optimization_id: str, pair_index: int
    ) -> tuple[dict[str, Any], GridSearchRequest] | None:
        """Build a pair child's real single-pair payload from its parent row.

        The child row stores only a tiny reference; the dataset and every other
        field live once, on the parent. Pair enumeration matches
        ``run_grid_search`` exactly (generation-major), so ``pair_index``
        selects the same (generation, reflection) combination the classic
        in-child path would have run.

        Args:
            parent_optimization_id: The grid parent to derive from.
            pair_index: This child's global pair index.

        Returns:
            ``(payload_dict, validated_payload)`` ready for the normal job
            pipeline, or ``None`` when the parent is gone / not running /
            malformed — the child must then cancel itself without spending.
        """
        try:
            parent = self._job_store.get_job(parent_optimization_id)
        except KeyError:
            return None
        except Exception:
            logger.exception("Pair child of %s: failed to load parent", parent_optimization_id)
            return None
        if parent.get("status") != "running":
            return None
        parent_payload = parent.get("payload")
        if not isinstance(parent_payload, dict):
            return None
        raw_gens = parent_payload.get("generation_models") or []
        raw_refs = parent_payload.get("reflection_models") or []
        total = len(raw_gens) * len(raw_refs)
        if not raw_refs or not 0 <= pair_index < total:
            return None
        child_dict = dict(parent_payload)
        child_dict["generation_models"] = [raw_gens[pair_index // len(raw_refs)]]
        child_dict["reflection_models"] = [raw_refs[pair_index % len(raw_refs)]]
        # Consumed by the spawn wiring in _process_job; pydantic ignores it.
        child_dict["_parent_total_pairs"] = total
        try:
            return child_dict, GridSearchRequest.model_validate(child_dict)
        except Exception:
            logger.exception("Pair child of %s: derived payload failed validation", parent_optimization_id)
            return None

    def _pair_progress_rewrite(self, parent_optimization_id: str) -> Any:
        """Build the progress-metric corrector for one pair child's events.

        A pair child's single-pair view reports ``completed_so_far=1`` /
        ``failed_so_far=0-or-1``; the dashboard needs grid-wide counters, so
        the pair-terminal events get them recomputed from sibling statuses
        (plus this event's own outcome — the emitting child is not terminal
        in the DB yet). Only the two pair-terminal events are touched.

        Args:
            parent_optimization_id: The grid parent whose siblings are counted.

        Returns:
            A ``(event_name, metrics) -> metrics`` callable for the drain.
        """

        def rewrite(event_name: Any, metrics: dict[str, Any]) -> dict[str, Any]:
            """Patch grid-wide counters onto pair-terminal events."""
            if event_name not in (PROGRESS_GRID_PAIR_COMPLETED, PROGRESS_GRID_PAIR_FAILED):
                return metrics
            try:
                siblings = self._job_store.get_grid_pair_children(parent_optimization_id)
            except Exception:
                return metrics
            done_ok = sum(1 for s in siblings if s.get("status") == "success")
            done_bad = sum(1 for s in siblings if s.get("status") in ("failed", "cancelled"))
            if event_name == PROGRESS_GRID_PAIR_COMPLETED:
                done_ok += 1
            else:
                done_bad += 1
            return {**metrics, "completed_so_far": done_ok, "failed_so_far": done_bad}

        return rewrite

    def _record_pair_outcome(self, parent_optimization_id: str, result_dict: dict[str, Any]) -> None:
        """Durably record a pair child's outcome onto its parent grid.

        Stores the child's single ``PairResult`` (success OR soft-failure —
        both carry the global ``pair_index``) plus the grid envelope (split
        counts, metric/module names) the finalizer needs. Runs BEFORE the
        child's terminal status write so a crash between the two can only
        lose the status (the sweeper re-runs the child), never the result.

        Args:
            parent_optimization_id: The grid parent to record onto.
            result_dict: The child's serialized 1-pair ``GridSearchResponse``.
        """
        try:
            pair_rows = result_dict.get("pair_results") or []
            pair_row = pair_rows[0] if pair_rows and isinstance(pair_rows[0], dict) else None
            if pair_row is None:
                return
            self._job_store.save_grid_pair_result(
                parent_optimization_id, int(pair_row.get("pair_index") or 0), pair_row
            )
            self._job_store.save_grid_pair_result(
                parent_optimization_id,
                GRID_ENVELOPE_PAIR_INDEX,
                {
                    "split_counts": result_dict.get("split_counts"),
                    "metric_name": result_dict.get("metric_name"),
                    "module_name": result_dict.get("module_name"),
                    "optimizer_name": result_dict.get("optimizer_name"),
                },
            )
        except Exception:
            logger.exception("Pair child of %s: failed to record pair outcome", parent_optimization_id)

    def _maybe_finalize_grid(self, parent_optimization_id: str) -> None:
        """Assemble and complete a distributed grid once every pair is terminal.

        Runs after every pair child's terminal transition (and from the
        stuck-grid backstop). No-ops unless ALL siblings are terminal and the
        parent is still ``running``. The terminal write is CAS-guarded against
        ``running`` so two racing finalizers (or a finalize racing a cancel)
        produce exactly one outcome, and the notification + credit debit ride
        the same once-only completion claim as a classic job.
        """
        store = self._job_store
        if not hasattr(store, "get_grid_pair_children"):
            return
        try:
            children = store.get_grid_pair_children(parent_optimization_id)
            if not children:
                return
            if any(c.get("status") not in _PAIR_TERMINAL_STATUSES for c in children):
                return
            parent = store.get_job(parent_optimization_id)
        except KeyError:
            return
        except Exception:
            logger.exception("Grid %s: finalize pre-check failed", parent_optimization_id)
            return
        if parent.get("status") != "running":
            return

        try:
            result_dict, final_status, final_message = self._assemble_grid_result(parent, children)
        except Exception:
            logger.exception("Grid %s: result assembly failed", parent_optimization_id)
            result_dict = None
            final_status = "failed"
            final_message = "Grid finalization failed; see worker logs"

        completion_fields: dict[str, Any] = {
            "status": final_status,
            "message": final_message,
            "completed_at": datetime.now(UTC).isoformat(),
            "result": result_dict,
        }
        if final_status == "stopped":
            pair_rows = (result_dict or {}).get("pair_results", [])
            available = any(p.get("result_availability") == "evaluated" or p.get("program_artifact") for p in pair_rows)
            completion_fields.update(
                stop_reason="budget_reached",
                result_availability="evaluated" if available else "none",
                terminal_evidence={
                    "candidate_origin": None,
                    "final_evaluation_completed": False,
                    "final_evaluation_reason": "budget_reached",
                },
            )
        cas = getattr(store, "update_job_if_status", None)
        if cas is not None:
            if not cas(parent_optimization_id, ("running",), **completion_fields):
                return
        else:
            store.update_job(parent_optimization_id, **completion_fields)
        logger.info("Grid %s finalized: status=%s", parent_optimization_id, final_status)
        # NOTE: unlike the in-child grid path, the parent's stored pair
        # results are KEPT after success — they are the durable per-pair
        # archive that seeds targeted re-runs and resumes.

        overview = parent.get("payload_overview", {})
        if isinstance(overview, str):
            with contextlib.suppress(Exception):
                overview = json.loads(overview)
        if not isinstance(overview, dict):
            overview = {}
        _username = overview.get(PAYLOAD_OVERVIEW_USERNAME, "")
        if store.claim_completion_notification(parent_optimization_id):
            notify_job_completed(
                optimization_id=parent_optimization_id,
                username=_username,
                status=final_status,
                message=final_message,
            )
            self._record_run_outcome(parent_optimization_id, _username, final_status, overview)
            if final_status == "success" and isinstance(result_dict, dict) and not parent.get("execution_budget_id"):
                billed = self._debit_run_credits(
                    _username,
                    result_dict,
                    optimization_id=parent_optimization_id,
                    run_name=overview.get(PAYLOAD_OVERVIEW_NAME) or "",
                    model=overview.get(PAYLOAD_OVERVIEW_MODEL_NAME),
                    token_source=overview.get(PAYLOAD_OVERVIEW_TOKEN_SOURCE) or TOKEN_SOURCE_MANAGED,
                    token_sources_by_model=overview.get(PAYLOAD_OVERVIEW_TOKEN_SOURCES_BY_MODEL),
                )
                self._stamp_billing_outcome(
                    parent_optimization_id,
                    result_dict,
                    billed=billed,
                    estimated_low=overview.get(PAYLOAD_OVERVIEW_ESTIMATED_LOW),
                    estimated_high=overview.get(PAYLOAD_OVERVIEW_ESTIMATED_HIGH),
                )
        if final_status == "success":
            self._schedule_embedding_indexing(parent_optimization_id)

    def _assemble_grid_result(
        self, parent: dict[str, Any], children: list[dict[str, Any]]
    ) -> tuple[dict[str, Any], str, str]:
        """Rebuild the parent ``GridSearchResponse`` from stored pair outcomes.

        Mirrors the tail of ``run_grid_search``: stored ``PairResult`` rows are
        taken verbatim; a child that died without recording one (hard crash,
        cancel, attempts exhausted) synthesizes an errored pair from its row so
        every index is accounted for — a grid can complete with missing pairs
        only as explicit failures, never silently.

        Args:
            parent: The parent ``JobRecord`` (payload included).
            children: The terminal pair-child rows.

        Returns:
            ``(result_dict, final_status, final_message)`` for the parent's
            terminal write.
        """
        store = self._job_store
        parent_id = str(parent.get("optimization_id"))
        payload = parent.get("payload") if isinstance(parent.get("payload"), dict) else {}
        raw_gens = payload.get("generation_models") or []
        raw_refs = payload.get("reflection_models") or []
        total = len(raw_gens) * len(raw_refs) if raw_gens and raw_refs else len(children)

        stored = dict(store.get_grid_pair_results(parent_id))
        envelope = stored.pop(GRID_ENVELOPE_PAIR_INDEX, None) or {}
        children_by_index = {int(c.get("pair_index") or 0): c for c in children}

        pair_results: list[PairResult] = []
        for k in range(total):
            raw = stored.get(k)
            if isinstance(raw, dict):
                pair_results.append(PairResult.model_validate(raw))
                continue
            gen_name = ""
            ref_name = ""
            if raw_refs:
                gen_raw = raw_gens[k // len(raw_refs)] if k // len(raw_refs) < len(raw_gens) else {}
                ref_raw = raw_refs[k % len(raw_refs)]
                gen_name = str(gen_raw.get("name") or "") if isinstance(gen_raw, dict) else ""
                ref_name = str(ref_raw.get("name") or "") if isinstance(ref_raw, dict) else ""
            child = children_by_index.get(k, {})
            if child.get("status") == "stopped":
                availability = child.get("result_availability")
                pair_results.append(
                    PairResult(
                        pair_index=k,
                        generation_model=gen_name,
                        reflection_model=ref_name,
                        stop_reason="budget_reached",
                        result_availability="evaluated" if availability == "evaluated" else "none",
                        terminal_evidence=child.get("terminal_evidence"),
                    )
                )
                continue
            if child.get("status") == "cancelled":
                error = "Pair cancelled"
            else:
                error = str(child.get("message") or "Pair failed without a recorded result")
            pair_results.append(
                PairResult(pair_index=k, generation_model=gen_name, reflection_model=ref_name, error=error)
            )

        successful = [p for p in pair_results if p.error is None and p.optimized_test_metric is not None]
        best_pair = (
            max(
                successful,
                key=lambda p: p.optimized_test_metric if p.optimized_test_metric is not None else float("-inf"),
            )
            if successful
            else None
        )
        completed_count = len([p for p in pair_results if p.error is None and p.stop_reason != "budget_reached"])
        failed_count = len([p for p in pair_results if p.error is not None])
        pair_token_counts = [p.total_tokens for p in pair_results if p.total_tokens is not None]
        runtime_seconds: float | None = None
        started_raw = parent.get("started_at")
        if isinstance(started_raw, str):
            with contextlib.suppress(ValueError):
                started = datetime.fromisoformat(started_raw)
                # SQLite round-trips naive timestamps; the rows are UTC either way.
                if started.tzinfo is None:
                    started = started.replace(tzinfo=UTC)
                runtime_seconds = round((datetime.now(UTC) - started).total_seconds(), 2)
        split_raw = envelope.get("split_counts")
        split_counts = (
            SplitCounts.model_validate(split_raw)
            if isinstance(split_raw, dict)
            else SplitCounts(train=0, val=0, test=0)
        )
        response = GridSearchResponse(
            module_name=str(envelope.get("module_name") or payload.get("module_name") or ""),
            optimizer_name=str(envelope.get("optimizer_name") or payload.get("optimizer_name") or ""),
            metric_name=envelope.get("metric_name"),
            split_counts=split_counts,
            total_pairs=total,
            completed_pairs=completed_count,
            failed_pairs=failed_count,
            stopped_pairs=sum(p.stop_reason == "budget_reached" for p in pair_results),
            pair_results=pair_results,
            best_pair=best_pair,
            runtime_seconds=runtime_seconds,
            total_tokens=sum(pair_token_counts) if pair_token_counts else None,
            usage_by_model=_merge_usage_rows([row for p in pair_results for row in p.usage_by_model]),
        )

        final_status = "success"
        final_message = "Optimization completed successfully"
        if response.stopped_pairs and not failed_count:
            final_status = "stopped"
            final_message = "The remaining budget cannot cover the requested grid work."
        elif failed_count and response.stopped_pairs:
            final_status = "failed"
            final_message = "Some model pairs failed before the budget stop."
        elif completed_count == 0 and total > 0:
            final_status = "failed"
            final_message = f"All {total} model pairs failed"
            first_error = next((p.error for p in pair_results if p.error), None)
            if first_error:
                final_message = f"{final_message}: {first_error}"
        return response.model_dump(mode="json"), final_status, final_message

    def _finalize_stuck_grids(self) -> None:
        """Backstop: finalize grids whose last pair finisher died mid-handoff.

        The normal finalizer is the last pair child to reach a terminal
        status; if that pod crashed between the child's status write and the
        parent assembly, the grid would sit at ``running`` with nothing left
        to run. Idle workers sweep for exactly that shape and finish the job.
        """
        lister = getattr(self._job_store, "list_finalizable_grid_parents", None)
        if lister is None:
            return
        try:
            parents = lister()
        except Exception:
            logger.exception("Stuck-grid sweep failed")
            return
        for parent_id in parents:
            with contextlib.suppress(Exception):
                self._maybe_finalize_grid(parent_id)

    def seconds_since_last_activity(self) -> float | None:
        """Return seconds since the most recent worker activity, or ``None`` if none recorded yet.

        Returns:
            Seconds since any worker last touched its activity timestamp.
        """
        with self._activity_lock:
            if not self._last_activity:
                return None
            latest = max(self._last_activity.values())
        return time.monotonic() - latest

    def dump_thread_stacks(self) -> str:
        """Return formatted stack traces of all worker threads, suitable for logging when diagnosing stuck workers.

        Returns:
            A multi-line string with the current frame of each worker thread.
        """
        frames = sys._current_frames()
        lines = []
        for thread in self._threads:
            frame = frames.get(thread.ident) if thread.ident is not None else None
            if frame:
                lines.append(f"--- {thread.name} (alive={thread.is_alive()}) ---")
                lines.extend(traceback.format_stack(frame))
            else:
                lines.append(f"--- {thread.name} (no frame, alive={thread.is_alive()}) ---")
        return "\n".join(lines)

    def threads_alive(self) -> bool:
        """Return True if the worker has at least one registered thread and every one is alive.

        Returns:
            ``True`` only when every spawned worker thread is still running.
        """
        if not self._threads:
            return False
        return all(t.is_alive() for t in self._threads)

    def cancel_job(self, optimization_id: str) -> bool:
        """Signal a job to stop. Returns True if the job was found (pending or currently running).

        Args:
            optimization_id: ID of the job to cancel.

        Returns:
            ``True`` if a pending or running job was found, ``False`` otherwise.
        """
        with self._queue_lock:
            event = self._cancel_events.get(optimization_id)
            if event:
                event.set()
            if optimization_id in self._pending_jobs:
                self._pending_jobs.remove(optimization_id)
                # Pending jobs never reach _mark_job_done; clean up event here.
                self._cancel_events.pop(optimization_id, None)
                return True
        return event is not None

    def queue_size(self) -> int:
        """Return the number of jobs waiting to be processed.

        Returns:
            Length of the pending queue at the moment the lock is held.
        """
        with self._queue_lock:
            return len(self._pending_jobs)

    def active_jobs(self) -> int:
        """Return the number of jobs currently being processed.

        Returns:
            Size of the processing set at the moment the lock is held.
        """
        with self._queue_lock:
            return len(self._processing_jobs)

    def thread_count(self) -> int:
        """Return the number of registered worker threads (alive or finished).

        Returns:
            Length of the internal thread list.
        """
        return len(self._threads)


_worker: BackgroundWorker | None = None
_worker_lock = threading.Lock()


def get_worker(
    job_store: JobStore,
    service: DspyService | None = None,
    pending_optimization_ids: list | None = None,
) -> BackgroundWorker:
    """Return the module-level singleton ``BackgroundWorker``, creating it if needed.

    If the current singleton is missing or its threads have died a new worker is
    constructed from ``settings.worker_threads`` / ``settings.worker_poll_interval``
    and started. With the DB-backed claim queue, ``pending_optimization_ids``
    is no longer required — pending rows are picked up automatically by the
    next claim — but the parameter is preserved (and used as a local hint) so
    callers don't have to coordinate the upgrade.

    Args:
        job_store: Backend used by the worker to persist job state.
        service: Optional pre-built ``DspyService`` shared with the worker.
        pending_optimization_ids: Optional local hint for jobs already known
            to be pending (eg. recovered on the same pod's restart).

    Returns:
        The module-level worker singleton.
    """
    global _worker

    with _worker_lock:
        if _worker is None or not _worker.threads_alive():
            num_workers = settings.worker_threads
            poll_interval = settings.worker_poll_interval
            _worker = BackgroundWorker(
                job_store=job_store,
                num_workers=num_workers,
                poll_interval=poll_interval,
                service=service,
            )
            _worker.start()
            for optimization_id in pending_optimization_ids or []:
                _worker.enqueue_job(optimization_id)

    return _worker


def reset_worker_for_tests(timeout: float = 5.0) -> None:
    """Stop and clear the module-level worker singleton (test-only helper).

    Calls ``stop`` on the existing singleton (swallowing any shutdown error so
    the next test is not blocked) and then resets the module-level reference to
    ``None`` so the next ``get_worker`` call constructs a fresh instance.

    Args:
        timeout: Seconds shared across worker thread joins during shutdown.
    """
    global _worker
    with _worker_lock:
        if _worker is not None:
            try:
                _worker.stop(timeout=timeout)
            except Exception:  # isolation boundary: a failing shutdown must not block subsequent tests
                logger.exception("Failed to stop global worker during test reset")
        _worker = None
