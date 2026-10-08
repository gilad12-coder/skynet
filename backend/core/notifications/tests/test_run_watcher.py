"""Tests for the in-run email triggers in ``core.notifications.run_watcher``."""

from __future__ import annotations

from typing import Any

import pytest

import core.notifications.run_watcher as watcher_module
from core.constants import (
    PROGRESS_BASELINE,
    PROGRESS_CANDIDATE,
    PROGRESS_EVALUATION_STARTED,
    PROGRESS_LANE_STARTED,
    PROGRESS_OPTIMIZER,
    TQDM_N_KEY,
    TQDM_TOTAL_KEY,
)
from core.notifications.notifier import (
    notify_run_budget,
    notify_run_needs_input,
    notify_run_new_best,
    notify_run_progress,
    notify_run_stuck,
)
from core.notifications.preferences import RunNotificationSettings
from core.notifications.run_watcher import RunNotificationWatcher

_JOB = "run-1"
_USER = "owner@example.com"


class _ClaimStore:
    """In-memory stand-in for ``JobStore.claim_job_notification`` shared across watchers."""

    def __init__(self) -> None:
        """Start with no claims."""
        self.claims: dict[str, list[str]] = {}

    def claim_job_notification(
        self, optimization_id: str, claim: str, *, cap_prefix: str | None = None, cap: int | None = None
    ) -> bool:
        """Mirror the store's once-per-kind and per-prefix cap semantics.

        Args:
            optimization_id: Job the claim is for.
            claim: Email kind identifier.
            cap_prefix: Prefix counted against ``cap``.
            cap: Maximum claims with ``cap_prefix``.

        Returns:
            Whether the claim was newly recorded.
        """
        held = self.claims.setdefault(optimization_id, [])
        if claim in held:
            return False
        if cap_prefix is not None and cap is not None and sum(c.startswith(cap_prefix) for c in held) >= cap:
            return False
        held.append(claim)
        return True


class _Sent:
    """Record dispatched emails instead of sending them."""

    def __init__(self) -> None:
        """Start with no recorded emails."""
        self.calls: list[tuple[Any, tuple[Any, ...], dict[str, Any]]] = []

    def __call__(self, send: Any, *args: Any, **kwargs: Any) -> None:
        """Record one dispatch.

        Args:
            send: Notifier function that would run.
            *args: Its positional arguments.
            **kwargs: Its keyword arguments.
        """
        self.calls.append((send, args, kwargs))

    def kinds(self) -> list[Any]:
        """Return the notifier functions dispatched, in order."""
        return [call[0] for call in self.calls]


def _watcher(store: _ClaimStore, sent: _Sent, *, clock: Any = lambda: 0.0, **settings: Any) -> RunNotificationWatcher:
    """Build a watcher with the given cadence settings.

    Args:
        store: Shared claim store.
        sent: Dispatch recorder.
        clock: Wall-clock source for digest windows.
        **settings: ``RunNotificationSettings`` overrides.

    Returns:
        The watcher under test.
    """
    return RunNotificationWatcher(
        optimization_id=_JOB,
        username=_USER,
        job_store=store,
        settings=RunNotificationSettings(**settings),
        dispatch=sent,
        clock=clock,
    )


def test_done_cadence_sends_no_in_run_mail() -> None:
    """The default cadence never sends milestone or progress mail."""
    sent = _Sent()
    watcher = _watcher(_ClaimStore(), sent)

    watcher.observe_progress(PROGRESS_CANDIDATE, {"score": 0.1})
    watcher.observe_progress(PROGRESS_CANDIDATE, {"score": 0.9})
    watcher.observe_spend(100, 100)
    watcher.notify_needs_input()

    assert sent.calls == []


def test_for_run_skips_when_cadence_is_done_or_mail_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """No watcher is built unless the owner's cadence sends in-run mail."""
    monkeypatch.setattr(watcher_module, "run_notification_settings", lambda _u: RunNotificationSettings())
    assert RunNotificationWatcher.for_run(_JOB, _USER, _ClaimStore()) is None

    monkeypatch.setattr(watcher_module, "run_notification_settings", lambda _u: None)
    assert RunNotificationWatcher.for_run(_JOB, _USER, _ClaimStore()) is None

    monkeypatch.setattr(
        watcher_module, "run_notification_settings", lambda _u: RunNotificationSettings(cadence="milestones")
    )
    assert RunNotificationWatcher.for_run(_JOB, _USER, _ClaimStore()) is not None
    assert RunNotificationWatcher.for_run(_JOB, None, _ClaimStore()) is None


