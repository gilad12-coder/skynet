"""LLM engine for the submission wizard's step-1 task interview. [INTERNAL]

The interview opens with "what do you want to optimize?" and asks a few
short, grounded questions, offering clickable answers whenever a click can
settle one. The model, not the user, writes the objective and background and
derives the artifact kind and its starting version; the user only confirms
them in the wizard. The turn streams over the shared interview driver
(:func:`~.code_interview.relay_interview_turn`): same events, retries and
parse salvage, with a task-specific signature and terminal payload. Nothing
here touches the database; the transcript and the draft are client-owned and
re-sent on every turn.
"""

from __future__ import annotations

import json
from typing import Any, get_args

import dspy

from ...api.model_catalog import agent_model_id
from ...config import settings
from ...models import ArtifactKind, TaskInterviewTurnResult
from ...models.blackbox import BlackboxCandidate
from .answer_options import normalize_options
from .code import _build_agent_lm, _reply_language
from .code_interview import MAX_INTERVIEW_QUESTIONS, _parse_json, _transcript_json, relay_interview_turn
from .conduct import with_conduct

ARTIFACT_KINDS: tuple[str, ...] = get_args(ArtifactKind)
OPENING_QUESTION = "what do you want to optimize?"
MAX_SAMPLE_CASE_CHARS = 4000
"""Cap on the JSON of the sample cases fed to the model, per turn."""

_ARTIFACT_KIND_ALIASES = {
    "dspy": "dspy_program",
    "program": "dspy_program",
    "dspy_module": "dspy_program",
    "system_prompt": "prompt",
    "python": "code",
    "function": "code",
    "document": "text",
}


class TaskInterviewTurnSig(dspy.Signature):
    __doc__ = with_conduct("""Run one turn of the interview that sets up what the user wants to optimize.

    You are a sharp engineer helping someone set up an optimization run on
    a prompt- and program-optimization platform. The run improves one
    artifact: a ``prompt`` (an LLM prompt or system prompt), ``code`` (a
    Python function or snippet), a ``dspy_program`` (a DSPy module whose
    predictor instructions get tuned) or ``text`` (any other text, e.g. a
    template or a policy). You write everything; the user only answers and
    confirms.

    When the transcript is empty, open by asking what they want to
    optimize ("what do you want to optimize?", in ``reply_language``).
    Then ask ONE short question at a time (``message`` is one or two short
    sentences) until you know the goal, how success is judged and the
    starting version. Never ask what the ``draft_*`` fields, the sample cases
    or the transcript already answer. When you know enough, or the
    question-count note says the limit is reached, set ``done`` to true and
    write a one-sentence summary inviting the user to confirm the card.

    Prefer buttons: for every question a click can settle, offer 2-4
    options in ``options_json``, each a short pickable answer (<= 6 words)
    with a one-line description, the recommended option first. Options are
    concrete answers, never "other" or "I'll type it": the user always has
    a free-text box. Use [] for an open question (e.g. "paste your
    prompt") and once ``done``.

    Every turn, rewrite the draft from everything known so far (keep the
    ``draft_*`` values unless the user changed them):
    - ``objective``: one or two sentences on what the artifact must do
      better, in ``reply_language``.
    - ``background``: the context an optimizer needs (domain, constraints,
      what good output looks like), in ``reply_language``; may be empty.
    - ``artifact_kind``: prompt | code | dspy_program | text, or empty
      when still unknown.
    - ``starting_version_json``: the artifact's starting version as JSON —
      a string for prompt/code/text (the user's prompt, code or text
      verbatim, or a short sensible first draft you write when they have
      none), or for dspy_program an object mapping each predictor name to
      its instruction. Empty when still unknown.
    - ``artifact_rationale``: one sentence on why this artifact kind fits.
    """)

    # The draft inputs carry a ``draft_`` prefix because the same names are
    # outputs: a dspy signature cannot hold an input and output of one name.
    draft_objective: str = dspy.InputField(desc="Current draft objective; may be empty.")
    draft_background: str = dspy.InputField(desc="Current draft background; may be empty.")
    draft_artifact_kind: str = dspy.InputField(desc="Current draft artifact kind; empty when unknown.")
    draft_starting_version: str = dspy.InputField(desc="Current draft starting version as JSON; empty when unknown.")
    sample_cases: str = dspy.InputField(desc="JSON array of up to five example inputs the user provided; may be [].")
    transcript_json: str = dspy.InputField(desc="JSON array of prior {role, content} turns, oldest first.")
    reply_language: str = dspy.InputField(desc="Language the message, options, objective and background use.")
    message: str = dspy.OutputField(desc="The next question, or a one-sentence summary when done.")
    # ``done`` sits right after ``message`` so it streams before the slower
    # draft fields; the shared driver turns it into ``turn_hint``.
    done: str = dspy.OutputField(desc="'true' when the draft is ready to confirm, else 'false'.")
    options_json: str = dspy.OutputField(
        desc=(
            'JSON array of 0-4 answer options, each {"label": <short answer>, '
            '"description": <one line>}, recommended first; [] for an open question or when done.'
        )
    )
    objective: str = dspy.OutputField(desc="Updated objective.")
    background: str = dspy.OutputField(desc="Updated background.")
    artifact_kind: str = dspy.OutputField(desc="prompt | code | dspy_program | text, or empty when unknown.")
    starting_version_json: str = dspy.OutputField(
        desc="Starting version as JSON: a string, or for dspy_program an object of predictor name to instruction."
    )
    artifact_rationale: str = dspy.OutputField(desc="One sentence on why the artifact kind fits.")


