"""Tests for :mod:`...agents.acting_react`: a step with no tool call is retried, not ended on."""

from __future__ import annotations

import dspy
import pytest
from dspy.adapters.types.tool import ToolCalls
from dspy.utils.exceptions import AdapterParseError

from ..agents import acting_react
from ..agents.acting_react import ActingReActV2, _ActingPredict


class _Sig(dspy.Signature):
    """Tiny signature so the predictor can be built without an LM."""

    question: str = dspy.InputField()
    answer: str = dspy.OutputField()


def _calls(*names: str) -> ToolCalls:
    """Build a tool-call envelope naming the given tools.

    Args:
        *names: Tool names to call, each with empty args.

    Returns:
        The envelope.
    """
    return ToolCalls(tool_calls=[ToolCalls.ToolCall(name=n, args={}) for n in names])


def _scripted(monkeypatch: pytest.MonkeyPatch, outcomes: list) -> list[dict]:
    """Make ``dspy.Predict.forward`` return or raise the given outcomes in order.

    Args:
        monkeypatch: Pytest monkeypatch fixture.
        outcomes: Predictions to return, or exceptions to raise, per call.

    Returns:
        The ``config`` each call received, filled in as calls happen.
    """
    configs: list[dict] = []

    def fake_forward(self: dspy.Predict, **kwargs: object) -> dspy.Prediction:
        """Record the call's config and play the next outcome."""
        configs.append(dict(kwargs.get("config") or {}))
        outcome = outcomes[len(configs) - 1]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(dspy.Predict, "forward", fake_forward)
    return configs


@pytest.mark.parametrize("native", [True, False])
def test_step_without_tool_call_is_retried_with_low_effort(monkeypatch: pytest.MonkeyPatch, native: bool) -> None:
    """A step that names no tool is retried once, forcing a tool only under native tool calling."""
    monkeypatch.setattr(acting_react, "native_tool_calling_active", lambda: native)
    configs = _scripted(
        monkeypatch,
        [dspy.Prediction(tool_calls=_calls()), dspy.Prediction(tool_calls=_calls("edit_scorer"))],
    )

    out = _ActingPredict(_Sig).forward(question="q")

    assert out.tool_calls.tool_calls[0].name == "edit_scorer"
    assert configs[0] == {}
    assert configs[1]["reasoning_effort"] == "low"
    assert ("tool_choice" in configs[1]) is native


def test_retry_lowers_the_native_effort_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """The retry keeps ``reasoning_effort`` and ``extra_body.reasoning.effort`` equal, as OpenRouter requires."""
    monkeypatch.setattr(acting_react, "native_tool_calling_active", lambda: False)
    configs = _scripted(
        monkeypatch,
        [dspy.Prediction(tool_calls=_calls()), dspy.Prediction(tool_calls=_calls("edit_scorer"))],
    )
    lm = dspy.LM(
        "litellm_proxy/z-ai/glm-5.3",
        reasoning_effort="high",
        extra_body={"reasoning": {"effort": "high", "summary": "auto"}, "cache": {"no-cache": True}},
    )

    with dspy.context(lm=lm):
        _ActingPredict(_Sig).forward(question="q")

    assert configs[1]["reasoning_effort"] == "low"
    assert configs[1]["extra_body"] == {"reasoning": {"effort": "low", "summary": "auto"}, "cache": {"no-cache": True}}


def test_parse_failure_is_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    """A step cut off mid-output that fails to parse gets the same one retry."""
    monkeypatch.setattr(acting_react, "native_tool_calling_active", lambda: True)
    configs = _scripted(
        monkeypatch,
        [AdapterParseError("ChatAdapter", _Sig, "cut off"), dspy.Prediction(tool_calls=_calls("submit"))],
    )

    out = _ActingPredict(_Sig).forward(question="q")

    assert out.tool_calls.tool_calls[0].name == "submit"
    assert len(configs) == 2


def test_step_with_tool_call_and_forced_submit_are_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    """A normal step and DSPy's own forced submit run exactly once."""
    configs = _scripted(
        monkeypatch,
        [dspy.Prediction(tool_calls=_calls("read_repo_file")), dspy.Prediction(tool_calls=_calls())],
    )
    pred = _ActingPredict(_Sig)

    pred.forward(question="q")
    forced = pred.forward(question="q", config={"tool_choice": {"type": "function", "function": {"name": "submit"}}})

    assert len(configs) == 2
    assert forced.tool_calls.tool_calls == []


def test_program_uses_the_acting_predictor() -> None:
    """The loop's step predictor is the retrying one, with the loop's own signature."""
    program = ActingReActV2(_Sig, tools=[dspy.Tool(func=lambda x: x, name="alpha", desc="echo")], max_iters=3)

    assert isinstance(program.react, _ActingPredict)
    assert "tool_calls" in program.react.signature.output_fields
