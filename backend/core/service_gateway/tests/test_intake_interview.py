"""Unit tests for the onboarding intake interview engine (parsing, validation, caps)."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from dspy.utils.dummies import DummyLM

from core.service_gateway.agents import intake_interview
from core.service_gateway.agents.intake_interview import (
    MAX_PHASE_QUESTIONS,
    IntakeInterviewTurnSig,
    answered_phases,
    featured_model_list,
    intake_inputs,
    parse_intake_prediction,
    validate_profile_patch,
)

_CATALOG = [
    SimpleNamespace(
        value="openai/gpt-4o-mini",
        label="gpt-4o-mini",
        featured=True,
        available=True,
        input_cost_per_token=1e-7,
        output_cost_per_token=4e-7,
        reasoning_mandatory=False,
    ),
    SimpleNamespace(
        value="openai/o9",
        label="o9",
        featured=True,
        available=True,
        input_cost_per_token=1e-8,
        output_cost_per_token=1e-8,
        reasoning_mandatory=True,
    ),
    SimpleNamespace(
        value="anthropic/claude-sonnet-5",
        label="claude-sonnet-5",
        featured=False,
        available=True,
        input_cost_per_token=1e-9,
        output_cost_per_token=1e-9,
        reasoning_mandatory=False,
    ),
]
_SLUGS = ["openai", "anthropic"]


def _parse(pred: SimpleNamespace | None, asked: int = 0, phase: str = "goal", turns=None) -> dict:
    """Parse a prediction against the test catalog."""
    return parse_intake_prediction(
        pred, asked, phase=phase, turns=turns or [], catalog_models=_CATALOG, provider_slugs=_SLUGS
    )


def _pred(**fields: str) -> SimpleNamespace:
    """Build a stand-in prediction with the given output fields."""
    return SimpleNamespace(**fields)


def test_signature_streams_message_then_done_first() -> None:
    """``message`` and ``done`` lead the outputs so the shared driver can stream and hint early."""
    outputs = list(IntakeInterviewTurnSig.output_fields)
    assert outputs[:2] == ["message", "done"]
    assert set(outputs) == {"message", "done", "options_json", "profile_patch_json", "skip_rest"}


def test_parse_question_turn() -> None:
    """A question turn carries its options and a validated patch, and the phase stays open."""
    turn = _parse(
        _pred(
            message="Where do the tickets live?",
            done="false",
            options_json=json.dumps(
                [
                    {"label": "Zendesk export (CSV)", "description": "A file you download"},
                    {"label": "An API I call", "description": "Live endpoint"},
                ]
            ),
            profile_patch_json=json.dumps(
                {"goal": " route tickets right ", "models": ["gpt-4o-mini"], "budget_usd": "$5", "level": "guided"}
            ),
            skip_rest="false",
        )
    )
    assert turn["message"] == "Where do the tickets live?"
    assert turn["phase_done"] is False
    assert [o["label"] for o in turn["options"]] == ["Zendesk export (CSV)", "An API I call"]
    assert turn["profile_patch"] == {
        "goal": "route tickets right",
        "models": ["openai/gpt-4o-mini"],
        "budget_usd": 5.0,
        "level": "guided",
    }
    assert turn["skip_phases"] == ["goal", "models", "budget"]
    assert turn["skip_rest"] is False
    assert set(turn) == {
        "message",
        "options",
        "phase_done",
        "profile_patch",
        "skip_phases",
        "skip_rest",
        "model",
    }


def test_parse_forces_phase_done_at_question_cap() -> None:
    """At the per-phase question cap the phase finishes even when the model keeps asking."""
    turn = _parse(_pred(message="One more?", done="false", options_json='[{"label": "x"}]'), asked=MAX_PHASE_QUESTIONS)
    assert turn["phase_done"] is True
    assert turn["options"] == []


def test_parse_skip_rest_finishes_the_phase() -> None:
    """A skip request ends the phase and drops the options."""
    turn = _parse(_pred(message="Sure.", done="false", options_json='[{"label": "x"}]', skip_rest="true"))
    assert turn["skip_rest"] is True
    assert turn["phase_done"] is True
    assert turn["options"] == []


def test_parse_unparseable_final_goal_turn_falls_back_to_first_answer() -> None:
    """A finished goal phase without a parseable patch keeps the user's first answer as the goal."""
    turns = [
        {"role": "assistant", "content": "What should get better?"},
        {"role": "user", "content": "  Our support bot misroutes tickets  "},
    ]
    turn = _parse(_pred(message="Got it.", done="true", profile_patch_json="not json"), asked=1, turns=turns)
    assert turn["profile_patch"] == {"goal": "Our support bot misroutes tickets"}
    assert turn["skip_phases"] == ["goal"]


def test_parse_tolerates_missing_prediction() -> None:
    """A stream that produced nothing yields a safe, empty turn."""
    turn = _parse(None, phase="source")
    assert turn["message"] == ""
    assert turn["profile_patch"] == {}
    assert turn["options"] == []
    assert turn["skip_phases"] == []


