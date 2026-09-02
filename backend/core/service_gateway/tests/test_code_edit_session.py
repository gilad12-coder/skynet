"""Unit tests for the code agent's chat edit tools.

Covers the no-LLM surface of :class:`_CodeEditSession`: the adapter-debris
strip applied to tool arguments (minimax occasionally emits a malformed
trailing field marker) and its interaction with the per-turn edit
guardrails. Validators are monkeypatched — their subprocess round-trip is
covered elsewhere. The black-box twin, :class:`_BlackboxEditSession`, and
its static scorer check are covered the same way.
"""

from __future__ import annotations

import pytest

from core.service_gateway.agents import code as code_module
from core.service_gateway.agents.code import (
    _BlackboxEditSession,
    _CodeEditSession,
    _validate_scorer_code,
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
    monkeypatch.setattr(
        code_module, "_validate_signature_code", lambda c: seen.append(c) or ""
    )
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


_SEED = "You are a support agent. Answer briefly.\n"
_SCORER = "def score(candidate, case=None):\n    return 1.0\n"


@pytest.fixture
def bb_events() -> list[dict]:
    """Collect the SSE events a black-box session emits during a test."""
    return []


@pytest.fixture
def bb_session(bb_events: list[dict]) -> _BlackboxEditSession:
    """Build a black-box session over a starter seed/scorer with a capturing emitter."""
    return _BlackboxEditSession(seed_text=_SEED, scorer_code=_SCORER, emit=bb_events.append)


def test_blackbox_edit_seed_rides_signature_events(
    bb_session: _BlackboxEditSession, bb_events: list[dict]
) -> None:
    """A seed edit publishes tool_start → signature_replace → tool_end ok and updates the slot."""
    observation = bb_session.edit_seed("add tone", "You are a support agent. Be warm.\n")
    assert "replaced" in observation
    assert bb_session.seed_text == "You are a support agent. Be warm."
    assert [e["event"] for e in bb_events] == ["tool_start", "signature_replace", "tool_end"]
    assert bb_events[0]["data"]["tool"] == "edit_seed"
    assert bb_events[1]["data"]["code"] == "You are a support agent. Be warm."
    assert bb_events[2]["data"]["status"] == "ok"


def test_blackbox_second_seed_edit_in_turn_is_rejected(bb_session: _BlackboxEditSession) -> None:
    """The per-turn guard rejects a second edit of the same artifact."""
    bb_session.edit_seed("first", "v1")
    observation = bb_session.edit_seed("second", "v2")
    assert "already replaced" in observation
    assert bb_session.seed_text == "v1"


def test_blackbox_identical_seed_is_rejected(
    bb_session: _BlackboxEditSession, bb_events: list[dict]
) -> None:
    """Current seed plus adapter debris is a no-op, not an edit."""
    observation = bb_session.edit_seed("noop", _SEED + "[[ ## completed ## ]]")
    assert "identical" in observation
    assert bb_session.seed_text == _SEED
    assert [e["event"] for e in bb_events] == ["tool_start", "tool_end"]
    assert bb_events[-1]["data"]["status"] == "error"


def test_blackbox_edit_scorer_rejects_invalid_code(
    bb_session: _BlackboxEditSession, bb_events: list[dict]
) -> None:
    """A scorer that fails the static check never reaches the editor."""
    observation = bb_session.edit_scorer("break it", "def score(candidate, case=None:\n    return 1\n")
    assert "invalid" in observation
    assert bb_session.scorer_code == _SCORER
    assert "metric_replace" not in [e["event"] for e in bb_events]
    assert bb_events[-1]["data"] == {"id": bb_events[0]["data"]["id"], "tool": "edit_scorer", "status": "error"}


def test_blackbox_edit_scorer_rides_metric_events(
    bb_session: _BlackboxEditSession, bb_events: list[dict]
) -> None:
    """A valid scorer edit publishes metric_replace and updates the slot."""
    new_scorer = "def score(candidate, case=None):\n    return 0.5, {'feedback': 'meh'}\n"
    observation = bb_session.edit_scorer("grade softly", new_scorer + "[[ ## completed ## ]")
    assert "replaced" in observation
    assert bb_session.scorer_code == new_scorer.rstrip()
    assert [e["event"] for e in bb_events] == ["tool_start", "metric_replace", "tool_end"]
    assert bb_events[1]["data"]["code"] == new_scorer.rstrip()


@pytest.mark.parametrize(
    ("code", "fragment"),
    [
        ("def score(candidate, case=None):\n    return 1.0\n", ""),
        ("def metric(candidate, case):\n    return 0.0\n", ""),
        ("def grade(candidate):\n    return 0.0\n", ""),
        ("def helper():\n    pass\n\ndef score(candidate, case=None):\n    return 1.0\n", ""),
        ("def score(*args):\n    return 1.0\n", ""),
        ("def score(candidate, case=None:\n    return 1\n", "line 1"),
        ("x = 1\n", "define a function"),
        ("def a(c):\n    pass\n\ndef b(c):\n    pass\n", "define a function"),
        ("def score():\n    return 1.0\n", "first argument"),
        ("   \n", "empty"),
    ],
)
def test_validate_scorer_code(code: str, fragment: str) -> None:
    """The static check accepts every entrypoint shape the runtime loads and names what's wrong otherwise."""
    err = _validate_scorer_code(code)
    if fragment:
        assert fragment in err
    else:
        assert err == ""


@pytest.mark.parametrize("scorer_has_model", [True, False])
def test_scorer_contract_offers_model_judges_only_with_a_model(scorer_has_model: bool) -> None:
    """The prompt lists the judge shapes that need llm() only when a model is attached."""
    contract = code_module._scorer_contract("text", scorer_has_model)

    assert "- Run program:" in contract
    assert ("- Vision judge:" in contract) is scorer_has_model
    assert ("- LLM judge:" in contract) is scorer_has_model
