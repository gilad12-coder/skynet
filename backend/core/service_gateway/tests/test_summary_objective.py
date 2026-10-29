"""Keep Explore summaries grounded in the objective and scoring metric."""

from __future__ import annotations

import json
from contextlib import nullcontext
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from core.service_gateway.embedding_pipeline import core as pipeline
from core.service_gateway.embedding_pipeline import summarizer

_OBJECTIVE = "Classify each support reply's tone as empathetic, neutral, or dismissive."
_METRIC = "def score(prediction, expected):\n    return float(prediction == expected)"
_CASES = [{"input": {"reply": "I understand."}, "expected": "empathetic"}]
_SUMMARY = "Classifies the tone of support replies. Accuracy measures agreement with the expected tone label."


@pytest.mark.parametrize("unified", [False, True])
def test_classification_summary_reaches_explore(unified: bool) -> None:
    """Persist a classification summary despite a name that suggests rewriting.

    Args:
        unified: Select the nested or legacy black-box payload shape.
    """
    payload = (
        {
            "payload_kind": "unified_v1",
            "task": {"objective": _OBJECTIVE},
            "workspace": {"metric_code": _METRIC},
            "data": {"cases": _CASES},
        }
        if unified
        else {"objective": _OBJECTIVE, "scorer": {"metric_code": _METRIC}, "cases": _CASES}
    )
    job = {
        "status": "success",
        "payload_overview": {
            "optimization_type": "blackbox",
            "name": "Support reply tone",
            "description": "Make replies more empathetic.",
            "username": "fixture@example.test",
        },
        "payload": payload,
    }
    store = SimpleNamespace(engine=object(), get_job=MagicMock(return_value=job))
    session = MagicMock()
    session.__enter__.return_value = session
    session.query.return_value.filter.return_value.first.return_value = None
    embedder = MagicMock()
    embedder.encode.return_value = [0.1, 0.2, 0.3]

    def model_stub(**inputs: Any) -> SimpleNamespace:
        """Return classification only when its evidence reaches the model.

        Args:
            inputs: The summary model's supplied fields.

        Returns:
            The stubbed prediction for the supplied task evidence.
        """
        if inputs.get("objective") == _OBJECTIVE and inputs.get("metric") == _METRIC:
            assert json.loads(inputs["cases_sample"]) == _CASES
            return SimpleNamespace(task_description=_SUMMARY)
        return SimpleNamespace(task_description="Rewrites support replies to be more empathetic.")

    with (
        patch.object(pipeline.settings, "embeddings_enabled", True),
        patch.object(pipeline, "get_embedder", return_value=embedder),
        patch.object(pipeline, "_owner_can_fund_summary", return_value=True),
        patch.object(pipeline, "meter_llm_run"),
        patch.object(pipeline, "Session", return_value=session),
        patch.object(summarizer, "_build_lm", return_value=object()),
        patch.object(summarizer.dspy, "context", return_value=nullcontext()),
        patch.object(summarizer.dspy, "Predict", return_value=model_stub),
    ):
        assert pipeline.embed_finished_job("classification-fixture", job_store=store)

    row = session.add.call_args.args[0]
    assert row.summary_text == _SUMMARY
    embedder.encode.assert_called_once_with(_SUMMARY, task="retrieval.passage", user="fixture@example.test")


@pytest.mark.parametrize("blackbox", [False, True])
@pytest.mark.parametrize("failure", ["no_balance", "no_model", "call_failed", "empty_output"])
def test_objective_survives_summary_fallback(failure: str, blackbox: bool) -> None:
    """Preserve classification when the paid model cannot supply a summary.

    Args:
        failure: Select the unavailable or unusable model path.
        blackbox: Select the black-box or DSPy summarizer.
    """
    predictor = MagicMock(return_value=SimpleNamespace(task_description=""))
    if failure == "call_failed":
        predictor.side_effect = RuntimeError("model unavailable")
    with (
        patch.object(summarizer, "_build_lm", return_value=None if failure == "no_model" else object()),
        patch.object(summarizer.dspy, "context", return_value=nullcontext()),
        patch.object(summarizer.dspy, "Predict", return_value=predictor),
    ):
        summarize = summarizer.summarize_blackbox_task if blackbox else summarizer.summarize_task
        text = summarize(
            title="Make replies empathetic",
            description="Rewrite replies.",
            objective=_OBJECTIVE,
            metric=_METRIC,
            **({"cases_sample": _CASES} if blackbox else {"dataset_sample": _CASES}),
            use_llm=failure != "no_balance",
        )
    assert text == _OBJECTIVE


def test_objective_alone_is_summarized() -> None:
    """Retain the objective even when a run has no name or description."""
    assert (
        summarizer.summarize_blackbox_task(
            title=None, description=None, objective=_OBJECTIVE, cases_sample=None, use_llm=False
        )
        == _OBJECTIVE
    )
