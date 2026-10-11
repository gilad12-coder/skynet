"""Unit tests for the code agent's chat edit tools.

Covers the no-LLM surface of :class:`_CodeEditSession`: the adapter-debris
strip applied to tool arguments (minimax occasionally emits a malformed
trailing field marker) and its interaction with the per-turn edit
guardrails. Validators are monkeypatched — their subprocess round-trip is
covered elsewhere. The wizard's twin, :class:`_UnifiedEditSession`, and its
static run-code / metric contract checks are covered the same way.
"""

from __future__ import annotations

import pytest

from core.service_gateway.agents import code as code_module
from core.service_gateway.agents.code import (
    _CodeEditSession,
    _unified_contracts,
    _unified_validators,
    _UnifiedEditSession,
    _validate_run_code,
    _validate_unified_metric_code,
)
from core.service_gateway.agents.parse_salvage import strip_adapter_debris

_SIG = (
    "class Step(dspy.Signature):\n"
    '    """Do the step."""\n\n'
    "    q: str = dspy.InputField()\n"
    "    a: str = dspy.OutputField()\n"
)

_NEW_SIG = (
    "class Step(dspy.Signature):\n"
    '    """Do the step carefully."""\n\n'
    "    q: str = dspy.InputField()\n"
    "    a: str = dspy.OutputField()\n"
)

_MET = "def metric(gold, pred, trace=None):\n    return 1.0\n"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("code = 1\n[[ ## completed ## ]]", "code = 1"),
        ("code = 1\n[[ ## completed ## ]", "code = 1"),
        ("code = 1\n[[ ## completed ##", "code = 1"),
        ("x = a[b[0]]", "x = a[b[0]]"),
    ],
)
def test_strip_adapter_debris(raw: str, expected: str) -> None:
    """Trailing field markers are dropped, well-formed or malformed; real code survives."""
    assert strip_adapter_debris(raw) == expected


@pytest.fixture
def events() -> list[dict]:
    """Collect the SSE events a session emits during a test."""
    return []


@pytest.fixture
def session(events: list[dict]) -> _CodeEditSession:
    """Build a session over the starter signature/metric with a capturing emitter."""
    return _CodeEditSession(signature_code=_SIG, metric_code=_MET, emit=events.append)


def test_edit_signature_strips_debris_before_validation(
    monkeypatch: pytest.MonkeyPatch, session: _CodeEditSession
) -> None:
    """A trailing malformed marker is stripped so the edit validates and applies."""
    seen: list[str] = []
    monkeypatch.setattr(code_module, "_validate_signature_code", lambda c: seen.append(c) or "")
    observation = session.edit_signature("tighten docstring", _NEW_SIG + "[[ ## completed ## ]")
    assert "replaced and validated" in observation
    assert session.signature_code == _NEW_SIG.rstrip()
    assert seen == [_NEW_SIG.rstrip()]


def test_edit_signature_debris_only_edit_is_rejected_as_identical(
    monkeypatch: pytest.MonkeyPatch, session: _CodeEditSession
) -> None:
    """Current code plus debris is recognized as a no-op, not applied as a change."""
    monkeypatch.setattr(code_module, "_validate_signature_code", lambda c: "")
    observation = session.edit_signature("noop", _SIG + "[[ ## completed ## ]]")
    assert "identical" in observation
    assert session.signature_code == _SIG


def test_edit_metric_strips_debris_before_validation(
    monkeypatch: pytest.MonkeyPatch, session: _CodeEditSession
) -> None:
    """The metric tool applies the same strip as the signature tool."""
    seen: list[str] = []
    monkeypatch.setattr(code_module, "_validate_metric_code", lambda c: seen.append(c) or "")
    new_metric = "def metric(gold, pred, trace=None):\n    return 0.5\n"
    observation = session.edit_metric("halve score", new_metric + "[[ ## completed ## ]")
    assert "replaced and validated" in observation
    assert session.metric_code == new_metric.rstrip()
    assert seen == [new_metric.rstrip()]


_RUN = "def run(artifact, input):\n    return artifact\n"
_SCORE = "def score(input, output, expected=None):\n    return 1.0, {'feedback': 'ok'}\n"


