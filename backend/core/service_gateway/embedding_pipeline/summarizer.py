"""LLM-backed task summariser feeding ``embedding_summary``.

Given a finished job, we want ~2-3 sentences describing *what the task is*
in natural language: input → output, objective, metric shape. This text is
embedded into ``embedding_summary``, which drives explore semantic search.
DSPy jobs are summarised from their signature / metric / column mapping;
black-box ("optimize anything") jobs from the user's objective, background,
starting artifact and scorer — the two shapes share no fields, so each has
its own signature and heuristic fallback.
Keeping a natural-language summary (rather than raw code) lets
semantically-similar tasks cluster together even when their Python source
looks unrelated.

The summariser is cheap to stub: ``settings.embeddings_summary_model`` (or
``settings.code_agent_model`` as fallback) is a normal LiteLLM model id,
wrapped in ``dspy.Predict``. If it fails for any reason (no key, network
error, quota) we fall back to a heuristic text composed from the column
mapping — the pipeline keeps working, just with weaker signal.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import dspy

from ...config import settings
from ...models import ModelConfig
from ..language_models import build_language_model

logger = logging.getLogger(__name__)


def _truncate(value: str, limit: int, *, label: str) -> str:
    """Truncate ``value`` to ``limit`` chars, appending ``…`` and logging when cut.

    Args:
        value: The string to bound.
        limit: Maximum length before truncation kicks in.
        label: Short identifier logged when truncation happens, so debug
            output points at the offending field.

    Returns:
        ``value`` unchanged when within ``limit``; otherwise the first
        ``limit`` characters with a single-character ``…`` marker so the
        downstream LLM (and any future log reader) can see the cut.
    """
    if len(value) <= limit:
        return value
    logger.debug("summariser truncated %s from %d chars to %d", label, len(value), limit)
    return value[:limit] + "…"


class _TaskSummary(dspy.Signature):
    """Describe a DSPy optimization task in 2-3 sentences."""

    signature_code: str = dspy.InputField(desc="The DSPy Signature source code being optimised.")
    metric_code: str = dspy.InputField(desc="The metric function source code (scoring rule).")
    column_mapping: str = dspy.InputField(desc="JSON column → role map (which columns feed inputs vs outputs).")
    dataset_sample: str = dspy.InputField(desc="A handful of sample rows from the training dataset.")
    task_description: str = dspy.OutputField(
        desc=(
            "2-3 sentences describing the task in plain English: what the "
            "inputs are, what output is produced, what the objective is. "
            "Avoid naming the optimizer or model — this text describes the "
            "task itself, not how it's trained."
        )
    )


class _BlackboxTaskSummary(dspy.Signature):
    """Describe a black-box optimization task in 2-3 sentences."""

    objective: str = dspy.InputField(desc="What the user wants improved, in their own words.")
    background: str = dspy.InputField(desc="Extra context about the artifact or the setting it runs in.")
    artifact: str = dspy.InputField(
        desc="The kind of artifact under optimization (prompt, code, text or setup) and an excerpt of its starting version."
    )
    scorer: str = dspy.InputField(
        desc="How a version is scored: the python metric source, or a note that a remote HTTP scorer is used."
    )
    cases_sample: str = dspy.InputField(desc="A handful of sample evaluation cases (may be empty).")
    task_description: str = dspy.OutputField(
        desc=(
            "2-3 sentences describing the task in plain English: what artifact "
            "is being improved, what a good result looks like, and how it is "
            "scored. Avoid naming the engine or model — this text describes "
            "the task itself, not how it's optimized."
        )
    )


_RECIPE_ARTIFACT_LABEL = {
    "prompt": "a prompt",
    "code": "code",
    "anything": "free-form text or a setup",
}


def _seed_excerpt(seed_candidate: str | dict[str, str] | None, *, limit: int) -> str:
    """Flatten a starting candidate (single text or ``{path: content}``) to a bounded excerpt.

    Args:
        seed_candidate: The submitted starting version; ``None`` when the run
            began from scratch.
        limit: Maximum number of characters to keep.

    Returns:
        The first ``limit`` characters of the candidate text, multi-file
        candidates rendered as ``path:`` blocks; empty when nothing was given.
    """
    if isinstance(seed_candidate, dict):
        text = "\n".join(f"{path}:\n{content}" for path, content in seed_candidate.items())
    else:
        text = seed_candidate or ""
    return _truncate(text.strip(), limit, label="seed_candidate")


def _heuristic_blackbox_summary(
    *,
    objective: str | None,
    background: str | None,
    description: str | None,
    seed_excerpt: str,
) -> str:
    """Fallback summary for a black-box job built from the user's own words.

    Args:
        objective: What the user asked to improve.
        background: Extra context the user supplied.
        description: The short run description from the submission form.
        seed_excerpt: Bounded excerpt of the starting artifact.

    Returns:
        Objective (or description) plus background, else the seed excerpt;
        empty only when the job carried none of those.
    """
    parts = [part.strip() for part in (objective or description, background) if part and part.strip()]
    if parts:
        return " ".join(parts)[:600]
    return seed_excerpt[:500]


def _heuristic_summary(
    signature_code: str | None,
    metric_code: str | None,
    column_mapping: dict[str, Any] | None,
) -> str:
    """Fallback summary built by inspecting the code + column mapping.

    Used when the LLM call is unavailable. Worse than a real summary
    for semantic search, but still non-empty and deterministic.

    Args:
        signature_code: Source code of the user's DSPy signature.
        metric_code: Source code of the user's metric function.
        column_mapping: Optional ``{"inputs": ..., "outputs": ...}`` map.

    Returns:
        A short text summary derived from the column mapping and metric
        first-line, or the truncated signature code when the mapping is
        missing.
    """
    if not column_mapping:
        return (signature_code or "").strip()[:500]
    inputs = column_mapping.get("inputs", {}) or {}
    outputs = column_mapping.get("outputs", {}) or {}
    in_names = list(inputs.values()) if isinstance(inputs, dict) else []
    out_names = list(outputs.values()) if isinstance(outputs, dict) else []
    parts: list[str] = []
    if in_names and out_names:
        parts.append(f"Task maps {', '.join(in_names)} to {', '.join(out_names)}.")
    elif in_names:
        parts.append(f"Task takes {', '.join(in_names)} as input.")
    if metric_code and len(metric_code) < 400:
        parts.append(f"Scored by: {metric_code.strip().splitlines()[0] if metric_code.strip() else ''}")
    return " ".join(p for p in parts if p).strip() or (signature_code or "").strip()[:500]


def _build_lm() -> dspy.LM | None:
    """Build the LM used for summarisation, preferring the dedicated setting.

    Routes through :func:`build_language_model` so the summariser obeys
    the same provider/base-url/extra-kwargs handling as the optimization
    path — keeps one factory in charge of LiteLLM idiosyncrasies.

    Returns:
        A :class:`dspy.LM` instance configured with
        ``embeddings_summary_model`` (or ``code_agent_model`` as fallback),
        or ``None`` when no model id is set or instantiation fails.
    """
    model_id = (settings.embeddings_summary_model or settings.code_agent_model).strip()
    if not model_id:
        return None
    try:
        return build_language_model(
            ModelConfig(name=model_id, max_tokens=1024, temperature=0.0)
        )
    except Exception as exc:
        logger.warning("Could not build summariser LM (%s): %s", model_id, exc)
        return None


def summarize_task(
    *,
    signature_code: str | None,
    metric_code: str | None,
    column_mapping: dict[str, Any] | None,
    dataset_sample: list[dict[str, Any]] | None,
) -> str:
    """Return a short natural-language description of the task.

    Never raises. Returns an empty string if nothing useful can be
    produced — callers should treat empty as "skip the summary
    embedding for this job."

    Args:
        signature_code: Source code of the user's DSPy signature.
        metric_code: Source code of the user's metric function.
        column_mapping: Optional column → role map for the dataset.
        dataset_sample: Optional list of sample rows; the first three
            are forwarded to the summariser LM.

    Returns:
        A 2-3 sentence task description from the LLM, or the heuristic
        fallback string when the LLM is unavailable or its call fails.
    """
    fallback = _heuristic_summary(signature_code, metric_code, column_mapping)
    lm = _build_lm()
    if lm is None:
        return fallback
    try:
        sample_rows = dataset_sample[:3] if dataset_sample else []
        predictor = dspy.Predict(_TaskSummary)
        with dspy.context(lm=lm):
            out = predictor(
                signature_code=_truncate((signature_code or "").strip(), 4000, label="signature_code"),
                metric_code=_truncate((metric_code or "").strip(), 4000, label="metric_code"),
                column_mapping=_truncate(
                    json.dumps(column_mapping or {}, ensure_ascii=False), 1000, label="column_mapping"
                ),
                dataset_sample=_truncate(
                    json.dumps(sample_rows, ensure_ascii=False), 2000, label="dataset_sample"
                ),
            )
        text = (out.task_description or "").strip()
        return text or fallback
    except Exception as exc:
        logger.warning("Summariser LLM call failed: %s", exc)
        return fallback


def summarize_blackbox_task(
    *,
    objective: str | None,
    background: str | None,
    description: str | None,
    recipe: str | None,
    seed_candidate: str | dict[str, str] | None,
    scorer: dict[str, Any] | None,
    cases_sample: list[dict[str, Any]] | None,
) -> str:
    """Return a short natural-language description of a black-box task.

    Mirrors :func:`summarize_task` for "optimize anything" jobs, which carry
    no DSPy signature or column mapping. Never raises; an empty string means
    the job had no describable content and should be skipped.

    Args:
        objective: What the user asked to improve, in their own words.
        background: Extra context the user supplied about the task.
        description: The short run description from the submission form.
        recipe: Which wizard recipe authored the run (prompt / code / anything).
        seed_candidate: The starting artifact, single text or ``{path: content}``.
        scorer: The submitted scorer dict (``kind`` plus ``metric_code`` or ``url``).
        cases_sample: Optional evaluation cases; the first three are forwarded.

    Returns:
        A 2-3 sentence task description from the LLM, or the heuristic
        fallback when the LLM is unavailable or its call fails.
    """
    seed_excerpt = _seed_excerpt(seed_candidate, limit=2000)
    fallback = _heuristic_blackbox_summary(
        objective=objective, background=background, description=description, seed_excerpt=seed_excerpt
    )
    if not fallback:
        return ""
    lm = _build_lm()
    if lm is None:
        return fallback
    scorer = scorer or {}
    if scorer.get("kind") == "remote":
        scorer_text = "Remote HTTP scorer (opaque to us)."
    else:
        scorer_text = _truncate((scorer.get("metric_code") or "").strip(), 4000, label="metric_code")
    artifact_kind = _RECIPE_ARTIFACT_LABEL.get(recipe or "", _RECIPE_ARTIFACT_LABEL["anything"])
    try:
        sample_rows = cases_sample[:3] if cases_sample else []
        predictor = dspy.Predict(_BlackboxTaskSummary)
        with dspy.context(lm=lm):
            out = predictor(
                objective=_truncate((objective or "").strip(), 2000, label="objective"),
                background=_truncate((background or "").strip(), 2000, label="background"),
                artifact=f"Optimizing {artifact_kind}. Starting version:\n{seed_excerpt}",
                scorer=scorer_text,
                cases_sample=_truncate(json.dumps(sample_rows, ensure_ascii=False), 2000, label="cases_sample"),
            )
        text = (out.task_description or "").strip()
        return text or fallback
    except Exception as exc:
        logger.warning("Black-box summariser LLM call failed: %s", exc)
        return fallback
