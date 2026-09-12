"""AutoSaddler engine: diagnose per-case failures, patch, keep verified gains.

A faithful in-process port of the AutoSaddler design (microsoft/AutoSaddler,
MIT). Each round the reflection model is shown the incumbent version's weakest
cases with the scorer's feedback, diagnoses why they fail and rewrites the
whole version. A rewrite is kept only when it strictly beats the incumbent on
the very cases it was diagnosed against (the matched-strict-improvement gate),
and is then confirmed on the full development set; the highest-scoring
confirmed version wins. Scoring goes through the shared eval server and every
proposal comes from ``ctx.reflection_lm``, exactly like the other in-process
engines.
"""

from __future__ import annotations

import json
import logging
import random
from typing import Any

from ....exceptions import ServiceError
from ..budget_stop import BudgetReached
from .feedback import emit_candidate, emit_scorer_feedback, scorer_feedback_text
from .protocol import (
    BudgetExhaustedError,
    Candidate,
    EngineContext,
    EvalServer,
    Result,
    SideInfo,
    Task,
    candidate_key,
    example_key,
)

logger = logging.getLogger(__name__)

# The named component a text version travels under in the agent's JSON patch.
_COMPONENT = "version"
# Cases drawn per round for diagnosis (AutoSaddler's fixed task-selection batch).
_BATCH_SIZE = 4
# Weakest cases from a batch shown to the model as failures to diagnose.
_MAX_FEEDBACK_CASES = 4
# Recent diagnoses fed forward as lessons, AutoSaddler's reflection carried cheaply.
_MAX_LESSONS = 3


