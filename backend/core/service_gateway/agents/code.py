"""DSPy-powered code agent for the submit wizard.

Every program is authored under one contract: the agent writes run code
(entry point ``run(artifact, input)``, or ``build_program()`` when a DSPy
optimizer needs the module) plus a metric in the exact shape the chosen
optimizer needs, and the validity check holds both to it before Run. The
unified authoring context carries that contract, so both modes take it:

* **Seed** (``user_message`` is empty): a non-agentic pass that drafts the
  run code and the metric in parallel, streamed so the editors fill in
  live, then a short intro composed from the finished code.

* **Chat** (``user_message`` is set): a :class:`dspy.ReActV2` agent with
  ``ask_user`` / ``set_brief`` / ``edit_run`` / ``edit_metric``. When a
  user-facing tool fires, the backend emits ``tool_start`` /
  ``signature_replace`` (or ``metric_replace``) / ``tool_end`` around the
  call so the UI can render a tool-call card and swap the code atomically.

The run code rides the ``signature_*`` events and the metric the
``metric_*`` ones, so the editor wiring is shared. A workflow graph on the
canvas (``prior_workflow``) switches both modes to graph-aware paths
instead. The DSPy Signature chat agent (``edit_signature`` /
``edit_metric``) still serves the MCP ``edit_code`` tool; it never seeds.

The agent runs on whatever LiteLLM-compatible model is configured via
``settings.code_agent_model`` (default: the model catalog's best-value
pick). Users can point it at an internal gateway via
``CODE_AGENT_BASE_URL``.
"""

from __future__ import annotations

import ast
import asyncio
import json
import logging
import uuid
from collections.abc import AsyncGenerator, Callable
from functools import partial
from typing import Any

import dspy
import jiter
from pydantic import ValidationError

from ...api.model_catalog import agent_model_id
from ...config import settings
from ...exceptions import ServiceError
from ...i18n import t_locale
from ...models import ModelConfig, WorkflowSpec
from ...models.unified import METRIC_SIGNATURES, run_entry_for
from ..language_models import (
    apply_model_reasoning_config,
    apply_reasoning_effort,
    build_language_model,
    served_model_from,
)
from ..react_compat import native_tool_calling_active
from ..safe_exec import validate_metric_code, validate_signature_code
from .acting_react import ActingReActV2
from .answer_options import normalize_options
from .conduct import with_conduct
from .constants import REASONING_FIELD
from .parse_salvage import strip_adapter_debris
from .steering import SteerInbox, attach_steering, get_steer_store

logger = logging.getLogger(__name__)

# ReActV2 termination reasons that mean the agent actually answered.
_ANSWERED_TERMINATIONS = frozenset({"submit", "forced_submit"})


# A seed lane's provider stream keeps sending reasoning, so the per-request
# read timeout never fires: a model that deliberates without end (a metric lane
# on GLM 5.3 Flash thought 460 s and never wrote code) would hold the turn open
# forever. Each lane gets a wall-clock deadline and a tighter completion budget
# than the chat agent, which rewrites whole artifacts and needs the headroom.
SEED_LANE_TIMEOUT_SECONDS = 120.0
SEED_MAX_TOKENS = 16000


class AgentStoppedError(RuntimeError):
    """The agent loop ended without calling ``submit`` and without a reply."""


class SeedLaneTimeoutError(RuntimeError):
    """A seed lane ran past its deadline without finishing its artifact."""


def _require_answer(prediction: dspy.Prediction | None, reply_text: str) -> None:
    """Fail a turn that ended without the agent ever answering.

    A reasoning model that spends its whole output budget thinking returns no
    tool call; ReActV2 then breaks out of the loop and its forced ``submit``
    can come back empty too. Reporting that as a finished turn shows the user
    a bare "Done." while nothing they asked for happened.

    Args:
        prediction: The loop's final prediction; ``None`` when none arrived.
        reply_text: The reply streamed or carried by the final prediction.

    Raises:
        AgentStoppedError: When the reply is empty and the loop did not end
            on a ``submit`` call.
    """
    if reply_text.strip():
        return
    reason = getattr(prediction, "termination_reason", None) if prediction is not None else "no_prediction"
    if reason in _ANSWERED_TERMINATIONS:
        return
    logger.warning("code agent stopped without answering: termination_reason=%s", reason)
    raise AgentStoppedError(
        "The model stopped before it answered, usually because it ran out of room while thinking. "
        "Check the editor, then send your message again or pick a different model."
    )


def _format_agent_error(exc: BaseException) -> str:
    """Produce a short, user-facing message from an agent failure.

    Walks through ``BaseExceptionGroup`` to the first leaf exception so
    structured-concurrency groups resolve to their underlying cause.
    Network-level failures are rewritten to a friendlier message.

    Args:
        exc: The exception (possibly a ``BaseExceptionGroup``) raised by the agent.

    Returns:
        A short string suitable for surfacing to the end user.
    """
    leaf = exc
    while isinstance(leaf, BaseExceptionGroup) and leaf.exceptions:
        leaf = leaf.exceptions[0]
    text = str(leaf).strip()
    name = type(leaf).__name__
    if not text:
        return name or "code agent failed"
    if isinstance(leaf, (AgentStoppedError, SeedLaneTimeoutError)):
        return text
    if "Cannot connect to host" in text or "nodename nor servname" in text:
        return "Can't reach the model provider. Check your network and try again."
    return f"{name}: {text}" if name not in text else text


# Provider phrasings for a prompt that overflowed the model's context window;
# matched case-insensitively across the exception chain because the overflow
# often surfaces as a plain provider 400 rather than litellm's typed error.
_CONTEXT_OVERFLOW_PATTERNS = (
    "context window",
    "context length",
    "context_length_exceeded",
    "prompt is too long",
    "input is too long",
    "too many tokens",
    "maximum prompt length",
)


def _agent_error_payload(exc: BaseException) -> dict[str, str]:
    """Build the ``error`` SSE event data for an agent failure.

    Alongside the human-readable text, attaches a stable machine ``code`` the
    frontend maps to a localized message. Currently classified:
    ``context_too_long`` — the turn overflowed the model's context window
    (litellm's ``ContextWindowExceededError`` or an equivalent provider
    message anywhere in the exception chain).

    Args:
        exc: The exception (possibly a ``BaseExceptionGroup``) raised by the agent.

    Returns:
        Event data with ``error`` text and, when classified, a ``code``.
    """
    payload = {"error": _format_agent_error(exc)}
    seen: set[int] = set()
    stack: list[BaseException] = [exc]
    while stack:
        leaf = stack.pop()
        if id(leaf) in seen:
            continue
        seen.add(id(leaf))
        text = str(leaf).lower()
        if type(leaf).__name__ == "ContextWindowExceededError" or any(
            pattern in text for pattern in _CONTEXT_OVERFLOW_PATTERNS
        ):
            payload["code"] = "context_too_long"
            break
        if isinstance(leaf, BaseExceptionGroup):
            stack.extend(leaf.exceptions)
        stack.extend(linked for linked in (leaf.__cause__, leaf.__context__) if linked is not None)
    return payload


def _validate_signature_code(code: str) -> str:
    """Smoke-test a signature snippet.

    Args:
        code: User-authored signature source code.

    Returns:
        An empty string when the snippet validates, otherwise a short error message.
    """
    try:
        validate_signature_code(code)
    except ServiceError as exc:
        return str(exc)
    except Exception as exc:
        return f"signature error: {exc}"
    return ""


def _validate_metric_code(code: str) -> str:
    """Smoke-test a metric snippet.

    Args:
        code: User-authored metric source code.

    Returns:
        An empty string when the snippet validates, otherwise a short error message.
    """
    try:
        validate_metric_code(code)
    except ServiceError as exc:
        return str(exc)
    except Exception as exc:
        return f"metric error: {exc}"
    return ""


# Function name, minimum positional-capable parameters and maximum required
# ones per metric shape. These match the validity check's ``_METRIC_SLOTS``
# (contract.py): a draft this accepts must not fail the check before Run.
_METRIC_SIGNATURES: dict[str, tuple[str, int, int, str]] = {
    "dspy_feedback": ("metric", 5, 5, METRIC_SIGNATURES["dspy_feedback"]),
    "dspy_scalar": ("metric", 3, 3, METRIC_SIGNATURES["dspy_scalar"]),
    "blackbox_side_info": ("score", 2, 2, METRIC_SIGNATURES["blackbox_side_info"]),
}


def _parse_functions(code: str, label: str) -> tuple[dict[str, ast.FunctionDef], str, set[str]]:
    """Parse ``code`` and index its top-level functions and imported modules.

    Args:
        code: Python source to inspect.
        label: Artifact name prefixed to error messages (``"run"`` or ``"metric"``).

    Returns:
        ``(functions, error, imported)`` — top-level functions by name, a short
        error message (empty when the source parses) and the root names of
        every imported module.
    """
    if not code.strip():
        return {}, f"{label} error: the code is empty.", set()
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return {}, f"{label} error: {exc.msg} (line {exc.lineno}).", set()
    functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    return functions, "", imported


def _positional_capacity(fn: ast.FunctionDef) -> tuple[int, int, bool]:
    """Count how many positional arguments ``fn`` accepts and requires.

    Args:
        fn: The parsed function definition.

    Returns:
        ``(accepted, required, variadic)``.
    """
    positional = [*fn.args.posonlyargs, *fn.args.args]
    return len(positional), len(positional) - len(fn.args.defaults), fn.args.vararg is not None


def _validate_run_code(code: str, artifact_kind: str) -> str:
    """Statically check the wizard's run code against the workspace contract.

    The sandboxed contract check executes it; here a syntax error or a
    missing / mis-shaped entrypoint is caught before the code lands in the
    editor, without executing model-written code in the API process.

    Args:
        code: Run-code source.
        artifact_kind: The artifact kind; ``dspy_program`` needs
            ``build_program()``, every other kind ``run(artifact, input)``.

    Returns:
        An empty string when the code fits the contract, otherwise a short error message.
    """
    functions, error, _ = _parse_functions(code, "run")
    if error:
        return error
    if artifact_kind == "dspy_program":
        fn = functions.get("build_program")
        if fn is None:
            return "run error: define def build_program() returning the dspy.Module."
        required_kwonly = [d for d in fn.args.kw_defaults if d is None]
        if _positional_capacity(fn)[1] > 0 or required_kwonly:
            return "run error: build_program() must take no arguments."
        return ""
    fn = functions.get("run")
    if fn is None:
        return "run error: define def run(artifact, input)."
    accepted, required, variadic = _positional_capacity(fn)
    if (accepted < 2 and not variadic) or required > 2:
        return "run error: run must take exactly (artifact, input)."
    return ""


def _validate_unified_metric_code(code: str, metric_shape: str, metric_has_model: bool) -> str:
    """Statically check the wizard's metric against the shape its optimizer needs.

    Args:
        code: Metric source.
        metric_shape: ``dspy_feedback``, ``dspy_scalar`` or ``blackbox_side_info``.
        metric_has_model: Whether a metric model is attached; without one the
            ``skynet`` helper does not exist in the metric's process.

    Returns:
        An empty string when the code fits the shape, otherwise a short error message.
    """
    functions, error, imported = _parse_functions(code, "metric")
    if error:
        return error
    name, minimum, most_required, shape_text = _METRIC_SIGNATURES.get(
        metric_shape, _METRIC_SIGNATURES["blackbox_side_info"]
    )
    fn = functions.get(name)
    if fn is None:
        return f"metric error: define {shape_text}."
    accepted, required, variadic = _positional_capacity(fn)
    if (accepted < minimum and not variadic) or required > most_required:
        return f"metric error: the signature must be {shape_text}."
    if "skynet" in imported and not metric_has_model:
        return "metric error: no metric model is attached, so `from skynet import llm` is unavailable."
    return ""


def _strip_json_fences(text: str) -> str:
    """Remove a wrapping markdown code fence from model-emitted JSON, if present.

    Args:
        text: Raw model output that should be a JSON object.

    Returns:
        The inner JSON text with any ```json fence removed.
    """
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
        if stripped.rstrip().endswith("```"):
            stripped = stripped.rstrip()[:-3]
    return stripped.strip()


def _validate_workflow_dict(spec_dict: dict) -> str:
    """Validate a workflow spec dict structurally plus per-node signature code.

    Runs the same exec-free ``WorkflowSpec`` pass submit runs, then
    smoke-tests every signature node's code in the safe-exec subprocess
    (memoized, so repeated checks of unchanged nodes are free).

    Args:
        spec_dict: The candidate workflow graph as a plain dict.

    Returns:
        An empty string when the graph validates, otherwise a short error
        message naming the offending node where possible.
    """
    try:
        spec = WorkflowSpec.model_validate(spec_dict)
    except ValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        return str(first.get("msg", exc)).removeprefix("Value error, ")
    for node in spec.nodes:
        if node.kind == "signature":
            err = _validate_signature_code(node.signature_code)
            if err:
                return f"Node '{node.id}': {err}"
    return ""


def _parse_workflow_json(text: str) -> tuple[dict | None, str]:
    """Parse model-emitted workflow JSON into a dict.

    Args:
        text: Raw model output expected to contain the graph JSON.

    Returns:
        ``(spec_dict, "")`` on success or ``(None, error)`` when the text is
        not a JSON object.
    """
    try:
        parsed = json.loads(_strip_json_fences(text))
    except (json.JSONDecodeError, ValueError) as exc:
        return None, f"workflow JSON does not parse: {exc}"
    if not isinstance(parsed, dict):
        return None, "workflow JSON must be a single object with 'nodes' and 'edges'."
    return parsed, ""


class GenerateMetricCode(dspy.Signature):
    """Write a GEPA-ready metric function that scores predictions AND
    returns rich, actionable feedback for the reflective optimizer.

    ## Why feedback matters

    GEPA is a reflective prompt optimizer: on every rollout it reads the
    ``feedback`` string to decide how to mutate the signature's prompt.
    A scalar score alone gives GEPA nothing to reason about; a rich
    feedback string turns each failure into a diagnosis and lets GEPA
    converge in far fewer rollouts. Write feedback the way you would
    brief a teammate debugging the model: concrete, grounded, and
    actionable.

    ## Required shape

    Exact signature:

        ``def metric(gold, pred, trace=None, pred_name=None,
                     pred_trace=None) -> dspy.Prediction``

    Always return ``dspy.Prediction(score=float, feedback=str)`` — never
    a bare float. Never raise. Handle ``pred_name is None`` (top-level
    eval) the SAME as a named predictor — always return both score and
    feedback. On malformed input return
    ``dspy.Prediction(score=0.0, feedback="expected <what>, got
    <raw!r>")``.

    ## Reading gold and pred

    ``gold`` is a ``dspy.Example`` and ``pred`` is a ``dspy.Prediction``.
    Read BOTH by plain dot access:

    * ``gold.<output_column>`` for each ground-truth value — the
      attribute name is the ``output`` column name verbatim.
    * ``pred.<output_field>`` for each predicted value — the field name
      matches the same ``output`` column.

    This is DSPy's canonical idiom
    (e.g. ``gold.answer.lower() == pred.answer.lower()``).

    NEVER write ``isinstance(gold, dict)`` (or ``isinstance(pred, dict)``).
    A ``dspy.Example`` is NOT a ``dict`` subclass, so such a check is
    always False and silently zeroes the metric. Do NOT branch on the
    type of ``gold``/``pred`` and do NOT use a
    ``getattr(...) or gold.get(...)`` chain — just dot access. Missing
    or malformed values are handled by the ``try/except`` below
    (return ``dspy.Prediction(score=0.0, feedback=...)``), never by
    type checks.

    ## Comparison logic (pick per-field from the samples)

    * **Strings** — normalize with ``str(x).strip().lower()`` then
      exact match.
    * **Integers** — parse both sides to ``int``; compare.
    * **Floats** — parse + compare with a small tolerance
      (``abs(a - b) <= 1e-3`` or ``1e-6 * max(1, abs(a))``).
    * **Booleans** — coerce yes/no/true/false/1/0 consistently.
    * **Lists / sets** — Jaccard overlap; enumerate matched /
      missing / extra in the feedback.
    * **Structured JSON** — parse and compare field-by-field.

    If the signature has MULTIPLE output fields, compute a per-field
    sub-score, average into the final score, log each sub-score via
    ``log_metrics`` (below), AND include every field's verdict in the
    feedback so GEPA sees which component failed.

    ## Named component scores — log_metrics

    A global ``log_metrics(**scores)`` is available inside the metric
    (no import needed). It reports the components hiding behind the
    single scalar — each name is averaged across the test set and shown
    on the run result next to the overall score:

        ``log_metrics(precision=p, recall=r, f1=f1)``

    * Log whenever the scalar is a composite: precision / recall / F1
      for classification, per-field sub-scores on multi-output
      signatures, partial-credit components.
    * Use a FIXED, small set of snake_case names (at most 20 distinct
      names); values must be finite numbers. Never derive a name from
      example content.
    * ``log_metrics`` only reports — it never changes the score you
      return.

    ## Keep it concise

    Write the SMALLEST metric that does the job: one clear comparison
    per output field plus the feedback string. Do NOT emit speculative
    prefix-stripping, regex "variation" tables, synonym maps, or dead
    branches unless the sample rows clearly demand them — that is the
    comparison logic for the data you actually see, nothing more. Aim
    for tight, readable code (a single-field metric is typically a dozen
    lines, not sixty of scaffolding).

    ## Feedback content — the core of a good GEPA metric

    Every feedback string must tell the reflection model three things:

    1. **Ground truth** — show the gold value: ``f"expected
       {gold_value!r}"``.
    2. **Prediction** — show what the model produced: ``f"got
       {pred_value!r}"``.
    3. **Diagnosis + fix on failure** — name WHY it failed (format
       mismatch, wrong label, off by N, missing items, extra items,
       wrong case, extra punctuation) and WHAT the output should look
       like instead. For multi-field tasks, list the verdict for each
       field so GEPA knows which predictor to patch.

    Do NOT emit only "correct" / "incorrect" — the score already says
    that. The feedback is the LLM's side of the conversation with the
    optimizer.

    ## Feedback shape (copy the structure, not the words)

        correct:  "Correct — {field} = {gold_v!r} matches (compared
                   {how})."
        wrong:    "Incorrect: {field} got {pred_v!r}, expected
                   {gold_v!r}. {why}. Output should be {format_hint}."
        parse:    "Parse failed: expected {format}, got {raw!r}.
                   {how_to_format}."
        partial:  "Partial: {field} {k}/{n} — matched
                   {overlap}, missing {missing}, extra {extra}.
                   Return items as {format_hint}."

    ## Hard rules

    * Self-contained, importable at module scope.
    * Allowed imports: ``dspy`` and common stdlib modules (``re``,
      ``json``, ``math``, ``difflib``, ``typing``). No third-party
      packages.
    * Never raise. Wrap every parse / lookup / comparison in
      ``try/except`` and return a diagnostic
      ``dspy.Prediction(score=0.0, feedback=...)`` instead.
    * No markdown fences, no prose outside the function body.
    """

    dataset_columns: list[str] = dspy.InputField(desc="Every column name in the dataset.")
    column_roles: str = dspy.InputField(
        desc="JSON object mapping column name → 'input' | 'output' | 'ignore'.",
    )
    column_kinds: str = dspy.InputField(
        desc=(
            "JSON object mapping input-column name → 'text' | 'image'. "
            "Image inputs are ``dspy.Image`` instances at runtime — never "
            "compare them as strings in your metric."
        ),
    )
    sample_rows: str = dspy.InputField(
        desc=(
            "JSON array of up to 5 representative rows — read them "
            "carefully to pick the right comparison per output column "
            "(string normalize, numeric tolerance, list overlap, ...). "
            "Image cells appear as URLs or base64 data URIs."
        ),
    )
    authoring_brief: str = dspy.InputField(
        desc=(
            "Directives distilled from an interview with the dataset owner. "
            "Every directive about scoring, strictness or feedback MUST be "
            "honored; empty when no interview happened."
        ),
    )

    metric_code: str = dspy.OutputField(
        desc=(
            "Complete ``def metric(gold, pred, trace=None, "
            "pred_name=None, pred_trace=None):`` Python code that "
            "returns ``dspy.Prediction(score=float, feedback=str)``. "
            "Feedback must name the gold value, the prediction, and a "
            "concrete diagnosis + fix on failure — no bare 'correct' / "
            "'incorrect'. Never raises. No markdown fences, no "
            "surrounding prose."
        ),
    )


