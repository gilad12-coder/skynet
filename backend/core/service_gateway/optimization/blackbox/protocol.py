"""Engine-facing contract for black-box optimization.

Mirrors the shape of GEPA's ``optimize_anything`` engine protocol — a task,
an eval server that is the single scoring choke point, and a result — so a
future upstream ``gepa.oa`` release can be adopted without changing the
Skynet-side contract (design brief TODO-4).
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from gepa.oa.budget import BudgetExhausted

from ..cost_ceiling import CostCeilingExceededError

if TYPE_CHECKING:
    from .native_runtime import NativeOptions

logger = logging.getLogger(__name__)

Candidate = str | dict[str, str]
SideInfo = dict[str, Any]
ScorerFn = Callable[[Candidate, Any], tuple[float, SideInfo]]
EvalListener = Callable[["EvalServer", float], None]


class BudgetExhaustedError(RuntimeError):
    """Raised by :class:`EvalServer` once its scorer-run cap is reached."""


class PlateauReachedError(BudgetExhaustedError):
    """Raised by a lane whose :class:`PlateauWatch` saw no improvement for too long.

    A subclass of the budget error on purpose: engines already treat that
    as "stop and hand back your best", which is exactly what a plateau asks.
    """


class ScorerAbortError(RuntimeError):
    """Raised by a scorer to stop the whole run.

    :class:`EvalServer` floors every other scorer failure to keep one bad
    version from killing a run; this one passes through untouched because the
    scorer has established that no version can be scored.
    """


class PlateauWatch:
    """Counts scorer runs since the last improvement and trips at ``patience``.

    Attached to one lane's :class:`EvalServer`; the lane's best mean score
    is compared against the best the run had seen when the lane started,
    so only a version that beats the run's record resets the count.
    """

    def __init__(self, patience: int, *, best_score: float | None = None) -> None:
        """Create a watch.

        Args:
            patience: Scorer runs without improvement before the lane stops.
            best_score: The run's best score so far; the bar to beat.
        """
        self.patience = patience
        self.best_score = best_score
        self.stalled = 0
        self.tripped = False
        self._lock = threading.Lock()

    @property
    def exhausted(self) -> bool:
        """Return True once ``patience`` runs passed without improvement."""
        return self.stalled >= self.patience

    def after_eval(self, server: EvalServer) -> None:
        """Fold one finished evaluation into the count.

        Args:
            server: The lane's server, whose best mean is the lane's progress.
        """
        score = server.best_score
        with self._lock:
            if score is not None and (self.best_score is None or score > self.best_score):
                self.best_score, self.stalled = score, 0
            else:
                self.stalled += 1

    def check(self) -> None:
        """Stop the lane once it is exhausted.

        Raises:
            PlateauReachedError: When ``patience`` runs passed without improvement.
        """
        with self._lock:
            if self.stalled < self.patience:
                return
            self.tripped = True
        raise PlateauReachedError(f"no improvement in the last {self.patience} scorer runs")


def candidate_key(candidate: Candidate) -> str:
    """Return a stable identity string for a candidate.

    Args:
        candidate: A text candidate or a named-parts mapping.

    Returns:
        The text itself, or the sorted-key JSON form of a mapping.
    """
    if isinstance(candidate, dict):
        return json.dumps(candidate, sort_keys=True)
    return candidate


def example_key(example: Any) -> str:
    """Return a stable identity string for a case.

    Args:
        example: A case mapping, or ``None`` in single-task mode.

    Returns:
        The sorted-key JSON form of the case (``"null"`` without one).
    """
    return json.dumps(example, sort_keys=True, default=str)


@dataclass
class Task:
    """What an engine optimizes: the starting point, the goal and the cases.

    ``test_set`` is intentionally absent — the held-out split never enters
    the optimization loop; the service scores it before and after.
    """

    seed_candidate: Candidate | None
    objective: str | None = None
    background: str | None = None
    train_set: list[Any] = field(default_factory=list)
    val_set: list[Any] = field(default_factory=list)

    @property
    def has_dataset(self) -> bool:
        """Return True when the task carries cases (multi-task mode)."""
        return bool(self.train_set or self.val_set)

    @property
    def str_mode(self) -> bool:
        """Return True when candidates are plain text (including seedless)."""
        return not isinstance(self.seed_candidate, dict)


@dataclass
class Result:
    """What an engine hands back: its best version and what it cost."""

    best_candidate: Candidate
    best_score: float | None
    total_evals: int
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class CandidateRecord:
    """One distinct version an eval server scored: its running mean and latest side info."""

    candidate: Candidate
    total: float
    count: int
    # Root-server call number that first scored this version, so the run's
    # versions can be laid out in the order they appeared.
    first_eval: int
    side_info: SideInfo

    @property
    def mean_score(self) -> float:
        """Return the mean score across every case this version was scored on."""
        return self.total / self.count


@dataclass
class EngineContext:
    """Run-scoped resources every engine receives alongside the task."""

    reflection_lm: Callable[[str | list[dict[str, Any]]], str]
    run_dir: str
    recovery_seed_boundary: Any | None = None
    native_options: NativeOptions | None = None
    proposer_token_budget_usd: float | None = None
    check_budget: Callable[[], None] | None = None
    remaining_cost_usd: Callable[[], float] | None = None
    seed: int = 0
    stop_at_score: float | None = None
    # Cap on proposer rounds for engines that iterate (Meta-Harness); ``None``
    # runs until the scorer budget is spent.
    max_iterations: int | None = None
    # How many cases an engine may score at once. Only pays off when the
    # scorer itself runs elsewhere (one sandbox per case); 1 for text targets.
    concurrency: int = 1
    # "harness · model" the proposer is told it writes for, on agent targets.
    target_label: str | None = None
    # Job-level progress sink. Engines that can narrate their run (GEPA via
    # the trajectory watcher) stream candidate events through it live.
    progress_callback: Callable[[str, dict[str, Any]], None] | None = None


class Engine(Protocol):
    """One optimization engine (GEPA, Best-of-N, ...)."""

    name: str

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Optimize ``task`` scoring only through ``server``.

        Args:
            task: The starting point, goal and cases.
            server: The budgeted scorer every evaluation must go through.
            ctx: Reflection LM, workspace and stop settings for this run.

        Returns:
            The engine's best version and its score.
        """
        ...


