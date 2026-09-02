"""Meta-Harness engine: rewrite a coding agent's harness from the traces of its runs.

The controller — history, proposer, evaluation — runs here in the worker;
every evaluation of a proposed harness happens in its own sandbox through
the agent-target scorer. The proposer is the run's optimizer model: it
sees the versions tried so far with their scores and their worst traces,
and writes the next version. The target harness and model are fixed for
the whole run (H0 → H1 → … → H*); joint harness + model search is a TODO.
"""

from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from ....exceptions import ServiceError
from ....models.blackbox import BLACKBOX_ENGINE_META_HARNESS
from .agent_runs import PHASE_VERSION, run_scope
from .best_of_n import _strip_fences
from .feedback import emit_candidate, emit_case_scored, emit_scorer_feedback
from .protocol import (
    BudgetExhaustedError,
    Candidate,
    EngineContext,
    EvalServer,
    Result,
    SideInfo,
    Task,
    candidate_key,
)

logger = logging.getLogger(__name__)

# How much history the proposer sees: the most recent trials plus the best.
_HISTORY_TRIALS = 6
_CANDIDATE_CHARS = 6_000
_FEEDBACK_CASES = 8
_FEEDBACK_CHARS = 600
# Each side-information part keeps its head and its tail: a traceback names the failure on its last line.
_FEEDBACK_PART_CHARS = 400
_FEEDBACK_TAIL_CHARS = 200
_CASE_LABEL_CHARS = 80
# Proposals that repeat a version already tried are retried this many times.
_DUPLICATE_RETRIES = 2
_FEEDBACK_KEYS = ("error", "feedback", "check", "agent_output", "transcript_tail")
_FILE_BLOCK = re.compile(r'<file path="([^"]+)">\n?(.*?)</file>', re.DOTALL)


@dataclass
class Trial:
    """One harness version and how it did on every case."""

    index: int
    candidate: Candidate
    parent_index: int | None = None
    generation: int = 0
    outcomes: list[tuple[Any, float, SideInfo]] = field(default_factory=list)
    complete: bool = True

    @property
    def score(self) -> float | None:
        """Return the mean score over the cases scored, or ``None`` when none were."""
        if not self.outcomes:
            return None
        return sum(score for _, score, _ in self.outcomes) / len(self.outcomes)


def _render_candidate(candidate: Candidate) -> str:
    """Show a version to the proposer, bounded per part.

    Args:
        candidate: Text or named parts.

    Returns:
        A fenced block, or one ``<file>`` block per part.
    """
    if isinstance(candidate, str):
        return f"```\n{_clip(candidate, _CANDIDATE_CHARS)}\n```"
    return "\n".join(
        f'<file path="{path}">\n{_clip(text, _CANDIDATE_CHARS)}\n</file>' for path, text in candidate.items()
    )


def _clip(text: str, limit: int, tail: int = 0) -> str:
    """Keep the head of ``text``, and optionally its tail.

    Args:
        text: Any text.
        limit: Maximum characters kept.
        tail: How many of the kept characters come from the end of ``text``.

    Returns:
        ``text`` when it fits, else its head, an ellipsis and — when ``tail`` is set — its tail.
    """
    text = str(text)
    if len(text) <= limit:
        return text
    if tail <= 0:
        return text[:limit] + "…"
    return text[: limit - tail] + " … " + text[-tail:]


def _case_label(case: Any) -> str:
    """Name a case briefly for the history.

    Args:
        case: The case.

    Returns:
        Its task text head, or its JSON head.
    """
    if isinstance(case, dict):
        for key in ("prompt", "task", "input", "question", "instruction", "id", "name"):
            value = case.get(key)
            if isinstance(value, str) and value.strip():
                return _clip(" ".join(value.split()), _CASE_LABEL_CHARS)
    return _clip(" ".join(str(case).split()), _CASE_LABEL_CHARS)


def _feedback(side_info: SideInfo) -> str:
    """Flatten the informative parts of a scorer's side information.

    Args:
        side_info: What the scorer (and the agent runner) reported.

    Returns:
        A bounded ``key: value`` summary.
    """
    parts = [
        f"{key}: {_clip(' '.join(str(side_info[key]).split()), _FEEDBACK_PART_CHARS, tail=_FEEDBACK_TAIL_CHARS)}"
        for key in _FEEDBACK_KEYS
        if side_info.get(key)
    ]
    return _clip(" | ".join(parts), _FEEDBACK_CHARS) or "no feedback"


