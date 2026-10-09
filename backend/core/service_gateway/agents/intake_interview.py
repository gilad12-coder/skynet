"""LLM engine for the first-login onboarding intake interview. [INTERNAL]

The intake walks a fixed agenda of phases. Only the open-ended phases
(``goal`` and ``source``) call a model; the rest are fixed multiple choice the
client renders itself. Each model turn asks at most one short question, and
also extracts any answer the user volunteered for a later phase into a
validated ``profile_patch`` so the client can skip those phases.

The turn streams over the Signature & Metric interview's machinery
(:func:`~.code_interview.relay_interview_turn`): same events, same retries,
same parse salvage. Only the signature and the terminal payload differ.
Nothing here touches the database; the transcript and the profile so far are
client-owned and re-sent on every turn.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable
from typing import Any

import dspy

from ...api.model_catalog import agent_model_id
from ...config import settings
from .answer_options import normalize_options
from .code import _build_agent_lm, _reply_language
from .code_interview import _parse_json, relay_interview_turn
from .conduct import with_conduct

LLM_PHASES = ("goal", "source")
AGENDA = ("goal", "source", "models", "billing", "budget", "privacy", "emails", "trust", "defaults", "level")
MAX_PHASE_QUESTIONS = 2
MAX_REQUEST_TURNS = 8
INTAKE_MAX_TOKENS = 4000
"""Completion budget per turn, reasoning included; a turn is a sentence or two plus small JSON."""

SOURCES = ("repo", "api", "spreadsheet", "file", "dataset", "none")
BILLING = ("platform", "byok")
PRIVACY = ("allow", "no_training", "zdr")
EMAIL_CADENCES = ("done", "milestones", "live")
# Mirrors ``TrustMode`` in ``agents.generalist``; importing it would pull the
# whole generalist agent into this module.
TRUST_MODES = ("ask", "auto_safe", "yolo")
AUTO_MANUAL = ("auto", "manual")
LEVELS = ("guided", "standard", "expert")

_SOURCE_ALIASES = {
    "github": "repo",
    "gitlab": "repo",
    "git": "repo",
    "repository": "repo",
    "http": "api",
    "endpoint": "api",
    "csv": "spreadsheet",
    "excel": "spreadsheet",
    "sheet": "spreadsheet",
    "xlsx": "spreadsheet",
    "huggingface": "dataset",
    "hf": "dataset",
    "nothing": "none",
}
# The privacy setting is stored as ``deny`` (see ``billing.data_policy``); the
# intake speaks ``no_training``, so accept the stored spelling too.
_PRIVACY_ALIASES = {"deny": "no_training"}
_LEVEL_ALIASES = {"new": "guided", "familiar": "standard"}
_TEXT_LIMIT = 500
_URL_LIMIT = 2000
_MAX_MODELS = 5
_MAX_BUDGET_USD = 100_000.0

_PHASE_BRIEFS = {
    "goal": (
        "Learn what should get better and how the user will know it got better "
        "(the success signal). No default: never offer 'Use the default' here."
    ),
    "source": (
        "Learn where the thing lives: a GitHub/GitLab repository URL, an HTTP API, a "
        "spreadsheet/CSV, a file, a Hugging Face dataset, or nothing yet; and its URL "
        "when there is one. Adapt to the goal: for a support bot that misroutes "
        "tickets ask where the tickets live, with options such as 'Zendesk export "
        "(CSV)', 'A database table', 'An API I call'. The default is 'none' (start "
        "from scratch with a few examples); end the options with 'Use the default' "
        "naming it."
    ),
}


class IntakeInterviewTurnSig(dspy.Signature):
    __doc__ = with_conduct("""Run one phase of a new user's onboarding interview, one short question at a time.

    You are a sharp engineer onboarding someone to a prompt- and
    program-optimization platform. The onboarding is a fixed agenda of
    phases; you run only ``phase`` (``phase_brief`` says what it must learn).
    ``profile_json`` holds what is already known — never ask about it again.
    Ask ONE short question at a time: ``message`` is one or two short
    sentences. If the transcript already answers the phase, or the
    question-count note says the limit is reached, set ``done`` to true and
    write a one-sentence acknowledgement instead of a question. If the user
    says to skip, to just use the defaults, or to get going, set
    ``skip_rest`` to true and ``done`` to true.

    For every question offer 2-4 options in ``options_json``, each a short
    pickable answer (<= 6 words) with a one-line description, the
    recommended option first. Options are concrete answers — never "other",
    "something else" or anything meaning "I'll type it": the user always has
    a free-text box. When the phase has a sensible default, the LAST option
    is "Use the default" (in ``reply_language``) with the default named in
    its description. Options are [] once ``done``.

    In ``profile_patch_json`` extract every setting the user's own words
    settle so far, for ANY phase of the agenda, omitting keys you do not
    know: goal (short, their words), success_signal, source (repo | api |
    spreadsheet | file | dataset | none), source_url, models (ids from
    ``featured_models`` only), billing (platform | byok), byok_provider
    (provider slug, e.g. openai), budget_usd (a number, per run), privacy
    (allow | no_training | zdr), email_cadence (done | milestones | live),
    trust (ask | auto_safe | yolo), code_assist (auto | manual), split_mode
    (auto | manual), level. Always infer level: 'guided' for someone
    describing a business task with a spreadsheet or file and no ML
    vocabulary; 'standard' for an engineer with a repository or an API;
    'expert' when they name optimizers, data splits, metrics, or DSPy/GEPA
    settings.
    """)

    phase: str = dspy.InputField(desc="The agenda phase this turn runs: 'goal' or 'source'.")
    phase_brief: str = dspy.InputField(desc="What this phase must learn, and its default if any.")
    agenda: list[str] = dspy.InputField(desc="Every phase of the onboarding, in order.")
    profile_json: str = dspy.InputField(desc="JSON object of settings already known; never ask about these.")
    featured_models: str = dspy.InputField(
        desc="JSON array of {id, label} catalog models; models in the patch must use these ids."
    )
    transcript_json: str = dspy.InputField(desc="JSON array of this phase's prior {role, content} turns.")
    reply_language: str = dspy.InputField(desc="Language the message and options are written in.")
    message: str = dspy.OutputField(desc="The next question, or a one-sentence acknowledgement when done.")
    # ``done`` sits right after ``message`` so it streams before the slower
    # options/patch fields; the shared driver turns it into ``turn_hint``.
    done: str = dspy.OutputField(desc="'true' when this phase is finished, else 'false'.")
    options_json: str = dspy.OutputField(
        desc=(
            'JSON array of 2-4 answer options, each {"label": <short answer>, '
            '"description": <one line>}, recommended first; [] when done.'
        )
    )
    profile_patch_json: str = dspy.OutputField(desc="JSON object of the profile keys the user's answers settle.")
    skip_rest: str = dspy.OutputField(desc="'true' when the user asked to skip ahead or use the defaults.")


def _truthy(value: Any) -> bool:
    """Read a model's boolean-ish text field.

    Args:
        value: Raw field value.

    Returns:
        Whether the value spells true.
    """
    return str(value or "").strip().lower() in {"true", "yes", "1"}


def _enum(value: Any, allowed: Iterable[str], aliases: dict[str, str] | None = None) -> str | None:
    """Coerce ``value`` onto an enum, tolerating case, spaces and known aliases.

    Args:
        value: Raw value.
        allowed: Accepted spellings.
        aliases: Extra spellings mapped onto accepted ones.

    Returns:
        The accepted value, or ``None``.
    """
    if not isinstance(value, str):
        return None
    cleaned = value.strip().lower().replace("-", "_").replace(" ", "_")
    cleaned = (aliases or {}).get(cleaned, cleaned)
    return cleaned if cleaned in allowed else None


def _text(value: Any, limit: int = _TEXT_LIMIT) -> str | None:
    """Trim a free-text value, dropping it when blank or not a string.

    Args:
        value: Raw value.
        limit: Maximum characters kept.

    Returns:
        The trimmed text, or ``None``.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()[:limit]