_LOCALE_LANGUAGE_NAMES = {
    "ar": "Arabic",
    "de": "German",
    "en": "English",
    "es": "Spanish",
    "fa": "Persian",
    "fr": "French",
    "he": "Hebrew",
    "hi": "Hindi",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "pt": "Portuguese",
    "ru": "Russian",
    "tr": "Turkish",
    "uk": "Ukrainian",
    "yue": "Cantonese",
    "zh": "Chinese",
}


def _reply_language(locale: str | None) -> str:
    """Resolve a UI locale code to the language name the agent replies in.

    Args:
        locale: UI locale code sent by the client (e.g. ``he``, ``en-GB``,
            ``zh-Hans``), or None when the client sent none.

    Returns:
        An English language name (e.g. ``"Hebrew"``). Unknown or missing
        locales fall back to Hebrew, the product's base language.
    """
    primary = (locale or "").split("-", 1)[0].strip().lower()
    return _LOCALE_LANGUAGE_NAMES.get(primary, "Hebrew")


_WORKFLOW_JSON_SCHEMA_DOC = """
    The workflow JSON has this exact shape:

    {"nodes": [...], "edges": [...]}

    Node kinds (discriminated by "kind"):
    * {"id": "input", "kind": "input", "fields": [{"name": "<field>"}]}
      — EXACTLY ONE. Its fields are the dataset's input columns.
    * {"id": "output", "kind": "output", "fields": [{"name": "<field>"}]}
      — EXACTLY ONE. Its fields are the dataset's output columns.
    * {"id": "<id>", "kind": "signature", "module_name": "predict"|"cot",
       "signature_code": "<full dspy.Signature class source>"}
      — an LLM step. The class's InputField/OutputField names are its ports.
    * {"id": "<id>", "kind": "transform", "transform_code":
       "def transform(<inputs>): return {<outputs>}",
       "input_fields": [{"name": ...}], "output_fields": [{"name": ...}]}
      — a pure-Python reshaping step. The function's parameter names MUST
      equal input_fields exactly; it must return a dict with exactly the
      output_fields keys.

    Edges: {"source": "<node id>", "source_port": "<output field>",
            "target": "<node id>", "target_port": "<input field>"}.

    Hard rules:
    * Node ids and field names: Python identifiers (letters/digits/_).
    * Every input port of every node must be fed by exactly one edge.
    * Every output-anchor field must be fed.
    * The graph must be acyclic and every node on a path input → output.
    * NEVER emit "mcp" tool nodes — the user wires tools manually.
    * Only ``dspy`` is importable inside signature_code / transform_code.
"""


class GenerateWorkflowGraph(dspy.Signature):
    """Design a multi-step DSPy workflow graph for the dataset's task.

    Decide the pipeline shape from the data: a single signature node is
    correct for simple input→output tasks; use two or three signature
    steps (draft → refine, extract → compose, ...) only when decomposition
    plausibly improves quality; add a transform node only when outputs
    genuinely need Python reshaping between steps. Prefer the simplest
    graph that fits the task — never pad the graph to look sophisticated.

    Every signature node's code follows the same craft rules as a
    standalone Signature: the class docstring is the step's task
    instruction, ``desc=`` on each field is that field's hint, and the
    final step's OutputFields must produce the dataset's output columns
    with EXACTLY those (sanitized) names.
    """

    __doc__ = (__doc__ or "") + _WORKFLOW_JSON_SCHEMA_DOC

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
    authoring_brief: str = dspy.InputField(
        desc=(
            "Directives distilled from an interview with the dataset owner. "
            "Every directive MUST be honored across the graph's steps; "
            "empty when no interview happened."
        ),
    )

    workflow_json: str = dspy.OutputField(
        desc=(
            "The complete workflow graph as a single JSON object "
            '({"nodes": [...], "edges": [...]}). RAW JSON only — no '
            "markdown fences, no commentary."
        ),
    )


class GenerateWorkflowSeedMessage(dspy.Signature):
    """Write a short chat reply describing the drafted workflow.

    Respond in one to three short, friendly sentences — written in the
    language named by ``reply_language`` — explaining the pipeline that
    was just drafted: name what each step does and what the Metric scores,
    grounded in the actual graph. No code, no markdown. Keep the terms
    ``Signature``, ``Metric`` and ``Workflow`` in English (product terms);
    everything else must be in the reply language.
    """

    workflow_json: str = dspy.InputField(desc="The workflow graph JSON just produced.")
    metric_code: str = dspy.InputField(desc="The metric code just produced.")
    reply_language: str = dspy.InputField(
        desc="Language to write the reply in (the product UI language).",
    )

    assistant_message: str = dspy.OutputField(
        desc=(
            "One to three short sentences for the user, written in "
            "reply_language. No code, no markdown; only the product terms "
            "Signature, Metric and Workflow stay in English."
        ),
    )


class FixWorkflowGraph(dspy.Signature):
    """Repair a workflow graph JSON that failed validation.

    You are given a workflow graph that does NOT pass validation, together
    with the exact validator error. Return the corrected full JSON with the
    SAME intent — make the smallest change that resolves the error (fix an
    id, add a missing edge, rename a port, fix a signature class). Output
    ONLY the raw JSON: no markdown fences, no commentary.
    """

    __doc__ = (__doc__ or "") + _WORKFLOW_JSON_SCHEMA_DOC

    broken_workflow_json: str = dspy.InputField(desc="The current graph JSON that failed validation.")
    validation_error: str = dspy.InputField(desc="The validator's error message to resolve.")
    dataset_columns: list[str] = dspy.InputField(desc="Every column name in the dataset.")
    column_roles: str = dspy.InputField(
        desc="JSON object mapping column name → 'input' | 'output' | 'ignore'.",
    )

    fixed_workflow_json: str = dspy.OutputField(
        desc="The corrected full workflow JSON. No markdown fences, no prose.",
    )


class FixCodeArtifact(dspy.Signature):
    """Repair a code artifact that failed validation.

    You are given a Signature class, a metric function or a black-box
    wizard run code / metric that does NOT pass
    validation, together with the exact validator error. Return the
    corrected full source with the SAME intent — make the smallest change
    that resolves the error (e.g. delete a stray brace, fix an identifier,
    correct the function arity). Preserve the docstring, field names, and
    semantics; only fix what the error points at. Output ONLY the code: no
    markdown fences, no commentary, no surrounding prose.
    """

    artifact_kind: str = dspy.InputField(desc="'signature', 'metric' or 'run'.")
    broken_code: str = dspy.InputField(desc="The current source that failed validation.")
    validation_error: str = dspy.InputField(desc="The validator's error message to resolve.")
    dataset_columns: list[str] = dspy.InputField(desc="Every column name in the dataset.")
    column_roles: str = dspy.InputField(
        desc="JSON object mapping column name → 'input' | 'output' | 'ignore'.",
    )

    fixed_code: str = dspy.OutputField(
        desc=("The corrected full source for the artifact. No markdown fences, no prose — just the Python code."),
    )


class CodeAssistant(dspy.Signature):
    __doc__ = with_conduct("""Chat assistant attached to a DSPy Signature + metric-function editor.

    ## Your tools

    * ``edit_signature(reason, new_code)`` — REWRITES the Signature class.
    * ``edit_metric(reason, new_code)`` — REWRITES the metric function.
    * ``finish`` — end the turn and answer in ``reply``.

    ## Rule 1: Default to ``finish``. Editing is the exception.

    Call ``edit_signature`` or ``edit_metric`` ONLY when the user's latest
    message is a direct instruction to CHANGE, MODIFY, REPLACE, ADD,
    REMOVE, FIX, or REWRITE code in that artifact.

    For EVERYTHING ELSE — questions, explanations, "how does X work",
    confirmations, clarifications, opinions, critique, small talk — answer
    in ``reply`` (after any ``set_brief``, reads or ``ask_user`` the turn
    needs). Never edit code just
    to "satisfy" a question.

    If the user says "don't change the code" (or any variant), you MUST
    call ``finish`` and answer in ``reply`` only.

    ## Rule 1a: Revert requests use ``initial_signature`` / ``initial_metric``.

    If the user asks to REVERT, UNDO, RESTORE, or go back to the ORIGINAL
    (any language), call the appropriate ``edit_*`` tool with new_code set
    VERBATIM to ``initial_signature`` or ``initial_metric`` — those fields
    hold the actual pre-edit code. NEVER guess what the original was from
    the chat history, and NEVER claim "already reverted" without checking
    whether ``current_*`` differs from ``initial_*``. If they are identical,
    call ``finish`` and say so; if they differ, the user genuinely wants a
    revert — perform it.

    ## Rule 2: Ground every reply in the actual code.

    When explaining or answering, READ ``current_signature`` and
    ``current_metric`` line by line, then reference what you see:
    * Name the fields by their Python identifier.
    * Quote the exact comparison the metric performs
      (e.g. "it does ``str(pred.label).strip().lower() == str(gold.label)...``").
    * State the concrete score values (e.g. "returns 1.0 on match, 0.0
      otherwise") and the feedback strings.

    Do NOT answer abstractly ("it rewards correct matches", "it finds
    patterns in your data"). Do NOT re-describe the overall system. Only
    describe what the code literally does.

    ## Examples

    * user: "how does the metric work?"
      → call ``finish``; reply names the fields, quotes the comparison,
        and states the return values.
    * user: "what does the Signature do?"
      → call ``finish``; reply lists the InputFields and OutputFields by
        name and their types.
    * user: "don't change any code, just explain"
      → call ``finish``; reply is an explanation only, no edits.
    * user: "make the metric case-sensitive"
      → call ``edit_metric`` with the full new function.
    * user: "add an 'explanation' OutputField"
      → call ``edit_signature`` with the full new class.

    ## Reply format

    Write the reply in the language named by ``reply_language`` — that is
    the product's configured UI language. Switch to the user's language
    ONLY if their latest message is clearly in another language. Keep
    product terms like ``Signature``, ``Metric``, ``InputField``,
    ``OutputField`` in English; the prose around them follows the reply
    language. Plain prose. No markdown headings, no bullet lists, no code
    fences. 2-5 sentences for explanations, 1-2 for confirmations.

    When you DO edit, pass the COMPLETE replacement file body — not a
    diff, not markdown fences. Only ``dspy`` is importable.
    """)

    dataset_columns: list[str] = dspy.InputField(desc="Every column name in the dataset.")
    column_roles: str = dspy.InputField(
        desc="JSON object mapping column name → 'input' | 'output' | 'ignore'.",
    )
    column_kinds: str = dspy.InputField(
        desc=(
            "JSON object mapping input-column name → 'text' | 'image'. "
            "Image columns are typed ``dspy.Image`` in the Signature; "
            "reference this when explaining why a field is typed that way."
        ),
    )
    sample_rows: str = dspy.InputField(
        desc="JSON array of up to 5 representative rows from the dataset.",
    )
    current_signature: str = dspy.InputField(
        desc=("The Signature class currently shown in the editor. Reference its fields by name in your reply."),
    )
    current_metric: str = dspy.InputField(
        desc=(
            "The metric function currently shown in the editor. Quote its comparison and return values in your reply."
        ),
    )
    current_signature_validation: str = dspy.InputField(
        desc=(
            "Latest validator output for current_signature. 'OK' means the "
            "code parsed and the signature class loaded. Non-empty 'errors: "
            "...' text means the code is broken — if you edit_signature, you "
            "MUST fix those errors in new_code."
        ),
    )
    current_metric_validation: str = dspy.InputField(
        desc=("Latest validator output for current_metric. Same rules as current_signature_validation."),
    )
    initial_signature: str = dspy.InputField(
        desc=(
            "The ORIGINAL signature code, before any edits in this "
            "conversation. May equal current_signature when nothing has been "
            "changed yet. Use this as the new_code for edit_signature when "
            "the user asks to REVERT, undo, or restore the original — do NOT "
            "confabulate what the original looked like."
        ),
    )
    initial_metric: str = dspy.InputField(
        desc=(
            "The ORIGINAL metric code, before any edits in this conversation. "
            "Same semantics as initial_signature: use it verbatim as new_code "
            "when the user asks to revert the metric."
        ),
    )
    chat_history: str = dspy.InputField(
        desc="Prior conversation turns as a JSON list of {role, content} objects.",
    )
    reply_language: str = dspy.InputField(
        desc=(
            "Language for user-facing prose (the product UI language). "
            "Both ``reply`` and every tool ``reason`` are written in it."
        ),
    )
    user_message: str = dspy.InputField(desc="The user's latest message.")

    reply: str = dspy.OutputField(
        desc=(
            "Reply to the user. For questions/explanations, ground it in "
            "the literal current_signature / current_metric code — name "
            "the fields and quote the comparison. 2-5 sentences. For "
            "edit confirmations, 1-2 sentences. Written in reply_language; "
            "mirror the user's language only if their message is clearly "
            "in another language. Keep product terms (Signature, Metric, "
            "InputField, OutputField, Python identifiers) in English. "
            "Plain prose, no markdown, no code fences."
        ),
    )


_DELIVERABLES = """You write exactly two things, and the user can edit either: the run code and the metric. This holds for every artifact, a DSPy program included. The run code turns one case input into an output; the metric scores that output. Before Run, the validity check confirms they and the data agree: the run code's entry point must exist, it must take the starting version and each sample case input to an output, and the metric must have the exact shape the metric contract states and score that output without an error. Write both so that check passes."""

_RUN_CONTRACT = """The run code is plain python that turns one case input into an output; the optimizer swaps in new versions of the artifact and the metric scores the output.
- Entry point: {entry}
- dspy, gepa and the standard library are installed; nothing else. No network of your own; temp files and subprocesses are fine.
- Let errors raise: the harness reports them to the user. Do not return a fake output on failure.
- Read input fields by their exact names; never invent fields."""

_RUN_ENTRY = (
    f"define {run_entry_for('prompt')}: "
    """artifact is the version under optimization (a str, or a dict of name -> text when the starting version is a mapping), exactly as the optimizer proposes it; input is one case input, a dict keyed by the input fields. Return the output: a str, or any JSON-serializable value the metric reads.
- The task model comes from the skynet module: `from skynet import llm` (never define your own). llm(prompt, input=None, images=None) -> str; llm(artifact, input["<input field>"]) runs the artifact as the system message with that field as the user message and returns the reply; that is how a prompt is exercised. llm() caps the reply length itself (the task model's max tokens, or a default), so never pass a token limit. images= attaches PNG/JPEG bytes, file paths or data: URLs.
- Per artifact kind: a prompt is exercised with llm(artifact, ...); code is python source to load with exec into a fresh dict namespace (or write to a temp file and run with subprocess and a timeout) and call on the input; text is used as written (return it, or apply it with llm when the objective is about what the text makes a model do)."""
)

# A DSPy optimizer tunes the module's predictors itself, so the engine needs
# the module rather than a call; build_program() is that run code's entry
# point, not a separate deliverable.
_DSPY_ENTRY = (
    """the artifact is a DSPy program, and the DSPy optimizer tunes its predictors itself, so the run code hands over the module instead of calling it: define """
    + run_entry_for("dspy_program")
    + """ taking no arguments and returning a dspy.Module. `import dspy` at the top; define the dspy.Signature classes and the module it uses inside the run code.
- The harness applies the version under optimization, a dict mapping each predictor name (as program.named_predictors() reports it) to its instruction text, configures the task model as the dspy LM and calls program(**input) with the input fields as keyword arguments; the output is the dspy.Prediction it returns. Never call dspy.configure, create a dspy.LM or set instructions yourself.
- Name the predictors so they match the keys of the starting version; the module's forward takes exactly the input fields as keyword arguments and returns a dspy.Prediction with the output fields the metric reads.
- Name the signature's input fields exactly as the case input fields. gold holds the case's expected fields under their own names (a single expected value is gold.expected), so name the output fields so the metric can compare pred.<field> with the matching gold field."""
)

