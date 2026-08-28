"""LLM engine for the Signature & Metric authoring interview. [INTERNAL]

Mirrors the tagger's dataset interview (``core.service_gateway.tagging``):
a stateless, single-turn dspy Signature streamed over the generalist agent's
event shapes. The interviewer asks the dataset owner a handful of grounded
questions before the seed generation runs, then distills their answers into
an authoring brief — short directives the Signature/metric seed authors must
honor. The transcript is client-owned and re-sent on every turn; nothing
here touches the database.

A black-box authoring context (the "optimize anything" wizard) swaps the
signature for :class:`BlackboxInterviewTurnSig`: same turn shape and event
stream, but the questions are about the objective, the starting point and
the python scorer instead of a dataset's Signature & Metric.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import dspy

from ...config import settings
from ..language_models import served_model_from
from .code import ReasoningStreamListener, _build_agent_lm, _reply_language
from .constants import REASONING_FIELD
from .parse_salvage import salvage_prediction

logger = logging.getLogger(__name__)

MAX_INTERVIEW_QUESTIONS = 5

INTERVIEW_TURN_ATTEMPTS = 2
"""LLM attempts per turn; a parse-salvaged reply never spends the retry."""


class CodeInterviewTurnSig(dspy.Signature):
    """Interview the dataset owner to distill a Signature & Metric brief.

    You are an authoring copilot about to write a DSPy Signature (the
    input → output contract whose docstring and field descriptions become
    the runtime prompt) and a Metric (the function that scores predictions)
    for the user's optimization job. Before writing anything, interview the
    owner. Ask ONE short, concrete question at a time — grounded in the
    sample rows — about what a high-quality output looks like, how strictly
    answers should match the reference, edge cases and dirty rows, tone /
    length / formatting / language constraints, and what should be rewarded
    or penalized when scoring. Never ask a generic question the dataset
    already answers, and never ask which LLM to use — that is chosen in a
    later step (``job_model`` tells you the current choice when one exists;
    take its strengths and quirks into account in what you ask). After at
    most five questions total (or as soon as the user asks to proceed, or
    their answers stop adding information), stop asking: set ``done`` to
    true, write a one-sentence wrap-up in ``message``, and emit the full
    brief — 4 to 10 crisp directives for the code authors. Directives state
    decisions ("Outputs must ...", "Score X lower when ..."), not process.
    Whenever the question has a small set of likely answers, offer 2-4 of
    them in ``options_json`` — each a short pickable answer with a one-line
    description of what choosing it means — so the owner can answer in one
    click. Every option must be a concrete, self-contained answer. The
    composer under the options is always the free-text path, so never spend
    an option on an escape hatch — no "other", "something else", "none of
    these", "I use my own ...", or any rewording whose real meaning is "I'll
    type it below"; when only escape hatches would fill the list, offer
    fewer options or ask an open question instead. Write ``message``, the
    options and the brief in ``reply_language``, keeping the product terms
    ``Signature`` and ``Metric`` in English.
    """

    dataset_columns: list[str] = dspy.InputField(desc="Every column name in the dataset.")
    column_roles: str = dspy.InputField(
        desc="JSON object mapping column name → 'input' | 'output' | 'ignore'.",
    )
    column_kinds: str = dspy.InputField(
        desc="JSON object mapping input-column name → 'text' | 'image'.",
    )
    sample_rows: str = dspy.InputField(
        desc="JSON array of up to 5 representative rows from the dataset.",
    )
    job_model: str = dspy.InputField(
        desc=(
            "The LLM the optimized program will run on, e.g. "
            "'openai/gpt-4o-mini'; 'not chosen yet' when the user has not "
            "picked one."
        ),
    )
    transcript_json: str = dspy.InputField(desc="JSON array of prior {role, content} turns.")
    reply_language: str = dspy.InputField(desc="Language every output is written in.")
    message: str = dspy.OutputField(desc="The next question, or a short wrap-up when done.")
    # ``done`` sits right after ``message`` so it streams before the (slow)
    # options/brief fields — the client uses it to pick the correct
    # still-generating placeholder (answer choices vs. the authoring brief).
    done: str = dspy.OutputField(desc="'true' when the interview is finished, else 'false'.")
    options_json: str = dspy.OutputField(
        desc=(
            'JSON array of 0-4 answer options for a closed question, each '
            '{"label": <short pickable answer, <= 6 words>, "description": '
            '<one-line note on what picking it means>}; [] for an open question.'
        )
    )
    brief_json: str = dspy.OutputField(desc="JSON array of authoring-directive strings; [] until done.")


class BlackboxInterviewTurnSig(dspy.Signature):
    """Interview the owner of a black-box optimization job to distill an authoring brief.

    You are an authoring copilot about to write the starting point and the
    scorer for the user's optimization job. The starting point is what the
    optimizer improves — per ``recipe`` a system prompt ('prompt'; each
    case's input becomes the user message), a program ('code') or any text
    ('anything'); with an 'agent' target it is the instructions file a
    coding agent runs with. The scorer is one python function,
    ``score(candidate, case=None)``, that reads a case's columns and
    returns a higher number for a better version — it IS the objective, so
    what it rewards matters most. Before writing anything, interview the
    owner. Ask ONE short, concrete question at a time — grounded in the
    objective, the background and the sample cases — about what a better
    version looks like, what must never change, how a version should be
    judged (exact match, graded similarity, a rubric, numeric targets,
    length / format limits), which case columns hold the input and the
    expected outcome, edge cases, and tone / language / format constraints.
    When ``objective`` is empty the owner has not said what they want yet:
    open by asking what they want to optimize and what a better version
    achieves, then report their answer through ``captured_objective`` on
    every later turn. Never ask a generic question the objective already answers, and never
    ask which LLM to use — that is chosen elsewhere (``job_model`` tells
    you the current choice when one exists; ``scorer_has_model`` tells you
    whether the scorer may call a model at all, so never propose an LLM
    judge when it cannot). After at most five questions total (or as soon
    as the user asks to proceed, or their answers stop adding information),
    stop asking: set ``done`` to true, write a one-sentence wrap-up in
    ``message``, and emit the full brief — 4 to 10 crisp directives for the
    authors. Directives state decisions ("The starting point must ...",
    "Score X lower when ..."), not process. Whenever the question has a
    small set of likely answers, offer 2-4 of them in ``options_json`` —
    each a short pickable answer with a one-line description of what
    choosing it means — so the owner can answer in one click. Every option
    must be a concrete, self-contained answer. The composer under the
    options is always the free-text path, so never spend an option on an
    escape hatch — no "other", "something else", "none of these", or any
    rewording whose real meaning is "I'll type it below"; when only escape
    hatches would fill the list, offer fewer options or ask an open
    question instead. Write ``message``, the options and the brief in
    ``reply_language``.
    """

    objective: str = dspy.InputField(desc="What a better version achieves, in the user's words.")
    background: str = dspy.InputField(desc="Free-form context from the user; may be empty.")
    recipe: str = dspy.InputField(desc="'prompt' | 'code' | 'anything' — what is being optimized.")
    target_kind: str = dspy.InputField(desc="'text' or 'agent' (an instructions file a coding agent runs with).")
    case_columns: list[str] = dspy.InputField(desc="Column names of the case file; empty when there are no cases.")
    sample_cases: str = dspy.InputField(desc="JSON array of up to 5 representative cases.")
    scorer_has_model: str = dspy.InputField(desc="'true' when the scorer may call a model via llm(), else 'false'.")
    job_model: str = dspy.InputField(
        desc=(
            "The LLM the optimized artifact will run on, e.g. "
            "'openai/gpt-4o-mini'; 'not chosen yet' when the user has not "
            "picked one."
        ),
    )
    transcript_json: str = dspy.InputField(desc="JSON array of prior {role, content} turns.")
    reply_language: str = dspy.InputField(desc="Language every output is written in.")
    message: str = dspy.OutputField(desc="The next question, or a short wrap-up when done.")
    # Same ordering constraint as ``CodeInterviewTurnSig``: ``done`` streams
    # before the slow payload fields so the client can hint early.
    done: str = dspy.OutputField(desc="'true' when the interview is finished, else 'false'.")
    options_json: str = dspy.OutputField(
        desc=(
            'JSON array of 0-4 answer options for a closed question, each '
            '{"label": <short pickable answer, <= 6 words>, "description": '
            '<one-line note on what picking it means>}; [] for an open question.'
        )
    )
    brief_json: str = dspy.OutputField(desc="JSON array of authoring-directive strings; [] until done.")
    captured_objective: str = dspy.OutputField(
        desc=(
            "The owner's objective in one or two sentences, in their words, "
            "once the transcript has answered it and the ``objective`` input "
            "was empty; '' otherwise."
        ),
    )


def normalize_options(raw: Any) -> list[dict[str, str]]:
    """Coerce a model options field into ``[{label, description}]``.

    Tolerant of the model emitting either the structured shape or a bare list
    of answer strings; drops entries without a label and caps the list at four.

    Args:
        raw: The parsed ``options_json`` value (any JSON type).

    Returns:
        Up to four ``{"label", "description"}`` dicts with non-empty labels.
    """
    if not isinstance(raw, list):
        return []
    options: list[dict[str, str]] = []
    for item in raw:
        if isinstance(item, dict):
            label = str(item.get("label", "")).strip()
            description = str(item.get("description", "")).strip()
        else:
            label, description = str(item).strip(), ""
        if label:
            options.append({"label": label, "description": description})
    return options[:4]


def _parse_json(text: str, fallback: Any) -> Any:
    """Parse a JSON-in-a-string model output, returning ``fallback`` on failure.

    Args:
        text: The raw output field value.
        fallback: Value returned when the text is empty or unparseable.
    """
    try:
        return json.loads(text) if text and text.strip() else fallback
    except (json.JSONDecodeError, TypeError):
        return fallback


def _interview_inputs(
    dataset_columns: list[str],
    column_roles: dict[str, str],
    column_kinds: dict[str, str],
    sample_rows: list[dict[str, Any]],
    job_model: str,
    turns: list[dict[str, str]],
    locale: str | None,
) -> dict[str, Any]:
    """Assemble the ``CodeInterviewTurnSig`` inputs for one turn.

    Args:
        dataset_columns: All dataset column names.
        column_roles: Column name → role mapping.
        column_kinds: Input column → kind (text/image) mapping.
        sample_rows: Up to 5 representative rows.
        job_model: The job's target model id; empty when not chosen yet.
        turns: Prior ``{role, content}`` turns, oldest first.
        locale: UI locale code; replies are written in that language.
    """
    return {
        "dataset_columns": dataset_columns,
        "column_roles": json.dumps(column_roles, ensure_ascii=False),
        "column_kinds": json.dumps(column_kinds, ensure_ascii=False),
        "sample_rows": json.dumps(sample_rows, ensure_ascii=False),
        "job_model": job_model.strip() or "not chosen yet",
        "transcript_json": _transcript_json(turns),
        "reply_language": _reply_language(locale),
    }


def _transcript_json(turns: list[dict[str, str]]) -> str:
    """Encode the transcript, appending the question-count reminder once questions were asked.

    Args:
        turns: Prior ``{role, content}`` turns, oldest first.

    Returns:
        The JSON-encoded transcript the interview signatures read.
    """
    asked = sum(1 for t in turns if t.get("role") == "assistant")
    noted = list(turns)
    if asked:
        noted.append(
            {
                "role": "system",
                "content": (
                    f"Questions asked so far: {asked} of at most {MAX_INTERVIEW_QUESTIONS}."
                    " If the limit is reached you MUST finish now."
                ),
            }
        )
    return json.dumps(noted, ensure_ascii=False)


def _blackbox_interview_inputs(
    blackbox: dict[str, Any],
    case_columns: list[str],
    sample_cases: list[dict[str, Any]],
    job_model: str,
    turns: list[dict[str, str]],
    locale: str | None,
) -> dict[str, Any]:
    """Assemble the ``BlackboxInterviewTurnSig`` inputs for one turn.

    Args:
        blackbox: The wizard's authoring context (``recipe``, ``objective``,
            ``background``, ``target_kind``, ``scorer_has_model``).
        case_columns: Column names of the case file; empty without cases.
        sample_cases: Up to 5 representative cases.
        job_model: The job's target model id; empty when not chosen yet.
        turns: Prior ``{role, content}`` turns, oldest first.
        locale: UI locale code; replies are written in that language.
    """
    return {
        "objective": str(blackbox.get("objective", "")).strip(),
        "background": str(blackbox.get("background", "") or "").strip(),
        "recipe": str(blackbox.get("recipe", "anything")),
        "target_kind": str(blackbox.get("target_kind", "text") or "text"),
        "case_columns": case_columns,
        "sample_cases": json.dumps(sample_cases, ensure_ascii=False, default=str),
        "scorer_has_model": "true" if blackbox.get("scorer_has_model") else "false",
        "job_model": job_model.strip() or "not chosen yet",
        "transcript_json": _transcript_json(turns),
        "reply_language": _reply_language(locale),
    }


def _parse_interview_prediction(pred: Any, asked: int) -> dict[str, Any]:
    """Turn a raw ``CodeInterviewTurnSig`` prediction into the client turn payload.

    Args:
        pred: The prediction (or ``None`` when the stream produced nothing).
        asked: Assistant questions asked before this turn (limit enforcement).

    Returns:
        ``{"message", "options", "brief", "done", "objective", "model"}`` —
        ``options`` is a list of ``{label, description}`` picks (empty once
        done); ``brief`` is empty until ``done`` is true; ``objective`` is the
        objective a black-box interview captured over a blank field, else "".
    """
    done = str(getattr(pred, "done", "")).strip().lower() in {"true", "yes", "1"}
    brief = _parse_json(getattr(pred, "brief_json", "[]"), [])
    brief = [str(b).strip() for b in brief if str(b).strip()] if isinstance(brief, list) else []
    if asked >= MAX_INTERVIEW_QUESTIONS and not done:
        done = True
    options = normalize_options(_parse_json(getattr(pred, "options_json", "[]"), []))
    return {
        "message": str(getattr(pred, "message", "")).strip(),
        "options": [] if done else options,
        "brief": brief if done else [],
        "done": done,
        "objective": str(getattr(pred, "captured_objective", "") or "").strip(),
        "model": settings.code_agent_model,
    }


async def _drive_interview_turn(
    *,
    predict: dspy.Predict,
    lm: dspy.LM,
    inputs: dict[str, Any],
    asked: int,
    model: str | None,
    queue: asyncio.Queue[dict | None],
) -> None:
    """Drive the interview predictor to completion, fanning events onto ``queue``.

    Runs the whole streamify loop inside this one task so that ``dspy.context``'s
    contextvar token and streamify's internal anyio task group are entered and
    exited in the same task. The previous shape yielded SSE events directly from
    inside the loop, which tied the streamify generator's finalization to the
    Starlette response task; when consumption crossed task boundaries the
    teardown raised ``RuntimeError: exit cancel scope in a different task`` and
    ``ValueError: Token was created in a different Context``, failing every turn.
    Pushing to an unbounded queue keeps the loop within this task, exactly as the
    code agent's seed/edit streams do.

    A terminal ``interview_done`` is enqueued on success; a total failure
    propagates out (the caller re-raises it for the router to translate into an
    ``error`` event). A ``None`` sentinel always closes the queue.

    Args:
        predict: The interview predictor (reused across attempts).
        lm: Language model conducting the interview.
        inputs: Keyword inputs forwarded to the streamify program.
        asked: Count of assistant turns so far, for the parsed turn's numbering.
        model: LiteLLM id conducting the interview; stamped on the parsed turn
            when set. ``None`` runs the default.
        queue: SSE event queue; receives event dicts and a trailing ``None``.
    """
    prediction: Any = None
    try:
        for attempt in range(INTERVIEW_TURN_ATTEMPTS):
            # Stream listeners are single-use; rebuild the program per attempt.
            program = dspy.streamify(
                predict,
                stream_listeners=[
                    dspy.streaming.StreamListener(signature_field_name="message"),
                    dspy.streaming.StreamListener(signature_field_name="done"),
                    ReasoningStreamListener(predict=predict),
                ],
                async_streaming=True,
            )
            if attempt:
                await queue.put({"event": "message_reset", "data": {}})
            done_text = ""
            try:
                with dspy.context(lm=lm):
                    async for chunk in program(**inputs):
                        if isinstance(chunk, dspy.streaming.StreamResponse):
                            if chunk.signature_field_name == REASONING_FIELD:
                                await queue.put(
                                    {"event": "reasoning_patch", "data": {"chunk": chunk.chunk}}
                                )
                            elif chunk.signature_field_name == "message":
                                await queue.put(
                                    {"event": "message_patch", "data": {"chunk": chunk.chunk}}
                                )
                                if chunk.is_last_chunk:
                                    await queue.put({"event": "message_end", "data": {}})
                            elif chunk.signature_field_name == "done":
                                done_text += chunk.chunk
                                if chunk.is_last_chunk:
                                    await queue.put(
                                        {
                                            "event": "turn_hint",
                                            "data": {"final": "true" in done_text.lower()},
                                        }
                                    )
                        elif isinstance(chunk, dspy.Prediction):
                            prediction = chunk
                break
            except Exception as err:
                # Keep a prediction already captured this attempt — an exception
                # raised during teardown must not discard a completed reply.
                if prediction is None:
                    prediction = salvage_prediction(err)
                if prediction is not None:
                    break
                if attempt + 1 >= INTERVIEW_TURN_ATTEMPTS:
                    raise
                logger.warning("code interview turn failed; retrying", exc_info=True)
        turn = _parse_interview_prediction(prediction, asked)
        if model:
            turn["model"] = model
        turn["served_model"] = served_model_from(lm)
        await queue.put({"event": "interview_done", "data": turn})
    finally:
        await queue.put(None)


async def interview_turn_stream(
    *,
    dataset_columns: list[str],
    column_roles: dict[str, str],
    column_kinds: dict[str, str],
    sample_rows: list[dict[str, Any]],
    job_model: str,
    turns: list[dict[str, str]],
    locale: str | None,
    model: str | None = None,
    reasoning_effort: str | None = None,
    lm_extra_body: dict[str, Any] | None = None,
    usage_sink: list | None = None,
    blackbox: dict[str, Any] | None = None,
) -> Any:
    """Run one interview turn, streaming it the way the generalist agent does.

    Yields ``{"event", "data"}`` mappings ready for ``sse_from_events``:
    ``reasoning_patch`` for provider thinking tokens (same synthetic channel
    the agents use), ``message_patch`` for reply deltas, ``message_end`` once
    the reply is fully streamed (the remaining structured fields — options,
    brief — are still generating), ``turn_hint`` with ``{"final"}`` as soon
    as the streamed ``done`` field settles (the client picks the matching
    still-generating placeholder), ``message_reset`` when a failed attempt is
    being retried (the client must drop partial text and the hint), and a
    terminal ``interview_done`` carrying the parsed turn.

    A turn whose terminal parse fails is first salvaged from the raw response
    (minimax-class models answer in chat-adapter format even under the JSON
    fallback — see ``parse_salvage``) and only then retried from scratch.

    Args:
        dataset_columns: All dataset column names.
        column_roles: Column name → role mapping.
        column_kinds: Input column → kind (text/image) mapping.
        sample_rows: Up to 5 representative rows.
        job_model: The job's target model id; empty when not chosen yet.
        turns: Prior ``{role, content}`` turns, oldest first.
        locale: UI locale code; replies are written in that language.
        model: LiteLLM id conducting the interview; ``None`` runs the default.
        reasoning_effort: Explicit effort level for ``model``; ``None`` keeps
            the model's default.
        lm_extra_body: Extra request-body fields for the LM call (the auto
            router's plugin dial when the composer picked an Auto tier).
        usage_sink: Optional list the built LM is appended to, so the caller
            can meter the turn's token usage on any exit path.
        blackbox: The black-box wizard's authoring context; set, the turn
            runs :class:`BlackboxInterviewTurnSig` with ``dataset_columns``
            / ``sample_rows`` read as the case columns / sample cases.
    """
    asked = sum(1 for t in turns if t.get("role") == "assistant")
    lm = _build_agent_lm(model, reasoning_effort, lm_extra_body)
    if usage_sink is not None:
        usage_sink.append(lm)
    if blackbox is not None:
        predict = dspy.Predict(BlackboxInterviewTurnSig)
        inputs = _blackbox_interview_inputs(blackbox, dataset_columns, sample_rows, job_model, turns, locale)
    else:
        predict = dspy.Predict(CodeInterviewTurnSig)
        inputs = _interview_inputs(
            dataset_columns, column_roles, column_kinds, sample_rows, job_model, turns, locale
        )

    # Drive the streamify loop in its own task and relay its events off a queue:
    # yielding directly from inside the loop finalizes the dspy.context token and
    # streamify's anyio task group in the SSE consumer's task, corrupting both.
    queue: asyncio.Queue[dict | None] = asyncio.Queue()
    task = asyncio.create_task(
        _drive_interview_turn(
            predict=predict, lm=lm, inputs=inputs, asked=asked, model=model, queue=queue
        )
    )
    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
        await task
    except asyncio.CancelledError:
        task.cancel()
        raise
