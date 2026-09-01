"""Stream what an engine learns — each scorer call and each scored version — as trajectory events.

DSPy runs feed the metric's feedback text into the candidate tree drawer
through :data:`PROGRESS_MINIBATCH` events and every accepted program
through :data:`PROGRESS_CANDIDATE` events. Black-box runs have no metric
and no DSPy optimizer, so the scorer's side info and the engine's own
versions stand in: this module puts them on the wire in the same shapes so
the frontend renders both kinds of run identically, while the run is
still going.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any

from ....constants import PROGRESS_CANDIDATE, PROGRESS_CASE_SCORED, PROGRESS_MINIBATCH
from ..trajectory import MINIBATCH_FEEDBACK_CHAR_CAP, CandidateEvent, current_proposal_iteration
from .protocol import Candidate, SideInfo
from .runner import side_info_json_default

logger = logging.getLogger(__name__)

# Scorers that follow the documented contract put their prose under this key.
FEEDBACK_KEY = "feedback"
# Part name a text-only version travels under in candidate events; the
# frontend keys renders and diffs off it (BLACKBOX_STR_CANDIDATE_KEY).
STR_CANDIDATE_KEY = "current_candidate"


def is_data_image(value: Any) -> bool:
    """Tell whether a side-info value is an inline ``data:image/…`` URL.

    Args:
        value: Any side-info value.

    Returns:
        Whether it is an inline image.
    """
    return isinstance(value, str) and value.startswith("data:image/")


def without_images(side_info: dict[str, Any]) -> dict[str, Any]:
    """Return ``side_info`` with its inline images (top-level or in lists) removed.

    Args:
        side_info: JSON-safe side info.

    Returns:
        The same mapping minus every data-URL image.
    """
    stripped: dict[str, Any] = {}
    for key, value in side_info.items():
        if is_data_image(value):
            continue
        if isinstance(value, list):
            value = [item for item in value if not is_data_image(item)]
        stripped[key] = value
    return stripped


def scorer_feedback_text(side_info: SideInfo) -> str:
    """Flatten the scorer's non-image side info into one feedback text.

    A ``feedback`` string leads verbatim; every other entry becomes a
    ``key: value`` line with non-strings JSON-encoded, so a crash's
    ``error`` and ad-hoc diagnostics reach the tree too.

    Args:
        side_info: What the scorer returned next to the score.

    Returns:
        The feedback text, capped at :data:`MINIBATCH_FEEDBACK_CHAR_CAP`;
        empty when the scorer said nothing beyond images.
    """
    notes = without_images(side_info)
    lines: list[str] = []
    feedback = notes.pop(FEEDBACK_KEY, None)
    if feedback is not None:
        lines.append(feedback if isinstance(feedback, str) else _dump(feedback))
    for key, value in notes.items():
        if value is None or (isinstance(value, (list, dict)) and not value):
            continue
        lines.append(f"{key}: {value if isinstance(value, str) else _dump(value)}")
    return "\n".join(line for line in lines if line.strip())[:MINIBATCH_FEEDBACK_CHAR_CAP]


def _dump(value: Any) -> str:
    """JSON-encode a side-info value for display.

    Args:
        value: Any JSON-safe (or image-bearing) side-info value.

    Returns:
        Its compact JSON form.
    """
    return json.dumps(value, ensure_ascii=False, default=side_info_json_default)


def emit_scorer_feedback(
    progress_callback: Callable[[str, dict[str, Any]], None] | None,
    *,
    example_id: str,
    score: float,
    side_info: SideInfo,
    iteration: int | None = None,
) -> None:
    """Forward one scorer call as a mini-batch feedback event, if it said anything.

    The event mirrors what DSPy runs emit per metric call, including the
    proposal iteration the call belongs to, so the drawer can show a
    candidate the feedback that led to it.

    Args:
        progress_callback: The lane's progress sink, if any.
        example_id: Display id of the case the scorer graded (``"?"`` when none).
        score: The score the scorer returned.
        side_info: What the scorer returned next to the score.
        iteration: The version the call scores. Engines that score from
            worker threads pass it explicitly; unset, it is read from the
            proposal-iteration context GEPA maintains on the calling thread.
    """
    if progress_callback is None:
        return
    feedback = scorer_feedback_text(side_info)
    if not feedback:
        return
    if iteration is None:
        iteration = current_proposal_iteration()
    try:
        progress_callback(
            PROGRESS_MINIBATCH,
            {
                "example_id": example_id,
                "score": score,
                "feedback": feedback,
                "prediction": "",
                "iteration": iteration,
            },
        )
    except Exception:
        logger.exception("progress_callback raised for scorer feedback (example=%s)", example_id)


def emit_case_scored(
    progress_callback: Callable[[str, dict[str, Any]], None] | None,
    *,
    trial: int,
    example_id: str,
    score: float,
    total: int,
) -> None:
    """Announce one scored case of a version that is scored on every case.

    Feedback events fire only when the scorer had something to say, so an
    engine that sweeps every case per version sends this alongside: the run
    view fills the version in case by case while the rest are still running.

    Args:
        progress_callback: The job's progress sink, if any.
        trial: Index of the version in the engine's history.
        example_id: Display id of the case.
        score: The score the scorer returned.
        total: How many cases the version is scored on.
    """
    if progress_callback is None:
        return
    try:
        progress_callback(
            PROGRESS_CASE_SCORED, {"trial": trial, "example_id": example_id, "score": score, "total": total}
        )
    except Exception:
        logger.exception("progress_callback raised for a scored case (trial=%s, example=%s)", trial, example_id)


def candidate_parts(candidate: Candidate) -> dict[str, str]:
    """Give a version the ``{part: text}`` shape candidate events carry.

    Args:
        candidate: Text or named parts.

    Returns:
        The parts, a text version under :data:`STR_CANDIDATE_KEY`.
    """
    if isinstance(candidate, str):
        return {STR_CANDIDATE_KEY: candidate}
    return dict(candidate)


def emit_candidate(
    progress_callback: Callable[[str, dict[str, Any]], None] | None,
    *,
    candidate_id: str,
    parent_id: str | None,
    generation: int,
    score: float,
    per_example: list[tuple[str, float]],
    candidate: Candidate,
    discovered_at_evals: int,
    iteration: int | None,
) -> None:
    """Announce a fully scored version as a node of the candidate tree.

    Emit each id once: the frontend keeps the first event per id.

    Args:
        progress_callback: The lane's progress sink, if any.
        candidate_id: The version's id within the lane.
        parent_id: The version it was proposed from; ``None`` for the first.
        generation: Depth in the tree — the parent's plus one, 0 for the first.
        score: Its mean score.
        per_example: ``(case id, score)`` per case scored.
        candidate: The version's text or parts.
        discovered_at_evals: Scorer runs the lane had spent when it was scored.
        iteration: The loop iteration that produced it; pairs the version
            with the scorer feedback emitted under the same value.
    """
    if progress_callback is None:
        return
    event = CandidateEvent(
        id=candidate_id,
        parent_id=parent_id,
        parents_extra=(),
        generation=generation,
        score=score,
        per_example=tuple(per_example),
        prompt=candidate_parts(candidate),
        discovered_at_evals=discovered_at_evals,
        iteration=iteration,
    )
    try:
        progress_callback(PROGRESS_CANDIDATE, event.to_metrics())
    except Exception:
        logger.exception("progress_callback raised for candidate %s", candidate_id)
