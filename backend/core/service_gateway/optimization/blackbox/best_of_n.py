"""Best-of-N engine: propose a fresh version with the reflection LM, keep the best.

The simplest useful engine — no evolution, no Pareto front — which makes it
a good explore-phase probe and a floor every other engine must beat.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ....exceptions import ServiceError
from .feedback import emit_candidate, emit_scorer_feedback
from .protocol import BudgetExhaustedError, EngineContext, EvalServer, Result, Task

logger = logging.getLogger(__name__)

_FEEDBACK_CHARS = 2000


def _strip_fences(text: str) -> str:
    """Drop a surrounding markdown code fence the LM may have added.

    Args:
        text: The raw LM output.

    Returns:
        The output without a leading/trailing ``\\`\\`\\``` fence.
    """
    stripped = text.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        body = stripped[3:-3]
        first_newline = body.find("\n")
        if first_newline != -1:
            body = body[first_newline + 1 :]
        return body.strip()
    return stripped


def _proposal_prompt(task: Task, current: str | None, score: float | None, feedback: dict[str, Any]) -> str:
    """Build the prompt asking the reflection LM for a new version.

    Args:
        task: The objective/background and starting point.
        current: The best version so far, or ``None`` when seedless.
        score: Its score, if known.
        feedback: Side information from scoring it.

    Returns:
        The prompt text.
    """
    parts = ["You are improving a text artifact so that it scores higher on an automated scorer."]
    if task.objective:
        parts.append(f"Objective: {task.objective}")
    if task.background:
        parts.append(f"Background: {task.background}")
    if current is None:
        parts.append("There is no version yet. Write a first version that satisfies the objective.")
    else:
        score_text = "unknown" if score is None else f"{score:.4f}"
        parts.append(f"Current best version (score {score_text}):\n<<<\n{current}\n>>>")
        if feedback:
            parts.append(f"Scorer feedback: {json.dumps(feedback, default=str)[:_FEEDBACK_CHARS]}")
        parts.append("Write an improved version.")
    parts.append("Output only the new version, with no commentary and no code fences.")
    return "\n\n".join(parts)


class BestOfNEngine:
    """Propose → score → keep-the-best, until the lane budget is spent."""

    name = "best_of_n"

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Optimize ``task`` by repeated independent proposals.

        Args:
            task: The starting point, goal and cases.
            server: The budgeted scorer for this lane.
            ctx: Reflection LM and stop settings.

        Returns:
            The best-scoring version seen (the seed when nothing beat it).

        Raises:
            ServiceError: When given a multi-part starting point.
        """
        if not task.str_mode:
            raise ServiceError("The best_of_n engine supports text starting points only.")
        cases = task.val_set or task.train_set
        cost = max(1, len(cases))
        best: str | None = task.seed_candidate if isinstance(task.seed_candidate, str) else None
        best_score: float | None = None
        feedback: dict[str, Any] = {}
        proposals = 0
        # Every fully scored version is a node of the candidate tree, numbered
        # in scoring order and hung under the best version it was proposed from.
        versions = 0
        best_id: str | None = None
        best_generation = 0
        try:
            if best is not None and server.remaining >= cost:
                best_score, feedback = self._score(best, cases, server, ctx, version=0, parent=None, generation=0)
                best_id, versions = "0", 1
            while server.remaining >= cost:
                if ctx.stop_at_score is not None and best_score is not None and best_score >= ctx.stop_at_score:
                    break
                proposal = _strip_fences(ctx.reflection_lm(_proposal_prompt(task, best, best_score, feedback)))
                if not proposal:
                    continue
                proposals += 1
                generation = 0 if best_id is None else best_generation + 1
                score, side_info = self._score(
                    proposal, cases, server, ctx, version=versions, parent=best_id, generation=generation
                )
                version_id = str(versions)
                versions += 1
                if best_score is None or score > best_score:
                    best, best_score, feedback = proposal, score, side_info
                    best_id, best_generation = version_id, generation
        except BudgetExhaustedError:
            logger.info("best_of_n lane hit its scorer budget after %d proposals", proposals)
        if best is None:
            raise ServiceError("The best_of_n engine could not produce a version within the scorer budget.")
        return Result(
            best_candidate=best, best_score=best_score, total_evals=server.used, metadata={"proposals": proposals}
        )

    @staticmethod
    def _score(
        candidate: str,
        cases: list[Any],
        server: EvalServer,
        ctx: EngineContext,
        *,
        version: int,
        parent: str | None,
        generation: int,
    ) -> tuple[float, dict[str, Any]]:
        """Score ``candidate`` across ``cases`` (or alone when there are none), streaming as it goes.

        Each scorer call is forwarded as feedback when it returns, and the
        version becomes a candidate-tree node once every case is scored.

        Args:
            candidate: The version to score.
            cases: The cases to average over; empty in single-task mode.
            server: The budgeted scorer.
            ctx: For the progress sink.
            version: The version's index in scoring order; its id and iteration.
            parent: Id of the best version it was proposed from; ``None`` for the first.
            generation: Depth in the candidate tree.

        Returns:
            The mean score and the last case's side information.

        Raises:
            BudgetExhaustedError: Midway, when the lane's budget runs out; no node is announced then.
        """
        total = 0.0
        side_info: dict[str, Any] = {}
        per_example: list[tuple[str, float]] = []
        for position, case in enumerate(cases or [None]):
            score, side_info = server.evaluate(candidate, case)
            emit_scorer_feedback(
                ctx.progress_callback, example_id=str(position), score=score, side_info=side_info, iteration=version
            )
            per_example.append((str(position), score))
            total += score
        mean = total / len(per_example)
        emit_candidate(
            ctx.progress_callback,
            candidate_id=str(version),
            parent_id=parent,
            generation=generation,
            score=mean,
            per_example=per_example,
            candidate=candidate,
            discovered_at_evals=server.used,
            iteration=version,
        )
        return mean, side_info