_METRIC_SHAPES = {
    "dspy_feedback": """The metric feeds a DSPy GEPA optimizer, so it returns a score AND feedback text.
- Define """
    + METRIC_SIGNATURES["dspy_feedback"]
    + """ with all five parameters.
- gold is a dspy.Example holding the case input fields and the expected output fields (read them as gold.<field>); pred is the dspy.Prediction the program returned (pred.<output field>).
- Return dspy.Prediction(score=float, feedback=str): score higher is better, 0.0 to 1.0 by convention; feedback says WHY, naming the expected value or the failed check, because the optimizer learns from it. {"score": ..., "feedback": ...} or (score, "feedback") are accepted too.""",
    "dspy_scalar": """The metric feeds a DSPy optimizer that reads only a number.
- Define """
    + METRIC_SIGNATURES["dspy_scalar"]
    + """.
- gold is a dspy.Example holding the case input fields and the expected output fields (read them as gold.<field>); pred is the dspy.Prediction the program returned (pred.<output field>).
- Return a float (higher is better, 0.0 to 1.0 by convention) or a bool. No feedback is read.""",
    "blackbox_side_info": """The metric feeds a black-box optimizer that reads a score and side info.
- Define """
    + METRIC_SIGNATURES["blackbox_side_info"]
    + """.
- input is the case input dict (keyed by the input fields), output is what run returned for it, expected is the case's expected output as a dict keyed by the expected field (read expected["<field>"]; None when the case has none). Declare expected only when you use it.
- Return (score, side_info): score is a float, higher is better, 0.0 to 1.0 by convention; side_info is a dict with "feedback": str saying WHY the output scored that, naming the expected value or the failed check. When several things are measured, add "scores": {"<name>": float, ...}, one entry per thing; the top-level score is then their (weighted) combination.""",
}

_METRIC_COMMON = """- Never raise: catch failures and return the lowest score with the error in the feedback.
- Standard library (and dspy for the DSPy shapes) only; no network of your own.
- The metric's source is never shown to the optimizer: it learns only from the scores and feedback, so put everything a better version needs to know into the feedback."""

_METRIC_LLM = """A metric model is attached: `from skynet import llm` calls it. llm(prompt) -> str asks a free-form question, e.g. to grade the output against a rubric: parse the reply defensively (look for a number or a verdict word, default to the lowest score). Prefer deterministic checks where they suffice."""

_METRIC_NO_LLM = """No metric model is attached, so the metric has NO llm helper: never import skynet or call llm(). Score with deterministic checks (exact match, contains, numeric tolerance, JSON fields, structure, length, similarity to the expected value)."""


def _unified_contracts(unified: dict[str, Any]) -> tuple[str, str]:
    """Spell out the exact run-code and metric contracts for a wizard setup.

    Args:
        unified: The wizard's :class:`~core.models.UnifiedAuthoringContext` as a dict.

    Returns:
        ``(run_contract, metric_contract)`` texts handed to the authors and the
        chat agent. Every artifact gets the same contract: run code plus a
        metric. Only the run code's entry point follows the artifact kind,
        because a DSPy optimizer needs the module itself.
    """
    kind = str(unified.get("task", {}).get("artifact", {}).get("kind", "prompt"))
    entry = _DSPY_ENTRY if kind == "dspy_program" else _RUN_ENTRY
    run_contract = f"{_DELIVERABLES}\n\n{_RUN_CONTRACT.format(entry=entry)}"
    shape = str(unified.get("metric_shape", "blackbox_side_info"))
    metric_contract = "\n\n".join(
        [
            _METRIC_SHAPES.get(shape, _METRIC_SHAPES["blackbox_side_info"]),
            _METRIC_COMMON,
            _METRIC_LLM if unified.get("metric_has_model") else _METRIC_NO_LLM,
        ]
    )
    return run_contract, metric_contract


class GenerateRunCode(dspy.Signature):
    """Write the run code of an optimization job: how one case input becomes an output.

    The optimizer improves an artifact (``artifact_kind``) toward
    ``objective``; the run code is the fixed harness that exercises the
    current version of that artifact on one case, the same for every
    artifact kind. Implement it under ``run_contract``: that contract is
    exact, and the validity check holds the code to it before the run
    starts, so follow it literally. Ground it in the starting version and
    the sample cases: read the input fields by their exact names and
    return what the metric needs to score. Keep it short and direct.
    Output ONLY the python code: no markdown fences, no commentary.
    """

    objective: str = dspy.InputField(desc="What a better version of the artifact achieves.")
    background: str = dspy.InputField(desc="Context, constraints and examples; may be empty.")
    artifact_kind: str = dspy.InputField(desc="prompt | code | dspy_program | text.")
    starting_version: str = dspy.InputField(desc="The artifact's starting version (JSON for a mapping).")
    case_fields: list[str] = dspy.InputField(desc="Keys of every case input dict (the input fields).")
    expected_field: str = dspy.InputField(desc="Column the expected output came from; empty when none.")
    sample_cases: str = dspy.InputField(desc="JSON array of up to 5 cases, each {input, expected}.")
    run_contract: str = dspy.InputField(desc="The exact contract the run code must satisfy; follow it literally.")
    authoring_brief: str = dspy.InputField(desc="Directives the user confirmed, one per line; may be empty.")

    run_code: str = dspy.OutputField(desc="Complete python source of the run code. No fences, no prose.")


class GenerateUnifiedMetric(dspy.Signature):
    """Write the metric of an optimization job: how good one output is.

    The optimizer keeps the versions that score higher, so the metric IS
    the objective: it must reward exactly what the user described and
    nothing else. Read the objective, the background and the sample
    cases, decide what a measurably better output looks like, then
    implement it in the exact shape ``metric_contract`` states for
    ``metric_shape`` — the function name, its parameters and its return
    value are fixed by the optimizer the user picked. Keep it short and
    simple, and decide quickly: when the expected value is a label or a
    short answer, normalize both sides (strip, lowercase) and score an
    exact match, or the expected label appearing in the output; do not
    try to parse every phrasing or anticipate every edge case, the user
    refines the metric afterwards. Use graded scores only where the
    objective is graded by nature. Read fields by their exact names.
    Output ONLY the python code: no markdown fences, no commentary.
    """

    objective: str = dspy.InputField(desc="What a better version of the artifact achieves.")
    background: str = dspy.InputField(desc="Context, constraints and examples; may be empty.")
    artifact_kind: str = dspy.InputField(desc="prompt | code | dspy_program | text.")
    case_fields: list[str] = dspy.InputField(desc="Keys of every case input dict (the input fields).")
    expected_field: str = dspy.InputField(desc="Column the expected output came from; empty when none.")
    sample_cases: str = dspy.InputField(desc="JSON array of up to 5 cases, each {input, expected}.")
    metric_shape: str = dspy.InputField(desc="dspy_feedback | dspy_scalar | blackbox_side_info.")
    metric_contract: str = dspy.InputField(desc="The exact shape the metric must have; follow it literally.")
    authoring_brief: str = dspy.InputField(desc="Directives the user confirmed, one per line; may be empty.")

    metric_code: str = dspy.OutputField(desc="Complete python source of the metric. No fences, no prose.")


class GenerateUnifiedSeedMessage(dspy.Signature):
    """Introduce the drafted run code and metric to the user.

    Both were just written from the task and the sample cases and are now
    in the editors. In 2-4 sentences say how the run code exercises the
    artifact and what the metric rewards (name the concrete checks and the
    fields it reads), then invite the user to edit either or ask for
    changes. Plain prose in ``reply_language``; keep python identifiers in
    English; no markdown, no code fences.
    """

    objective: str = dspy.InputField(desc="What a better version of the artifact achieves.")
    run_code: str = dspy.InputField(desc="The drafted run code.")
    metric_code: str = dspy.InputField(desc="The drafted metric.")
    reply_language: str = dspy.InputField(desc="Language the message is written in.")

    assistant_message: str = dspy.OutputField(desc="2-4 sentences of plain prose.")


class UnifiedAssistant(dspy.Signature):
    __doc__ = with_conduct("""Chat assistant attached to an optimization job's run-code + metric editors.

    The user is setting up an optimization run. The optimizer improves an
    artifact (``artifact_kind``, starting from ``starting_version``) toward
    ``objective``. ``current_run`` is the plain python harness that runs
    one version of the artifact on one case input; ``current_metric`` is
    the python function that scores what it returns. The optimizer never
    sees the metric's source, only its scores and feedback.

    ## What you own

    Both pieces are yours to write: the first draft comes from you, and
    after that you change them when the user asks; the user can also edit
    either directly. Every artifact, a DSPy program included, gets run
    code plus a metric under one contract; ``run_contract`` opens with
    exactly what to write.
    Before Run, a validity check confirms the code, the metric and the
    data agree; everything you write must pass it.

    ## Your tools

    * ``ask_user(question, options_json)`` — shows the user ONE question
      with clickable answers. Call ``finish`` right after it.
    * ``set_brief(objective, background)`` — writes what you learned into
      the job's Objective and Background fields.
    * ``edit_run(reason, new_code)`` — REWRITES the run code.
    * ``edit_metric(reason, new_code)`` — REWRITES the metric.
    * ``finish`` — end the turn and answer in ``reply``.

    ## Rule 0: Pull out what the user knows about judging an output.

    The optimization is only as good as the metric, so when the user's
    intent is unclear, ask ONE short, concrete question per turn, grounded
    in what you already know and never one the context answers: what
    counts as right, partly right or wrong, which numbers or limits
    matter, the edge cases. Ask through ``ask_user`` whenever a click can
    settle it: 2-4 options, each a concrete, self-contained answer with a
    one-line description (never "other"; the user can always type), then
    ``finish`` with ``reply`` holding the same question. An open question
    goes straight into ``reply``. ``focus`` says which editor the user is
    looking at ('run' or 'metric'). When an answer changes the goal, call
    ``set_brief`` with the full updated text of the field that changed.

    ## Rule 1: Edit only on request. Never edit just to answer.

    Call ``edit_run`` or ``edit_metric`` ONLY when the user's latest
    message is a direct instruction to CHANGE, MODIFY, REPLACE, ADD,
    REMOVE, FIX, or REWRITE that code, or answers a question you asked
    about how to judge outputs. For questions, explanations, opinions and
    small talk, answer in ``reply``. If the user says "don't change
    anything" (or any variant), call ``finish`` and answer only.

    ## Rule 1a: Revert requests use ``initial_run`` / ``initial_metric``.

    If the user asks to REVERT, UNDO, RESTORE, or go back to the ORIGINAL
    (any language), call the matching ``edit_*`` tool with the new code
    set VERBATIM to ``initial_run`` or ``initial_metric``. NEVER guess the
    original from the chat history.

    ## Rule 2: Ground every reply in the actual code.

    READ ``current_run`` and ``current_metric`` line by line and reference
    what you see: the checks, the fields read, the score values and the
    feedback strings. Do NOT answer abstractly.

    ## Rule 3: New code satisfies its contract literally.

    New run code follows ``run_contract``; a new metric has the exact
    function name, parameters and return value ``metric_contract`` states
    for ``metric_shape`` (the optimizer the user picked fixes that shape),
    and calls ``llm`` only when the contract says it exists. When
    ``current_validation`` reports an error and the user asks for a fix,
    fix exactly that error.

    ## Reply format

    Written in ``reply_language``; mirror the user's language only if
    their message is clearly in another language. Keep python identifiers
    and product terms in English. Plain prose, no markdown, no code
    fences. 2-5 sentences for explanations, 1-2 for edit confirmations.
    """)

    objective: str = dspy.InputField(desc="What a better version of the artifact achieves.")
    background: str = dspy.InputField(desc="Context, constraints and examples; may be empty.")
    artifact_kind: str = dspy.InputField(desc="prompt | code | dspy_program | text.")
    starting_version: str = dspy.InputField(desc="The artifact's starting version (JSON for a mapping).")
    focus: str = dspy.InputField(desc="'run' or 'metric' — the editor the user is looking at.")
    case_fields: list[str] = dspy.InputField(desc="Keys of every case input dict (the input fields).")
    expected_field: str = dspy.InputField(desc="Column the expected output came from; empty when none.")
    sample_cases: str = dspy.InputField(desc="JSON array of up to 5 cases, each {input, expected}.")
    metric_shape: str = dspy.InputField(desc="dspy_feedback | dspy_scalar | blackbox_side_info.")
    run_contract: str = dspy.InputField(desc="The exact contract any new run code must satisfy.")
    metric_contract: str = dspy.InputField(desc="The exact shape any new metric must have.")
    current_run: str = dspy.InputField(desc="The run code as currently shown in the editor.")
    current_metric: str = dspy.InputField(desc="The metric as currently shown in the editor.")
    current_validation: str = dspy.InputField(
        desc="Latest check result for the run code and metric ('OK', an error, or empty when not run).",
    )
    initial_run: str = dspy.InputField(desc="The original run code before any edits; used verbatim for reverts.")
    initial_metric: str = dspy.InputField(desc="The original metric before any edits; used verbatim for reverts.")
    chat_history: str = dspy.InputField(desc="Prior conversation turns as a JSON list of {role, content} objects.")
    reply_language: str = dspy.InputField(
        desc="Language for user-facing prose. Both ``reply`` and every tool ``reason`` are written in it.",
    )
    user_message: str = dspy.InputField(desc="The user's latest message.")

    reply: str = dspy.OutputField(
        desc=(
            "Reply to the user, grounded in the literal current_run / "
            "current_metric. Written in reply_language; plain prose, no "
            "markdown, no code fences."
        ),
    )


class WorkflowAssistant(dspy.Signature):
    __doc__ = with_conduct("""Chat assistant attached to a visual DSPy workflow-graph editor.

    The user is building a multi-step pipeline on a canvas: an input node,
    signature (LLM) steps, optional Python transform steps, optional tool
    nodes, and an output node, wired by edges. One end-to-end Metric
    scores the final output.

    ## Your tools

    * ``add_node(reason, node_json)`` — add a signature/transform node.
    * ``update_node(reason, node_id, node_json)`` — replace a node's spec
      (same id, same kind; anchors may only change their fields).
    * ``remove_node(reason, node_id)`` — delete a non-anchor node and its edges.
    * ``connect(reason, source, source_port, target, target_port)`` — add an edge.
    * ``disconnect(reason, source, source_port, target, target_port)`` — remove an edge.
    * ``edit_metric(reason, new_code)`` — REWRITE the end-to-end metric.
    * ``finish`` — end the turn and answer in ``reply``.

    ## Rule 1: Default to ``finish``. Editing is the exception.

    Use tools ONLY when the user's latest message directly instructs a
    CHANGE to the graph or the metric. For questions, explanations,
    critique, or small talk, call ``finish`` and answer in ``reply``.

    ## Rule 2: Leave the graph VALID before finishing.

    After your edits, every input port must be fed, every output-anchor
    field must be fed, and the graph must stay acyclic and connected.
    Tool observations report the remaining structural issues after each
    edit — resolve ALL of them (usually by adding the right edges) before
    calling ``finish``. A typical "add a step between A and B" needs:
    disconnect A→B, add_node, connect A→new, connect new→B.

    ## Rule 3: Ground every reply in the actual graph.

    Reference nodes by their ids, name the fields, and describe what each
    step literally does per its signature_code. To revert, rebuild the
    graph from ``initial_workflow`` using the tools.

    ## Reply format

    Write the reply in the language named by ``reply_language`` — that is
    the product's configured UI language. Switch to the user's language
    ONLY if their latest message is clearly in another language. Keep
    product terms (Signature, Metric, Workflow, node ids, field names) in
    English. Plain prose, no markdown, no code fences. 2-5 sentences for
    explanations, 1-2 for edit confirmations.
    """)

    __doc__ = (__doc__ or "") + _WORKFLOW_JSON_SCHEMA_DOC

    dataset_columns: list[str] = dspy.InputField(desc="Every column name in the dataset.")
    column_roles: str = dspy.InputField(
        desc="JSON object mapping column name → 'input' | 'output' | 'ignore'.",
    )
    sample_rows: str = dspy.InputField(
        desc="JSON array of up to 5 representative rows from the dataset.",
    )
    current_workflow: str = dspy.InputField(
        desc="The workflow graph currently on the canvas, as JSON. Reference its node ids in your reply.",
    )
    current_metric: str = dspy.InputField(
        desc="The end-to-end metric function currently in the editor.",
    )
    current_workflow_validation: str = dspy.InputField(
        desc=(
            "Latest validator output for current_workflow. 'OK' means the "
            "graph is structurally valid. Non-empty error text means it is "
            "broken — if the user asks for changes, fix these too."
        ),
    )
    initial_workflow: str = dspy.InputField(
        desc=(
            "The ORIGINAL graph JSON before any edits this conversation. "
            "Rebuild from it (via the tools) when the user asks to revert."
        ),
    )
    chat_history: str = dspy.InputField(
        desc="Prior conversation turns as a JSON list of {role, content} objects.",
    )
    reply_language: str = dspy.InputField(
        desc=(
            "Language for user-facing prose (the product UI language). "
            "Both ``reply`` and every tool ``reason`` are written in it."
        ),
    )
    user_message: str = dspy.InputField(desc="The user's latest message.")

    reply: str = dspy.OutputField(
        desc=(
            "Reply to the user, grounded in the literal graph — name node "
            "ids and fields. Written in reply_language; mirror the user's "
            "language only if clearly different. Product terms stay in "
            "English. Plain prose, no markdown. 2-5 sentences."
        ),
    )


def _extract_reasoning_token(chunk: object) -> str | None:
    """Pull a thinking/reasoning token from a raw LiteLLM streaming chunk.

    Handles the conventions in the wild:
      - LiteLLM-normalized: ``delta.reasoning_content`` (string). Emitted by
        Fireworks, DeepSeek, OpenAI o-series, and most reasoning providers.
      - OpenRouter passthrough: ``delta.reasoning`` (string) on responses that
        skip LiteLLM's normalization (direct/BYOK OpenRouter calls).
      - Detail blocks: ``delta.reasoning_details`` — MiniMax ``reasoning_split``
        and OpenRouter both use it; blocks carry ``text`` (``reasoning.text``)
        or ``summary`` (``reasoning.summary``, OpenAI-style summarized CoT).

    Args:
        chunk: A streaming chunk object from LiteLLM.

    Returns:
        The reasoning token text, or ``None`` when the chunk has no reasoning content.
    """
    choices = getattr(chunk, "choices", None)
    if not choices:
        return None
    delta = getattr(choices[0], "delta", None)
    if delta is None:
        return None
    content = getattr(delta, "reasoning_content", None)
    if isinstance(content, str) and content:
        return content
    plain = getattr(delta, "reasoning", None)
    if isinstance(plain, str) and plain:
        return plain
    details = getattr(delta, "reasoning_details", None)
    if isinstance(details, list) and details:
        parts: list[str] = []
        for block in details:
            if isinstance(block, dict):
                text = block.get("text") or block.get("summary")
            else:
                text = getattr(block, "text", None) or getattr(block, "summary", None)
            if isinstance(text, str) and text:
                parts.append(text)
        if parts:
            return "".join(parts)
    return None