def test_new_best_fires_once_after_the_starting_score() -> None:
    """The first score is the baseline; the first improvement mails once, later ones don't."""
    store, sent = _ClaimStore(), _Sent()
    watcher = _watcher(store, sent, cadence="milestones")

    watcher.observe_progress(PROGRESS_CANDIDATE, {"score": 0.5})
    assert sent.calls == []
    watcher.observe_progress(PROGRESS_CANDIDATE, {"score": 0.4})
    watcher.observe_progress(PROGRESS_CANDIDATE, {"score": 0.6})
    watcher.observe_progress(PROGRESS_CANDIDATE, {"score": 0.7})

    assert sent.kinds() == [notify_run_new_best]
    assert sent.calls[0][1] == (_JOB, _USER, 0.6)


def test_new_best_is_not_resent_by_a_restarted_worker() -> None:
    """A fresh watcher for the same run (worker restart) respects the durable claim."""
    store, sent = _ClaimStore(), _Sent()
    first = _watcher(store, sent, cadence="milestones")
    first.observe_progress(PROGRESS_CANDIDATE, {"score": 0.5})
    first.observe_progress(PROGRESS_CANDIDATE, {"score": 0.6})

    resumed = _watcher(store, sent, cadence="milestones")
    resumed.observe_progress(PROGRESS_CANDIDATE, {"score": 0.6})
    resumed.observe_progress(PROGRESS_CANDIDATE, {"score": 0.8})

    assert sent.kinds() == [notify_run_new_best]


def test_stuck_fires_once_when_no_improvement_over_the_fraction() -> None:
    """Stalling for ``stuck_fraction`` of the planned calls mails once."""
    sent = _Sent()
    watcher = _watcher(_ClaimStore(), sent, cadence="milestones", stuck_fraction=0.25)

    watcher.observe_progress(PROGRESS_OPTIMIZER, {TQDM_TOTAL_KEY: 100, TQDM_N_KEY: 0})
    watcher.observe_progress(PROGRESS_CANDIDATE, {"score": 0.5, "discovered_at_evals": 0})
    watcher.observe_progress(PROGRESS_OPTIMIZER, {TQDM_TOTAL_KEY: 100, TQDM_N_KEY: 24})
    assert sent.calls == []
    watcher.observe_progress(PROGRESS_OPTIMIZER, {TQDM_TOTAL_KEY: 100, TQDM_N_KEY: 25})
    watcher.observe_progress(PROGRESS_OPTIMIZER, {TQDM_TOTAL_KEY: 100, TQDM_N_KEY: 60})

    assert sent.kinds() == [notify_run_stuck]
    assert sent.calls[0][1] == (_JOB, _USER, 0.5, 0.25)


def test_stuck_resets_on_improvement() -> None:
    """An improvement restarts the stall window."""
    sent = _Sent()
    watcher = _watcher(_ClaimStore(), sent, cadence="milestones", stuck_fraction=0.25)

    watcher.observe_progress(PROGRESS_OPTIMIZER, {TQDM_TOTAL_KEY: 100, TQDM_N_KEY: 0})
    watcher.observe_progress(PROGRESS_CANDIDATE, {"score": 0.5})
    watcher.observe_progress(PROGRESS_OPTIMIZER, {TQDM_TOTAL_KEY: 100, TQDM_N_KEY: 20})
    watcher.observe_progress(PROGRESS_CANDIDATE, {"score": 0.6})
    watcher.observe_progress(PROGRESS_OPTIMIZER, {TQDM_TOTAL_KEY: 100, TQDM_N_KEY: 40})

    assert notify_run_stuck not in sent.kinds()


def test_budget_alert_fires_once_at_the_fraction() -> None:
    """Spend at the alert fraction of the limit mails once; uncapped runs never do."""
    sent = _Sent()
    watcher = _watcher(_ClaimStore(), sent, cadence="milestones", budget_alert_fraction=0.8)

    watcher.observe_spend(500, None)
    watcher.observe_spend(79, 100)
    assert sent.calls == []
    watcher.observe_spend(80, 100)
    watcher.observe_spend(95, 100)

    assert sent.kinds() == [notify_run_budget]
    assert sent.calls[0][1] == (_JOB, _USER, 80, 100)


def test_needs_input_fires_once() -> None:
    """A budget pause mails the owner once per run."""
    sent = _Sent()
    watcher = _watcher(_ClaimStore(), sent, cadence="milestones")

    watcher.notify_needs_input()
    watcher.notify_needs_input()

    assert sent.kinds() == [notify_run_needs_input]


def test_milestones_cadence_sends_no_stage_mail() -> None:
    """Stage-change mail is only for the live cadence."""
    sent = _Sent()
    watcher = _watcher(_ClaimStore(), sent, cadence="milestones")

    watcher.observe_progress(PROGRESS_BASELINE, {})
    watcher.observe_progress(PROGRESS_EVALUATION_STARTED, {})

    assert sent.calls == []


