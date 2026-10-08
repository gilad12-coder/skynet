"""In-run email triggers: milestones and live progress for one running job.

The worker feeds every persisted progress event and periodic spend reading of
a run to one :class:`RunNotificationWatcher`. The watcher applies the owner's
cadence (see :mod:`core.notifications.preferences`) and sends each email kind
at most once per run: the once-only guard is a durable claim on the job row
(``JobStore.claim_job_notification``), not process memory, so a resumed or
orphan-recovered run never re-sends what an earlier attempt already sent.
Only the trigger bookkeeping (best score, evaluations since improvement) is
in memory; after a restart it re-baselines from the next events, which can
delay a stuck email but never duplicate one.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections.abc import Callable
from typing import Any

from ..constants import (
    PROGRESS_BASELINE,
    PROGRESS_CANDIDATE,
    PROGRESS_EVALUATION_STARTED,
    PROGRESS_LANE_STARTED,
    PROGRESS_OPTIMIZER,
    PROGRESS_SPLITS_READY,
    TQDM_N_KEY,
    TQDM_TOTAL_KEY,
)
from .notifier import (
    notify_run_budget,
    notify_run_needs_input,
    notify_run_new_best,
    notify_run_progress,
    notify_run_stuck,
)
from .preferences import RunNotificationSettings, run_notification_settings

logger = logging.getLogger(__name__)

# Spend is read from the billing ledger, so the worker polls it on this cadence
# instead of on every poll tick.
SPEND_CHECK_INTERVAL_SECONDS = 30.0

_STAGE_BY_EVENT = {
    PROGRESS_SPLITS_READY: "prepared",
    PROGRESS_BASELINE: "baseline",
    PROGRESS_OPTIMIZER: "optimizing",
    PROGRESS_CANDIDATE: "optimizing",
    PROGRESS_EVALUATION_STARTED: "evaluating",
}


def _dispatch_in_background(send: Callable[..., None], *args: Any, **kwargs: Any) -> None:
    """Send one email on a daemon thread so SMTP latency never stalls the worker poll loop.

    Args:
        send: Notifier function to run.
        *args: Positional arguments for ``send``.
        **kwargs: Keyword arguments for ``send``.
    """
    threading.Thread(target=send, args=args, kwargs=kwargs, name="run-notify", daemon=True).start()


def _finite_number(value: Any) -> float | None:
    """Return ``value`` as a float when it is a finite non-bool number.

    Args:
        value: Candidate metric value.

    Returns:
        The float value, or ``None`` for anything else.
    """
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


class RunNotificationWatcher:
    """Decide and send the in-run emails of one job."""

    def __init__(
        self,
        *,
        optimization_id: str,
        username: str,
        job_store: Any,
        settings: RunNotificationSettings | None,
        dispatch: Callable[..., None] = _dispatch_in_background,
        clock: Callable[[], float] = time.time,
    ) -> None:
        """Bind the watcher to a run.

        Args:
            optimization_id: The job the user watches (a grid parent for pairs).
            username: Owner and email recipient.
            job_store: Store providing ``claim_job_notification``.
            settings: The owner's cadence, or ``None`` when job mail is off.
            dispatch: ``(send, *args, **kwargs)`` runner for one email.
            clock: Wall-clock source in seconds; digest windows are wall-clock
                aligned so restarted workers agree on them.
        """
        self._optimization_id = optimization_id
        self._username = username
        self._job_store = job_store
        self._settings = settings
        self._dispatch = dispatch
        self._clock = clock
        self._best: float | None = None
        self._last_improvement_calls = 0
        self._done_calls = 0
        self._planned_calls: int | None = None
        self._stage: str | None = None
        self._stage_detail: str | None = None
        self._last_digest_window: int | None = None
        self._next_spend_check = 0.0

    @classmethod
    def for_run(cls, optimization_id: str, username: str | None, job_store: Any) -> RunNotificationWatcher | None:
        """Build a watcher when the owner's cadence sends any in-run email.

        Args:
            optimization_id: The job the user watches.
            username: Owner and recipient; ``None`` disables the watcher.
            job_store: Store providing ``claim_job_notification``.

        Returns:
            A watcher, or ``None`` when no in-run email could ever be sent.
        """
        if not username:
            return None
        settings = run_notification_settings(username)
        if settings is None or not settings.milestones:
            return None
        return cls(optimization_id=optimization_id, username=username, job_store=job_store, settings=settings)

    @property
    def _active(self) -> bool:
        """Whether any milestone mail is enabled for this run."""
        return self._settings is not None and self._settings.milestones

    def _claim(self, claim: str, *, cap_prefix: str | None = None, cap: int | None = None) -> bool:
        """Win the durable once-per-run claim for one email kind.

        Args:
            claim: Email kind identifier stored on the job row.
            cap_prefix: Prefix counted against ``cap``.
            cap: Maximum claims with ``cap_prefix`` for this run.

        Returns:
            Whether this caller should send the email. A store without claim
            support, or a failing one, sends nothing rather than risk repeats.
        """
        claim_fn = getattr(self._job_store, "claim_job_notification", None)
        if not callable(claim_fn):
            return False
        try:
            return bool(claim_fn(self._optimization_id, claim, cap_prefix=cap_prefix, cap=cap))
        except Exception:
            logger.warning("Run notification claim %s failed for %s", claim, self._optimization_id, exc_info=True)
            return False

    def observe_progress(self, event_name: Any, metrics: Any) -> None:
        """Feed one persisted progress event; never raises.

        Args:
            event_name: Progress event discriminator.
            metrics: The event's metrics mapping.
        """
        if not self._active or not isinstance(metrics, dict):
            return
        try:
            self._observe(event_name, metrics)
        except Exception:
            logger.warning("Run notification check failed for %s", self._optimization_id, exc_info=True)

    def _observe(self, event_name: Any, metrics: dict[str, Any]) -> None:
        """Update trigger state from one event and send whatever it unlocks.

        Args:
            event_name: Progress event discriminator.
            metrics: The event's metrics mapping.
        """
        settings = self._settings
        assert settings is not None
        total = metrics.get(TQDM_TOTAL_KEY)
        if isinstance(total, int) and not isinstance(total, bool) and total > 0:
            self._planned_calls = total
            done = metrics.get(TQDM_N_KEY)
            if isinstance(done, int) and not isinstance(done, bool) and done > self._done_calls:
                self._done_calls = done

        if event_name == PROGRESS_CANDIDATE:
            self._observe_candidate(metrics)

        planned = self._planned_calls
        if (
            planned
            and self._best is not None
            and self._done_calls - self._last_improvement_calls >= settings.stuck_fraction * planned
            and self._claim("stuck")
        ):
            self._dispatch(notify_run_stuck, self._optimization_id, self._username, self._best, settings.stuck_fraction)

        if settings.live:
            self._observe_stage(event_name, metrics)

    def _observe_candidate(self, metrics: dict[str, Any]) -> None:
        """Track the best score and mail the first improvement over the starting one.

        Args:
            metrics: A ``candidate`` event's metrics.
        """
        score = _finite_number(metrics.get("score"))
        if score is None:
            return
        discovered = metrics.get("discovered_at_evals")
        if isinstance(discovered, int) and not isinstance(discovered, bool) and discovered > self._done_calls:
            self._done_calls = discovered
        if self._best is None:
            # The first scored version (the seed, or the incumbent after a
            # resume) is the reference point, not an improvement.
            self._best = score
            self._last_improvement_calls = self._done_calls
            return
        if score <= self._best:
            return
        self._best = score
        self._last_improvement_calls = self._done_calls
        if self._claim("new_best"):
            self._dispatch(notify_run_new_best, self._optimization_id, self._username, score)

    def _observe_stage(self, event_name: Any, metrics: dict[str, Any]) -> None:
        """Send live progress mail on stage changes, throttled by ``live_mode``.

        Args:
            event_name: Progress event discriminator.
            metrics: The event's metrics mapping.
        """
        settings = self._settings
        assert settings is not None
        stage_id: str | None = None
        detail: str | None = None
        if event_name == PROGRESS_LANE_STARTED:
            engine = metrics.get("engine")
            detail = engine if isinstance(engine, str) and engine else None
            stage_id = f"optimizing:{detail or ''}:{metrics.get('phase') or ''}"
        elif event_name in _STAGE_BY_EVENT:
            stage_id = _STAGE_BY_EVENT[event_name]
            # Per-step optimizer/candidate events only mark entering the
            # optimizing stage; they keep a lane's own stage and never move a
            # run that reached final evaluation back to "optimizing".
            if stage_id == "optimizing" and self._stage not in (None, "prepared", "baseline"):
                stage_id = None

        if settings.live_mode == "digest":
            if stage_id is not None:
                self._stage, self._stage_detail = stage_id, detail
            self._maybe_send_digest()
            return
        if stage_id is None or stage_id == self._stage:
            return
        self._stage, self._stage_detail = stage_id, detail
        if settings.live_mode == "per_run_count":
            claimed = self._claim(f"stage:{stage_id}", cap_prefix="stage:", cap=settings.live_count)
        else:
            claimed = self._claim(f"stage:{stage_id}")
        if claimed:
            self._dispatch(
                notify_run_progress,
                self._optimization_id,
                self._username,
                stage_id.split(":", 1)[0],
                detail=detail,
                best_score=self._best,
            )

    def _maybe_send_digest(self) -> None:
        """Send at most one progress digest per ``digest_minutes`` wall-clock window."""
        settings = self._settings
        assert settings is not None
        if self._stage is None:
            return
        window = int(self._clock() // (settings.digest_minutes * 60))
        if window == self._last_digest_window:
            return
        self._last_digest_window = window
        if self._claim(f"digest:{window}"):
            self._dispatch(
                notify_run_progress,
                self._optimization_id,
                self._username,
                self._stage.split(":", 1)[0],
                detail=self._stage_detail,
                best_score=self._best,
                digest=True,
            )

    def spend_check_due(self) -> bool:
        """Return whether the worker should read the run's spend now (rate-limited).

        Returns:
            ``True`` at most once per :data:`SPEND_CHECK_INTERVAL_SECONDS`.
        """
        if not self._active:
            return False
        now = time.monotonic()
        if now < self._next_spend_check:
            return False
        self._next_spend_check = now + SPEND_CHECK_INTERVAL_SECONDS
        return True

    def observe_spend(self, spent_cents: float, limit_cents: int | None) -> None:
        """Mail once when spend reaches the alert fraction of the spending limit.

        Args:
            spent_cents: Cents settled by the run so far.
            limit_cents: The run's spending limit, or ``None`` when uncapped.
        """
        settings = self._settings
        if not self._active or settings is None or not limit_cents or limit_cents <= 0:
            return
        if spent_cents >= settings.budget_alert_fraction * limit_cents and self._claim("budget"):
            self._dispatch(notify_run_budget, self._optimization_id, self._username, spent_cents, limit_cents)

    def notify_needs_input(self) -> None:
        """Mail once when the run paused and waits for the owner to act."""
        if self._active and self._claim("needs_input"):
            self._dispatch(notify_run_needs_input, self._optimization_id, self._username)