def _url(value: Any) -> str | None:
    """Trim a URL, dropping blanks, overlong values and anything with inner whitespace.

    Args:
        value: Raw value.

    Returns:
        The trimmed URL, or ``None``.
    """
    if not isinstance(value, str):
        return None
    cleaned = value.strip().strip("<>").strip()
    if not cleaned or len(cleaned) > _URL_LIMIT or any(c.isspace() for c in cleaned):
        return None
    return cleaned


def _model_lookup(catalog_models: Iterable[Any]) -> dict[str, str]:
    """Index catalog models by id, label and bare name for tolerant matching.

    Args:
        catalog_models: Catalog entries with ``value`` and ``label``.

    Returns:
        Lower-cased spelling → catalog id; ids win over labels and bare names.
    """
    lookup: dict[str, str] = {}
    entries = list(catalog_models)
    for entry in entries:
        value = str(getattr(entry, "value", "") or "")
        if not value:
            continue
        for alias in (str(getattr(entry, "label", "") or ""), value.rsplit("/", 1)[-1]):
            if alias:
                lookup.setdefault(alias.strip().lower(), value)
    for entry in entries:
        value = str(getattr(entry, "value", "") or "")
        if value:
            lookup[value.lower()] = value
    return lookup


def _models(value: Any, lookup: dict[str, str]) -> list[str] | None:
    """Keep the catalog models a patch names, dropping unknown ids.

    Args:
        value: Raw ``models`` value (a list, or a single string).
        lookup: Output of :func:`_model_lookup`.

    Returns:
        Up to five distinct catalog ids, or ``None`` when none matched.
    """
    items = [value] if isinstance(value, str) else value
    if not isinstance(items, list):
        return None
    picked: list[str] = []
    for item in items:
        model_id = lookup.get(str(item).strip().lower()) if isinstance(item, str) else None
        if model_id and model_id not in picked:
            picked.append(model_id)
    return picked[:_MAX_MODELS] or None


