"""Tests for the black-box branch of the explore task summariser."""

from __future__ import annotations

from unittest.mock import patch

from core.service_gateway.embedding_pipeline import summarizer


def test_heuristic_blackbox_summary_prefers_objective_and_background() -> None:
    """The fallback text is the user's objective followed by their background."""
    text = summarizer._heuristic_blackbox_summary(
        objective="Make the unicorn look real.",
        background="Rendered with pyrender.",
        description="ignored when objective exists",
        seed_excerpt="def build(): ...",
    )
    assert text == "Make the unicorn look real. Rendered with pyrender."


def test_heuristic_blackbox_summary_falls_back_to_description_then_seed() -> None:
    """Description stands in for a missing objective; the seed excerpt is the last resort."""
    assert (
        summarizer._heuristic_blackbox_summary(
            objective=None, background=None, description="Tidy the prompt", seed_excerpt="x"
        )
        == "Tidy the prompt"
    )
    assert (
        summarizer._heuristic_blackbox_summary(
            objective=None, background="  ", description=None, seed_excerpt="You are a helpful bot"
        )
        == "You are a helpful bot"
    )
    assert (
        summarizer._heuristic_blackbox_summary(objective=None, background=None, description=None, seed_excerpt="") == ""
    )


def test_seed_excerpt_flattens_multi_file_candidates() -> None:
    """Multi-file seeds render as ``path:`` blocks so the LLM sees every file."""
    text = summarizer._seed_excerpt({"a.py": "print(1)", "b.py": "print(2)"}, limit=100)
    assert text == "a.py:\nprint(1)\nb.py:\nprint(2)"
    assert summarizer._seed_excerpt(None, limit=10) == ""


def test_summarize_blackbox_task_returns_fallback_without_lm() -> None:
    """With no summariser model configured the heuristic text is returned as-is."""
    with patch.object(summarizer, "_build_lm", return_value=None):
        text = summarizer.summarize_blackbox_task(
            objective="Shorter answers.",
            background=None,
            description=None,
            recipe="prompt",
            seed_candidate="Answer briefly.",
            scorer={"kind": "remote", "url": "https://scorer.example"},
            cases_sample=None,
        )
    assert text == "Shorter answers."


def test_summarize_blackbox_task_skips_lm_when_nothing_to_describe() -> None:
    """An empty job never reaches the LLM; the empty string tells the pipeline to skip."""
    with patch.object(summarizer, "_build_lm", side_effect=AssertionError("LM built")):
        text = summarizer.summarize_blackbox_task(
            objective=None,
            background=None,
            description=None,
            recipe=None,
            seed_candidate=None,
            scorer=None,
            cases_sample=None,
        )
    assert text == ""