def _unified(**overrides: object) -> dict:
    """Build a wizard authoring context as the router hands it over."""
    base: dict = {
        "task": {"objective": "Answer tickets.", "artifact": {"kind": "prompt", "starting_version": "Be brief."}},
        "data_mode": "pairs",
        "input_fields": ["ticket"],
        "expected_field": "label",
        "optimizer": "auto",
        "metric_shape": "blackbox_side_info",
        "metric_has_model": False,
    }
    return {**base, **overrides}


@pytest.fixture
def u_events() -> list[dict]:
    """Collect the SSE events a unified session emits during a test."""
    return []


@pytest.fixture
def u_session(u_events: list[dict]) -> _UnifiedEditSession:
    """Build a unified session over a starter run/metric with the real contract checks."""
    run_validator, metric_validator = _unified_validators(_unified())
    return _UnifiedEditSession(
        run_code=_RUN,
        metric_code=_SCORE,
        emit=u_events.append,
        run_validator=run_validator,
        metric_validator=metric_validator,
    )


def test_unified_edit_run_rides_signature_events(u_session: _UnifiedEditSession, u_events: list[dict]) -> None:
    """A run edit publishes tool_start → signature_replace → tool_end ok and updates the slot."""
    new_run = "def run(artifact, input):\n    return artifact + input['ticket']\n"
    observation = u_session.edit_run("use the ticket", new_run + "[[ ## completed ## ]")
    assert "replaced" in observation
    assert u_session.run_code == new_run.rstrip()
    assert [e["event"] for e in u_events] == ["tool_start", "signature_replace", "tool_end"]
    assert u_events[0]["data"]["tool"] == "edit_run"
    assert u_events[2]["data"]["status"] == "ok"


def test_unified_edit_metric_rides_metric_events(u_session: _UnifiedEditSession, u_events: list[dict]) -> None:
    """A valid metric edit publishes metric_replace and updates the slot."""
    new_score = "def score(input, output, expected=None):\n    return 0.5, {'feedback': 'meh'}\n"
    observation = u_session.edit_metric("grade softly", new_score)
    assert "replaced" in observation
    assert u_session.metric_code == new_score.rstrip()
    assert [e["event"] for e in u_events] == ["tool_start", "metric_replace", "tool_end"]


def test_unified_second_edit_in_turn_is_rejected(u_session: _UnifiedEditSession) -> None:
    """The per-turn guard rejects a second edit of the same artifact."""
    u_session.edit_run("first", "def run(artifact, input):\n    return 1\n")
    observation = u_session.edit_run("second", "def run(artifact, input):\n    return 2\n")
    assert "already replaced" in observation
    assert "return 1" in u_session.run_code


def test_unified_identical_edit_is_rejected(u_session: _UnifiedEditSession, u_events: list[dict]) -> None:
    """Current code plus adapter debris is a no-op, not an edit."""
    observation = u_session.edit_metric("noop", _SCORE + "[[ ## completed ## ]]")
    assert "identical" in observation
    assert [e["event"] for e in u_events] == ["tool_start", "tool_end"]
    assert u_events[-1]["data"]["status"] == "error"


def test_unified_metric_in_the_wrong_shape_is_rejected(u_session: _UnifiedEditSession, u_events: list[dict]) -> None:
    """A DSPy-shaped metric never lands when the optimizer needs score(input, output)."""
    observation = u_session.edit_metric("dspy style", "def metric(gold, pred, trace=None):\n    return 1.0\n")
    assert "invalid" in observation
    assert u_session.metric_code == _SCORE
    assert "metric_replace" not in [e["event"] for e in u_events]


def test_unified_ask_user_and_set_brief_emit_events(u_session: _UnifiedEditSession, u_events: list[dict]) -> None:
    """ask emits once per turn; set_brief writes only the non-empty fields."""
    u_session.ask_user("Strict match?", '[{"label": "Yes"}, {"label": "No"}]')
    assert "already shown" in u_session.ask_user("Again?", "[]")
    u_session.set_brief("", "Tickets are short.")
    names = [e["event"] for e in u_events]
    assert names.count("ask") == 1
    assert {"event": "brief", "data": {"background": "Tickets are short."}} in u_events


