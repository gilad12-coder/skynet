"""Tests for the black-box branch of the explore task summariser."""

from __future__ import annotations

from unittest.mock import patch

from core.service_gateway.embedding_pipeline import summarizer


def test_heuristic_summary_joins_title_and_description() -> None:
    """The fallback text is the task's title followed by its description."""
    text = summarizer._heuristic_summary("Make a unicorn", "Rendered with pyrender.")
    assert text == "Make a unicorn Rendered with pyrender."


def test_heuristic_summary_tolerates_missing_parts() -> None:
    """Either field alone stands; a blank or absent pair yields the empty string."""
    assert summarizer._heuristic_summary("Tidy the prompt", None) == "Tidy the prompt"
    assert summarizer._heuristic_summary(None, "You are a helpful bot") == "You are a helpful bot"
    assert summarizer._heuristic_summary(None, "   ") == ""
    assert summarizer._heuristic_summary(None, None) == ""


def test_summarize_blackbox_task_returns_fallback_without_lm() -> None:
    """With no summariser model configured the heuristic text is returned as-is."""
    with patch.object(summarizer, "_build_lm", return_value=None):
        text = summarizer.summarize_blackbox_task(
            title="Shorter answers",
            description="Answer briefly.",
            cases_sample=None,
        )
    assert text == "Shorter answers Answer briefly."


def test_summarize_blackbox_task_skips_lm_when_nothing_to_describe() -> None:
    """An empty job never reaches the LLM; the empty string tells the pipeline to skip."""
    with patch.object(summarizer, "_build_lm", side_effect=AssertionError("LM built")):
        text = summarizer.summarize_blackbox_task(
            title=None,
            description=None,
            cases_sample=None,
        )
    assert text == ""