class _SubmitArgExtractor:
    """Recover token-level streaming of a ReActV2 submit argument.

    ReActV2 dropped V1's separate ``extract`` step: the user's output fields
    are now arguments of an internal ``submit`` tool call carried in the
    ``tool_calls`` field of the inner predict. The raw text streamed for
    that field is JSON of the shape
    ``{"tool_calls": [{"name": "submit", "args": {<arg>: "..."}}]}``. We
    feed every chunk from a regular ``StreamListener`` bound to
    ``tool_calls`` through ``feed``; partial JSON parsing pulls out the
    growing value of ``args[<target_arg>]`` so we can re-emit
    token-by-token deltas the same way V1's ``extract.predict`` listener
    did.

    One instance per agent turn. Call ``reset`` whenever the bound stream
    listener finishes a field (its ``is_last_chunk`` signal) so the next
    loop iteration starts with a clean accumulator.
    """

    def __init__(self, target_arg: str, *, exclusive_submit: bool = False):
        """Bind the extractor to a specific submit argument name.

        Args:
            target_arg: Name of the ``submit`` arg to extract — e.g.
                ``assistant_message`` for the generalist agent or
                ``reply`` for the code agent.
            exclusive_submit: Buffer until the field ends and suppress the
                reply when submit appeared beside a non-submit tool.
        """
        self._target_arg = target_arg
        self._exclusive_submit = exclusive_submit
        self._buffer = ""
        self._emitted_chars = 0

    def feed(self, chunk: str, *, final: bool = False) -> str | None:
        """Append a chunk and return the newly streamed slice of the target arg.

        Args:
            chunk: Latest streaming chunk from the ``tool_calls`` listener.
            final: Whether this is the field's terminal chunk.

        Returns:
            The new characters of ``args[target_arg]`` since the last
            successful feed, or ``None`` when the partial JSON has not
            yet exposed any additional content for the target arg.
        """
        if not chunk:
            return None
        self._buffer += chunk
        if self._exclusive_submit and not final:
            return None
        try:
            parsed = jiter.from_json(
                self._buffer.encode("utf-8"),
                partial_mode="trailing-strings",
            )
        except ValueError:
            return None
        if not isinstance(parsed, dict):
            return None
        tool_calls = parsed.get("tool_calls")
        if not isinstance(tool_calls, list):
            return None
        if self._exclusive_submit and any(
            isinstance(call, dict) and call.get("name") != "submit" for call in tool_calls
        ):
            return None
        for call in tool_calls:
            if not isinstance(call, dict) or call.get("name") != "submit":
                continue
            args = call.get("args")
            if not isinstance(args, dict):
                continue
            value = args.get(self._target_arg)
            if not isinstance(value, str):
                continue
            if len(value) <= self._emitted_chars:
                return None
            delta = value[self._emitted_chars :]
            self._emitted_chars = len(value)
            return delta
        return None

    def reset(self) -> None:
        """Drop accumulated state between ReAct loop iterations."""
        self._buffer = ""
        self._emitted_chars = 0


class _NativeSubmitArgExtractor:
    """Recover token-level streaming of a submit argument under native function calling.

    Sibling of :class:`_SubmitArgExtractor` for the native path. When native
    function calling is active the provider streams the ``submit`` tool's
    arguments directly — raw JSON of the shape ``{<arg>: "..."}`` — without
    DSPy's ``{"tool_calls": [{"name": ..., "args": ...}]}`` text envelope. The
    incremental-emit machinery is identical; only the JSON shape differs, so
    this navigates ``parsed[target_arg]`` rather than the nested envelope.

    One instance per agent turn; call ``reset`` between loop iterations.
    """

    def __init__(self, target_arg: str):
        """Bind the extractor to a specific submit argument name.

        Args:
            target_arg: Name of the ``submit`` arg to extract — e.g. ``reply``
                for the code agent or ``assistant_message`` for the generalist.
        """
        self._target_arg = target_arg
        self._buffer = ""
        self._emitted_chars = 0

    def feed(self, chunk: str) -> str | None:
        """Append a chunk and return the newly streamed slice of the target arg.

        Args:
            chunk: Latest fragment of the submit call's ``arguments`` JSON.

        Returns:
            The new characters of ``parsed[target_arg]`` since the last
            successful feed, or ``None`` when the partial JSON has not yet
            exposed any additional content for the target arg.
        """
        if not chunk:
            return None
        self._buffer += chunk
        try:
            parsed = jiter.from_json(
                self._buffer.encode("utf-8"),
                partial_mode="trailing-strings",
            )
        except ValueError:
            return None
        if not isinstance(parsed, dict):
            return None
        value = parsed.get(self._target_arg)
        if not isinstance(value, str):
            return None
        if len(value) <= self._emitted_chars:
            return None
        delta = value[self._emitted_chars :]
        self._emitted_chars = len(value)
        return delta

    def reset(self) -> None:
        """Drop accumulated state between ReAct loop iterations."""
        self._buffer = ""
        self._emitted_chars = 0


class ReasoningStreamListener(dspy.streaming.StreamListener):
    """StreamListener subclass that harvests provider reasoning tokens.

    DSPy's built-in ``StreamListener`` only reads ``delta.content``. For
    reasoning-capable providers (Fireworks/MiniMax/DeepSeek/o-series) the
    model's thinking arrives on ``delta.reasoning_content`` or, for native
    MiniMax, on ``delta.reasoning_details`` — channels DSPy drops on the
    floor. This subclass intercepts those and emits them as synthetic
    ``StreamResponse`` events with ``signature_field_name = REASONING_FIELD``.

    The listener is manually bound to a specific ``Predict`` via the
    ``predict=...`` constructor arg so DSPy's auto-resolution never tries
    to find the synthetic field on the signature (it doesn't exist there).
    ``allow_reuse=True`` is required when bound to ReAct's inner predict
    because that predict fires once per loop iteration.
    """

    def __init__(self, predict: dspy.Predict, allow_reuse: bool = False):
        """Bind the listener to a specific Predict and mark the synthetic reasoning field.

        Args:
            predict: The :class:`dspy.Predict` whose reasoning chunks should be intercepted.
            allow_reuse: Whether the listener can fire more than once (required for
                ReAct's inner predict, which fires per loop iteration).
        """
        super().__init__(
            signature_field_name=REASONING_FIELD,
            predict=predict,
            allow_reuse=allow_reuse,
        )
        self.predict_name = REASONING_FIELD

    def receive(self, chunk: object) -> dspy.streaming.StreamResponse | None:
        """Extract a reasoning token from a LiteLLM chunk and re-emit it as a stream response.

        Args:
            chunk: A raw LiteLLM streaming chunk.

        Returns:
            A synthetic :class:`dspy.streaming.StreamResponse` carrying the
            reasoning token, or ``None`` when no token is present.
        """
        token = _extract_reasoning_token(chunk)
        if not token:
            return None
        return dspy.streaming.StreamResponse(
            predict_name=self.predict_name,
            signature_field_name=REASONING_FIELD,
            chunk=token,
            is_last_chunk=False,
        )

    def finalize(self) -> None:
        """No-op — reasoning has no terminal aggregate event.

        Kept as an explicit method so the listener satisfies the streamer's
        aggregator protocol alongside peers that do emit a final summary.
        """
        return


class NativeToolCallStreamListener(dspy.streaming.StreamListener):
    """StreamListener that harvests a native ``submit`` tool call's arguments.

    When native function calling is active, ReActV2's inner predict emits its
    tool calls through the provider API rather than as text in the ``tool_calls``
    field, so DSPy's built-in listener — which reads only ``delta.content`` —
    never sees them. This subclass reads the raw ``delta.tool_calls`` deltas,
    tracks the call index whose function name is ``submit``, and re-emits that
    call's streaming ``arguments`` JSON as synthetic ``StreamResponse`` events
    on the ``tool_calls`` field. It emits on the same field name the text path
    uses so the reply bridge routes both paths identically; the arguments there
    are the bare ``{<arg>: ...}`` object that :class:`_NativeSubmitArgExtractor`
    decodes. Parallel non-submit tool calls stream on other indices and are
    ignored — they execute, they are not the reply.

    ``allow_reuse=True`` is required because the inner predict fires once per
    ReAct loop iteration; per-turn index tracking is reset when a turn's
    ``finish_reason`` arrives.
    """

    def __init__(self, predict: dspy.Predict, allow_reuse: bool = True):
        """Bind the listener to a specific Predict and mark the tool_calls field.

        Args:
            predict: The :class:`dspy.Predict` (ReAct's inner loop predictor)
                whose native tool-call deltas should be intercepted.
            allow_reuse: Whether the listener can fire more than once (required
                for ReAct's inner predict, which fires per loop iteration).
        """
        super().__init__(
            signature_field_name="tool_calls",
            predict=predict,
            allow_reuse=allow_reuse,
        )
        self.predict_name = "tool_calls"
        self._submit_index: int | None = None
        self._pending: dict[int, str] = {}

    def _consume_tool_calls(self, tool_calls: list) -> str | None:
        """Pull the submit call's newest ``arguments`` fragment from a delta's tool calls.

        Args:
            tool_calls: The ``delta.tool_calls`` list from one streaming chunk —
                objects carrying ``index``, ``function.name`` and streaming
                ``function.arguments`` fragments.

        Returns:
            The concatenated new ``arguments`` text for the submit call in this
            delta, or ``None`` when the delta contributes nothing to it. Args
            arriving before the submit index is known are buffered per index and
            flushed once that index reveals the ``submit`` name.
        """
        out: list[str] = []
        for call in tool_calls:
            index = getattr(call, "index", None)
            function = getattr(call, "function", None)
            name = getattr(function, "name", None) if function is not None else None
            args = getattr(function, "arguments", None) if function is not None else None
            if name == "submit":
                self._submit_index = index
                buffered = self._pending.pop(index, "")
                if buffered:
                    out.append(buffered)
            if args:
                if index == self._submit_index:
                    out.append(args)
                elif self._submit_index is None and index is not None:
                    self._pending[index] = self._pending.get(index, "") + args
        return "".join(out) if out else None

    def receive(self, chunk: object) -> dspy.streaming.StreamResponse | None:
        """Extract the submit call's argument delta from a LiteLLM chunk.

        Args:
            chunk: A raw LiteLLM streaming chunk.

        Returns:
            A synthetic :class:`dspy.streaming.StreamResponse` on the
            ``tool_calls`` field carrying the submit call's newest ``arguments``
            text, marked ``is_last_chunk`` when the turn's ``finish_reason``
            arrives (so the reply bridge resets between loop iterations), or
            ``None`` when the chunk carries nothing for the submit call.
        """
        try:
            choice = chunk.choices[0]
        except (AttributeError, IndexError, TypeError):
            return None
        delta = getattr(choice, "delta", None)
        tool_calls = getattr(delta, "tool_calls", None) if delta is not None else None
        emitted = self._consume_tool_calls(tool_calls) if tool_calls else None
        if getattr(choice, "finish_reason", None):
            terminal = dspy.streaming.StreamResponse(
                predict_name=self.predict_name,
                signature_field_name="tool_calls",
                chunk=emitted or "",
                is_last_chunk=True,
            )
            self._submit_index = None
            self._pending = {}
            return terminal
        if emitted:
            return dspy.streaming.StreamResponse(
                predict_name=self.predict_name,
                signature_field_name="tool_calls",
                chunk=emitted,
                is_last_chunk=False,
            )
        return None

    def finalize(self) -> None:
        """No-op — the reply's terminal chunk rides the turn's finish_reason.

        Kept explicit so the listener satisfies the streamer's aggregator
        protocol alongside peers that emit a final summary.
        """
        return


class ReactReplyStream:
    """Stream a ReActV2 program's reply out of its ``submit`` tool call.

    ReActV2 carries the reply as a ``submit`` tool-call argument streamed on the
    inner ``react`` predictor's ``tool_calls`` field, either as provider tool-call
    deltas (native function calling) or as DSPy's text protocol. This hides that
    difference so the agent loops stay identical: build ``listeners()`` once,
    then feed every non-reasoning ``StreamResponse`` through ``reply_delta``.
    """

    def __init__(self, program: dspy.Module, reply_field: str, lm: dspy.LM | None = None):
        """Bind to a constructed ReActV2 program and the signature's reply field.

        Args:
            program: The constructed ReActV2 program (or subclass).
            reply_field: Output field carrying the user-visible reply, a
                ``submit`` argument.
            lm: The LM the loop runs on; defaults to the active ``dspy.settings.lm``.
        """
        self._program = program
        lm = lm or getattr(dspy.settings, "lm", None)
        # The adapter only sends native tools when the LM also claims support;
        # otherwise it silently falls back to the text protocol, and a native
        # listener would never see the reply.
        self._native = native_tool_calling_active() and (lm is None or bool(lm.supports_function_calling))
        self._stream_field = "tool_calls"
        if self._native:
            self._extractor: _NativeSubmitArgExtractor | _SubmitArgExtractor = _NativeSubmitArgExtractor(reply_field)
        else:
            self._extractor = _SubmitArgExtractor(
                reply_field,
                exclusive_submit=bool(getattr(self._program.react, "_serial_tool_calls", False)),
            )

    def listeners(self) -> list[dspy.streaming.StreamListener]:
        """Return the reply + reasoning stream listeners for this program.

        Returns:
            With native function calling: a :class:`NativeToolCallStreamListener`
            reading the provider's ``tool_calls`` deltas. With the text protocol:
            a built-in ``tool_calls`` listener bound to the reused inner
            predictor. Both carry the same reasoning listener on the loop
            predictor.
        """
        if self._native:
            reply_listener: dspy.streaming.StreamListener = NativeToolCallStreamListener(
                predict=self._program.react,
                allow_reuse=True,
            )
        else:
            reply_listener = dspy.streaming.StreamListener(
                signature_field_name="tool_calls",
                predict=self._program.react,
                allow_reuse=True,
            )
        return [
            reply_listener,
            ReasoningStreamListener(predict=self._program.react, allow_reuse=True),
        ]

    def reply_delta(self, chunk: dspy.streaming.StreamResponse) -> str | None:
        """Return the newly streamed reply text from a chunk, or ``None``.

        The chunk is partial ``submit`` JSON decoded incrementally. Chunks for
        any field other than ``tool_calls`` return ``None``.

        Args:
            chunk: A non-reasoning ``StreamResponse`` from the wrapped program.

        Returns:
            The new reply substring since the last call, or ``None`` when this
            chunk carries no fresh reply content.
        """
        if chunk.signature_field_name != self._stream_field:
            return None
        if isinstance(self._extractor, _SubmitArgExtractor):
            delta = self._extractor.feed(
                chunk.chunk,
                final=chunk.is_last_chunk,
            )
        else:
            delta = self._extractor.feed(chunk.chunk)
        if chunk.is_last_chunk:
            self._extractor.reset()
        return delta


def _build_agent_lm(
    model_name_override: str | None = None,
    reasoning_effort: str | None = None,
    max_tokens: int = 32000,
) -> dspy.LM:
    """Construct the LM used by the code agent from global settings.

    Args:
        model_name_override: Optional LiteLLM id chosen by the caller (the
            interview composer's model menu); ``None`` runs the configured
            code-agent model.
        reasoning_effort: Explicit effort level for the chosen model; ``None``
            keeps the model's default.
        max_tokens: Completion budget, reasoning included; short-answer
            callers (the onboarding intake) lower it to bound latency and cost.

    Reasoning knobs we send, by provider:

    - **Native MiniMax** (``minimax/...`` or a MiniMax base_url): forward
      ``extra_body={"reasoning_split": true}`` so the provider emits its
      interleaved ``<think>`` reasoning in a clean ``reasoning_details``
      channel. Thinking depth is always max on this endpoint — no knob.
    - **OpenRouter MiniMax** (``openrouter/minimax/...``, the shipped default)
      **and Fireworks-hosted MiniMax** (``fireworks_ai/.../minimax-*``):
      reasoning arrives inline in the assistant content as ``<think>…</think>``
      blocks. Neither host honours ``reasoning_split``, so we send nothing.
    - **Everything else** (``openai/gpt-4o-mini`` etc.): no reasoning knob.

    Returns:
        A configured :class:`dspy.LM` instance for the code agent.
    """
    model_name = model_name_override or agent_model_id(settings.code_agent_model)
    lower = model_name.lower()
    extra: dict = {}
    is_native_minimax = lower.startswith("minimax/") or (
        "minimax" in lower and "fireworks" not in lower and "openrouter" not in lower
    )
    if is_native_minimax:
        extra["extra_body"] = {"reasoning_split": True}
    config = ModelConfig(
        name=model_name,
        base_url=settings.code_agent_base_url or None,
        # Reasoning models spend their thinking tokens against this same
        # budget, and on real datasets the seed's reasoning alone can run
        # thousands of tokens; keep enough headroom that code is never cut
        # off mid-artifact (a truncation costs a repair LLM call plus two
        # more multi-second subprocess validations). A chat step that rewrites
        # a whole scorer often drafts it in its reasoning first and then emits
        # it again as the tool argument, which overran 16000.
        max_tokens=max_tokens,
        extra=extra,
    )
    config = apply_reasoning_effort(config, reasoning_effort)
    # A caller-chosen model can be anything in the catalog — run it through
    # the generic reasoning-model knobs (mandatory temperature/effort for
    # OpenAI reasoning models); the configured default keeps its hand-tuned
    # MiniMax setup untouched.
    if model_name_override:
        config = apply_model_reasoning_config(config)
    return build_language_model(config, disable_cache=True)