class AutoSaddlerEngine:
    """Diagnosis-driven patch search that keeps only verified development gains."""

    name = "autosaddler"

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Optimize ``task`` by diagnosing failures and patching the version.

        Args:
            task: The starting point, goal and cases.
            server: The budgeted scorer every evaluation goes through.
            ctx: Reflection LM, workspace, seed and stop settings.

        Returns:
            The highest-scoring confirmed version, or the seed unscored when
            no scorer runs remained.

        Raises:
            ServiceError: When given named parts, or a seedless run whose cold
                start the reflection model never produced.
        """
        if not task.str_mode:
            raise ServiceError("AutoSaddler supports text starting points only.")
        if server.remaining <= 0:
            return Result(best_candidate=task.seed_candidate or "", best_score=None, total_evals=0)

        development: list[Any] = task.val_set or task.train_set or [None]
        diagnosis_pool: list[Any] = task.train_set or task.val_set or [None]
        case_ids: dict[int, str] = {}
        for index, example in enumerate([*development, *diagnosis_pool]):
            case_ids.setdefault(id(example), str(index))

        cache: dict[tuple[str, str], tuple[float, SideInfo]] = {}
        lessons: list[str] = []
        metadata: dict[str, Any] = {"algorithm": "autosaddler", "iterations": 0, "accepted": 0}

        incumbent = task.seed_candidate
        if incumbent is None:
            incumbent = _cold_start(ctx, task)
            if incumbent is None:
                raise ServiceError("AutoSaddler could not produce an initial version.")

        incumbent_id = "seed"
        generation = 0
        iteration = 0
        # Bind the incumbent as best-so-far before any scoring, so a budget stop
        # during the seed's own evaluation still reports it rather than crashing.
        best, best_score = incumbent, None
        try:
            incumbent_score = self._score_mean(
                server, incumbent, development, cache, ctx, case_ids, iteration
            )
            best, best_score = incumbent, incumbent_score
            self._emit(ctx, incumbent_id, None, generation, incumbent, development, cache, server, iteration)

            while _should_continue(server, ctx, best_score, iteration):
                iteration += 1
                batch = _select_batch(diagnosis_pool, iteration, ctx.seed)
                batch_rows = self._score_rows(server, incumbent, batch, cache, ctx, case_ids, iteration)
                failures = sorted(batch_rows, key=lambda row: row[1])[:_MAX_FEEDBACK_CASES]

                proposal, diagnosis = _diagnose_patch(ctx, incumbent, failures, task, lessons)
                if proposal is None or proposal == incumbent:
                    continue

                proposal_batch = self._score_mean(server, proposal, batch, cache, ctx, case_ids, iteration)
                incumbent_batch = _mean([row[1] for row in batch_rows])
                if proposal_batch <= incumbent_batch:
                    lessons = _remember(lessons, diagnosis)
                    continue

                proposal_score = self._score_mean(server, proposal, development, cache, ctx, case_ids, iteration)
                proposal_id = f"iter-{iteration}"
                self._emit(
                    ctx, proposal_id, incumbent_id, generation + 1, proposal, development, cache, server, iteration
                )
                lessons = _remember(lessons, diagnosis)
                if proposal_score > incumbent_score:
                    incumbent, incumbent_score, incumbent_id = proposal, proposal_score, proposal_id
                    generation += 1
                    metadata["accepted"] = int(metadata["accepted"]) + 1
                    if proposal_score > best_score:
                        best, best_score = proposal, proposal_score
        except BudgetReached as exc:
            metadata["iterations"] = iteration
            exc.result = Result(
                best_candidate=best,
                best_score=best_score,
                total_evals=server.used,
                metadata={**metadata, "selection_source": "autosaddler_incumbent"},
            )
            exc.evidence.update(
                selection_scope="development",
                final_evaluation_completed=False,
                final_evaluation_reason="budget_reached",
            )
            raise
        except BudgetExhaustedError:
            logger.info("AutoSaddler stopped after exhausting the scorer budget at iteration %d.", iteration)

        metadata["iterations"] = iteration
        return Result(best_candidate=best, best_score=best_score, total_evals=server.used, metadata=metadata)

    def _score_rows(
        self,
        server: EvalServer,
        candidate: Candidate,
        cases: list[Any],
        cache: dict[tuple[str, str], tuple[float, SideInfo]],
        ctx: EngineContext,
        case_ids: dict[int, str],
        iteration: int,
    ) -> list[tuple[Any, float, SideInfo]]:
        """Score ``candidate`` on every case, reusing measured pairs and streaming feedback.

        Args:
            server: The budgeted scorer.
            candidate: The version to score.
            cases: Cases to score it on (``[None]`` in single-task mode).
            cache: Measured ``(candidate, case)`` scores to avoid re-paying.
            ctx: Budget guard and progress sink.
            case_ids: Display id per case, by identity.
            iteration: Loop round the scores belong to.

        Returns:
            One ``(case, score, side_info)`` row per case.
        """
        rows: list[tuple[Any, float, SideInfo]] = []
        for case in cases:
            key = (candidate_key(candidate), example_key(case))
            if key in cache:
                score, side_info = cache[key]
            else:
                if ctx.check_budget is not None:
                    ctx.check_budget()
                score, side_info = server.evaluate(candidate, case)
                if ctx.check_budget is not None:
                    ctx.check_budget()
                cache[key] = (score, side_info)
                emit_scorer_feedback(
                    ctx.progress_callback,
                    example_id=case_ids.get(id(case), "?"),
                    score=score,
                    side_info=side_info,
                    iteration=iteration,
                )
            rows.append((case, score, side_info))
        return rows

    def _score_mean(
        self,
        server: EvalServer,
        candidate: Candidate,
        cases: list[Any],
        cache: dict[tuple[str, str], tuple[float, SideInfo]],
        ctx: EngineContext,
        case_ids: dict[int, str],
        iteration: int,
    ) -> float:
        """Return the mean score of ``candidate`` over ``cases``.

        Args:
            server: The budgeted scorer.
            candidate: The version to score.
            cases: Cases to average over.
            cache: Measured-pair cache passed through to :meth:`_score_rows`.
            ctx: Budget guard and progress sink.
            case_ids: Display id per case, by identity.
            iteration: Loop round the scores belong to.

        Returns:
            The mean score across ``cases``.
        """
        return _mean([row[1] for row in self._score_rows(server, candidate, cases, cache, ctx, case_ids, iteration)])

    def _emit(
        self,
        ctx: EngineContext,
        candidate_id: str,
        parent_id: str | None,
        generation: int,
        candidate: Candidate,
        cases: list[Any],
        cache: dict[tuple[str, str], tuple[float, SideInfo]],
        server: EvalServer,
        iteration: int,
    ) -> None:
        """Announce one fully scored version as a node of the run's candidate tree.

        Args:
            ctx: Progress sink.
            candidate_id: The version's id within the run.
            parent_id: The version it was patched from, ``None`` for the seed.
            generation: Depth in the tree.
            candidate: The version's text.
            cases: Development cases it was scored on.
            cache: Measured-pair cache holding those scores.
            server: Scorer, for the evaluation count at discovery.
            iteration: The round that produced it.
        """
        if ctx.progress_callback is None:
            return
        per_example: list[tuple[str, float]] = []
        for index, case in enumerate(cases):
            score = cache.get((candidate_key(candidate), example_key(case)))
            if score is not None:
                per_example.append((str(index), score[0]))
        emit_candidate(
            ctx.progress_callback,
            candidate_id=candidate_id,
            parent_id=parent_id,
            generation=generation,
            score=_mean([value for _, value in per_example]),
            per_example=per_example,
            candidate=candidate,
            discovered_at_evals=server.used,
            iteration=iteration,
        )


def _should_continue(server: EvalServer, ctx: EngineContext, best_score: float, iteration: int) -> bool:
    """Tell whether another diagnosis round is allowed.

    Args:
        server: Scorer whose remaining budget bounds the run.
        ctx: Iteration cap and stop-at-score settings.
        best_score: Best confirmed score so far.
        iteration: Rounds already run.

    Returns:
        Whether budget, the iteration cap and the score target all allow more.
    """
    if server.remaining <= 0:
        return False
    if ctx.max_iterations is not None and iteration >= ctx.max_iterations:
        return False
    return ctx.stop_at_score is None or best_score < ctx.stop_at_score


def _select_batch(cases: list[Any], iteration: int, seed: int) -> list[Any]:
    """Draw a deterministic diagnosis batch for this round.

    Args:
        cases: The pool to draw from (``[None]`` in single-task mode).
        iteration: The round, so successive rounds see shuffled batches.
        seed: Run seed for reproducibility.

    Returns:
        Up to :data:`_BATCH_SIZE` cases, the whole pool when it is smaller.
    """
    if len(cases) <= _BATCH_SIZE:
        return list(cases)
    return random.Random((seed, iteration)).sample(cases, _BATCH_SIZE)


def _diagnose_patch(
    ctx: EngineContext,
    incumbent: Candidate,
    failures: list[tuple[Any, float, SideInfo]],
    task: Task,
    lessons: list[str],
) -> tuple[str | None, str]:
    """Ask the reflection model to diagnose failures and rewrite the version.

    Args:
        ctx: Reflection model and budget guard.
        incumbent: The version being improved.
        failures: The weakest ``(case, score, side_info)`` rows to fix.
        task: Objective and background for context.
        lessons: Diagnoses carried from earlier rounds.

    Returns:
        The rewritten version (``None`` when the model returned no usable
        patch) and the diagnosis text.
    """
    prompt = _patch_prompt(str(incumbent), failures, task, lessons)
    patch = _ask_json(ctx, prompt)
    if patch is None:
        return None, ""
    updated = patch.get("updates", {}).get(_COMPONENT) if isinstance(patch.get("updates"), dict) else None
    diagnosis = patch.get("diagnosis", "")
    if not isinstance(updated, str) or not updated.strip():
        return None, diagnosis if isinstance(diagnosis, str) else ""
    return updated, diagnosis if isinstance(diagnosis, str) else ""


def _cold_start(ctx: EngineContext, task: Task) -> str | None:
    """Generate a first version from the objective when the run is seedless.

    Args:
        ctx: Reflection model and budget guard.
        task: Objective and background to write toward.

    Returns:
        The generated version, or ``None`` when the model produced none.
    """
    patch = _ask_json(ctx, _cold_start_prompt(task))
    if patch is None or not isinstance(patch.get("updates"), dict):
        return None
    version = patch["updates"].get(_COMPONENT)
    return version if isinstance(version, str) and version.strip() else None


def _ask_json(ctx: EngineContext, prompt: str) -> dict[str, Any] | None:
    """Call the reflection model under the budget guard and parse its JSON reply.

    Args:
        ctx: Reflection model and budget guard.
        prompt: The instruction to send.

    Returns:
        The parsed object, or ``None`` when the reply held no JSON object.
    """
    if ctx.check_budget is not None:
        ctx.check_budget()
    reply = ctx.reflection_lm(prompt)
    if ctx.check_budget is not None:
        ctx.check_budget()
    return _extract_json(reply)


def _extract_json(text: str) -> dict[str, Any] | None:
    """Recover the first JSON object from a model reply, tolerating code fences.

    Args:
        text: The raw model reply.

    Returns:
        The decoded object, or ``None`` when no object could be parsed.
    """
    if not isinstance(text, str):
        return None
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except (json.JSONDecodeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _remember(lessons: list[str], diagnosis: str) -> list[str]:
    """Append a fresh diagnosis to the carried lessons, keeping the most recent.

    Args:
        lessons: Diagnoses carried so far.
        diagnosis: The latest diagnosis, ignored when empty.

    Returns:
        The trimmed lessons list.
    """
    if not diagnosis.strip():
        return lessons
    return [*lessons, diagnosis.strip()][-_MAX_LESSONS:]


def _mean(values: list[float]) -> float:
    """Return the arithmetic mean of ``values``, or ``0.0`` when empty.

    Args:
        values: The scores to average.

    Returns:
        Their mean.
    """
    return sum(values) / len(values) if values else 0.0


def _patch_prompt(incumbent: str, failures: list[tuple[Any, float, SideInfo]], task: Task, lessons: list[str]) -> str:
    """Build the diagnose-and-rewrite instruction for the reflection model.

    Args:
        incumbent: The version to improve.
        failures: The weakest ``(case, score, side_info)`` rows.
        task: Objective and background.
        lessons: Diagnoses carried from earlier rounds.

    Returns:
        A single prompt string requesting a JSON patch.
    """
    sections = [
        "You are improving a solution to maximize an automated score.",
        _context_block(task),
        f"## Current version\n{incumbent}",
        "## Weakest cases for the current version",
        _failures_block(failures),
    ]
    if lessons:
        sections.append("## Lessons from earlier rounds\n" + "\n".join(f"- {lesson}" for lesson in lessons))
    sections.append(
        "Diagnose why the current version underperforms on these cases, then rewrite the entire "
        "version to fix them without breaking what already works.\n\n"
        "Respond with ONLY a JSON object of the form:\n"
        f'{{"diagnosis": "<one or two sentences>", "updates": {{"{_COMPONENT}": "<the full rewritten version>"}}}}'
    )
    return "\n\n".join(section for section in sections if section)


def _cold_start_prompt(task: Task) -> str:
    """Build the initial-version instruction for a seedless run.

    Args:
        task: Objective and background to write toward.

    Returns:
        A single prompt string requesting a JSON version.
    """
    return "\n\n".join(
        section
        for section in [
            "You are writing an initial solution to maximize an automated score.",
            _context_block(task),
            "Write the strongest first version you can.\n\n"
            "Respond with ONLY a JSON object of the form:\n"
            f'{{"updates": {{"{_COMPONENT}": "<the version>"}}}}',
        ]
        if section
    )


def _context_block(task: Task) -> str:
    """Render the objective and background the model should optimize toward.

    Args:
        task: The task whose goal and context to describe.

    Returns:
        The formatted block, empty when neither was given.
    """
    parts: list[str] = []
    if task.objective:
        parts.append(f"## Objective\n{task.objective}")
    if task.background:
        parts.append(f"## Background\n{task.background}")
    return "\n\n".join(parts)


def _failures_block(failures: list[tuple[Any, float, SideInfo]]) -> str:
    """Render the weakest cases with their scores and scorer feedback.

    Args:
        failures: The ``(case, score, side_info)`` rows to show.

    Returns:
        One labelled block per case, feedback included when the scorer gave any.
    """
    blocks: list[str] = []
    for index, (_, score, side_info) in enumerate(failures, start=1):
        feedback = scorer_feedback_text(side_info)
        header = f"Case {index} (score {score:.3f}):"
        blocks.append(f"{header}\n{feedback}" if feedback else header)
    return "\n\n".join(blocks) if blocks else "The current version scored the same on every case in this batch."