def _budget(value: Any) -> float | None:
    """Coerce a per-run budget to a positive dollar amount.

    Args:
        value: Raw value (number, or a string such as ``"$5"``).

    Returns:
        The amount, or ``None`` when missing, non-positive or absurd.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip().lstrip("$").replace(",", "").strip()
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(amount) or amount <= 0 or amount > _MAX_BUDGET_USD:
        return None
    return round(amount, 2)


def validate_profile_patch(
    raw: Any,
    *,
    catalog_models: Iterable[Any],
    provider_slugs: Iterable[str],
) -> dict[str, Any]:
    """Validate and coerce a model-written profile patch, dropping every invalid key.

    Args:
        raw: The parsed ``profile_patch_json`` (or a client profile).
        catalog_models: Catalog entries ``models`` may name.
        provider_slugs: Provider slugs ``byok_provider`` may name.

    Returns:
        Only the keys that validated, in their canonical form.
    """
    if not isinstance(raw, dict):
        return {}
    slugs = {s.strip().lower() for s in provider_slugs if s}
    checks: dict[str, Any] = {
        "goal": _text,
        "success_signal": _text,
        "source": lambda v: _enum(v, SOURCES, _SOURCE_ALIASES),
        "source_url": _url,
        "models": lambda v: _models(v, _model_lookup(catalog_models)),
        "billing": lambda v: _enum(v, BILLING),
        "byok_provider": lambda v: v.strip().lower() if isinstance(v, str) and v.strip().lower() in slugs else None,
        "budget_usd": _budget,
        "privacy": lambda v: _enum(v, PRIVACY, _PRIVACY_ALIASES),
        "email_cadence": lambda v: _enum(v, EMAIL_CADENCES),
        "trust": lambda v: _enum(v, TRUST_MODES),
        "code_assist": lambda v: _enum(v, AUTO_MANUAL),
        "split_mode": lambda v: _enum(v, AUTO_MANUAL),
        "level": lambda v: _enum(v, LEVELS, _LEVEL_ALIASES),
    }
    patch: dict[str, Any] = {}
    for key, check in checks.items():
        if key in raw:
            value = check(raw[key])
            if value is not None:
                patch[key] = value
    if patch.get("billing") == "platform":
        patch.pop("byok_provider", None)
    return patch


def answered_phases(patch: dict[str, Any]) -> list[str]:
    """List the agenda phases a validated patch fully answers.

    ``level`` is never listed: the model always infers it, and the client
    shows the level step pre-selected rather than skipping it.

    Args:
        patch: Output of :func:`validate_profile_patch`.

    Returns:
        Phase ids in agenda order.
    """
    answered = {
        "goal": "goal" in patch,
        "source": "source" in patch,
        "models": bool(patch.get("models")),
        "billing": patch.get("billing") == "platform" or bool(patch.get("byok_provider")),
        "budget": "budget_usd" in patch,
        "privacy": "privacy" in patch,
        "emails": "email_cadence" in patch,
        "trust": "trust" in patch,
        "defaults": "code_assist" in patch and "split_mode" in patch,
    }
    return [phase for phase in AGENDA if answered.get(phase)]


def featured_model_list(catalog_models: Iterable[Any]) -> list[dict[str, str]]:
    """Return the featured catalog models the interviewer may name, as ``{id, label}``.

    Args:
        catalog_models: Catalog entries.

    Returns:
        The featured entries (the same list the frontend's pickers lead with).
    """
    return [
        {"id": str(m.value), "label": str(getattr(m, "label", "") or m.value)}
        for m in catalog_models
        if getattr(m, "featured", False)
    ]


def _transcript_json(turns: list[dict[str, str]]) -> str:
    """Encode this phase's transcript with the per-phase question-count note.

    Args:
        turns: This phase's prior ``{role, content}`` turns, oldest first.

    Returns:
        The JSON-encoded transcript.
    """
    asked = sum(1 for t in turns if t.get("role") == "assistant")
    noted = list(turns)
    if asked:
        noted.append(
            {
                "role": "system",
                "content": (
                    f"Questions asked in this phase: {asked} of at most {MAX_PHASE_QUESTIONS}."
                    " If the limit is reached you MUST finish now."
                ),
            }
        )
    return json.dumps(noted, ensure_ascii=False)


def intake_inputs(
    *,
    phase: str,
    turns: list[dict[str, str]],
    profile: dict[str, Any],
    featured: list[dict[str, str]],
    locale: str | None,
) -> dict[str, Any]:
    """Assemble the ``IntakeInterviewTurnSig`` inputs for one turn.

    Args:
        phase: ``goal`` or ``source``.
        turns: This phase's prior turns.
        profile: The validated profile so far.
        featured: Output of :func:`featured_model_list`.
        locale: UI locale code; replies are written in that language.

    Returns:
        Keyword inputs for the predictor.
    """
    return {
        "phase": phase,
        "phase_brief": _PHASE_BRIEFS[phase],
        "agenda": list(AGENDA),
        "profile_json": json.dumps(profile, ensure_ascii=False),
        "featured_models": json.dumps(featured, ensure_ascii=False),
        "transcript_json": _transcript_json(turns),
        "reply_language": _reply_language(locale),
    }


def parse_intake_prediction(
    pred: Any,
    asked: int,
    *,
    phase: str,
    turns: list[dict[str, str]],
    catalog_models: Iterable[Any],
    provider_slugs: Iterable[str],
) -> dict[str, Any]:
    """Turn a raw ``IntakeInterviewTurnSig`` prediction into the ``interview_done`` payload.

    A finished ``goal`` phase whose patch carries no goal (an unparseable
    final turn) falls back to the user's first answer, so the summary never
    loses what they said.

    Args:
        pred: The prediction, or ``None`` when the stream produced nothing.
        asked: Assistant questions asked in this phase before this turn.
        phase: The phase the turn ran.
        turns: This phase's prior turns.
        catalog_models: Catalog entries the patch's ``models`` may name.
        provider_slugs: Provider slugs ``byok_provider`` may name.

    Returns:
        ``{"message", "options", "phase_done", "profile_patch", "skip_phases",
        "skip_rest", "model"}``.
    """
    skip_rest = _truthy(getattr(pred, "skip_rest", ""))
    phase_done = _truthy(getattr(pred, "done", "")) or skip_rest or asked >= MAX_PHASE_QUESTIONS
    patch = validate_profile_patch(
        _parse_json(getattr(pred, "profile_patch_json", "{}"), {}),
        catalog_models=catalog_models,
        provider_slugs=provider_slugs,
    )
    if phase == "goal" and phase_done and "goal" not in patch:
        first = next((t.get("content", "") for t in turns if t.get("role") == "user"), "")
        if goal := _text(first):
            patch["goal"] = goal
    options = [] if phase_done else normalize_options(_parse_json(getattr(pred, "options_json", "[]"), []))
    return {
        "message": str(getattr(pred, "message", "") or "").strip(),
        "options": options,
        "phase_done": phase_done,
        "profile_patch": patch,
        "skip_phases": answered_phases(patch),
        "skip_rest": skip_rest,
        "model": agent_model_id(settings.code_agent_model),
    }


async def intake_turn_stream(
    *,
    phase: str,
    turns: list[dict[str, str]],
    profile: dict[str, Any],
    catalog_models: list[Any],
    provider_slugs: list[str],
    locale: str | None,
    model: str | None,
    reasoning_effort: str | None = None,
    usage_sink: list | None = None,
) -> Any:
    """Run one intake turn, streaming the Signature & Metric interview's events.

    Yields ``reasoning_patch``, ``message_patch``, ``message_end``,
    ``turn_hint`` (``{"final"}`` = phase done), ``message_reset`` on a
    retry, and a terminal ``interview_done`` (see
    :func:`parse_intake_prediction`, plus ``served_model``).

    Args:
        phase: ``goal`` or ``source``.
        turns: This phase's prior turns, oldest first.
        profile: The client's profile so far (validated again here).
        catalog_models: Catalog entries (patch validation, featured list).
        provider_slugs: Provider slugs ``byok_provider`` may name.
        locale: UI locale code.
        model: LiteLLM id conducting the turn; ``None`` runs the server default.
        reasoning_effort: Effort level for ``model``; ``None`` keeps its default.
        usage_sink: Optional list the built LM is appended to, for metering.
    """
    asked = sum(1 for t in turns if t.get("role") == "assistant")
    lm = _build_agent_lm(model, reasoning_effort, max_tokens=INTAKE_MAX_TOKENS)
    if usage_sink is not None:
        usage_sink.append(lm)
    known = validate_profile_patch(profile, catalog_models=catalog_models, provider_slugs=provider_slugs)
    inputs = intake_inputs(
        phase=phase, turns=turns, profile=known, featured=featured_model_list(catalog_models), locale=locale
    )

    def parse(pred: Any, count: int) -> dict[str, Any]:
        """Bind the turn's context onto :func:`parse_intake_prediction`.

        Args:
            pred: The final prediction.
            count: Assistant questions asked before this turn.

        Returns:
            The ``interview_done`` payload.
        """
        return parse_intake_prediction(
            pred, count, phase=phase, turns=turns, catalog_models=catalog_models, provider_slugs=provider_slugs
        )

    async for event in relay_interview_turn(
        predict=dspy.Predict(IntakeInterviewTurnSig), lm=lm, inputs=inputs, asked=asked, model=model, parse=parse
    ):
        yield event
