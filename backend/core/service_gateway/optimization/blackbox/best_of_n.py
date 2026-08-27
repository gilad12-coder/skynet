"""Best-of-N engine: propose a fresh version with the reflection LM, keep the best.

The simplest useful engine — no evolution, no Pareto front — which makes it
a good explore-phase probe and a floor every other engine must beat.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ....exceptions import ServiceError
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
        try:
            if best is not None and server.remaining >= cost:
                best_score, feedback = self._score(best, cases, server)
            while server.remaining >= cost:
                if ctx.stop_at_score is not None and best_score is not None and best_score >= ctx.stop_at_score:
                    break
                proposal = _strip_fences(ctx.reflection_lm(_proposal_prompt(task, best, best_score, feedback)))
                if not proposal:
                    continue
                proposals += 1
                score, side_info = self._score(proposal, cases, server)
                if best_score is None or score > best_score:
                    best, best_score, feedback = proposal, score, side_info
        except BudgetExhaustedError:
            logger.info("best_of_n lane hit its scorer budget after %d proposals", proposals)
        if best is None:
            raise ServiceError("The best_of_n engine could not produce a version within the scorer budget.")
        return Result(
            best_candidate=best, best_score=best_score, total_evals=server.used, metadata={"proposals": proposals}
        )

    @staticmethod
    def _score(candidate: str, cases: list[Any], server: EvalServer) -> tuple[float, dict[str, Any]]:
        """Score ``candidate`` across ``cases`` (or alone when there are none).

        Args:
            candidate: The version to score.
            cases: The cases to average over; empty in single-task mode.
            server: The budgeted scorer.

        Returns:
            The mean score and the last case's side information.
        """
        if not cases:
            return server.evaluate(candidate, None)
        total = 0.0
        side_info: dict[str, Any] = {}
        for case in cases:
            score, side_info = server.evaluate(candidate, case)
            total += score
        return total / len(cases), side_info