async def _pump_seed_stream(
    program: Any,
    inputs: dict[str, Any],
    field: str,
    event_name: str,
    *,
    queue: asyncio.Queue[dict | None],
    results: dict[str, str],
    reasoning_source: str,
) -> None:
    """Drive one streamify program and fan its tokens out to the shared SSE queue.

    Forwards provider reasoning tokens as ``reasoning_patch`` events and the
    target field's own tokens as ``event_name`` (``signature_patch`` or
    ``metric_patch``). On the final ``dspy.Prediction`` the completed text
    is written to ``results[field]`` for the orchestrator to consume; when
    the stream ends without a terminal Prediction (provider truncation),
    the concatenated streamed tokens are used instead so the artifact isn't
    silently empty.

    Args:
        program: The streamify-wrapped predictor to invoke.
        inputs: Keyword arguments forwarded to the program.
        field: Signature field name whose tokens are forwarded as ``event_name``.
        event_name: Outbound SSE event name for ``field`` tokens.
        queue: Shared SSE queue receiving the events.
        results: Mutable result map; the final value of ``field`` is written here.
        reasoning_source: Stream label stamped on each ``reasoning_patch`` so
            the UI can keep parallel seeds' reasoning apart (the signature and
            metric authors run concurrently on one multiplexed queue).
    """
    streamed: list[str] = []
    async for chunk in program(**inputs):
        if isinstance(chunk, dspy.streaming.StreamResponse):
            if chunk.signature_field_name == REASONING_FIELD:
                await queue.put(
                    {
                        "event": "reasoning_patch",
                        "data": {"chunk": chunk.chunk, "source": reasoning_source},
                    }
                )
            elif chunk.signature_field_name == field:
                streamed.append(chunk.chunk)
                await queue.put({"event": event_name, "data": {"chunk": chunk.chunk}})
        elif isinstance(chunk, dspy.Prediction):
            results[field] = getattr(chunk, field, "") or ""
    if not results[field] and streamed:
        results[field] = "".join(streamed)
    # DSPy's StreamListener yields nothing for a field that arrives whole in
    # one provider chunk (its "cache hit" shortcut), which some providers do
    # for short answers after a long think. Without this the editor stays
    # empty until the whole turn ends.
    if results[field] and not streamed:
        await queue.put({"event": event_name, "data": {"chunk": results[field]}})


def _run_code_fixer(
    *,
    lm: dspy.LM,
    artifact_kind: str,
    broken_code: str,
    validation_error: str,
    dataset_columns: list[str],
    column_roles_json: str,
) -> str:
    """Run the one-shot ``FixCodeArtifact`` predictor under ``lm``.

    Runs synchronously (invoked via ``asyncio.to_thread``) so the dspy LM
    round-trip never blocks the event loop, and binds ``lm`` explicitly so
    the repair uses the same model as the seed regardless of contextvar
    propagation across the thread hop.

    Args:
        lm: Language model driving the repair.
        artifact_kind: ``"signature"`` or ``"metric"``.
        broken_code: Source that failed validation.
        validation_error: Validator error message to resolve.
        dataset_columns: Dataset column names for context.
        column_roles_json: JSON column → role map for context.

    Returns:
        The repaired source (stripped), or an empty string when the
        predictor yields nothing usable.
    """
    fixer = dspy.Predict(FixCodeArtifact)
    with dspy.context(lm=lm):
        pred = fixer(
            artifact_kind=artifact_kind,
            broken_code=broken_code,
            validation_error=validation_error,
            dataset_columns=dataset_columns,
            column_roles=column_roles_json,
        )
    return (getattr(pred, "fixed_code", "") or "").strip()


async def _validate_and_repair_artifact(
    *,
    lm: dspy.LM,
    artifact_kind: str,
    code: str,
    validator: Callable[[str], str],
    dataset_columns: list[str],
    column_roles_json: str,
    queue: asyncio.Queue[dict | None],
    replace_event: str,
    max_attempts: int = 2,
) -> tuple[str, str]:
    """Validate ``code`` and repair it in a bounded loop when it fails.

    The seed predictors emit unvalidated code, so without this a stray
    brace or bad identifier would reach submit unchecked (the chat path
    gets this guarantee from ``edit_signature``/``edit_metric``; the seed
    path did not). Each repaired revision is published via ``replace_event``
    so the editor reflects the fix live, and the subprocess validator runs
    off-thread to keep the loop responsive.

    Args:
        lm: Language model used for repair attempts.
        artifact_kind: ``"signature"`` or ``"metric"`` (passed to the fixer).
        code: Freshly generated source to validate.
        validator: ``_validate_signature_code`` / ``_validate_metric_code`` —
            returns an empty string on success or an error message.
        dataset_columns: Dataset column names for repair context.
        column_roles_json: JSON column → role map for repair context.
        queue: SSE queue receiving the ``replace_event`` updates.
        replace_event: ``"signature_replace"`` or ``"metric_replace"``.
        max_attempts: Maximum repair attempts before giving up.

    Returns:
        A ``(code, error)`` tuple — the best source produced and the final
        validator error (empty string once valid).
    """
    code = strip_adapter_debris(code)
    error = await asyncio.to_thread(validator, code)
    attempts = 0
    while error and attempts < max_attempts:
        attempts += 1
        try:
            candidate = await asyncio.to_thread(
                _run_code_fixer,
                lm=lm,
                artifact_kind=artifact_kind,
                broken_code=code,
                validation_error=error,
                dataset_columns=dataset_columns,
                column_roles_json=column_roles_json,
            )
        except Exception:
            logger.exception("seed code repair attempt failed")
            break
        if not candidate or candidate == code:
            break
        code = candidate
        queue.put_nowait({"event": replace_event, "data": {"code": code}})
        error = await asyncio.to_thread(validator, code)
    return code, error


def _emit_to_code_queue(
    loop: asyncio.AbstractEventLoop,
    queue: asyncio.Queue[dict | None],
    ev: dict,
) -> None:
    """Hand ``ev`` to ``queue`` from any thread by scheduling ``put_nowait`` on ``loop``.

    DSPy may invoke ReAct tools on a worker thread; ``asyncio.Queue`` is not
    thread-safe, so SSE events must be enqueued via the owning loop. Binding
    ``loop`` and ``queue`` with :func:`functools.partial` turns this helper
    into a closure-free drop-in emit callback.

    Args:
        loop: The event loop owning ``queue``.
        queue: The destination SSE queue.
        ev: The event payload to enqueue.
    """
    loop.call_soon_threadsafe(queue.put_nowait, ev)


class _CodeEditSession:
    """Per-turn state for the ReAct ``edit_signature`` / ``edit_metric`` tools.

    Holds the current signature and metric source, a guardrail counter that
    rejects duplicate edits within a single turn, and the thread-safe emit
    callback used to publish SSE events from worker threads.

    ``edit_signature`` and ``edit_metric`` are exposed as bound methods so
    :class:`dspy.ReAct` can register them as tools; bound methods preserve
    the per-method Google-style docstring and the ``(reason, new_code)``
    signature that the ReAct prompt builder introspects.
    """

    def __init__(
        self,
        *,
        signature_code: str,
        metric_code: str,
        emit: Callable[[dict], None],
    ) -> None:
        """Initialize the session with the starting code and a thread-safe emitter.

        Args:
            signature_code: Initial Signature class source.
            metric_code: Initial metric function source.
            emit: Callback used to publish SSE events thread-safely.
        """
        # Per-turn guardrail: once an artifact has been successfully replaced,
        # subsequent calls for it are rejected so ReAct can't loop on the same
        # edit (which we've seen happen — four identical rewrites in one turn,
        # burning tokens and cluttering the UI). A failed validation does NOT
        # count as a successful edit, so the agent can still retry after a fix.
        self._slots = {"signature_code": signature_code, "metric_code": metric_code}
        self._successful_edits = {"signature": 0, "metric": 0}
        self._emit = emit

    @property
    def signature_code(self) -> str:
        """Return the live Signature source (updated after each successful edit).

        Returns:
            The current Signature class source as a string.
        """
        return self._slots["signature_code"]

    @property
    def metric_code(self) -> str:
        """Return the live metric source (updated after each successful edit).

        Returns:
            The current metric function source as a string.
        """
        return self._slots["metric_code"]

    def edit_signature(self, reason: str, new_code: str) -> str:
        """Replace the current Signature class in the editor.

        Call ONLY when the user asks for a change to the Signature and the
        artifact has NOT yet been edited this turn. For questions,
        explanations, or after any successful edit, call ``finish`` and
        answer in ``reply`` instead.

        The new code is validated before it's applied. If validation fails,
        the edit is rejected and the observation returns the error message
        so you can fix the code and try again in the next iteration.

        ``reason`` must be prose in the reply language — the ``reply_language`` input (≤10 words); product terms like
        Signature/Metric may stay in English.

        Args:
            reason: Short rationale for the edit, in the reply language.
            new_code: Complete replacement Signature class body.

        Returns:
            An observation string the ReAct agent reads back: a confirmation
            on success or a rejection message on validation/policy failure.
        """
        call_id = uuid.uuid4().hex[:8]
        self._emit(
            {
                "event": "tool_start",
                "data": {"id": call_id, "tool": "edit_signature", "reason": reason or ""},
            }
        )
        if self._successful_edits["signature"] >= 1:
            self._emit(
                {
                    "event": "tool_end",
                    "data": {"id": call_id, "tool": "edit_signature", "status": "error"},
                }
            )
            return (
                "Edit rejected — signature was already replaced in this "
                "turn. STOP editing; call finish and summarize the change "
                "in reply."
            )
        # Tool args can carry the same malformed trailing field marker the
        # seed path strips; unstripped it fails validation and burns a ReAct
        # iteration on an otherwise-valid edit.
        new_code = strip_adapter_debris(new_code)
        if new_code.strip() == self._slots["signature_code"].strip():
            self._emit(
                {
                    "event": "tool_end",
                    "data": {"id": call_id, "tool": "edit_signature", "status": "error"},
                }
            )
            return "Edit rejected — new_code is identical to the current signature. Call finish."
        err = _validate_signature_code(new_code)
        if err:
            self._emit(
                {
                    "event": "tool_end",
                    "data": {"id": call_id, "tool": "edit_signature", "status": "error"},
                }
            )
            return (
                f"Edit rejected — new_code is invalid: {err}. "
                "Fix the error and call edit_signature again with the "
                "corrected full class body."
            )
        self._slots["signature_code"] = new_code
        self._successful_edits["signature"] += 1
        self._emit({"event": "signature_replace", "data": {"code": new_code}})
        self._emit(
            {
                "event": "tool_end",
                "data": {"id": call_id, "tool": "edit_signature", "status": "ok"},
            }
        )
        return (
            "Signature replaced and validated. Do NOT edit the signature "
            "again this turn — call finish and summarize the change in "
            "reply."
        )

    def edit_metric(self, reason: str, new_code: str) -> str:
        """Replace the current metric function in the editor.

        Call ONLY when the user asks for a change to the metric and the
        artifact has NOT yet been edited this turn. For questions,
        explanations, or after any successful edit, call ``finish`` and
        answer in ``reply`` instead.

        The new code is validated before it's applied. If validation fails,
        the edit is rejected and the observation returns the error message
        so you can fix the code and try again in the next iteration.

        ``reason`` must be prose in the reply language — the ``reply_language`` input (≤10 words); product terms like
        Signature/Metric may stay in English. ``new_code`` must return
        ``dspy.Prediction(score=..., feedback=...)``.

        Args:
            reason: Short rationale for the edit, in the reply language.
            new_code: Complete replacement metric function body.

        Returns:
            An observation string the ReAct agent reads back: a confirmation
            on success or a rejection message on validation/policy failure.
        """
        call_id = uuid.uuid4().hex[:8]
        self._emit(
            {
                "event": "tool_start",
                "data": {"id": call_id, "tool": "edit_metric", "reason": reason or ""},
            }
        )
        if self._successful_edits["metric"] >= 1:
            self._emit(
                {
                    "event": "tool_end",
                    "data": {"id": call_id, "tool": "edit_metric", "status": "error"},
                }
            )
            return (
                "Edit rejected — metric was already replaced in this "
                "turn. STOP editing; call finish and summarize the change "
                "in reply."
            )
        # Same trailing-marker strip as edit_signature — see the note there.
        new_code = strip_adapter_debris(new_code)
        if new_code.strip() == self._slots["metric_code"].strip():
            self._emit(
                {
                    "event": "tool_end",
                    "data": {"id": call_id, "tool": "edit_metric", "status": "error"},
                }
            )
            return "Edit rejected — new_code is identical to the current metric. Call finish."
        err = _validate_metric_code(new_code)
        if err:
            self._emit(
                {
                    "event": "tool_end",
                    "data": {"id": call_id, "tool": "edit_metric", "status": "error"},
                }
            )
            return (
                f"Edit rejected — new_code is invalid: {err}. "
                "Fix the error and call edit_metric again with the corrected "
                "full function body."
            )
        self._slots["metric_code"] = new_code
        self._successful_edits["metric"] += 1
        self._emit({"event": "metric_replace", "data": {"code": new_code}})
        self._emit(
            {
                "event": "tool_end",
                "data": {"id": call_id, "tool": "edit_metric", "status": "ok"},
            }
        )
        return (
            "Metric replaced and validated. Do NOT edit the metric again "
            "this turn — call finish and summarize the change in reply."
        )


class _UnifiedEditSession:
    """Per-turn state for the wizard's ``edit_run`` / ``edit_metric`` tools.

    The run code rides the ``signature_*`` events and the metric the
    ``metric_*`` events so the editor wiring is shared with the DSPy
    artifacts. Same per-turn guardrail as :class:`_CodeEditSession` (one
    successful edit per artifact) and the same thread-safe emit callback;
    each replacement is statically checked against its contract before it
    is applied.
    """

    def __init__(
        self,
        *,
        run_code: str,
        metric_code: str,
        emit: Callable[[dict], None],
        run_validator: Callable[[str], str],
        metric_validator: Callable[[str], str],
    ) -> None:
        """Initialize the session with the editor contents and the contract checks.

        Args:
            run_code: The run code as currently shown in the editor.
            metric_code: The metric as currently shown in the editor.
            emit: Callback used to publish SSE events thread-safely.
            run_validator: Returns an error message for run code that breaks
                its contract, or an empty string.
            metric_validator: Same for the metric.
        """
        self._slots = {"run": run_code, "metric": metric_code}
        self._validators = {"run": run_validator, "metric": metric_validator}
        self._successful_edits = {"run": 0, "metric": 0}
        self._emit = emit
        self._asked = False

    @property
    def run_code(self) -> str:
        """Return the live run code (updated after each successful edit).

        Returns:
            The current run-code source.
        """
        return self._slots["run"]

    @property
    def metric_code(self) -> str:
        """Return the live metric source (updated after each successful edit).

        Returns:
            The current metric source.
        """
        return self._slots["metric"]

    def _apply(self, *, slot: str, tool: str, label: str, reason: str, new_code: str, replace_event: str) -> str:
        """Run the guard → strip → validate → publish pipeline for one tool call.

        Args:
            slot: ``"run"`` or ``"metric"``.
            tool: Tool name stamped on the ``tool_start`` / ``tool_end`` events.
            label: Human name of the artifact for the observation strings.
            reason: The model's rationale for the edit.
            new_code: The proposed replacement.
            replace_event: SSE event carrying the accepted replacement.

        Returns:
            The observation string the ReAct agent reads back.
        """
        call_id = uuid.uuid4().hex[:8]
        self._emit({"event": "tool_start", "data": {"id": call_id, "tool": tool, "reason": reason or ""}})

        def _reject(message: str) -> str:
            """Close the tool call as failed and return its observation."""
            self._emit({"event": "tool_end", "data": {"id": call_id, "tool": tool, "status": "error"}})
            return message

        if self._successful_edits[slot] >= 1:
            return _reject(
                f"Edit rejected — the {label} was already replaced in this turn. "
                "STOP editing; call finish and summarize the change in reply."
            )
        # Tool args can carry the same malformed trailing field marker the
        # seed path strips (see ``_CodeEditSession``).
        new_code = strip_adapter_debris(new_code)
        if new_code.strip() == self._slots[slot].strip():
            return _reject(f"Edit rejected — the new {label} is identical to the current one. Call finish.")
        err = self._validators[slot](new_code)
        if err:
            return _reject(
                f"Edit rejected — the new {label} is invalid: {err} "
                f"Fix the error and call {tool} again with the corrected full source."
            )
        self._slots[slot] = new_code
        self._successful_edits[slot] += 1
        self._emit({"event": replace_event, "data": {"code": new_code}})
        self._emit({"event": "tool_end", "data": {"id": call_id, "tool": tool, "status": "ok"}})
        return (
            f"{label[0].upper()}{label[1:]} replaced. Do NOT edit the {label} again this turn — "
            "call finish and summarize the change in reply."
        )

    def ask_user(self, question: str, options_json: str) -> str:
        """Show the user one question with clickable answers.

        Call it for a question with a small set of likely answers, then call
        ``finish`` with ``reply`` holding the same question. One question per
        turn.

        Args:
            question: The question, in the reply language.
            options_json: JSON array of 2-4 ``{"label": <answer, <= 6 words>,
                "description": <what picking it means>}`` objects.

        Returns:
            An observation string the ReAct agent reads back.
        """
        if self._asked:
            return "A question is already shown this turn. Call finish now."
        try:
            raw = json.loads(options_json) if options_json and options_json.strip() else []
        except (json.JSONDecodeError, TypeError):
            raw = []
        options = normalize_options(raw)
        self._asked = True
        self._emit({"event": "ask", "data": {"question": question.strip(), "options": options}})
        return "The question and its answers are shown. Call finish now with the same question in reply."

    def set_brief(self, objective: str, background: str) -> str:
        """Write what the user told you into the job's Objective and Background fields.

        Pass the FULL new text of each field you change, in the user's terms;
        an empty string leaves that field as it is.

        Args:
            objective: What a better version achieves, or ``""``.
            background: Context, constraints and examples, or ``""``.

        Returns:
            An observation string the ReAct agent reads back.
        """
        fields = {k: v.strip() for k, v in (("objective", objective), ("background", background)) if v and v.strip()}
        if not fields:
            return "Nothing to write: both fields were empty."
        call_id = uuid.uuid4().hex[:8]
        self._emit({"event": "tool_start", "data": {"id": call_id, "tool": "set_brief", "reason": ""}})
        self._emit({"event": "brief", "data": fields})
        self._emit({"event": "tool_end", "data": {"id": call_id, "tool": "set_brief", "status": "ok"}})
        return f"Updated: {', '.join(fields)}."

    def edit_run(self, reason: str, new_code: str) -> str:
        """Replace the run code in the editor.

        Call ONLY when the user asks for a change to how the artifact is run
        on a case and the run code has NOT yet been edited this turn. For
        questions, explanations, or after any successful edit, call
        ``finish`` and answer in ``reply`` instead.

        The new code is checked against ``run_contract`` before it's applied.
        If the check fails, the edit is rejected and the observation returns
        the error so you can fix the code and try again.

        ``reason`` must be prose in the reply language — the
        ``reply_language`` input (≤10 words). ``new_code`` is the COMPLETE
        python source, not a diff.

        Args:
            reason: Short rationale for the edit, in the reply language.
            new_code: Complete replacement run code.

        Returns:
            An observation string the ReAct agent reads back: a confirmation
            on success or a rejection message on validation/policy failure.
        """
        return self._apply(
            slot="run",
            tool="edit_run",
            label="run code",
            reason=reason,
            new_code=new_code,
            replace_event="signature_replace",
        )

    def edit_metric(self, reason: str, new_code: str) -> str:
        """Replace the metric in the editor.

        Call ONLY when the user asks for a change to how outputs are scored
        (or answers a question you asked about it) and the metric has NOT
        yet been edited this turn. For questions, explanations, or after any
        successful edit, call ``finish`` and answer in ``reply`` instead.

        The new code is checked against ``metric_contract`` (the exact
        function name and parameters for ``metric_shape``) before it's
        applied. If the check fails, the edit is rejected and the
        observation returns the error so you can fix the code and try again.

        ``reason`` must be prose in the reply language — the
        ``reply_language`` input (≤10 words). ``new_code`` is the COMPLETE
        python source, not a diff.

        Args:
            reason: Short rationale for the edit, in the reply language.
            new_code: Complete replacement metric source.

        Returns:
            An observation string the ReAct agent reads back: a confirmation
            on success or a rejection message on validation/policy failure.
        """
        return self._apply(
            slot="metric",
            tool="edit_metric",
            label="metric",
            reason=reason,
            new_code=new_code,
            replace_event="metric_replace",
        )