class MetaHarnessEngine:
    """Propose-from-full-history loop over whole-case-set evaluations."""

    name = BLACKBOX_ENGINE_META_HARNESS

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Iterate harness versions until the budget, the iteration cap or the target score stops it.

        Args:
            task: The starting harness, goal and cases.
            server: The budgeted scorer.
            ctx: Optimizer model, iteration cap, concurrency and stop score.

        Returns:
            The best complete trial's version and mean score.

        Raises:
            ServiceError: Without cases, when no first version can be produced,
                or when the budget did not cover a single evaluation.
        """
        cases = [*task.train_set, *task.val_set]
        if not cases:
            raise ServiceError("Meta-Harness needs cases: the tasks the agent is run on.")
        trials: list[Trial] = []
        seen: set[str] = set()
        candidate = task.seed_candidate
        if candidate is None:
            candidate = self._propose(task, trials, ctx)
            if candidate is None:
                raise ServiceError("Meta-Harness could not produce a first version from the objective.")
        proposals = 0
        stopped = "budget_exhausted"
        while True:
            seen.add(candidate_key(candidate))
            trial = self._evaluate(candidate, cases, server, ctx, index=len(trials), parent=self._best(trials))
            trials.append(trial)
            logger.info("meta-harness trial %d: score=%s complete=%s", trial.index, trial.score, trial.complete)
            if not trial.complete:
                break
            best = self._best(trials)
            if ctx.stop_at_score is not None and best is not None and (best.score or 0.0) >= ctx.stop_at_score:
                stopped = "target_reached"
                break
            if ctx.max_iterations is not None and proposals >= ctx.max_iterations:
                stopped = "max_iterations"
                break
            if server.remaining < len(cases):
                break
            proposal = None
            for _ in range(1 + _DUPLICATE_RETRIES):
                proposal = self._propose(task, trials, ctx)
                proposals += 1
                if proposal is not None and candidate_key(proposal) not in seen:
                    break
                proposal = None
            if proposal is None:
                stopped = "no_new_proposal"
                break
            candidate = proposal
        best = self._best(trials)
        if best is None:
            raise ServiceError("Meta-Harness could not evaluate any version within the budget.")
        return Result(
            best_candidate=best.candidate,
            best_score=best.score,
            total_evals=server.used,
            metadata={"trials": len(trials), "proposals": proposals, "stopped": stopped},
        )

    @staticmethod
    def _best(trials: list[Trial]) -> Trial | None:
        """Pick the best complete trial, falling back to partial ones only when none completed.

        Args:
            trials: Every trial so far.

        Returns:
            The trial with the highest mean, or ``None`` when nothing was scored.
        """
        complete = [trial for trial in trials if trial.complete and trial.score is not None]
        pool = complete or [trial for trial in trials if trial.score is not None]
        if not pool:
            return None
        return max(pool, key=lambda trial: trial.score or float("-inf"))

    @staticmethod
    def _evaluate(
        candidate: Candidate,
        cases: list[Any],
        server: EvalServer,
        ctx: EngineContext,
        *,
        index: int,
        parent: Trial | None,
    ) -> Trial:
        """Score ``candidate`` on every case, ``ctx.concurrency`` at a time, streaming what it learns.

        Every scorer call goes out as feedback the moment it returns, and the
        trial itself as a candidate-tree node once every case is in, so the
        run view moves while the sandboxes are still busy. A trial cut short
        by the budget is not announced: its mean covers only part of the cases.

        Args:
            candidate: The version.
            cases: The cases.
            server: The budgeted scorer.
            ctx: For ``concurrency`` and the progress sink.
            index: The trial's position in the history.
            parent: The best trial when this version was proposed; ``None`` for the first.

        Returns:
            The trial; ``complete`` is False when the budget ran out midway.
        """
        trial = Trial(
            index=index,
            candidate=candidate,
            parent_index=None if parent is None else parent.index,
            generation=0 if parent is None else parent.generation + 1,
        )

        def score_case(item: tuple[int, Any]) -> tuple[int, Any, float, SideInfo] | None:
            """Score one case, or ``None`` once the budget is gone."""
            position, case = item
            try:
                with run_scope(PHASE_VERSION, str(position), trial=index):
                    score, side_info = server.evaluate(candidate, case)
            except BudgetExhaustedError:
                return None
            emit_scorer_feedback(
                ctx.progress_callback, example_id=str(position), score=score, side_info=side_info, iteration=index
            )
            emit_case_scored(
                ctx.progress_callback, trial=index, example_id=str(position), score=score, total=len(cases)
            )
            return position, case, score, side_info

        workers = max(1, min(ctx.concurrency, len(cases)))
        if workers == 1:
            results = [score_case(item) for item in enumerate(cases)]
        else:
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="meta-harness") as pool:
                results = list(pool.map(score_case, enumerate(cases)))
        scored = [result for result in results if result is not None]
        trial.outcomes = [(case, score, side_info) for _, case, score, side_info in scored]
        trial.complete = len(scored) == len(cases)
        if trial.complete and trial.score is not None:
            emit_candidate(
                ctx.progress_callback,
                candidate_id=str(index),
                parent_id=None if trial.parent_index is None else str(trial.parent_index),
                generation=trial.generation,
                score=trial.score,
                per_example=[(str(position), score) for position, _, score, _ in scored],
                candidate=candidate,
                discovered_at_evals=server.used,
                iteration=index,
            )
        return trial

    def _propose(self, task: Task, trials: list[Trial], ctx: EngineContext) -> Candidate | None:
        """Ask the optimizer model for the next version.

        Args:
            task: For the objective, background and part names.
            trials: The history shown to the proposer.
            ctx: For the optimizer model and target label.

        Returns:
            The proposed version, or ``None`` when the reply held none.
        """
        raw = ctx.reflection_lm(self._prompt(task, trials, ctx))
        if task.str_mode:
            text = _strip_fences(raw).strip()
            return text or None
        base = dict((self._best(trials) or Trial(0, task.seed_candidate or {})).candidate)
        parsed = {path: body.strip("\n") for path, body in _FILE_BLOCK.findall(raw) if path in base}
        if not parsed:
            return None
        return {**base, **parsed}

    def _prompt(self, task: Task, trials: list[Trial], ctx: EngineContext) -> str:
        """Build the proposer prompt: objective, bounded history with traces, output format.

        Args:
            task: For the objective and background.
            trials: The history.
            ctx: For the target label.

        Returns:
            The prompt.
        """
        target = f" ({ctx.target_label})" if ctx.target_label else ""
        lines = [
            f"You are optimizing the harness of a coding agent{target}: the instruction file(s) the agent reads "
            "before it works on a task. The agent, its model and the tasks are fixed; only the harness text changes."
        ]
        if task.objective:
            lines += ["", f"Objective: {task.objective}"]
        if task.background:
            lines += ["", f"Background: {task.background}"]
        if not trials:
            lines += ["", "There is no version yet. Write the first one from the objective."]
        else:
            best = self._best(trials)
            shown = trials[-_HISTORY_TRIALS:]
            if best is not None and best not in shown:
                shown = [best, *shown]
            lines += ["", f"## Versions tried so far ({len(trials)} total, showing {len(shown)})"]
            for trial in shown:
                score = "incomplete" if trial.score is None else f"mean score {trial.score:.4f}"
                tag = " — best so far" if trial is best else ""
                lines += ["", f"### Version {trial.index} — {score}{tag}", _render_candidate(trial.candidate)]
                if trial.outcomes:
                    lines.append("Weakest cases:")
                    for case, case_score, side_info in sorted(trial.outcomes, key=lambda o: o[1])[:_FEEDBACK_CASES]:
                        lines.append(f"- {_case_label(case)} → score {case_score:.3f}: {_feedback(side_info)}")
        lines += [
            "",
            "## Your task",
            "Write the next version of the harness. Change what the traces show is failing and keep what works. "
            "Be concrete: the agent follows the text literally.",
        ]
        if task.str_mode:
            lines.append("Output only the new harness text inside a single ``` fenced block.")
        else:
            lines.append(
                'Output each part as a <file path="..."> ... </file> block with its full new content; '
                "parts you leave out keep their current content."
            )
        return "\n".join(lines)