def _truthy(value: Any) -> bool:
    """Read a model's boolean-ish text field.

    Args:
        value: Raw field value.

    Returns:
        Whether the value spells true.
    """
    return str(value or "").strip().lower() in {"true", "yes", "1"}


def normalize_artifact_kind(value: Any) -> ArtifactKind | None:
    """Coerce a model-written artifact kind onto :data:`ArtifactKind`.

    Args:
        value: Raw field value.

    Returns:
        The artifact kind, or ``None`` when the value names none.
    """
    if not isinstance(value, str):
        return None
    cleaned = value.strip().lower().replace("-", "_").replace(" ", "_")
    cleaned = _ARTIFACT_KIND_ALIASES.get(cleaned, cleaned)
    return cleaned if cleaned in ARTIFACT_KINDS else None  # type: ignore[return-value]


def normalize_starting_version(raw: Any, artifact_kind: ArtifactKind | None) -> BlackboxCandidate | None:
    """Turn a model-written starting version into ``str | dict[str, str]``.

    A JSON string is decoded first; a value that is not JSON is the version
    itself (models often skip the quoting). A DSPy program's version must be
    a non-empty mapping of predictor names to instructions; any other kind
    takes a string, so a mapping is flattened only when it has one entry.

    Args:
        raw: The raw ``starting_version_json`` value.
        artifact_kind: The validated artifact kind, or ``None``.

    Returns:
        The starting version, or ``None`` when it is empty or invalid.
    """
    value: Any = raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return None
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            value = text
    if isinstance(value, dict):
        mapping = {str(k).strip(): str(v) for k, v in value.items() if str(k).strip() and v is not None}
        if not mapping:
            return None
        if artifact_kind == "dspy_program" or artifact_kind is None:
            return mapping
        return next(iter(mapping.values())) if len(mapping) == 1 else None
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        text = str(value)
        if not text.strip() or artifact_kind == "dspy_program":
            return None
        return text
    return None


def _version_json(version: BlackboxCandidate | None) -> str:
    """Encode the draft's starting version for the model.

    Args:
        version: The client's draft starting version.

    Returns:
        JSON text, or ``""`` when there is none.
    """
    return "" if version is None else json.dumps(version, ensure_ascii=False)


def _sample_cases_json(cases: list[dict[str, Any]]) -> str:
    """Encode the sample cases, truncated to :data:`MAX_SAMPLE_CASE_CHARS`.

    Args:
        cases: Up to five example inputs.

    Returns:
        JSON text, cut at the character cap.
    """
    return json.dumps(cases, ensure_ascii=False, default=str)[:MAX_SAMPLE_CASE_CHARS]


def task_interview_inputs(
    *,
    turns: list[dict[str, str]],
    objective: str,
    background: str,
    artifact_kind: ArtifactKind | None,
    starting_version: BlackboxCandidate | None,
    sample_cases: list[dict[str, Any]],
    locale: str | None,
) -> dict[str, Any]:
    """Assemble the :class:`TaskInterviewTurnSig` inputs for one turn.

    Args:
        turns: Prior ``{role, content}`` turns, oldest first.
        objective: Current draft objective.
        background: Current draft background.
        artifact_kind: Current draft artifact kind.
        starting_version: Current draft starting version.
        sample_cases: Example inputs the user provided.
        locale: UI locale code; replies are written in that language.

    Returns:
        Keyword inputs for the predictor.
    """
    return {
        "draft_objective": objective,
        "draft_background": background,
        "draft_artifact_kind": artifact_kind or "",
        "draft_starting_version": _version_json(starting_version),
        "sample_cases": _sample_cases_json(sample_cases),
        "transcript_json": _transcript_json(turns),
        "reply_language": _reply_language(locale),
    }