class _WorkflowEditSession:
    """Per-turn state for the ReAct workflow-graph tools.

    Holds the mutable graph dict + metric source, applies each op with
    local checks (id uniqueness, anchors immutable, cycle prevention,
    single-producer ports), and emits a full ``workflow_replace`` snapshot
    after every successful mutation so the canvas re-renders atomically.
    Transient invalid states (an added node not yet wired) are allowed;
    each observation reports the remaining structural issues so the agent
    wires everything up before finishing.
    """

    # A restructure legitimately needs several ops (disconnect + add +
    # 2 connects); cap the turn well above that so ReAct can't run away.
    MAX_EDITS = 10

    def __init__(
        self,
        *,
        workflow: dict,
        metric_code: str,
        emit: Callable[[dict], None],
    ) -> None:
        """Initialize the session with the current graph and a thread-safe emitter.

        Args:
            workflow: The workflow spec currently on the canvas, as a dict.
            metric_code: Current end-to-end metric source.
            emit: Callback used to publish SSE events thread-safely.
        """
        self._workflow = json.loads(json.dumps(workflow))
        self._metric_code = metric_code
        self._edits = 0
        self._metric_edits = 0
        self._emit = emit

    @property
    def workflow(self) -> dict:
        """Return the live graph dict (updated after each successful edit).

        Returns:
            The current workflow spec as a plain dict.
        """
        return self._workflow

    @property
    def metric_code(self) -> str:
        """Return the live metric source.

        Returns:
            The current metric function source as a string.
        """
        return self._metric_code

    def _issues_summary(self) -> str:
        """Summarize the graph's remaining structural issues for observations.

        Returns:
            ``"graph is valid"`` or ``"remaining issues: <error>"``.
        """
        err = _validate_workflow_dict(self._workflow)
        return "graph is valid" if not err else f"remaining issues: {err}"

    def _node(self, node_id: str) -> dict | None:
        """Return the node dict with the given id, or None.

        Args:
            node_id: The node id to look up.
        """
        return next((n for n in self._workflow["nodes"] if n.get("id") == node_id), None)

    def _tool_result(self, call_id: str, tool: str, *, ok: bool, message: str, changed: str | None = None) -> str:
        """Emit the tool lifecycle events and return the observation string.

        Args:
            call_id: Correlation id shared by tool_start/tool_end.
            tool: Tool name for the events.
            ok: Whether the op applied.
            message: Observation text for the agent.
            changed: Node id to pulse on the canvas (successful ops only).

        Returns:
            The observation string, unchanged.
        """
        if ok:
            self._edits += 1
            self._emit(
                {
                    "event": "workflow_replace",
                    "data": {"workflow": self._workflow, "changed_node_id": changed},
                }
            )
        self._emit({"event": "tool_end", "data": {"id": call_id, "tool": tool, "status": "ok" if ok else "error"}})
        return message

    def _start(self, tool: str, reason: str) -> tuple[str, str | None]:
        """Emit tool_start and enforce the per-turn edit budget.

        Args:
            tool: Tool name for the event.
            reason: Model-provided rationale.

        Returns:
            ``(call_id, rejection)`` — rejection is a ready observation when
            the budget is exhausted, else None.
        """
        call_id = uuid.uuid4().hex[:8]
        self._emit({"event": "tool_start", "data": {"id": call_id, "tool": tool, "reason": reason or ""}})
        if self._edits >= self.MAX_EDITS:
            return call_id, (
                "Edit rejected — too many graph edits this turn. STOP editing; call finish and explain in reply."
            )
        return call_id, None

    def add_node(self, reason: str, node_json: str) -> str:
        """Add a signature or transform node to the graph.

        ``node_json`` is ONE node object per the workflow schema (kind
        'signature' or 'transform' only — never anchors or 'mcp'). The node
        starts unwired: follow up with ``connect`` calls for every input
        port and for whatever consumes its outputs, before ``finish``.

        ``reason`` must be prose in the reply language — the ``reply_language`` input (≤10 words); product terms may stay
        in English.

        Args:
            reason: Short rationale for the edit, in the reply language.
            node_json: The complete node object as JSON.

        Returns:
            An observation string: confirmation plus remaining structural
            issues on success, or a rejection message.
        """
        call_id, rejection = self._start("add_node", reason)
        if rejection:
            return self._tool_result(call_id, "add_node", ok=False, message=rejection)
        try:
            node = json.loads(_strip_json_fences(node_json))
        except (json.JSONDecodeError, ValueError) as exc:
            return self._tool_result(
                call_id, "add_node", ok=False, message=f"Edit rejected — node_json does not parse: {exc}"
            )
        if not isinstance(node, dict) or node.get("kind") not in ("signature", "transform"):
            return self._tool_result(
                call_id,
                "add_node",
                ok=False,
                message="Edit rejected — node_json must be one node object with kind 'signature' or 'transform'.",
            )
        node_id = str(node.get("id", ""))
        if not node_id or self._node(node_id) is not None:
            return self._tool_result(
                call_id,
                "add_node",
                ok=False,
                message=f"Edit rejected — node id '{node_id}' is missing or already taken.",
            )
        if node["kind"] == "signature":
            err = _validate_signature_code(str(node.get("signature_code", "")))
            if err:
                return self._tool_result(
                    call_id, "add_node", ok=False, message=f"Edit rejected — signature_code is invalid: {err}"
                )
        self._workflow["nodes"].append(node)
        return self._tool_result(
            call_id,
            "add_node",
            ok=True,
            changed=node_id,
            message=f"Node '{node_id}' added ({self._issues_summary()}). Wire its ports with connect before finish.",
        )

    def update_node(self, reason: str, node_id: str, node_json: str) -> str:
        """Replace an existing node's spec (same id, same kind).

        Use for editing a signature node's code, a transform's code/fields,
        or an anchor's field list. The id and kind must not change.

        ``reason`` must be prose in the reply language — the ``reply_language`` input (≤10 words).

        Args:
            reason: Short rationale for the edit, in the reply language.
            node_id: Id of the node to replace.
            node_json: The complete replacement node object as JSON.

        Returns:
            An observation string: confirmation plus remaining structural
            issues on success, or a rejection message.
        """
        call_id, rejection = self._start("update_node", reason)
        if rejection:
            return self._tool_result(call_id, "update_node", ok=False, message=rejection)
        existing = self._node(node_id)
        if existing is None:
            return self._tool_result(
                call_id, "update_node", ok=False, message=f"Edit rejected — no node with id '{node_id}'."
            )
        try:
            node = json.loads(_strip_json_fences(node_json))
        except (json.JSONDecodeError, ValueError) as exc:
            return self._tool_result(
                call_id, "update_node", ok=False, message=f"Edit rejected — node_json does not parse: {exc}"
            )
        if not isinstance(node, dict) or node.get("id") != node_id or node.get("kind") != existing.get("kind"):
            return self._tool_result(
                call_id,
                "update_node",
                ok=False,
                message="Edit rejected — the replacement must keep the same id and kind.",
            )
        if node.get("kind") == "signature":
            err = _validate_signature_code(str(node.get("signature_code", "")))
            if err:
                return self._tool_result(
                    call_id, "update_node", ok=False, message=f"Edit rejected — signature_code is invalid: {err}"
                )
        self._workflow["nodes"] = [node if n.get("id") == node_id else n for n in self._workflow["nodes"]]
        return self._tool_result(
            call_id,
            "update_node",
            ok=True,
            changed=node_id,
            message=f"Node '{node_id}' updated ({self._issues_summary()}).",
        )

    def remove_node(self, reason: str, node_id: str) -> str:
        """Delete a non-anchor node and every edge touching it.

        ``reason`` must be prose in the reply language — the ``reply_language`` input (≤10 words).

        Args:
            reason: Short rationale for the edit, in the reply language.
            node_id: Id of the node to delete.

        Returns:
            An observation string: confirmation plus remaining structural
            issues on success, or a rejection message.
        """
        call_id, rejection = self._start("remove_node", reason)
        if rejection:
            return self._tool_result(call_id, "remove_node", ok=False, message=rejection)
        node = self._node(node_id)
        if node is None:
            return self._tool_result(
                call_id, "remove_node", ok=False, message=f"Edit rejected — no node with id '{node_id}'."
            )
        if node.get("kind") in ("input", "output"):
            return self._tool_result(
                call_id, "remove_node", ok=False, message="Edit rejected — the input/output anchors cannot be removed."
            )
        self._workflow["nodes"] = [n for n in self._workflow["nodes"] if n.get("id") != node_id]
        self._workflow["edges"] = [
            e for e in self._workflow["edges"] if e.get("source") != node_id and e.get("target") != node_id
        ]
        return self._tool_result(
            call_id,
            "remove_node",
            ok=True,
            changed=None,
            message=f"Node '{node_id}' and its edges removed ({self._issues_summary()}).",
        )

    def connect(self, reason: str, source: str, source_port: str, target: str, target_port: str) -> str:
        """Add an edge from a node's output port to another node's input port.

        The target port must not already be fed, and the edge must not
        close a cycle. ``reason`` must be prose in the reply language — the ``reply_language`` input (≤10 words).

        Args:
            reason: Short rationale for the edit, in the reply language.
            source: Source node id.
            source_port: Output field name on the source node.
            target: Target node id.
            target_port: Input field name on the target node.

        Returns:
            An observation string: confirmation plus remaining structural
            issues on success, or a rejection message.
        """
        call_id, rejection = self._start("connect", reason)
        if rejection:
            return self._tool_result(call_id, "connect", ok=False, message=rejection)
        if self._node(source) is None or self._node(target) is None:
            return self._tool_result(
                call_id, "connect", ok=False, message="Edit rejected — unknown source or target node id."
            )
        if source == target:
            return self._tool_result(call_id, "connect", ok=False, message="Edit rejected — a node cannot feed itself.")
        for e in self._workflow["edges"]:
            if e.get("target") == target and e.get("target_port") == target_port:
                return self._tool_result(
                    call_id,
                    "connect",
                    ok=False,
                    message=(
                        f"Edit rejected — port '{target_port}' on '{target}' is already fed "
                        f"(by {e.get('source')}.{e.get('source_port')}). Disconnect it first."
                    ),
                )
        # Cycle iff source is already reachable from target.
        adjacency: dict[str, list[str]] = {}
        for e in self._workflow["edges"]:
            adjacency.setdefault(str(e.get("source")), []).append(str(e.get("target")))
        stack, seen = [target], set()
        while stack:
            cur = stack.pop()
            if cur == source:
                return self._tool_result(
                    call_id, "connect", ok=False, message="Edit rejected — that edge would close a cycle."
                )
            if cur in seen:
                continue
            seen.add(cur)
            stack.extend(adjacency.get(cur, []))
        self._workflow["edges"].append(
            {"source": source, "source_port": source_port, "target": target, "target_port": target_port}
        )
        return self._tool_result(
            call_id,
            "connect",
            ok=True,
            changed=target,
            message=f"Connected {source}.{source_port} → {target}.{target_port} ({self._issues_summary()}).",
        )

    def disconnect(self, reason: str, source: str, source_port: str, target: str, target_port: str) -> str:
        """Remove the edge between the given ports.

        ``reason`` must be prose in the reply language — the ``reply_language`` input (≤10 words).

        Args:
            reason: Short rationale for the edit, in the reply language.
            source: Source node id.
            source_port: Output field name on the source node.
            target: Target node id.
            target_port: Input field name on the target node.

        Returns:
            An observation string: confirmation plus remaining structural
            issues on success, or a rejection message.
        """
        call_id, rejection = self._start("disconnect", reason)
        if rejection:
            return self._tool_result(call_id, "disconnect", ok=False, message=rejection)
        before = len(self._workflow["edges"])
        self._workflow["edges"] = [
            e
            for e in self._workflow["edges"]
            if not (
                e.get("source") == source
                and e.get("source_port") == source_port
                and e.get("target") == target
                and e.get("target_port") == target_port
            )
        ]
        if len(self._workflow["edges"]) == before:
            return self._tool_result(call_id, "disconnect", ok=False, message="Edit rejected — no such edge.")
        return self._tool_result(
            call_id,
            "disconnect",
            ok=True,
            changed=target,
            message=f"Disconnected {source}.{source_port} → {target}.{target_port} ({self._issues_summary()}).",
        )

    def edit_metric(self, reason: str, new_code: str) -> str:
        """Replace the end-to-end metric function.

        The new code is validated before it's applied; a failed validation
        rejects the edit and returns the error so you can retry. ``reason``
        must be prose in the reply language — the ``reply_language`` input (≤10 words). ``new_code`` must return
        ``dspy.Prediction(score=..., feedback=...)``.

        Args:
            reason: Short rationale for the edit, in the reply language.
            new_code: Complete replacement metric function body.

        Returns:
            An observation string: confirmation on success or a rejection
            message on validation failure.
        """
        call_id = uuid.uuid4().hex[:8]
        self._emit({"event": "tool_start", "data": {"id": call_id, "tool": "edit_metric", "reason": reason or ""}})
        if self._metric_edits >= 1:
            self._emit({"event": "tool_end", "data": {"id": call_id, "tool": "edit_metric", "status": "error"}})
            return "Edit rejected — metric was already replaced this turn. Call finish."
        err = _validate_metric_code(new_code)
        if err:
            self._emit({"event": "tool_end", "data": {"id": call_id, "tool": "edit_metric", "status": "error"}})
            return f"Edit rejected — new_code is invalid: {err}. Fix the error and call edit_metric again."
        self._metric_code = new_code
        self._metric_edits += 1
        self._emit({"event": "metric_replace", "data": {"code": new_code}})
        self._emit({"event": "tool_end", "data": {"id": call_id, "tool": "edit_metric", "status": "ok"}})
        return "Metric replaced and validated. Do NOT edit the metric again this turn."


async def _run_agent(
    *,
    lm: dspy.LM,
    dataset_columns: list[str],
    column_roles_json: str,
    column_kinds_json: str,
    sample_rows_json: str,
    user_message: str,
    chat_history_json: str,
    prior_signature: str,
    prior_metric: str,
    prior_signature_validation: str,
    prior_metric_validation: str,
    initial_signature: str,
    initial_metric: str,
    reply_language: str,
    queue: asyncio.Queue[dict | None],
    steering: SteerInbox | None = None,
) -> dict[str, str]:
    """Run a ReAct agent with ``edit_signature`` + ``edit_metric`` tools.

    Tools are bound methods on a :class:`_CodeEditSession` that mutate the
    session's slot dict and emit SSE events (``tool_start``,
    ``signature_replace`` / ``metric_replace``, ``tool_end``) via
    ``loop.call_soon_threadsafe`` — DSPy may invoke tools from a worker
    thread, so we can't touch the asyncio queue directly.

    The final ``reply`` field is streamed as ``message_patch`` tokens and
    returned as ``assistant_message``. For reasoning-capable providers, the
    ReAct loop's inner ``next_thought`` predict emits ``reasoning_patch``
    tokens (with ``allow_reuse=True`` so the listener survives the loop).

    Args:
        lm: Language model bound to the ReAct loop.
        dataset_columns: All dataset column names.
        column_roles_json: JSON string mapping column → role.
        column_kinds_json: JSON string mapping input column → kind (text/image).
        sample_rows_json: JSON-encoded list of representative sample rows.
        user_message: The user's latest message driving the turn.
        chat_history_json: JSON-encoded prior chat turns.
        prior_signature: Signature source as currently shown in the editor.
        prior_metric: Metric source as currently shown in the editor.
        prior_signature_validation: Latest validator output for the signature.
        prior_metric_validation: Latest validator output for the metric.
        initial_signature: Original signature source before any edits this conversation.
        initial_metric: Original metric source before any edits this conversation.
        reply_language: Language name for the reply and tool rationales.
        queue: SSE event queue receiving lifecycle and token events.
        steering: The turn's inbox for messages the user sends while it
            runs; ``None`` leaves the turn unsteerable.

    Returns:
        Mapping with keys ``signature_code``, ``metric_code``, and
        ``assistant_message`` reflecting post-turn state.
    """
    loop = asyncio.get_running_loop()
    emit: Callable[[dict], None] = partial(_emit_to_code_queue, loop, queue)
    session = _CodeEditSession(
        signature_code=prior_signature,
        metric_code=prior_metric,
        emit=emit,
    )

    # Keep max_iters bounded. A normal turn is: (1) think → (2) edit_* OR
    # submit. The worst legitimate case edits both artifacts with one
    # validator-driven retry each (edit fails → edit succeeds, twice) plus
    # the submit that carries the reply — max_iters=5 covers that without
    # room to run away (the per-artifact success guards reject any further
    # edits).
    react = ActingReActV2(
        CodeAssistant,
        tools=[session.edit_signature, session.edit_metric],
        max_iters=5,
    )
    attach_steering(react, steering)
    # The user's ``reply`` rides a ``submit`` tool call; ``ReactReplyStream``
    # wires the listeners and decodes it into reply deltas.
    reply_stream = ReactReplyStream(react, "reply", lm)
    program = dspy.streamify(
        react,
        stream_listeners=reply_stream.listeners(),
        async_streaming=True,
    )

    inputs = {
        "dataset_columns": dataset_columns,
        "column_roles": column_roles_json,
        "column_kinds": column_kinds_json,
        "sample_rows": sample_rows_json,
        "current_signature": prior_signature,
        "current_metric": prior_metric,
        "current_signature_validation": prior_signature_validation or "",
        "current_metric_validation": prior_metric_validation or "",
        "initial_signature": initial_signature or prior_signature,
        "initial_metric": initial_metric or prior_metric,
        "chat_history": chat_history_json,
        "reply_language": reply_language,
        "user_message": user_message,
    }

    reply_text = ""
    prediction: dspy.Prediction | None = None
    with dspy.context(lm=lm):
        async for chunk in program(**inputs):
            if isinstance(chunk, dspy.streaming.StreamResponse):
                if chunk.signature_field_name == REASONING_FIELD:
                    await queue.put(
                        {
                            "event": "reasoning_patch",
                            "data": {"chunk": chunk.chunk, "source": "agent"},
                        }
                    )
                else:
                    delta = reply_stream.reply_delta(chunk)
                    if delta:
                        reply_text += delta
                        await queue.put({"event": "message_patch", "data": {"chunk": delta}})
            elif isinstance(chunk, dspy.Prediction):
                prediction = chunk
                final = getattr(chunk, "reply", "") or ""
                if final and final != reply_text:
                    reply_text = final
    _require_answer(prediction, reply_text)

    return {
        "signature_code": session.signature_code,
        "metric_code": session.metric_code,
        "assistant_message": reply_text,
    }


