"""Verify isolated setup checks exercise configured task models without optimization."""

from __future__ import annotations

from typing import Any

import dspy
import pytest
from dspy.utils.dummies import DummyLM

from core.worker import preflight


def _payload() -> dict[str, Any]:
    """Build one parent-selected training sample with authored metric code."""
    return {
        "module_name": "predict",
        "signature_code": "import dspy\nclass Answer(dspy.Signature):\n    question: str = dspy.InputField()\n    answer: str = dspy.OutputField()\n",
        "metric_code": "def metric(gold, pred, trace=None):\n    return float(gold.answer == pred.answer)\n",
        "column_mapping": {"inputs": {"question": "question"}, "outputs": {"answer": "answer"}},
        "dataset": [{"question": "sample", "answer": "yes"}],
        "model_config": {"name": "test/model"},
    }


def test_evaluation_check_does_not_call_models(monkeypatch: pytest.MonkeyPatch) -> None:
    """Inspect authored code and sample mapping while explicitly deferring inference."""

    def forbid(*args: Any, **kwargs: Any) -> None:
        """Reject accidental paid model construction during evaluation-only setup."""
        pytest.fail("Evaluation-only preflight must not invoke a model.")

    monkeypatch.setattr(preflight, "build_language_model", forbid)
    result = preflight.run_dspy_preflight(_payload(), {"scope": "evaluation"})
    assert result["checks"][-1] == {"key": "sample_prediction", "status": "pending"}


def test_execution_checks_each_task_model_without_search(monkeypatch: pytest.MonkeyPatch) -> None:
    """Perform a sample prediction and actual metric for each grid task configuration."""
    calls = []

    def build(config: Any, **kwargs: Any) -> DummyLM:
        """Return deterministic DSPy responses instead of contacting a model provider."""
        calls.append(config.name)
        return DummyLM([{"answer": "yes"}])

    monkeypatch.setattr(preflight, "build_language_model", build)
    payload = _payload()
    payload["generation_models"] = [{"name": "test/a"}, {"name": "test/b"}]
    with dspy.context():
        result = preflight.run_dspy_preflight(payload, {"scope": "execution"})
    assert calls == ["test/a", "test/b"]
    assert [score["score"] for score in result["sample_scores"]] == [1.0, 1.0]
    assert all(check["status"] == "succeeded" for check in result["checks"])


def _workflow_payload(*, fail: bool = False) -> dict[str, Any]:
    """Build an actual authored transform between workflow input and output anchors."""
    payload = _payload()
    payload["module_name"] = "workflow"
    code = "def transform(question):\n    return {'answer': question.upper()}\n"
    if fail:
        code = "def transform(question):\n    raise ValueError('sample node failed')\n"
    payload["workflow"] = {
        "nodes": [
            {"id": "input", "kind": "input", "fields": [{"name": "question"}]},
            {
                "id": "actual_transform",
                "kind": "transform",
                "transform_code": code,
                "input_fields": [{"name": "question"}],
                "output_fields": [{"name": "answer"}],
            },
            {"id": "output", "kind": "output", "fields": [{"name": "answer"}]},
        ],
        "edges": [
            {"source": "input", "source_port": "question", "target": "actual_transform", "target_port": "question"},
            {"source": "actual_transform", "source_port": "answer", "target": "output", "target_port": "answer"},
        ],
    }
    payload["dataset"] = [{"question": "real sample", "answer": "REAL SAMPLE"}]
    return payload