def test_live_per_stage_sends_one_mail_per_stage_change() -> None:
    """Each distinct stage mails once; repeated optimizer steps don't re-trigger it."""
    sent = _Sent()
    watcher = _watcher(_ClaimStore(), sent, cadence="live", live_mode="per_stage")

    watcher.observe_progress(PROGRESS_BASELINE, {})
    watcher.observe_progress(PROGRESS_BASELINE, {})
    watcher.observe_progress(PROGRESS_OPTIMIZER, {})
    watcher.observe_progress(PROGRESS_OPTIMIZER, {})
    watcher.observe_progress(PROGRESS_EVALUATION_STARTED, {})

    stages = [call[1][2] for call in sent.calls if call[0] is notify_run_progress]
    assert stages == ["baseline", "optimizing", "evaluating"]


def test_live_per_stage_mails_each_auto_lane_once() -> None:
    """Optimize Anything Auto lanes are separate stages carrying the engine name."""
    sent = _Sent()
    watcher = _watcher(_ClaimStore(), sent, cadence="live", live_mode="per_stage")

    watcher.observe_progress(PROGRESS_LANE_STARTED, {"engine": "gepa", "phase": "explore"})
    watcher.observe_progress(PROGRESS_OPTIMIZER, {})
    watcher.observe_progress(PROGRESS_LANE_STARTED, {"engine": "best_of_n", "phase": "explore"})
    watcher.observe_progress(PROGRESS_LANE_STARTED, {"engine": "gepa", "phase": "explore"})

    details = [call[2]["detail"] for call in sent.calls]
    assert details == ["gepa", "best_of_n"]


def test_live_per_run_count_caps_progress_mail() -> None:
    """``per_run_count`` stops after ``live_count`` progress emails."""
    sent = _Sent()
    watcher = _watcher(_ClaimStore(), sent, cadence="live", live_mode="per_run_count", live_count=2)

    watcher.observe_progress(PROGRESS_BASELINE, {})
    watcher.observe_progress(PROGRESS_OPTIMIZER, {})
    watcher.observe_progress(PROGRESS_EVALUATION_STARTED, {})

    assert [call[1][2] for call in sent.calls] == ["baseline", "optimizing"]


def test_live_digest_sends_at_most_one_mail_per_window() -> None:
    """Digest mode mails once per ``digest_minutes`` window, whatever the stage traffic."""
    now = {"t": 0.0}
    sent = _Sent()
    watcher = _watcher(
        _ClaimStore(), sent, clock=lambda: now["t"], cadence="live", live_mode="digest", digest_minutes=15
    )

    watcher.observe_progress(PROGRESS_BASELINE, {})
    now["t"] = 60.0
    watcher.observe_progress(PROGRESS_OPTIMIZER, {})
    watcher.observe_progress(PROGRESS_EVALUATION_STARTED, {})
    assert len(sent.calls) == 1
    assert sent.calls[0][2]["digest"] is True

    now["t"] = 15 * 60.0
    watcher.observe_progress(PROGRESS_OPTIMIZER, {})

    assert len(sent.calls) == 2
    assert sent.calls[1][1][2] == "evaluating"


def test_store_without_claim_support_sends_nothing() -> None:
    """Without a durable guard the watcher prefers silence over repeats."""
    sent = _Sent()
    watcher = RunNotificationWatcher(
        optimization_id=_JOB,
        username=_USER,
        job_store=object(),
        settings=RunNotificationSettings(cadence="live"),
        dispatch=sent,
    )

    watcher.observe_progress(PROGRESS_BASELINE, {})
    watcher.notify_needs_input()

    assert sent.calls == []


def test_observe_progress_never_raises() -> None:
    """A failing store or odd metrics never break the worker's progress drain."""

    class _Broken:
        """Store whose claim always raises."""

        def claim_job_notification(self, *_args: Any, **_kwargs: Any) -> bool:
            """Raise like a lost database connection."""
            raise RuntimeError("db down")

    sent = _Sent()
    watcher = RunNotificationWatcher(
        optimization_id=_JOB,
        username=_USER,
        job_store=_Broken(),
        settings=RunNotificationSettings(cadence="live"),
        dispatch=sent,
    )

    watcher.observe_progress(PROGRESS_BASELINE, {})
    watcher.observe_progress(PROGRESS_CANDIDATE, {"score": float("nan")})
    watcher.observe_progress(PROGRESS_CANDIDATE, "not-a-dict")

    assert sent.calls == []