async def _run_workflow_seed(
    *,
    lm: dspy.LM,
    dataset_columns: list[str],
    column_roles_json: str,
    column_kinds_json: str,
    sample_rows_json: str,
    authoring_brief: str,
    reply_language: str,
    queue: asyncio.Queue[dict | None],
) -> dict[str, Any]:
    """Run the workflow seed: draft the full graph + the metric, then intro.

    The graph and metric generate in parallel. Metric tokens stream as
    ``metric_patch`` (same as the classic seed); the graph is emitted as a
    single ``workflow_replace`` snapshot once it parses and validates —
    with up to two LLM repair attempts against the exact validator error.

    Args:
        lm: The language model to drive the seed predictors.
        dataset_columns: All dataset column names.
        column_roles_json: JSON string mapping column → role.
        column_kinds_json: JSON string mapping input column → kind.
        sample_rows_json: JSON-encoded list of representative sample rows.
        authoring_brief: Interview directives both authors must honor; empty
            when no interview happened.
        reply_language: Language name the intro message is written in.
        queue: SSE event queue to push token events onto.

    Returns:
        Mapping with keys ``workflow`` (dict), ``metric_code``,
        ``assistant_message``, ``workflow_valid`` / ``metric_valid`` flags,
        and an optional ``validation_error``.
    """
    graph_predict = dspy.Predict(GenerateWorkflowGraph)
    graph_program = dspy.streamify(
        graph_predict,
        stream_listeners=[ReasoningStreamListener(predict=graph_predict)],
        async_streaming=True,
    )
    met_predict = dspy.Predict(GenerateMetricCode)
    met_program = dspy.streamify(
        met_predict,
        stream_listeners=[
            dspy.streaming.StreamListener(signature_field_name="metric_code"),
            ReasoningStreamListener(predict=met_predict),
        ],
        async_streaming=True,
    )

    shared_inputs = {
        "dataset_columns": dataset_columns,
        "column_roles": column_roles_json,
        "column_kinds": column_kinds_json,
        "sample_rows": sample_rows_json,
        "authoring_brief": authoring_brief,
    }
    results: dict[str, Any] = {"workflow": None, "metric_code": "", "assistant_message": ""}

    async def _pump_graph() -> None:
        """Stream the graph predictor, forwarding reasoning and capturing the JSON."""
        async for chunk in graph_program(**shared_inputs):
            if isinstance(chunk, dspy.streaming.StreamResponse):
                if chunk.signature_field_name == REASONING_FIELD:
                    await queue.put(
                        {
                            "event": "reasoning_patch",
                            "data": {"chunk": chunk.chunk, "source": "workflow"},
                        }
                    )
            elif isinstance(chunk, dspy.Prediction):
                results["workflow_json"] = getattr(chunk, "workflow_json", "") or ""

    with dspy.context(lm=lm):
        # Two independent lanes (mirrors the classic seed): the graph and the
        # metric each parse/validate/repair as soon as their OWN stream ends,
        # so neither waits on the slower author before starting its checks.
        async def _graph_lane() -> str:
            """Stream the graph author, then parse/validate/repair its JSON."""
            await _pump_graph()
            raw_json = str(results.pop("workflow_json", "") or "")
            spec_dict, error = _parse_workflow_json(raw_json)
            if spec_dict is not None:
                error = await asyncio.to_thread(_validate_workflow_dict, spec_dict)
            fixer = dspy.Predict(FixWorkflowGraph)
            for _attempt in range(2):
                if not error:
                    break
                pred = await asyncio.to_thread(
                    fixer,
                    broken_workflow_json=raw_json if spec_dict is None else json.dumps(spec_dict, ensure_ascii=False),
                    validation_error=error,
                    dataset_columns=dataset_columns,
                    column_roles=column_roles_json,
                )
                raw_json = getattr(pred, "fixed_workflow_json", "") or ""
                spec_dict, error = _parse_workflow_json(raw_json)
                if spec_dict is not None:
                    error = await asyncio.to_thread(_validate_workflow_dict, spec_dict)

            if spec_dict is not None:
                results["workflow"] = spec_dict
                await queue.put({"event": "workflow_replace", "data": {"workflow": spec_dict, "changed_node_id": None}})
            results["workflow_valid"] = not error
            return error

        async def _metric_lane() -> tuple[str, str]:
            """Stream the metric, then validate/repair it immediately."""
            await _pump_seed_stream(
                met_program,
                shared_inputs,
                "metric_code",
                "metric_patch",
                queue=queue,
                results=results,
                reasoning_source="metric",
            )
            return await _validate_and_repair_artifact(
                lm=lm,
                artifact_kind="metric",
                code=results["metric_code"],
                validator=_validate_metric_code,
                dataset_columns=dataset_columns,
                column_roles_json=column_roles_json,
                queue=queue,
                replace_event="metric_replace",
            )

        error, (met_code, met_err) = await asyncio.gather(_graph_lane(), _metric_lane())
        results["metric_code"] = met_code
        results["metric_valid"] = not met_err
        if error or met_err:
            parts = []
            if error:
                parts.append(f"Workflow: {error}")
            if met_err:
                parts.append(f"Metric: {met_err}")
            results["validation_error"] = " | ".join(parts)

        msg_predict = dspy.Predict(GenerateWorkflowSeedMessage)
        msg_program = dspy.streamify(
            msg_predict,
            stream_listeners=[dspy.streaming.StreamListener(signature_field_name="assistant_message")],
            async_streaming=True,
        )
        async for chunk in msg_program(
            workflow_json=json.dumps(results["workflow"] or {}, ensure_ascii=False),
            metric_code=results["metric_code"],
            reply_language=reply_language,
        ):
            if isinstance(chunk, dspy.streaming.StreamResponse):
                if chunk.signature_field_name == "assistant_message":
                    await queue.put({"event": "message_patch", "data": {"chunk": chunk.chunk}})
            elif isinstance(chunk, dspy.Prediction):
                results["assistant_message"] = getattr(chunk, "assistant_message", "") or ""

    return results


async def _run_workflow_agent(
    *,
    lm: dspy.LM,
    dataset_columns: list[str],
    column_roles_json: str,
    sample_rows_json: str,
    user_message: str,
    chat_history_json: str,
    prior_workflow: dict,
    prior_metric: str,
    initial_workflow: dict | None,
    reply_language: str,
    queue: asyncio.Queue[dict | None],
    steering: SteerInbox | None = None,
) -> dict[str, Any]:
    """Run a ReAct agent with graph tools over the canvas workflow.

    Mirrors :func:`_run_agent`, swapping the signature/metric pair for a
    :class:`_WorkflowEditSession` whose tools mutate the graph dict and
    emit ``workflow_replace`` snapshots (plus ``metric_replace`` for the
    shared metric tool).

    Args:
        lm: Language model bound to the ReAct loop.
        dataset_columns: All dataset column names.
        column_roles_json: JSON string mapping column → role.
        sample_rows_json: JSON-encoded list of representative sample rows.
        user_message: The user's latest message driving the turn.
        chat_history_json: JSON-encoded prior chat turns.
        prior_workflow: Graph spec currently on the canvas.
        prior_metric: Metric source as currently shown in the editor.
        initial_workflow: Original graph before any edits this conversation.
        reply_language: Language name for the reply and tool rationales.
        queue: SSE event queue receiving lifecycle and token events.
        steering: The turn's inbox for messages the user sends while it
            runs; ``None`` leaves the turn unsteerable.

    Returns:
        Mapping with keys ``workflow`` (dict), ``metric_code``, and
        ``assistant_message`` reflecting post-turn state.
    """
    loop = asyncio.get_running_loop()
    emit: Callable[[dict], None] = partial(_emit_to_code_queue, loop, queue)
    session = _WorkflowEditSession(workflow=prior_workflow, metric_code=prior_metric, emit=emit)

    workflow_validation = await asyncio.to_thread(_validate_workflow_dict, prior_workflow)

    # A graph restructure is several ops (disconnect + add + reconnects),
    # each its own ReAct iteration; 8 covers a two-step insert with a
    # validation retry without room to run away.
    react = ActingReActV2(
        WorkflowAssistant,
        tools=[
            session.add_node,
            session.update_node,
            session.remove_node,
            session.connect,
            session.disconnect,
            session.edit_metric,
        ],
        max_iters=8,
    )
    attach_steering(react, steering)
    reply_stream = ReactReplyStream(react, "reply", lm)
    program = dspy.streamify(
        react,
        stream_listeners=reply_stream.listeners(),
        async_streaming=True,
    )

    inputs = {
        "dataset_columns": dataset_columns,
        "column_roles": column_roles_json,
        "sample_rows": sample_rows_json,
        "current_workflow": json.dumps(prior_workflow, ensure_ascii=False),
        "current_metric": prior_metric,
        "current_workflow_validation": workflow_validation or "OK",
        "initial_workflow": json.dumps(initial_workflow or prior_workflow, ensure_ascii=False),
        "chat_history": chat_history_json,
        "reply_language": reply_language,
        "user_message": user_message,
    }

    reply_text = ""
    prediction: dspy.Prediction | None = None
    with dspy.context(lm=lm):
        async for chunk in program(**inputs):
            if isinstance(chunk, dspy.streaming.StreamResponse):
                if chunk.signature_field_name == REASONING_FIELD:
                    await queue.put(
                        {
                            "event": "reasoning_patch",
                            "data": {"chunk": chunk.chunk, "source": "agent"},
                        }
                    )
                else:
                    delta = reply_stream.reply_delta(chunk)
                    if delta:
                        reply_text += delta
                        await queue.put({"event": "message_patch", "data": {"chunk": delta}})
            elif isinstance(chunk, dspy.Prediction):
                prediction = chunk
                final = getattr(chunk, "reply", "") or ""
                if final and final != reply_text:
                    reply_text = final
    _require_answer(prediction, reply_text)

    final_error = await asyncio.to_thread(_validate_workflow_dict, session.workflow)
    return {
        "workflow": session.workflow,
        "workflow_valid": not final_error,
        **({"validation_error": f"Workflow: {final_error}"} if final_error else {}),
        "metric_code": session.metric_code,
        "assistant_message": reply_text,
    }


def _unified_inputs(unified: dict[str, Any]) -> dict[str, Any]:
    """Map the wizard's authoring context onto the unified signatures' shared inputs.

    Args:
        unified: The wizard's :class:`~core.models.UnifiedAuthoringContext` as a dict.

    Returns:
        Every input field the unified signatures declare (each signature
        takes the subset it names; see :func:`_inputs_for`).
    """
    task = unified.get("task") or {}
    artifact = task.get("artifact") or {}
    version = artifact.get("starting_version", "")
    run_contract, metric_contract = _unified_contracts(unified)
    case_fields = [str(f) for f in unified.get("input_fields") or []]
    return {
        "objective": str(task.get("objective", "")).strip(),
        "background": str(task.get("background", "") or "").strip(),
        "artifact_kind": str(artifact.get("kind", "prompt")),
        "starting_version": version if isinstance(version, str) else json.dumps(version, ensure_ascii=False),
        "case_fields": case_fields,
        "expected_field": str(unified.get("expected_field") or ""),
        "sample_cases": json.dumps(
            [_project_case(case, case_fields) for case in (unified.get("sample_cases") or [])[:5]],
            ensure_ascii=False,
            default=str,
        ),
        "metric_shape": str(unified.get("metric_shape", "blackbox_side_info")),
        "run_contract": run_contract,
        "metric_contract": metric_contract,
    }


def _project_case(case: Any, case_fields: list[str]) -> Any:
    """Keep only the declared input fields of one sample case's ``input``.

    The run hands ``run`` exactly the declared fields, so a sample carrying
    other columns would teach the agent to read keys the contract check and
    the optimization never pass.

    Args:
        case: One ``{"input": {...}, "expected": ...}`` sample case.
        case_fields: The declared input field names.

    Returns:
        The case with its ``input`` narrowed to ``case_fields``, or the case
        unchanged when it has no input dict or no fields are declared.
    """
    if not case_fields or not isinstance(case, dict) or not isinstance(case.get("input"), dict):
        return case
    return {**case, "input": {k: v for k, v in case["input"].items() if k in case_fields}}


def _inputs_for(signature: type[dspy.Signature], values: dict[str, Any]) -> dict[str, Any]:
    """Pick the inputs ``signature`` declares out of ``values``.

    Args:
        signature: The DSPy signature about to be called.
        values: A superset of its inputs.

    Returns:
        Only the keys ``signature`` declares as input fields.
    """
    return {name: values[name] for name in signature.input_fields if name in values}


def _unified_validators(unified: dict[str, Any]) -> tuple[Callable[[str], str], Callable[[str], str]]:
    """Bind the run-code and metric checks to the wizard's setup.

    Args:
        unified: The wizard's authoring context as a dict.

    Returns:
        ``(run_validator, metric_validator)``, each returning an error message or ``""``.
    """
    kind = str((unified.get("task") or {}).get("artifact", {}).get("kind", "prompt"))
    return (
        partial(_validate_run_code, artifact_kind=kind),
        partial(
            _validate_unified_metric_code,
            metric_shape=str(unified.get("metric_shape", "blackbox_side_info")),
            metric_has_model=bool(unified.get("metric_has_model")),
        ),
    )


def _unified_column_roles(unified: dict[str, Any]) -> tuple[list[str], str]:
    """Describe the case fields to the repair predictor in its column vocabulary.

    Args:
        unified: The wizard's authoring context as a dict.

    Returns:
        ``(columns, column_roles_json)`` — input fields as ``input`` and the
        expected field, when any, as ``output``.
    """
    roles = {str(f): "input" for f in unified.get("input_fields") or []}
    if unified.get("expected_field"):
        roles[str(unified["expected_field"])] = "output"
    return list(roles), json.dumps(roles, ensure_ascii=False)


