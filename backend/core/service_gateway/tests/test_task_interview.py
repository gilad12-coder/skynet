"""Tests for the submission wizard's step-1 task interview.

Pure-function coverage of the input assembly and the turn parser; the
streaming path is the shared driver, covered in ``test_code_interview``.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from core.models import TaskInterviewTurnResult
from core.service_gateway.agents.code_interview import MAX_INTERVIEW_QUESTIONS
from core.service_gateway.agents.task_interview import (
    TaskInterviewTurnSig,
    normalize_artifact_kind,
    normalize_starting_version,
    parse_task_interview_prediction,
    task_interview_inputs,
)


def _pred(**fields: str) -> SimpleNamespace:
    """Build a prediction-shaped object with the given output fields."""
    return SimpleNamespace(**fields)


def test_signature_streams_message_then_done_first() -> None:
    """``message`` and ``done`` lead the outputs so the driver can stream and hint early."""
    outputs = list(TaskInterviewTurnSig.output_fields)
    assert outputs[:2] == ["message", "done"]
    assert {"options_json", "objective", "background", "artifact_kind", "starting_version_json"} <= set(outputs)


def test_signature_opens_with_the_optimize_question() -> None:
    """The instructions carry the fixed opening question."""
    assert "what do you want to optimize?" in TaskInterviewTurnSig.__doc__


def test_inputs_encode_draft_and_language() -> None:
    """The draft, the samples and the transcript are encoded for the model."""
    inputs = task_interview_inputs(
        turns=[{"role": "assistant", "content": "What do you want to optimize?"}],
        objective="Shorter replies",
        background="",
        artifact_kind="dspy_program",
        starting_version={"answer": "Reply briefly."},
        sample_cases=[{"question": "hi"}],
        locale="en",
    )
    assert inputs["draft_objective"] == "Shorter replies"
    assert inputs["draft_artifact_kind"] == "dspy_program"
    assert json.loads(inputs["draft_starting_version"]) == {"answer": "Reply briefly."}
    assert json.loads(inputs["sample_cases"]) == [{"question": "hi"}]
    assert json.loads(inputs["transcript_json"])[-1]["role"] == "system"
    assert inputs["reply_language"] == "English"


def test_inputs_blank_draft() -> None:
    """An empty draft encodes as empty strings and Hebrew is the default language."""
    inputs = task_interview_inputs(
        turns=[], objective="", background="", artifact_kind=None, starting_version=None, sample_cases=[], locale=None
    )
    assert inputs["draft_artifact_kind"] == ""
    assert inputs["draft_starting_version"] == ""
    assert json.loads(inputs["transcript_json"]) == []
    assert inputs["reply_language"] == "Hebrew"


def test_normalize_artifact_kind_aliases_and_rejects() -> None:
    """Common spellings map onto the contract; anything else is unknown."""
    assert normalize_artifact_kind("Prompt") == "prompt"
    assert normalize_artifact_kind("dspy-program") == "dspy_program"
    assert normalize_artifact_kind("DSPy") == "dspy_program"
    assert normalize_artifact_kind("python") == "code"
    assert normalize_artifact_kind("spreadsheet") is None
    assert normalize_artifact_kind("") is None
    assert normalize_artifact_kind(None) is None


def test_normalize_starting_version_shapes() -> None:
    """Strings stay strings, a DSPy program needs a mapping, junk is dropped."""
    assert normalize_starting_version('"Be concise."', "prompt") == "Be concise."
    assert normalize_starting_version("def f(): pass", "code") == "def f(): pass"
    assert normalize_starting_version('{"qa": "Answer."}', "dspy_program") == {"qa": "Answer."}
    assert normalize_starting_version('{"only": "Be brief."}', "prompt") == "Be brief."
    assert normalize_starting_version('{"a": "1", "b": "2"}', "text") is None
    assert normalize_starting_version('"plain"', "dspy_program") is None
    assert normalize_starting_version("   ", "prompt") is None
    assert normalize_starting_version("[1, 2]", "prompt") is None


def test_parse_mid_interview_turn_keeps_options() -> None:
    """A turn in progress offers buttons and validates against the result model."""
    turn = parse_task_interview_prediction(
        _pred(
            message="What kind of artifact is it?",
            done="false",
            options_json='[{"label": "A prompt", "description": "An LLM prompt."}, "Python code"]',
            objective="Classify tickets",
            background="",
            artifact_kind="",
            starting_version_json="",
            artifact_rationale="",
        ),
        asked=1,
    )
    TaskInterviewTurnResult.model_validate(turn)
    assert turn["done"] is False
    assert [o["label"] for o in turn["options"]] == ["A prompt", "Python code"]
    assert turn["artifact_kind"] is None
    assert turn["starting_version"] is None
    assert turn["objective"] == "Classify tickets"


def test_parse_done_turn_drops_options_and_fills_draft() -> None:
    """A finished turn carries the draft and no options."""
    turn = parse_task_interview_prediction(
        _pred(
            message="Confirm the card.",
            done="true",
            options_json='["Yes"]',
            objective="Answer support questions accurately.",
            background="SaaS support desk.",
            artifact_kind="dspy_program",
            starting_version_json='{"answer": "Answer the question."}',
            artifact_rationale="They already have a DSPy module.",
        ),
        asked=3,
    )
    assert turn["done"] is True
    assert turn["options"] == []
    assert turn["artifact_kind"] == "dspy_program"
    assert turn["starting_version"] == {"answer": "Answer the question."}
    assert turn["artifact_rationale"] == "They already have a DSPy module."


def test_parse_keeps_the_draft_when_the_model_leaves_fields_out() -> None:
    """Empty or invalid fields never wipe what an earlier turn settled."""
    draft = {
        "objective": "Shorter code",
        "background": "Python 3.11",
        "artifact_kind": "code",
        "starting_version": "def f(x):\n    return x",
    }
    turn = parse_task_interview_prediction(
        _pred(
            message="Anything else?",
            done="false",
            options_json="not json",
            objective="",
            background="",
            artifact_kind="banana",
            starting_version_json="",
            artifact_rationale="",
        ),
        asked=2,
        draft=draft,
    )
    assert turn["objective"] == "Shorter code"
    assert turn["background"] == "Python 3.11"
    assert turn["artifact_kind"] == "code"
    assert turn["starting_version"] == "def f(x):\n    return x"
    assert turn["options"] == []


def test_parse_forces_done_at_the_question_cap() -> None:
    """Hitting the question cap ends the interview even if the model resists."""
    turn = parse_task_interview_prediction(_pred(message="One more?", done="false"), asked=MAX_INTERVIEW_QUESTIONS)
    assert turn["done"] is True


def test_parse_tolerates_a_missing_prediction() -> None:
    """A ``None`` prediction degrades to an empty, valid turn."""
    turn = parse_task_interview_prediction(None, asked=0)
    TaskInterviewTurnResult.model_validate(turn)
    assert turn["message"] == ""
    assert turn["done"] is False