def test_workflow_preflight_returns_actual_sample_traces(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replay the actual authored transform and its output anchor without optimization."""
    monkeypatch.setattr(preflight, "build_language_model", lambda *_args, **_kwargs: DummyLM([]))
    result = preflight.run_dspy_preflight(_workflow_payload(), {"scope": "execution"})
    actual = result["workflow_result"]
    assert actual["outputs"] == {"answer": "REAL SAMPLE"}
    assert actual["model_used"] == "test/model"
    assert [trace["node_id"] for trace in actual["node_traces"]] == ["input", "actual_transform", "output"]
    assert actual["node_traces"][1]["inputs"] == {"question": "real sample"}
    assert actual["node_traces"][1]["outputs"] == {"answer": "REAL SAMPLE"}
    assert actual["error"] is None
    assert result["sample_score"] == 1.0


def test_workflow_preflight_retains_actual_failed_node_trace(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep partial traces while a real node failure blocks setup readiness."""
    monkeypatch.setattr(preflight, "build_language_model", lambda *_args, **_kwargs: DummyLM([]))
    result = preflight.run_dspy_preflight(_workflow_payload(fail=True), {"scope": "execution"})
    actual = result["workflow_result"]
    assert actual["outputs"] is None
    assert actual["failed_node_id"] == "actual_transform"
    assert "sample node failed" in actual["error"]
    assert [trace["node_id"] for trace in actual["node_traces"]] == ["input", "actual_transform"]
    assert result["checks"][-1]["status"] == "failed"
    assert result["sample_scores"] == []


def test_explicit_workflow_preview_uses_only_debug_inputs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Execute explicit debug values without inventing a gold answer or evaluating a metric."""
    monkeypatch.setattr(preflight, "build_language_model", lambda *_args, **_kwargs: DummyLM([]))
    payload = _workflow_payload()
    payload["inputs"] = {"question": "explicit debug input"}
    payload["metric_code"] = "raise AssertionError('A debug preview must not load a metric')"
    result = preflight.run_dspy_preflight(payload, {"kind": "workflow_preview"})
    assert result["workflow_result"]["outputs"] == {"answer": "EXPLICIT DEBUG INPUT"}
    assert result["workflow_result"]["node_traces"][1]["inputs"] == {"question": "explicit debug input"}
    assert "sample_score" not in result
    assert "sample_scores" not in result


def test_explicit_workflow_preview_preserves_failed_node(monkeypatch: pytest.MonkeyPatch) -> None:
    """Return the real failed node and partial traces from an explicit preview."""
    monkeypatch.setattr(preflight, "build_language_model", lambda *_args, **_kwargs: DummyLM([]))
    payload = _workflow_payload(fail=True)
    payload["inputs"] = {"question": "explicit debug input"}
    result = preflight.run_dspy_preflight(payload, {"kind": "workflow_preview"})
    assert result["workflow_result"]["failed_node_id"] == "actual_transform"
    assert "sample node failed" in result["workflow_result"]["error"]
    assert result["workflow_result"]["node_traces"][-1]["node_id"] == "actual_transform"


@pytest.mark.parametrize("node_failure", [False, True])
def test_workflow_preview_does_not_replay_after_stream_dispatch(
    monkeypatch: pytest.MonkeyPatch, node_failure: bool
) -> None:
    """Preserve a stream failure without executing a second blocking prediction."""
    calls = []

    def streamify(*args: Any, **kwargs: Any):
        """Return an execution stream that fails after its physical attempt starts."""

        def stream(**inputs: Any):
            """Report an actual midstream failure without returning a prediction."""
            calls.append(inputs)
            if node_failure:
                raise RuntimeError("Stream ended after provider dispatch") from preflight.WorkflowNodeExecutionError(
                    "actual_transform", "Wrapped node failure"
                )
            raise RuntimeError("Stream ended after provider dispatch")
            yield

        return stream

    monkeypatch.setattr(preflight, "build_language_model", lambda *_args, **_kwargs: DummyLM([]))
    monkeypatch.setattr(preflight.dspy, "streamify", streamify)
    payload = _workflow_payload()
    payload["inputs"] = {"question": "explicit"}
    result = preflight.run_dspy_preflight(payload, {"kind": "workflow_preview", "stream": True}, lambda _value: None)
    assert result["workflow_result"]["outputs"] is None
    if node_failure:
        assert result["workflow_result"]["failed_node_id"] == "actual_transform"
        assert "Wrapped node failure" in result["workflow_result"]["error"]
    else:
        assert "provider dispatch" in result["workflow_result"]["error"]
    assert calls == [{"question": "explicit"}]