@pytest.mark.parametrize(
    ("code", "kind", "fragment"),
    [
        ("def run(artifact, input):\n    return 1\n", "prompt", ""),
        ("def run(artifact, input, extra=None):\n    return 1\n", "code", ""),
        ("def run(*args):\n    return 1\n", "text", ""),
        ("def run(input):\n    return 1\n", "prompt", "(artifact, input)"),
        ("def go(artifact, input):\n    return 1\n", "prompt", "def run"),
        ("def build_program():\n    return None\n", "dspy_program", ""),
        ("def build_program(lm):\n    return None\n", "dspy_program", "no arguments"),
        ("def run(artifact, input):\n    return 1\n", "dspy_program", "build_program"),
        ("def run(artifact, input:\n    return 1\n", "prompt", "line 1"),
        ("  \n", "prompt", "empty"),
    ],
)
def test_validate_run_code(code: str, kind: str, fragment: str) -> None:
    """The run check follows the artifact kind's entrypoint and names what is wrong."""
    err = _validate_run_code(code, kind)
    if fragment:
        assert fragment in err
    else:
        assert err == ""


@pytest.mark.parametrize(
    ("code", "shape", "has_model", "fragment"),
    [
        (
            "def metric(gold, pred, trace=None, pred_name=None, pred_trace=None):\n    return 1\n",
            "dspy_feedback",
            False,
            "",
        ),
        ("def metric(gold, pred, trace=None):\n    return 1\n", "dspy_feedback", False, "pred_trace"),
        ("def metric(gold, pred, trace=None):\n    return 1\n", "dspy_scalar", False, ""),
        ("def metric(gold, pred):\n    return True\n", "dspy_scalar", False, ""),
        ("def score(input, output, expected=None):\n    return 1, {}\n", "dspy_scalar", False, "def metric"),
        ("def score(input, output):\n    return 1, {}\n", "blackbox_side_info", False, ""),
        ("def score(input):\n    return 1, {}\n", "blackbox_side_info", False, "score(input, output"),
        (
            "from skynet import llm\n\ndef score(input, output, expected=None):\n    return 1, {}\n",
            "blackbox_side_info",
            False,
            "no metric model",
        ),
        (
            "from skynet import llm\n\ndef score(input, output, expected=None):\n    return 1, {}\n",
            "blackbox_side_info",
            True,
            "",
        ),
    ],
)
def test_validate_unified_metric_code(code: str, shape: str, has_model: bool, fragment: str) -> None:
    """The metric check enforces the optimizer's exact shape and the metric model."""
    err = _validate_unified_metric_code(code, shape, has_model)
    if fragment:
        assert fragment in err
    else:
        assert err == ""


@pytest.mark.parametrize(
    ("shape", "needle"),
    [
        ("dspy_feedback", "def metric(gold, pred, trace=None, pred_name=None, pred_trace=None)"),
        ("dspy_scalar", "def metric(gold, pred, trace=None)"),
        ("blackbox_side_info", "def score(input, output, expected=None)"),
    ],
)
def test_metric_contract_states_the_exact_shape(shape: str, needle: str) -> None:
    """The authoring prompt names the exact function the chosen optimizer calls."""
    _, metric_contract = _unified_contracts(_unified(metric_shape=shape))
    assert needle in metric_contract


@pytest.mark.parametrize("has_model", [True, False])
def test_metric_contract_offers_llm_only_with_a_model(has_model: bool) -> None:
    """The llm helper is described only when a metric model is attached."""
    _, metric_contract = _unified_contracts(_unified(metric_has_model=has_model))
    assert ("`from skynet import llm` calls it" in metric_contract) is has_model


def test_run_contract_follows_the_artifact_kind() -> None:
    """A DSPy program gets the build_program contract; every other kind gets run()."""
    program, _ = _unified_contracts(_unified(task={"objective": "x", "artifact": {"kind": "dspy_program"}}))
    prompt, _ = _unified_contracts(_unified())
    assert "build_program" in program
    assert "def run(artifact, input)" in prompt