def test_validate_patch_coerces_enums_and_drops_invalid_keys() -> None:
    """Enum aliases are canonicalised; unknown values, keys, models and providers are dropped."""
    patch = validate_profile_patch(
        {
            "source": "GitHub",
            "source_url": "  https://github.com/acme/bot  ",
            "models": ["openai/gpt-4o-mini", "made-up/model", "claude-sonnet-5", "openai/gpt-4o-mini"],
            "billing": "BYOK",
            "byok_provider": "OpenAI",
            "budget_usd": -3,
            "privacy": "deny",
            "email_cadence": "weekly",
            "trust": "auto-safe",
            "code_assist": "Auto",
            "split_mode": "manual",
            "level": "familiar",
            "goal": "",
            "mystery": "x",
        },
        catalog_models=_CATALOG,
        provider_slugs=_SLUGS,
    )
    assert patch == {
        "source": "repo",
        "source_url": "https://github.com/acme/bot",
        "models": ["openai/gpt-4o-mini", "anthropic/claude-sonnet-5"],
        "billing": "byok",
        "byok_provider": "openai",
        "privacy": "no_training",
        "trust": "auto_safe",
        "code_assist": "auto",
        "split_mode": "manual",
        "level": "standard",
    }


def test_validate_patch_rejects_bad_urls_providers_and_budgets() -> None:
    """Whitespace URLs, unknown providers, booleans and absurd budgets never pass."""
    patch = validate_profile_patch(
        {
            "source_url": "not a url",
            "byok_provider": "acme",
            "budget_usd": True,
            "models": "nope",
        },
        catalog_models=_CATALOG,
        provider_slugs=_SLUGS,
    )
    assert patch == {}
    assert validate_profile_patch({"budget_usd": 1e9}, catalog_models=_CATALOG, provider_slugs=_SLUGS) == {}
    assert validate_profile_patch("[]", catalog_models=_CATALOG, provider_slugs=_SLUGS) == {}


def test_platform_billing_drops_byok_provider() -> None:
    """A platform-billed patch carries no BYOK provider."""
    patch = validate_profile_patch(
        {"billing": "platform", "byok_provider": "openai"}, catalog_models=_CATALOG, provider_slugs=_SLUGS
    )
    assert patch == {"billing": "platform"}


def test_answered_phases() -> None:
    """Phases skip only when fully answered; level never skips."""
    assert answered_phases({"billing": "byok"}) == []
    assert answered_phases({"billing": "byok", "byok_provider": "openai"}) == ["billing"]
    assert answered_phases({"code_assist": "auto"}) == []
    assert answered_phases(
        {
            "code_assist": "auto",
            "split_mode": "auto",
            "privacy": "zdr",
            "email_cadence": "live",
            "trust": "ask",
            "source": "none",
            "level": "expert",
        }
    ) == ["source", "privacy", "emails", "trust", "defaults"]


def test_featured_model_list_and_inputs() -> None:
    """The prompt gets the featured models, the validated profile and the per-phase question note."""
    featured = featured_model_list(_CATALOG)
    assert featured == [
        {"id": "openai/gpt-4o-mini", "label": "gpt-4o-mini"},
        {"id": "openai/o9", "label": "o9"},
    ]
    inputs = intake_inputs(
        phase="source",
        turns=[{"role": "assistant", "content": "Q?"}, {"role": "user", "content": "A"}],
        profile={"goal": "g"},
        featured=featured,
        locale="en",
    )
    assert inputs["phase"] == "source"
    assert inputs["reply_language"] == "English"
    assert json.loads(inputs["profile_json"]) == {"goal": "g"}
    transcript = json.loads(inputs["transcript_json"])
    assert transcript[-1]["role"] == "system"
    assert f"1 of at most {MAX_PHASE_QUESTIONS}" in transcript[-1]["content"]
    assert (
        json.loads(intake_inputs(phase="goal", turns=[], profile={}, featured=[], locale="he")["transcript_json"]) == []
    )


def test_intake_turn_stream_end_to_end_with_dummy_lm(monkeypatch) -> None:
    """A full turn runs over the shared driver and ends in a validated ``interview_done``."""
    answer = {
        "message": "Where do the tickets live?",
        "done": "false",
        "options_json": json.dumps([{"label": "Zendesk export (CSV)", "description": "A file"}]),
        "profile_patch_json": json.dumps({"goal": "route tickets", "models": ["gpt-4o-mini", "x/unknown"]}),
        "skip_rest": "false",
    }
    built: list[dict] = []

    def fake_lm(model, effort, max_tokens):
        """Record the LM knobs and return a canned responder."""
        built.append({"model": model, "effort": effort, "max_tokens": max_tokens})
        return DummyLM([answer])

    monkeypatch.setattr(intake_interview, "_build_agent_lm", fake_lm)

    async def collect() -> list[dict]:
        """Drain the stream."""
        return [
            event
            async for event in intake_interview.intake_turn_stream(
                phase="goal",
                turns=[{"role": "user", "content": "our support bot misroutes tickets"}],
                profile={"level": "bogus"},
                catalog_models=_CATALOG,
                provider_slugs=_SLUGS,
                locale="en",
                model="openai/gpt-4o-mini",
                reasoning_effort="low",
            )
        ]

    events = asyncio.run(collect())
    done = events[-1]
    assert done["event"] == "interview_done"
    assert built == [{"model": "openai/gpt-4o-mini", "effort": "low", "max_tokens": intake_interview.INTAKE_MAX_TOKENS}]
    assert done["data"]["message"] == "Where do the tickets live?"
    assert done["data"]["phase_done"] is False
    assert done["data"]["options"] == [{"label": "Zendesk export (CSV)", "description": "A file"}]
    assert done["data"]["profile_patch"] == {"goal": "route tickets", "models": ["openai/gpt-4o-mini"]}
    assert done["data"]["skip_phases"] == ["goal", "models"]
    assert done["data"]["model"] == "openai/gpt-4o-mini"
    assert "served_model" in done["data"]
