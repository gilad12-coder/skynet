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
from typing import Any, Protocol

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
class EngineContext:
    """Run-scoped resources every engine receives alongside the task."""

    reflection_lm: Callable[[str], str]
    run_dir: str
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
        self._sums: dict[str, tuple[float, int]] = {}
        self._candidates: dict[str, Candidate] = {}
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
        self._reserve()
        root = self._root
        score, side_info = root._score(candidate, example)
        server: EvalServer | None = self
        while server is not None:
            with server._lock:
                server._record(candidate, score)
            if server._watch is not None:
                server._watch.after_eval(server)
            server = server._parent
        if root._on_eval is not None:
            with root._lock:
                root._on_eval(root, score)
        return score, side_info

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
        """
        try:
            return self._scorer(candidate, example)
        except Exception as exc:
            logger.warning("scorer raised on a candidate: %s", exc)
            return 0.0, {"error": f"{type(exc).__name__}: {exc}"}

    def _record(self, candidate: Candidate, score: float) -> None:
        """Fold ``score`` into the candidate's running mean.

        Args:
            candidate: The scored version.
            score: Its score on the case just evaluated.
        """
        key = candidate_key(candidate)
        total, count = self._sums.get(key, (0.0, 0))
        self._sums[key] = (total + score, count + 1)
        self._candidates.setdefault(key, candidate)

    def mean_score(self, candidate: Candidate) -> float | None:
        """Return the mean score recorded for ``candidate``, if any.

        Args:
            candidate: The version to look up.

        Returns:
            Its mean score across the cases scored so far, or ``None``.
        """
        entry = self._sums.get(candidate_key(candidate))
        if entry is None:
            return None
        total, count = entry
        return total / count

    @property
    def best_candidate(self) -> Candidate | None:
        """Return the candidate with the highest mean score, if any was scored."""
        if not self._sums:
            return None
        best_key = max(self._sums, key=lambda key: self._sums[key][0] / self._sums[key][1])
        return self._candidates[best_key]

    @property
    def best_score(self) -> float | None:
        """Return the highest mean score recorded, if any."""
        best = self.best_candidate
        return None if best is None else self.mean_score(best)