def parse_task_interview_prediction(
    pred: Any,
    asked: int,
    *,
    draft: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Turn a raw :class:`TaskInterviewTurnSig` prediction into the ``interview_done`` payload.

    A field the model left empty or wrote invalidly keeps the draft's value,
    so a sloppy turn never wipes what an earlier turn settled. The turn is
    forced done once :data:`MAX_INTERVIEW_QUESTIONS` questions were asked.

    Args:
        pred: The prediction, or ``None`` when the stream produced nothing.
        asked: Assistant questions asked before this turn.
        draft: The client's current draft (``objective``, ``background``,
            ``artifact_kind``, ``starting_version``); fills in what the
            prediction leaves out.

    Returns:
        A :class:`TaskInterviewTurnResult` as a dict.
    """
    draft = draft or {}
    done = _truthy(getattr(pred, "done", "")) or asked >= MAX_INTERVIEW_QUESTIONS
    kind = normalize_artifact_kind(getattr(pred, "artifact_kind", "")) or normalize_artifact_kind(
        draft.get("artifact_kind")
    )
    version = normalize_starting_version(getattr(pred, "starting_version_json", ""), kind)
    if version is None:
        version = normalize_starting_version(_version_json(draft.get("starting_version")), kind)
    options = [] if done else normalize_options(_parse_json(getattr(pred, "options_json", "[]"), []))
    result = TaskInterviewTurnResult(
        message=str(getattr(pred, "message", "") or "").strip(),
        options=[{"label": o["label"][:80], "description": o["description"][:400]} for o in options],
        done=done,
        objective=str(getattr(pred, "objective", "") or "").strip() or str(draft.get("objective") or ""),
        background=str(getattr(pred, "background", "") or "").strip() or str(draft.get("background") or ""),
        artifact_kind=kind,
        starting_version=version,
        artifact_rationale=str(getattr(pred, "artifact_rationale", "") or "").strip(),
        model=agent_model_id(settings.code_agent_model),
    )
    return result.model_dump()


async def task_interview_turn_stream(
    *,
    turns: list[dict[str, str]],
    objective: str = "",
    background: str = "",
    artifact_kind: ArtifactKind | None = None,
    starting_version: BlackboxCandidate | None = None,
    sample_cases: list[dict[str, Any]] | None = None,
    locale: str | None = None,
    model: str | None = None,
    reasoning_effort: str | None = None,
    usage_sink: list | None = None,
) -> Any:
    """Run one task-interview turn, streaming the shared interview events.

    Yields ``reasoning_patch``, ``message_patch``, ``message_end``,
    ``turn_hint`` (``{"final"}`` = draft ready), ``message_reset`` on a
    retry, and a terminal ``interview_done`` carrying a
    :class:`TaskInterviewTurnResult`.

    Args:
        turns: Prior ``{role, content}`` turns, oldest first.
        objective: Current draft objective.
        background: Current draft background.
        artifact_kind: Current draft artifact kind.
        starting_version: Current draft starting version.
        sample_cases: Example inputs the user provided.
        locale: UI locale code.
        model: LiteLLM id conducting the turn; ``None`` runs the server default.
        reasoning_effort: Effort level for ``model``; ``None`` keeps its default.
        usage_sink: Optional list the built LM is appended to, for metering.
    """
    asked = sum(1 for t in turns if t.get("role") == "assistant")
    lm = _build_agent_lm(model, reasoning_effort)
    if usage_sink is not None:
        usage_sink.append(lm)
    draft = {
        "objective": objective,
        "background": background,
        "artifact_kind": artifact_kind,
        "starting_version": starting_version,
    }
    inputs = task_interview_inputs(
        turns=turns,
        objective=objective,
        background=background,
        artifact_kind=artifact_kind,
        starting_version=starting_version,
        sample_cases=sample_cases or [],
        locale=locale,
    )

    def parse(pred: Any, count: int) -> dict[str, Any]:
        """Bind the client's draft onto :func:`parse_task_interview_prediction`.

        Args:
            pred: The final prediction.
            count: Assistant questions asked before this turn.

        Returns:
            The ``interview_done`` payload.
        """
        return parse_task_interview_prediction(pred, count, draft=draft)

    async for event in relay_interview_turn(
        predict=dspy.Predict(TaskInterviewTurnSig), lm=lm, inputs=inputs, asked=asked, model=model, parse=parse
    ):
        yield event