class EvalServer:
    """Budgeted scoring choke point shared by every engine in a run.

    Enforces ``max_evals``, keeps a per-candidate mean so a best version is
    always recoverable even when an engine dies mid-run, and — through
    :meth:`lane` — hands out sub-budgets that count against the parent.

    Safe to call from several threads at once: a call is reserved against
    every budget in the chain before the scorer runs, so concurrent
    evaluations can never overspend, and the bookkeeping is locked.
    """

    def __init__(
        self,
        scorer: ScorerFn,
        *,
        max_evals: int,
        parent: EvalServer | None = None,
        on_eval: EvalListener | None = None,
        watch: PlateauWatch | None = None,
    ) -> None:
        """Create a server over ``scorer`` with a cap of ``max_evals`` calls.

        Args:
            scorer: Callable scoring ``(candidate, case)`` → ``(score, side_info)``.
            max_evals: Maximum scorer calls this server will make.
            parent: Server whose budget this one is a slice of, if any.
            on_eval: Listener called with ``(server, score)`` after each root eval.
            watch: Plateau watch that ends this server's budget early once
                its lane stops improving.
        """
        self._scorer = scorer
        self.max_evals = max_evals
        self._parent = parent
        self._on_eval = on_eval
        self._watch = watch
        self.used = 0
        self._records: dict[str, CandidateRecord] = {}
        # Root only: the latest score per (version, case) an engine paid for,
        # so the final held-out pass can reuse it instead of re-measuring, and
        # scores handed in by :meth:`prime` for the engine's first look at a
        # pair — each consumed once.
        self._scores: dict[tuple[str, str], float] = {}
        self._primed: dict[tuple[str, str], tuple[float, SideInfo]] = {}
        # Locks are only ever taken child → parent, so lanes cannot deadlock.
        self._lock = threading.Lock()

    @property
    def _root(self) -> EvalServer:
        """Return the top of the lane chain: the server that owns the scorer and listener."""
        server = self
        while server._parent is not None:
            server = server._parent
        return server

    @property
    def plateaued(self) -> bool:
        """Return True when this server's plateau watch has run out of patience."""
        return self._watch is not None and self._watch.exhausted

    @property
    def remaining(self) -> int:
        """Return how many scorer calls this server may still make (0 once plateaued)."""
        if self.plateaued:
            return 0
        own = max(0, self.max_evals - self.used)
        if self._parent is None:
            return own
        return min(own, self._parent.remaining)

    def lane(self, max_evals: int, *, watch: PlateauWatch | None = None) -> EvalServer:
        """Open a sub-budget of at most ``max_evals`` calls against this server.

        Args:
            max_evals: Cap for the lane; clamped to what remains here.
            watch: Plateau watch that ends the lane early once it stops improving.

        Returns:
            A child server whose evaluations count against both budgets.
        """
        return EvalServer(self._scorer, max_evals=min(max_evals, self.remaining), parent=self, watch=watch)

    def evaluate(self, candidate: Candidate, example: Any = None) -> tuple[float, SideInfo]:
        """Score one candidate on one case (or on its own in single-task mode).

        Args:
            candidate: The version to score.
            example: The case to score it on, or ``None`` when there are no cases.

        Returns:
            The score and the scorer's side information.

        Raises:
            BudgetExhaustedError: When no scorer calls remain.
        """
        root = self._root
        key = (candidate_key(candidate), example_key(example))
        primed = root._take_primed(key)
        if primed is None:
            self._reserve()
            score, side_info = root._score(candidate, example)
            # Per-call heartbeat at DEBUG so it surfaces only in the Logs tab's
            # verbose view — the black-box counterpart of the DSPy per-example eval
            # heartbeat, so every run type gets the same normal=aggregates /
            # verbose=per-call split. Counted against the run-wide budget.
            logger.debug("scorer eval %d/%d score=%.3f", root.used, root.max_evals, score)
        else:
            score, side_info = primed
        with root._lock:
            root._scores[key] = score
        server: EvalServer | None = self
        while server is not None:
            with server._lock:
                server._record(candidate, score, side_info)
            # A primed score cost no scorer run, so it neither counts toward a
            # lane's plateau patience nor ticks the progress listener.
            if primed is None and server._watch is not None:
                server._watch.after_eval(server)
            server = server._parent
        if primed is None and root._on_eval is not None:
            with root._lock:
                root._on_eval(root, score)
        return score, side_info

    def prime(self, candidate: Candidate, example: Any, score: float, side_info: SideInfo) -> None:
        """Hand in a score measured outside the budget for one (version, case) pair.

        The engine's first :meth:`evaluate` of that pair returns it without a
        scorer run; any later evaluation of the pair is measured afresh.

        Args:
            candidate: The version that was scored.
            example: The case it was scored on (``None`` in single-task mode).
            score: The measured score.
            side_info: The scorer's side information for that measurement.
        """
        root = self._root
        with root._lock:
            root._primed[(candidate_key(candidate), example_key(example))] = (score, side_info)

    def recorded(self, candidate: Candidate, example: Any = None) -> float | None:
        """Return the score already measured for ``(candidate, example)``, if any.

        Args:
            candidate: The version to look up.
            example: The case, or ``None`` in single-task mode.

        Returns:
            The latest score an engine paid for on that pair, else a primed
            score not yet consumed, else ``None``.
        """
        root = self._root
        key = (candidate_key(candidate), example_key(example))
        with root._lock:
            score = root._scores.get(key)
            if score is None and key in root._primed:
                score = root._primed[key][0]
        return score

    def _take_primed(self, key: tuple[str, str]) -> tuple[float, SideInfo] | None:
        """Pop and return the primed score for ``key``, if one is waiting.

        Args:
            key: The ``(candidate_key, example_key)`` pair.

        Returns:
            The primed ``(score, side_info)``, or ``None``.
        """
        with self._lock:
            return self._primed.pop(key, None)

    def _reserve(self) -> None:
        """Claim one scorer call here and in every ancestor, or claim nothing.

        Raises:
            BudgetExhaustedError: When this server or an ancestor has no
                calls left; no budget in the chain is touched in that case.
            PlateauReachedError: When this server's lane stopped improving.
        """
        if self._watch is not None:
            self._watch.check()
        with self._lock:
            if self.used >= self.max_evals:
                raise BudgetExhaustedError(f"scorer-run budget of {self.max_evals} exhausted")
            if self._parent is not None:
                self._parent._reserve()
            self.used += 1

    def _score(self, candidate: Candidate, example: Any) -> tuple[float, SideInfo]:
        """Call the scorer, turning a crash into a floor score with feedback.

        A scorer that raises on one version marks that version as bad — it
        must not kill the run (GEPA's ``raise_on_exception=False`` semantics,
        applied here so every engine gets them).

        Args:
            candidate: The version to score.
            example: The case to score it on.

        Returns:
            The score and side information, or ``(0.0, {"error": ...})``.

        Raises:
            ScorerAbortError: When the scorer asks to stop the run.
        """
        try:
            return self._scorer(candidate, example)
        except (ScorerAbortError, BudgetExhaustedError, BudgetExhausted, CostCeilingExceededError):
            raise
        except Exception as exc:
            logger.warning("scorer raised on a candidate: %s", exc)
            return 0.0, {"error": f"{type(exc).__name__}: {exc}"}

    def _record(self, candidate: Candidate, score: float, side_info: SideInfo) -> None:
        """Fold ``score`` into the candidate's running mean and keep its latest side info.

        Args:
            candidate: The scored version.
            score: Its score on the case just evaluated.
            side_info: What the scorer said about it on that case.
        """
        key = candidate_key(candidate)
        record = self._records.get(key)
        if record is None:
            self._records[key] = CandidateRecord(candidate, score, 1, self._root.used, side_info)
            return
        record.total += score
        record.count += 1
        record.side_info = side_info

    @property
    def history(self) -> list[CandidateRecord]:
        """Return every distinct version this server scored, in first-seen order."""
        return list(self._records.values())

    def mean_score(self, candidate: Candidate) -> float | None:
        """Return the mean score recorded for ``candidate``, if any.

        Args:
            candidate: The version to look up.

        Returns:
            Its mean score across the cases scored so far, or ``None``.
        """
        record = self._records.get(candidate_key(candidate))
        return None if record is None else record.mean_score

    @property
    def best_candidate(self) -> Candidate | None:
        """Return the candidate with the highest mean score, if any was scored."""
        if not self._records:
            return None
        return max(self._records.values(), key=lambda record: record.mean_score).candidate

    @property
    def best_score(self) -> float | None:
        """Return the highest mean score recorded, if any."""
        best = self.best_candidate
        return None if best is None else self.mean_score(best)