async def _run_unified_seed(
    *,
    lm: dspy.LM,
    unified: dict[str, Any],
    authoring_brief: str,
    reply_language: str,
    queue: asyncio.Queue[dict | None],
    locale: str | None = None,
) -> dict[str, Any]:
    """Draft the wizard's run code and metric in parallel, then the intro message.

    The run code streams as ``signature_patch`` and the metric as
    ``metric_patch`` — the wizard's editors sit on the same slots as the
    DSPy Signature / metric — and the finished pair is returned under
    ``signature_code`` / ``metric_code`` for the same reason. Both get the
    static contract check + repair loop, and each lane then emits
    ``artifact_done`` with its ``source`` (``signature`` / ``metric``).

    Args:
        lm: The language model driving the seed predictors.
        unified: The wizard's authoring context as a dict.
        authoring_brief: Directives both authors must honor; empty when none.
        reply_language: Language name the intro message is written in.
        queue: SSE event queue to push token events onto.
        locale: UI locale the timeout error is written in; ``None`` is Hebrew.

    Returns:
        Mapping with keys ``signature_code`` (the run code), ``metric_code``,
        ``assistant_message``, the boolean ``signature_valid`` /
        ``metric_valid`` flags, and an optional ``validation_error`` string
        when either could not be repaired within the attempt budget.

    Raises:
        SeedLaneTimeoutError: When a lane runs past
            ``SEED_LANE_TIMEOUT_SECONDS``; the other lane is cancelled.
    """
    shared = {**_unified_inputs(unified), "authoring_brief": authoring_brief}
    run_validator, metric_validator = _unified_validators(unified)
    columns, roles_json = _unified_column_roles(unified)
    lanes = {
        "run": (GenerateRunCode, "run_code", "signature_patch", "signature", run_validator, "signature_replace"),
        "metric": (GenerateUnifiedMetric, "metric_code", "metric_patch", "metric", metric_validator, "metric_replace"),
    }
    streamed: dict[str, Any] = {"run_code": "", "metric_code": ""}
    msg_predict = dspy.Predict(GenerateUnifiedSeedMessage)
    msg_program = dspy.streamify(
        msg_predict,
        stream_listeners=[dspy.streaming.StreamListener(signature_field_name="assistant_message")],
        async_streaming=True,
    )

    with dspy.context(lm=lm):

        async def _lane(name: str) -> tuple[str, str]:
            """Run one lane under its deadline."""
            try:
                async with asyncio.timeout(SEED_LANE_TIMEOUT_SECONDS):
                    return await _draft(name)
            except TimeoutError:
                logger.warning("unified seed %s lane passed its %ss deadline", name, SEED_LANE_TIMEOUT_SECONDS)
                raise SeedLaneTimeoutError(t_locale(locale, "code_agent.seed_lane_timeout")) from None

        async def _draft(name: str) -> tuple[str, str]:
            """Stream one artifact, then check/repair it against its contract."""
            signature, field, event, source, validator, replace_event = lanes[name]
            predict = dspy.Predict(signature)
            program = dspy.streamify(
                predict,
                stream_listeners=[
                    dspy.streaming.StreamListener(signature_field_name=field),
                    ReasoningStreamListener(predict=predict),
                ],
                async_streaming=True,
            )
            await _pump_seed_stream(
                program,
                _inputs_for(signature, shared),
                field,
                event,
                queue=queue,
                results=streamed,
                reasoning_source=source,
            )
            checked = await _validate_and_repair_artifact(
                lm=lm,
                artifact_kind=name,
                code=streamed[field],
                validator=validator,
                dataset_columns=columns,
                column_roles_json=roles_json,
                queue=queue,
                replace_event=replace_event,
            )
            # The lanes run in parallel and can finish minutes apart, so each
            # reports its own end rather than the UI guessing from the other's tokens.
            await queue.put({"event": "artifact_done", "data": {"source": source}})
            return checked

        try:
            async with asyncio.TaskGroup() as lanes_group:
                run_task = lanes_group.create_task(_lane("run"))
                metric_task = lanes_group.create_task(_lane("metric"))
        except BaseExceptionGroup as group:
            raise group.exceptions[0] from None
        run_code, run_err = run_task.result()
        metric_code, metric_err = metric_task.result()
        results: dict[str, Any] = {
            "signature_code": run_code,
            "metric_code": metric_code,
            "assistant_message": "",
            "signature_valid": not run_err,
            "metric_valid": not metric_err,
        }
        errors = [f"Run code: {run_err}"] if run_err else []
        if metric_err:
            errors.append(f"Metric: {metric_err}")
        if errors:
            results["validation_error"] = "\n".join(errors)

        async for chunk in msg_program(
            objective=shared["objective"],
            run_code=run_code,
            metric_code=metric_code,
            reply_language=reply_language,
        ):
            if isinstance(chunk, dspy.streaming.StreamResponse):
                if chunk.signature_field_name == "assistant_message":
                    await queue.put({"event": "message_patch", "data": {"chunk": chunk.chunk}})
            elif isinstance(chunk, dspy.Prediction):
                results["assistant_message"] = getattr(chunk, "assistant_message", "") or ""

    return results


async def _run_unified_agent(
    *,
    lm: dspy.LM,
    unified: dict[str, Any],
    user_message: str,
    chat_history_json: str,
    prior_run: str,
    prior_metric: str,
    prior_validation: str,
    initial_run: str,
    initial_metric: str,
    reply_language: str,
    queue: asyncio.Queue[dict | None],
    steering: SteerInbox | None = None,
) -> dict[str, str]:
    """Run the wizard's ReAct agent with ``ask_user``/``set_brief``/``edit_run``/``edit_metric``.

    Tools are bound methods on a :class:`_UnifiedEditSession` that emit
    ``tool_start`` / ``signature_replace`` (run code) or ``metric_replace``
    (metric) / ``tool_end`` thread-safely, and the ``reply`` streams as
    ``message_patch`` tokens.

    Args:
        lm: Language model bound to the ReAct loop.
        unified: The wizard's authoring context as a dict.
        user_message: The user's latest message driving the turn.
        chat_history_json: JSON-encoded prior chat turns.
        prior_run: Run code as currently shown in the editor.
        prior_metric: Metric as currently shown in the editor.
        prior_validation: Latest check summary for both artifacts.
        initial_run: Original run code before any edits this conversation.
        initial_metric: Original metric before any edits this conversation.
        reply_language: Language name for the reply and tool rationales.
        queue: SSE event queue receiving lifecycle and token events.
        steering: The turn's inbox for messages the user sends while it
            runs; ``None`` leaves the turn unsteerable.

    Returns:
        Mapping with keys ``signature_code`` (the run code), ``metric_code``
        and ``assistant_message`` reflecting post-turn state.
    """
    loop = asyncio.get_running_loop()
    run_validator, metric_validator = _unified_validators(unified)
    session = _UnifiedEditSession(
        run_code=prior_run,
        metric_code=prior_metric,
        emit=partial(_emit_to_code_queue, loop, queue),
        run_validator=run_validator,
        metric_validator=metric_validator,
    )
    tools: list[Callable[..., str]] = [session.ask_user, session.set_brief, session.edit_run, session.edit_metric]
    # Both artifacts edited with one validator-driven retry each, a brief and
    # a question, before the reply.
    react = ActingReActV2(UnifiedAssistant, tools=tools, max_iters=8)
    attach_steering(react, steering)
    reply_stream = ReactReplyStream(react, "reply", lm)
    program = dspy.streamify(react, stream_listeners=reply_stream.listeners(), async_streaming=True)

    values = {
        **_unified_inputs(unified),
        "focus": "metric" if unified.get("focus") == "metric" else "run",
        "current_run": prior_run,
        "current_metric": prior_metric,
        "current_validation": prior_validation or "",
        "initial_run": initial_run or prior_run,
        "initial_metric": initial_metric or prior_metric,
        "chat_history": chat_history_json,
        "reply_language": reply_language,
        "user_message": user_message,
    }

    reply_text = ""
    prediction: dspy.Prediction | None = None
    with dspy.context(lm=lm):
        async for chunk in program(**_inputs_for(UnifiedAssistant, values)):
            if isinstance(chunk, dspy.streaming.StreamResponse):
                if chunk.signature_field_name == REASONING_FIELD:
                    await queue.put({"event": "reasoning_patch", "data": {"chunk": chunk.chunk, "source": "agent"}})
                else:
                    delta = reply_stream.reply_delta(chunk)
                    if delta:
                        reply_text += delta
                        await queue.put({"event": "message_patch", "data": {"chunk": delta}})
            elif isinstance(chunk, dspy.Prediction):
                prediction = chunk
                final = getattr(chunk, "reply", "") or ""
                if final and final != reply_text:
                    reply_text = final
    _require_answer(prediction, reply_text)

    return {
        "signature_code": session.run_code,
        "metric_code": session.metric_code,
        "assistant_message": reply_text,
    }


async def _run_code_agent_orchestration(
    *,
    is_seed: bool,
    lm: dspy.LM,
    model_name: str,
    queue: asyncio.Queue[dict | None],
    dataset_columns: list[str],
    column_roles_json: str,
    column_kinds_json: str,
    sample_rows_json: str,
    authoring_brief: str,
    user_message: str,
    chat_history_json: str,
    prior_signature: str,
    prior_metric: str,
    prior_signature_validation: str,
    prior_metric_validation: str,
    initial_signature: str,
    initial_metric: str,
    prior_workflow: dict | None,
    initial_workflow: dict | None,
    reply_language: str,
    unified: dict[str, Any] | None,
    steering: SteerInbox | None = None,
    locale: str | None = None,
) -> None:
    """Run the seed or chat path and push the terminal envelope into ``queue``.

    A non-None ``unified`` runs the run-code + metric seed or chat path and
    a non-None ``prior_workflow`` the graph-aware ones. Without either, a
    chat turn runs the DSPy Signature agent (:func:`_run_agent`, kept for
    the MCP ``edit_code`` tool) and a seed fails: there is no Signature
    seed, every first draft goes through the one run-code contract. Emits
    exactly one terminal event (``done`` on success, ``error`` on failure)
    followed by the ``None`` sentinel that unblocks the outer consumer.

    Args:
        is_seed: True to run the seed path; False to run the chat agent.
        lm: Language model bound to the chosen runner.
        model_name: Catalog model id requested for this turn.
        queue: SSE event queue.
        dataset_columns: All dataset column names.
        column_roles_json: JSON string mapping column → role.
        column_kinds_json: JSON string mapping input column → kind.
        sample_rows_json: JSON-encoded list of sample rows.
        authoring_brief: Interview directives the seed authors must honor;
            empty when no interview happened (seed paths only).
        user_message: User's latest message (empty in seed mode).
        chat_history_json: JSON-encoded prior chat turns.
        prior_signature: Current Signature source in the editor.
        prior_metric: Current metric source in the editor.
        prior_signature_validation: Latest signature validator output.
        prior_metric_validation: Latest metric validator output.
        initial_signature: Original signature source for revert support.
        initial_metric: Original metric source for revert support.
        reply_language: Language name for all user-facing agent text.
        unified: The wizard's authoring context; ``None`` for the DSPy
            paths. Set, the ``prior_*`` / ``initial_*`` signature and metric
            slots hold the run code and the metric.
        steering: The turn's inbox for messages the user sends while it
            runs; ``None`` leaves the turn unsteerable.
        locale: UI locale of the client, for errors the engine words itself.
    """
    try:
        if unified is not None and is_seed:
            results = await _run_unified_seed(
                lm=lm,
                unified=unified,
                authoring_brief=authoring_brief,
                reply_language=reply_language,
                queue=queue,
                locale=locale,
            )
        elif unified is not None:
            validation = "\n".join(v for v in (prior_signature_validation, prior_metric_validation) if v)
            results = await _run_unified_agent(
                lm=lm,
                unified=unified,
                user_message=user_message,
                chat_history_json=chat_history_json,
                prior_run=prior_signature,
                prior_metric=prior_metric,
                prior_validation=validation,
                initial_run=initial_signature,
                initial_metric=initial_metric,
                reply_language=reply_language,
                queue=queue,
                steering=steering,
            )
        elif is_seed and prior_workflow is not None:
            results = await _run_workflow_seed(
                lm=lm,
                dataset_columns=dataset_columns,
                column_roles_json=column_roles_json,
                column_kinds_json=column_kinds_json,
                sample_rows_json=sample_rows_json,
                authoring_brief=authoring_brief,
                reply_language=reply_language,
                queue=queue,
            )
        elif prior_workflow is not None:
            results = await _run_workflow_agent(
                lm=lm,
                dataset_columns=dataset_columns,
                column_roles_json=column_roles_json,
                sample_rows_json=sample_rows_json,
                user_message=user_message,
                chat_history_json=chat_history_json,
                prior_workflow=prior_workflow,
                prior_metric=prior_metric,
                initial_workflow=initial_workflow,
                reply_language=reply_language,
                queue=queue,
                steering=steering,
            )
        elif is_seed:
            raise ValueError("A first draft needs the authoring context (unified) or a workflow graph.")
        else:
            results = await _run_agent(
                lm=lm,
                dataset_columns=dataset_columns,
                column_roles_json=column_roles_json,
                column_kinds_json=column_kinds_json,
                sample_rows_json=sample_rows_json,
                user_message=user_message,
                chat_history_json=chat_history_json,
                prior_signature=prior_signature,
                prior_metric=prior_metric,
                prior_signature_validation=prior_signature_validation,
                prior_metric_validation=prior_metric_validation,
                initial_signature=initial_signature,
                initial_metric=initial_metric,
                reply_language=reply_language,
                queue=queue,
                steering=steering,
            )
        payload = dict(results)
        payload.setdefault("model", model_name)
        payload["served_model"] = served_model_from(lm)
        await queue.put({"event": "done", "data": payload})
    except Exception as exc:
        logger.exception("Code agent failed")
        await queue.put({"event": "error", "data": _agent_error_payload(exc)})
    finally:
        await queue.put(None)


async def run_code_agent(
    *,
    dataset_columns: list[str],
    column_roles: dict[str, str],
    column_kinds: dict[str, str] | None = None,
    sample_rows: list[dict],
    user_message: str,
    chat_history: list[dict] | None = None,
    prior_signature: str,
    prior_metric: str,
    prior_signature_validation: str = "",
    prior_metric_validation: str = "",
    initial_signature: str = "",
    initial_metric: str = "",
    prior_workflow: dict | None = None,
    initial_workflow: dict | None = None,
    interview_brief: list[str] | None = None,
    locale: str | None = None,
    model: str | None = None,
    reasoning_effort: str | None = None,
    usage_sink: list | None = None,
    unified: dict[str, Any] | None = None,
    steer_owner: str | None = None,
    steer_key: str | None = None,
) -> AsyncGenerator[dict, None]:
    """Stream code-agent events to the UI.

    When ``user_message`` is empty → seed path (parallel run code + metric
    drafts, which needs ``unified`` or ``prior_workflow``). When set → chat
    path (ReAct). Both paths share the same ``done`` / ``error`` envelope
    and the same ``reasoning_patch`` event for reasoning-capable providers.

    A non-None ``prior_workflow`` switches both modes to their graph-aware
    counterparts: the seed drafts a full workflow graph (emitted as one
    ``workflow_replace`` snapshot) and the chat agent gets graph tools
    (``add_node``/``update_node``/``remove_node``/``connect``/``disconnect``
    plus the shared ``edit_metric``), each successful op emitting a fresh
    ``workflow_replace`` — ``{"workflow", "changed_node_id"}`` — so the
    canvas re-renders atomically. The ``done`` payload then carries
    ``workflow`` + ``workflow_valid`` instead of ``signature_code``.

    A non-None ``unified`` switches both modes to the submission wizard's
    workspace paths: the seed drafts the run code and the metric in the
    shape the chosen optimizer needs, the chat agent gets ``ask_user`` /
    ``set_brief`` / ``edit_run`` / ``edit_metric``. The run code rides the
    signature events and slots (``signature_patch`` / ``signature_replace``
    / ``signature_code``) and the metric the metric ones, so the wizard's
    editors share one wire contract; ``dataset_columns`` / ``sample_rows``
    are unused (the context carries the input fields and sample cases).

    Events:

    * ``signature_patch`` / ``metric_patch`` — seed-mode token streams.
    * ``reasoning_patch`` — provider thinking tokens (both modes).
    * ``tool_start`` — ``{id, tool, reason}``, before a tool is invoked.
    * ``signature_replace`` / ``metric_replace`` — ``{code}``, full
      replacement when a tool runs.
    * ``tool_end`` — ``{id, tool, status}``, after the tool returns.
    * ``message_patch`` — chat-mode reply token stream.
    * ``done`` — ``{signature_code, metric_code, assistant_message, model,
      served_model}``; the seed path additionally carries ``signature_valid`` /
      ``metric_valid`` booleans and an optional ``validation_error``.
    * ``error`` — ``{error}``.

    Args:
        dataset_columns: All dataset column names.
        column_roles: Mapping of column name to role (input/output/ignore).
        column_kinds: Optional mapping of input column to kind (text/image).
        sample_rows: Up to 5 representative dataset rows.
        user_message: User's latest message; empty triggers seed mode.
        chat_history: Prior {role, content} chat turns.
        prior_signature: Signature source currently shown in the editor.
        prior_metric: Metric source currently shown in the editor.
        prior_signature_validation: Latest signature validator output.
        prior_metric_validation: Latest metric validator output.
        initial_signature: Original signature source for revert support.
        initial_metric: Original metric source for revert support.
        prior_workflow: Workflow graph currently on the canvas; non-None
            switches to the graph-aware seed/chat paths.
        initial_workflow: Original graph for revert support.
        interview_brief: Directives from the Signature & Metric interview;
            honored by the seed authors (seed paths only).
        locale: UI locale code of the client; sets the language of every
            user-facing agent string (replies, intro messages, tool
            rationales). Unknown or missing falls back to Hebrew.
        model: LiteLLM id of the model that authors the code, resolved from
            the composer's model menu. ``None`` runs the server default
            (``settings.code_agent_model``).
        reasoning_effort: Explicit reasoning-effort level for ``model``;
            ``None`` keeps the model's default.
        usage_sink: Optional list the built LM is appended to, so the caller
            can meter the turn's token usage on any exit path.
        unified: The wizard's :class:`~core.models.UnifiedAuthoringContext`
            as a dict; ``None`` runs the DSPy paths.
        steer_owner: Username whose mid-turn messages this turn reads.
        steer_key: Client-chosen key those messages are posted under; with
            ``steer_owner`` it makes a chat turn steerable.

    Yields:
        SSE event dicts of shape ``{"event": str, "data": dict}``.
    """
    is_seed = not user_message.strip()
    lm = _build_agent_lm(model, reasoning_effort, SEED_MAX_TOKENS if is_seed and unified is not None else 32000)
    model_name = model or agent_model_id(settings.code_agent_model)
    if usage_sink is not None:
        usage_sink.append(lm)
    column_roles_json = json.dumps(column_roles, ensure_ascii=False)
    column_kinds_json = json.dumps(column_kinds or {}, ensure_ascii=False)
    sample_rows_json = json.dumps(sample_rows[:5], ensure_ascii=False, default=str)
    chat_history_json = json.dumps(chat_history or [], ensure_ascii=False)
    authoring_brief = "\n".join(f"- {d.strip()}" for d in (interview_brief or []) if d.strip())

    queue: asyncio.Queue[dict | None] = asyncio.Queue()
    steering = (
        SteerInbox(
            owner=steer_owner,
            steer_key=steer_key,
            input_field="user_message",
            emit=partial(_emit_to_code_queue, asyncio.get_running_loop(), queue),
            store=get_steer_store(),
        )
        if steer_owner and steer_key and not is_seed
        else None
    )

    task = asyncio.create_task(
        _run_code_agent_orchestration(
            is_seed=is_seed,
            lm=lm,
            model_name=model_name,
            queue=queue,
            dataset_columns=dataset_columns,
            column_roles_json=column_roles_json,
            column_kinds_json=column_kinds_json,
            sample_rows_json=sample_rows_json,
            authoring_brief=authoring_brief,
            user_message=user_message,
            chat_history_json=chat_history_json,
            prior_signature=prior_signature,
            prior_metric=prior_metric,
            prior_signature_validation=prior_signature_validation,
            prior_metric_validation=prior_metric_validation,
            initial_signature=initial_signature,
            initial_metric=initial_metric,
            prior_workflow=prior_workflow,
            initial_workflow=initial_workflow,
            reply_language=_reply_language(locale),
            unified=unified,
            steering=steering,
            locale=locale,
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
