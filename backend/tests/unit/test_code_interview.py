"""Unit tests for ``core.service_gateway.agents.code_interview`` turn parsing."""

import dspy

from core.service_gateway.agents.code_interview import (
    BlackboxInterviewTurnSig,
    _parse_interview_prediction,
)


def _prediction(**fields: str) -> dspy.Prediction:
    """Build a raw prediction carrying ``fields`` as the LM's output values."""
    return dspy.Prediction(**fields)


def test_blackbox_turn_reports_captured_objective() -> None:
    """The objective the interviewer distilled over a blank field reaches the client."""
    turn = _parse_interview_prediction(
        _prediction(
            message="Got it.",
            done="false",
            options_json="[]",
            brief_json="[]",
            captured_objective="  Short answers that cite the source.  ",
        ),
        asked=1,
    )
    assert turn["objective"] == "Short answers that cite the source."
    assert turn["done"] is False


def test_turn_without_objective_field_reports_empty_string() -> None:
    """The DSPy interviewer has no ``objective`` output; the payload still carries the key."""
    turn = _parse_interview_prediction(
        _prediction(message="Which column is the input?", done="false", options_json="[]", brief_json="[]"),
        asked=0,
    )
    assert turn["objective"] == ""


def test_blackbox_signature_declares_objective_output() -> None:
    """The black-box interviewer keeps ``objective`` as input and reports ``captured_objective``."""
    assert "objective" in BlackboxInterviewTurnSig.input_fields
    assert "captured_objective" in BlackboxInterviewTurnSig.output_fields
