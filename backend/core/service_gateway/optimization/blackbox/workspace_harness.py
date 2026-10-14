"""In-sandbox harness for unified workspace code: the run code, then the metric.

This file is shipped verbatim into the scorer sandbox as
``skynet_workspace_harness.py``, next to ``skynet_runner.py``, whose gateway
client, helper module and image wrapper it reuses. Like the runner it depends
on the standard library alone (``dspy`` is imported only for a DSPy program)
and stays valid Python 3.9.

Every artifact kind runs one contract: the run code defines
``run(artifact, input)`` and the metric defines ``score(input, output,
expected=None)`` returning ``(score, side_info)``. For a DSPy program the run
code builds its ``dspy.Module`` at module level and calls it inside ``run``;
the harness finds that module (:func:`find_program`), applies the candidate's
instructions and state to it and binds the task model as its LM.

Protocol: JSON lines. The first message initializes the workspace::

    {"run_code": str, "metric_code": str, "files": {path: str}, "artifact_kind": str,
     "input_fields": [str], "gateways": {"task": {...} | null, "metric": {...} | null}}

and is answered with ``{"ready": true}`` or a load error. Every later
``{"candidate": ..., "case": {"input": {...}, "expected": ...}}`` is answered
with ``{"output_preview", "score", "side_info", "usage"}`` or
``{"error", "stage": "run" | "metric" | "shape", "detail", "usage"}``.
``error`` is ``"<Type>: <message>"`` and is all an optimizer may ever see;
``detail`` adds the user-code frames for the person who wrote the code.

The run code and the candidate never share a process with the metric: each
call runs them in a fresh child interpreter (``--run-child``) that receives
only the run code, its extra workspace files, the task model, the candidate
and the case's inputs, and answers with the output as JSON. The extra files
(helpers ``run.py`` imports) are written to a fresh temporary directory at the
front of the child's ``sys.path`` and removed when the child is done; the
metric's process never sees them. Candidate-written code (a ``code`` artifact
the run code executes) therefore cannot read the metric source, the
expected value or the metric model's key, and a run-stage ``error`` is cut to
one short line.

The run and metric code arrive only inside the message stream and are never
written to a file. ``python3 skynet_workspace_harness.py`` reads the stream from stdin;
with ``--env`` it reads it from base64 chunks in ``SKYNET_WS_STREAM_<n>``
environment variables, because the sandbox API runs one command at a time
without stdin, and drops them from the environment before user code runs.
Replies go to the original stdout prefixed with :data:`REPLY_PREFIX`; user
prints go to stderr.
"""

from __future__ import annotations

import base64
import contextlib
import ctypes
import importlib
import importlib.util
import inspect
import json
import linecache
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, TextIO

try:
    from . import runner as _runner
except ImportError:
    try:
        import skynet_runner as _runner  # type: ignore[no-redef]
    except ImportError:
        # The run child is this file run as a script from the package
        # directory (tests, local runs), where the runner is ``runner.py``.
        _spec = importlib.util.spec_from_file_location("skynet_runner", Path(__file__).resolve().parent / "runner.py")
        _runner = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type,no-redef]
        sys.modules["skynet_runner"] = _runner
        _spec.loader.exec_module(_runner)  # type: ignore[union-attr]

REPLY_PREFIX = "SKYNET_WS_REPLY "
ENV_STREAM_PREFIX = "SKYNET_WS_STREAM_"
ENV_STREAM_COUNT = "SKYNET_WS_STREAM_COUNT"
ENV_TASK_API_KEY = "SKYNET_TASK_API_KEY"
ENV_METRIC_API_KEY = "SKYNET_METRIC_API_KEY"
RUN_FILENAME = "<run_code>"
METRIC_FILENAME = "<metric_code>"
DETAIL_MAX_CHARS = 4000
RUN_ERROR_MAX_CHARS = 300
RUN_CHILD_FLAG = "--run-child"
# Mirrors ``unified.dspy_engine.DSPY_STATE_KEY``; this file runs alone in the box.
DSPY_STATE_KEY = "__dspy_state__"
PREVIEW_MAX_CHARS = 2000
ARTIFACT_KIND_DSPY_PROGRAM = "dspy_program"
RUN_ENTRY_NAME = "run"
METRIC_ENTRY_NAME = "score"
# When the run code holds several modules, the one under this name is the program.
PROGRAM_NAME = "program"
_USER_FILENAMES = (RUN_FILENAME, METRIC_FILENAME)
FILES_DIR_PREFIX = "skynet_ws_files_"
# The run child's extra-files directory, so tracebacks name a helper file by
# its workspace path. Set only inside a run child.
_files_dir: str | None = None
_NUMBER_TYPES = (bool, int, float)
_PR_SET_DUMPABLE = 4


class ShapeError(Exception):
    """The metric returned a value other than ``(score, side_info)``."""


def user_detail(exc: BaseException) -> str:
    """Render an exception with only the frames of the user's own code.

    Args:
        exc: The exception raised while running user code.

    Returns:
        A traceback-style text, at most :data:`DETAIL_MAX_CHARS` characters.
    """
    frames = []
    for frame in traceback.extract_tb(exc.__traceback__):
        if frame.filename in _USER_FILENAMES:
            frames.append(frame)
        elif _files_dir is not None and frame.filename.startswith(_files_dir + os.sep):
            frame.filename = frame.filename[len(_files_dir) + 1 :].replace(os.sep, "/")
            frames.append(frame)
    lines = ["Traceback (user code):\n", *traceback.format_list(frames)] if frames else []
    lines.extend(traceback.format_exception_only(type(exc), exc))
    text = "".join(lines).rstrip()
    return text if len(text) <= DETAIL_MAX_CHARS else text[-DETAIL_MAX_CHARS:]


def error_text(exc: BaseException) -> str:
    """Return ``"<Type>: <message>"``, the only error form an optimizer sees.

    Args:
        exc: The exception raised while running user code.

    Returns:
        The exception's type name and message.
    """
    return f"{type(exc).__name__}: {exc}"


def run_error_text(exc: BaseException) -> str:
    """Return the short form of a run-stage failure an optimizer may see.

    Candidate code chooses the exception message, so only its first line,
    capped at :data:`RUN_ERROR_MAX_CHARS`, ever leaves the run child.

    Args:
        exc: The exception raised by the run code or the candidate.

    Returns:
        ``"<Type>: <first line of the message>"``, capped.
    """
    lines = str(exc).strip().splitlines()
    text = f"{type(exc).__name__}: {lines[0] if lines else ''}".rstrip()
    return text[:RUN_ERROR_MAX_CHARS]


def preview(value: Any) -> str:
    """Return a short readable rendering of a run output.

    Args:
        value: Whatever the run code returned.

    Returns:
        JSON when the value serializes, else ``repr``, capped in length.
    """
    if hasattr(value, "toDict"):
        value = value.toDict()
    try:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        text = repr(value)
    return text[:PREVIEW_MAX_CHARS]


def positional_capacity(fn: Callable[..., Any]) -> int:
    """Count how many positional arguments ``fn`` can take.

    Args:
        fn: A user function.

    Returns:
        The count, or a large number when it takes ``*args``.
    """
    params = inspect.signature(fn).parameters.values()
    if any(param.kind is param.VAR_POSITIONAL for param in params):
        return 1_000
    return sum(param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD) for param in params)


def _is_number(value: Any) -> bool:
    """Return True for a real number or boolean, never a numeric string."""
    return isinstance(value, _NUMBER_TYPES)


def normalize_metric(raw: Any) -> tuple[float, dict[str, Any]]:
    """Validate a metric's ``(score, side_info)`` return value and normalize it.

    Args:
        raw: What ``score`` returned.

    Returns:
        The score and side info, which always carries a ``feedback`` string.

    Raises:
        ShapeError: When the value is not ``(score, side_info)``.
    """
    if not isinstance(raw, (tuple, list)) or len(raw) != 2:
        raise ShapeError(f"expected (score, side_info), got {type(raw).__name__}")
    score, side_info = raw
    if not _is_number(score) or not isinstance(side_info, dict) or not isinstance(side_info.get("feedback"), str):
        raise ShapeError("expected a numeric score and a side_info dict with a feedback string")
    scores = side_info.get("scores")
    if scores is not None and (
        not isinstance(scores, dict) or not all(isinstance(k, str) and _is_number(v) for k, v in scores.items())
    ):
        raise ShapeError("side_info['scores'] must map names to numbers")
    plain = json.loads(json.dumps(side_info, default=_runner.side_info_json_default))
    return float(score), plain


def find_program(namespace: dict[str, Any], module_type: type) -> Any:
    """Find the DSPy module the run code builds at module level and calls in ``run``.

    Args:
        namespace: The executed run code's namespace.
        module_type: ``dspy.Module``.

    Returns:
        The single module-level ``dspy.Module`` instance, or the one named
        :data:`PROGRAM_NAME` when there are several.

    Raises:
        NameError: When the run code holds no module, or several and none is
            named :data:`PROGRAM_NAME`.
    """
    found: dict[int, tuple[str, Any]] = {}
    for name, value in namespace.items():
        if isinstance(value, module_type) and not name.startswith("__"):
            found.setdefault(id(value), (name, value))
    if len(found) == 1:
        return next(iter(found.values()))[1]
    named = namespace.get(PROGRAM_NAME)
    if isinstance(named, module_type):
        return named
    if not found:
        raise NameError(
            "the run code builds no dspy.Module: create it at module level "
            f"({PROGRAM_NAME} = MyProgram()) and call it inside run(artifact, input)"
        )
    names = ", ".join(sorted(name for name, _ in found.values()))
    raise NameError(f"the run code builds several dspy.Modules ({names}): name the one to optimize {PROGRAM_NAME}")


def apply_dspy_candidate(program: Any, candidate: Any) -> None:
    """Set a DSPy program's state and predictor instructions from a candidate.

    Args:
        program: The ``dspy.Module`` to update in place.
        candidate: ``{predictor name: instruction}``, optionally with the full
            program state under :data:`DSPY_STATE_KEY`; a plain string sets
            every predictor's instruction.
    """
    if isinstance(candidate, dict) and candidate.get(DSPY_STATE_KEY):
        # The compiled program's demos live here; instructions alone would
        # score a different program than the one that is saved.
        program.load_state(json.loads(candidate[DSPY_STATE_KEY]))
    for name, predictor in program.named_predictors():
        text = candidate if isinstance(candidate, str) else (candidate or {}).get(name)
        if text is not None:
            predictor.signature = predictor.signature.with_instructions(str(text))


def run_artifact(candidate: Any) -> Any:
    """Return the candidate as ``run`` receives it: without the serialized program state.

    Args:
        candidate: The version under optimization.

    Returns:
        The candidate, minus :data:`DSPY_STATE_KEY` when it is a mapping.
    """
    if isinstance(candidate, dict) and DSPY_STATE_KEY in candidate:
        return {key: value for key, value in candidate.items() if key != DSPY_STATE_KEY}
    return candidate


def _client(gateway: Any, key_env: str) -> Any:
    """Build the ``llm`` helper for one model, or ``None`` when no model is set.

    Args:
        gateway: The runner-shaped gateway section, if any.
        key_env: Environment variable holding this model's key when the edge does not inject it.

    Returns:
        A gateway client, or ``None``.
    """
    if not isinstance(gateway, dict):
        return None
    return _runner.GatewayClient(
        str(gateway["url"]),
        str(gateway["model"]),
        api_key=gateway.get("api_key") or os.environ.get(key_env),
        temperature=gateway.get("temperature"),
        max_tokens=gateway.get("max_tokens"),
        reasoning_effort=gateway.get("reasoning_effort"),
        timeout_seconds=float(gateway.get("timeout_seconds") or 120.0),
        protected=bool(gateway.get("protected")),
    )


def _helpers(client: Any) -> Any:
    """Build the ``skynet`` module one piece of user code imports from.

    Args:
        client: The model this code's ``llm`` calls, or ``None``.

    Returns:
        The helper module.
    """
    return _runner.helper_module(
        {
            _runner.LLM_HELPER_NAME: client if client is not None else _runner.missing_llm,
            _runner.IMAGE_HELPER_NAME: _runner.Image,
            _runner.LOG_HELPER_NAME: _runner.log,
        }
    )


def _load(code: str, filename: str, module: Any) -> dict[str, Any]:
    """Execute user code with its own ``skynet`` module and return its namespace.

    Args:
        code: User-authored source, held in memory only.
        filename: Pseudo filename its frames carry.
        module: The ``skynet`` helper module for this code.

    Returns:
        The executed namespace.
    """
    # Registered in memory so the user's tracebacks show their own source lines.
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
    namespace: dict[str, Any] = dict(module.__dict__)
    sys.modules[_runner.HELPER_MODULE_NAME] = module
    exec(compile(code, filename, "exec", dont_inherit=True), namespace)
    return namespace


class _ProgramLM:
    """Factory for a ``dspy.BaseLM`` that sends every request through the task ``llm`` client."""

    @staticmethod
    def build(dspy: Any, client: Any, model: str) -> Any:
        """Return a DSPy LM bound to ``client``.

        Args:
            dspy: The imported ``dspy`` module.
            client: The task model's gateway client.
            model: Model id, for DSPy's history.

        Returns:
            A ``dspy.BaseLM`` instance.
        """

        class GatewayLM(dspy.BaseLM):
            """A DSPy LM whose requests go through the harness gateway client."""

            def forward(self, prompt: Any = None, messages: Any = None, **kwargs: Any) -> Any:
                """Complete one request and return an OpenAI-shaped response."""
                text = client(messages=messages or [{"role": "user", "content": str(prompt)}])
                message = type("Message", (), {"content": text})()
                choice = type("Choice", (), {"message": message})()
                return type("Response", (), {"choices": [choice], "usage": {}, "model": self.model})()

        return GatewayLM(model=model, cache=False)


def _plain_output(output: Any) -> tuple[Any, bool]:
    """Turn a run output into JSON-safe data the metric process can rebuild.

    Args:
        output: Whatever the run code returned.

    Returns:
        The JSON-safe value and whether it was a ``dspy.Prediction``.
    """
    is_prediction = hasattr(output, "toDict") and type(output).__name__ == "Prediction"
    value = output.toDict() if hasattr(output, "toDict") else output
    return json.loads(json.dumps(value, default=_runner.side_info_json_default)), is_prediction


class RunStage:
    """The run code, loaded in the run child with the task model as its ``llm``."""

    def __init__(self, message: dict[str, Any]) -> None:
        """Load the run code from the child's message.

        Args:
            message: ``{"run_code", "artifact_kind", "gateway"}``.

        Raises:
            BaseException: Whatever the run code raises while loading.
        """
        self.kind = str(message.get("artifact_kind") or "text")
        gateway = message.get("gateway")
        self.task_llm = _client(gateway, ENV_TASK_API_KEY)
        self.task_model = str((gateway or {}).get("model") or "task")
        self.program: Any = None
        self.program_lm: Any = None
        self.namespace = _load(str(message.get("run_code") or ""), RUN_FILENAME, _helpers(self.task_llm))

    def run(self, candidate: Any, inputs: dict[str, Any]) -> Any:
        """Produce the output for one case with the candidate applied.

        Args:
            candidate: The version under optimization.
            inputs: The case's input fields.

        Returns:
            What ``run(artifact, input)`` returned.
        """
        run = _entry(self.namespace, RUN_ENTRY_NAME)
        if self.kind != ARTIFACT_KIND_DSPY_PROGRAM:
            return run(candidate, inputs)
        dspy = importlib.import_module("dspy")
        if self.program is None:
            self.program = find_program(self.namespace, dspy.Module)
            if self.task_llm is not None:
                self.program_lm = _ProgramLM.build(dspy, self.task_llm, self.task_model)
        apply_dspy_candidate(self.program, candidate)
        if self.program_lm is None:
            return run(run_artifact(candidate), inputs)
        with dspy.context(lm=self.program_lm):
            return run(run_artifact(candidate), inputs)


def _safe_relative(path: str) -> bool:
    """Return whether ``path`` stays inside the directory it is joined to.

    Args:
        path: An extra file's workspace path; the API validated it already.

    Returns:
        True for a relative ``/``-separated path with no empty, ``.`` or ``..`` part.
    """
    parts = path.split("/")
    return bool(path) and not path.startswith("/") and "\\" not in path and all(p not in ("", ".", "..") for p in parts)


def write_files(files: dict[str, Any]) -> str:
    """Write the extra workspace files to a fresh directory.

    Args:
        files: Path to text of every extra file.

    Returns:
        The directory, to put at the front of ``sys.path``.

    Raises:
        ValueError: When a path would leave the directory.
    """
    root = tempfile.mkdtemp(prefix=FILES_DIR_PREFIX)
    for path, text in files.items():
        if not _safe_relative(str(path)):
            shutil.rmtree(root, ignore_errors=True)
            raise ValueError(f"unsafe workspace path: {path!r}")
        target = Path(root).joinpath(*str(path).split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(text), encoding="utf-8")
    return root


def run_child(message: dict[str, Any]) -> dict[str, Any]:
    """Run one case's run stage; the body of the ``--run-child`` process.

    Args:
        message: ``{"run_code", "files", "artifact_kind", "gateway", "candidate", "inputs"}``.

    Returns:
        ``{"output", "prediction", "output_preview", "usage"}``, or
        ``{"error", "detail", "usage"}``, or ``{"control", "usage"}``.
    """
    global _files_dir
    stage: RunStage | None = None
    reply: dict[str, Any]
    files = message.get("files") or {}
    try:
        if files:
            _files_dir = os.path.realpath(write_files(dict(files)))
            sys.path.insert(0, _files_dir)
        stage = RunStage(message)
        output = stage.run(message.get("candidate"), dict(message.get("inputs") or {}))
        plain, is_prediction = _plain_output(output)
        reply = {"output": plain, "prediction": is_prediction, "output_preview": preview(output)}
    except _runner.GatewayControl as exc:
        reply = {"control": {"code": exc.code, "message": str(exc)}}
    except BaseException as exc:  # user code is arbitrary — any failure is reported, not raised
        reply = {"error": run_error_text(exc), "detail": user_detail(exc)}
    finally:
        if _files_dir is not None:
            shutil.rmtree(_files_dir, ignore_errors=True)
    client = stage.task_llm if stage is not None else None
    if client is not None and client.control is not None:
        reply = {"control": client.control}
    reply["usage"] = list(client.usage) if client is not None else []
    return reply


def _child_env() -> dict[str, str]:
    """Return the run child's environment: no message stream, no metric key."""
    return {
        name: value
        for name, value in os.environ.items()
        if not name.startswith(ENV_STREAM_PREFIX) and name not in (ENV_STREAM_COUNT, ENV_METRIC_API_KEY)
    }


def _entry(namespace: dict[str, Any], name: str) -> Callable[..., Any]:
    """Return a required user function.

    Args:
        namespace: The executed code's namespace.
        name: The function's required name.

    Returns:
        The callable.

    Raises:
        NameError: When the code defines no such name.
        TypeError: When the name is not callable.
    """
    fn = namespace.get(name)
    if fn is None:
        raise NameError(f"the code does not define {name}()")
    if not callable(fn):
        raise TypeError(f"{name} is not a function")
    return fn


class Workspace:
    """One loaded workspace: the metric here, the run code in a child per call."""

    def __init__(self, init: dict[str, Any]) -> None:
        """Load the metric and check the run code compiles.

        Args:
            init: The first protocol message.
        """
        self.kind = str(init.get("artifact_kind") or "text")
        gateways = init.get("gateways") or {}
        self.run_code = str(init.get("run_code") or "")
        self.files = dict(init.get("files") or {})
        self.task_gateway = gateways.get("task")
        self.metric_llm = _client(gateways.get("metric"), ENV_METRIC_API_KEY)
        self.metric_module = _helpers(self.metric_llm)
        self.load_error: dict[str, Any] | None = None
        self.metric_ns: dict[str, Any] = {}
        stage = "run"
        try:
            # Compiling never runs anything: a syntax error is reported once
            # here, everything else surfaces in the run child.
            compile(self.run_code, RUN_FILENAME, "exec", dont_inherit=True)
            stage = "metric"
            if self.kind == ARTIFACT_KIND_DSPY_PROGRAM:
                # Imported before any run child exists, so nothing a child
                # writes can stand in for it in this process.
                importlib.import_module("dspy")
            self.metric_ns = _load(str(init.get("metric_code") or ""), METRIC_FILENAME, self.metric_module)
        except _runner.GatewayControl as exc:
            self.load_error = {"control": {"code": exc.code, "message": str(exc)}}
        except BaseException as exc:  # user code is arbitrary — any failure is reported, not raised
            error = run_error_text(exc) if stage == "run" else error_text(exc)
            self.load_error = {"error": error, "stage": stage, "detail": user_detail(exc)}

    def _bind(self, module: Any) -> None:
        """Point ``import skynet`` at the helpers of the code about to run."""
        sys.modules[_runner.HELPER_MODULE_NAME] = module

    def _run(self, candidate: Any, inputs: dict[str, Any]) -> dict[str, Any]:
        """Run the run stage for one case in a fresh child interpreter.

        Args:
            candidate: The version under optimization.
            inputs: The case's input fields; the expected value never goes to the child.

        Returns:
            The child's reply (see :func:`run_child`).
        """
        message = {
            "run_code": self.run_code,
            "files": self.files,
            "artifact_kind": self.kind,
            "gateway": self.task_gateway,
            "candidate": candidate,
            "inputs": inputs,
        }
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), RUN_CHILD_FLAG],
            input=json.dumps(message, default=_runner.side_info_json_default),
            stdout=subprocess.PIPE,
            env=_child_env(),
            text=True,
            check=False,
        )
        replies = parse_replies(result.stdout or "")
        if not replies:
            return {
                "error": f"RuntimeError: the run code exited with status {result.returncode} without a result",
                "detail": f"the run process exited with status {result.returncode}",
                "usage": [],
            }
        return replies[-1]

    def _metric(self, inputs: dict[str, Any], output: Any, expected: Any) -> Any:
        """Call ``score(input, output, expected=None)``.

        Args:
            inputs: The case's input fields.
            output: The run output.
            expected: The case's expected value, if any.

        Returns:
            The metric's raw return value.
        """
        fn = _entry(self.metric_ns, METRIC_ENTRY_NAME)
        return fn(inputs, output, expected) if positional_capacity(fn) >= 3 else fn(inputs, output)

    def _usage(self, task_usage: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
        """Combine the run child's task usage with the metric's usage since the last reply.

        Args:
            task_usage: What the run child reported for the task model.

        Returns:
            ``{"task": [...], "metric": [...]}`` for the roles that have a model.
        """
        usage: dict[str, list[dict[str, Any]]] = {}
        if self.task_gateway is not None:
            usage["task"] = list(task_usage)
        if self.metric_llm is not None:
            usage["metric"] = list(self.metric_llm.usage)
            self.metric_llm.usage.clear()
        return usage

    def handle(self, message: dict[str, Any]) -> dict[str, Any]:
        """Run one case through the run code (in a child) and the metric (here).

        Args:
            message: ``{"candidate": ..., "case": {...}}``.

        Returns:
            The reply document.
        """
        if self.load_error is not None:
            return {**self.load_error, "usage": self._usage([])}
        case = message.get("case") or {}
        inputs = dict(case.get("input") or {}) if isinstance(case, dict) else {}
        expected = case.get("expected") if isinstance(case, dict) else None
        ran = self._run(message.get("candidate"), inputs)
        task_usage = list(ran.get("usage") or [])
        if isinstance(ran.get("control"), dict):
            return {"control": ran["control"], "usage": self._usage(task_usage)}
        if ran.get("error") is not None:
            return {
                "error": str(ran["error"])[:RUN_ERROR_MAX_CHARS],
                "stage": "run",
                "detail": str(ran.get("detail") or "")[-DETAIL_MAX_CHARS:],
                "usage": self._usage(task_usage),
            }
        output = ran.get("output")
        if ran.get("prediction"):
            output = importlib.import_module("dspy").Prediction(**(output or {}))
        reply: dict[str, Any] = {"output_preview": ran.get("output_preview")}
        stage = "metric"
        try:
            self._bind(self.metric_module)
            raw = self._metric(inputs, output, expected)
            stage = "shape"
            score, side_info = normalize_metric(raw)
            reply.update(score=score, side_info=side_info)
        except _runner.GatewayControl as exc:
            reply = {"control": {"code": exc.code, "message": str(exc)}}
        except ShapeError as exc:
            reply.update(error=str(exc), stage="shape", detail=str(exc))
        except BaseException as exc:  # user code is arbitrary — any failure is reported, not raised
            reply.update(error=error_text(exc), stage=stage, detail=user_detail(exc))
        if self.metric_llm is not None and self.metric_llm.control is not None:
            reply = {"control": self.metric_llm.control}
        reply["usage"] = self._usage(task_usage)
        return reply


def serve(lines: Iterable[str], out: TextIO) -> None:
    """Answer every protocol message in ``lines`` on ``out``.

    Args:
        lines: JSON lines; the first is the init message.
        out: Where prefixed replies are written.
    """
    workspace: Workspace | None = None
    for line in lines:
        if not line.strip():
            continue
        message = json.loads(line)
        if workspace is None:
            workspace = Workspace(message)
            reply: dict[str, Any] = workspace.load_error or {"ready": True}
        else:
            reply = workspace.handle(message)
        out.write(REPLY_PREFIX + json.dumps(reply, default=_runner.side_info_json_default) + "\n")
        out.flush()


def env_stream() -> list[str]:
    """Decode the message stream from the environment and remove it from there.

    Returns:
        The protocol lines.
    """
    count = int(os.environ.pop(ENV_STREAM_COUNT, "0") or 0)
    text = "".join(
        base64.b64decode(os.environ.pop(f"{ENV_STREAM_PREFIX}{index}", "")).decode("utf-8") for index in range(count)
    )
    return text.splitlines()


def encode_stream(messages: Iterable[dict[str, Any]], chunk_chars: int = 100_000) -> dict[str, str]:
    """Encode protocol messages into the environment ``--env`` reads.

    Args:
        messages: The init message, then the calls.
        chunk_chars: Largest single variable; one variable must stay under the kernel's per-string limit.

    Returns:
        The environment variables carrying the stream.
    """
    text = "".join(json.dumps(message, default=_runner.side_info_json_default) + "\n" for message in messages)
    encoded = base64.b64encode(text.encode("utf-8")).decode("ascii")
    chunks = [encoded[start : start + chunk_chars] for start in range(0, len(encoded), chunk_chars)] or [""]
    return {ENV_STREAM_COUNT: str(len(chunks)), **{f"{ENV_STREAM_PREFIX}{i}": c for i, c in enumerate(chunks)}}


def parse_replies(stdout: str) -> list[dict[str, Any]]:
    """Return the harness replies found in a command's stdout.

    Args:
        stdout: The captured output.

    Returns:
        Each decoded reply, in order.
    """
    return [json.loads(line[len(REPLY_PREFIX) :]) for line in stdout.splitlines() if line.startswith(REPLY_PREFIX)]


def _forbid_inspection() -> None:
    """Make this process non-dumpable so a run child cannot read its memory or environment.

    The message stream (metric source, expected values) stays readable in
    ``/proc/<pid>/environ`` after it is popped from ``os.environ``; a
    non-dumpable process denies that and ``/proc/<pid>/mem`` to other
    processes of the same user. A no-op where ``prctl`` does not exist.
    """
    with contextlib.suppress(AttributeError, OSError):
        ctypes.CDLL(None).prctl(_PR_SET_DUMPABLE, 0, 0, 0, 0)


def main(argv: list[str] | None = None) -> int:
    """Serve the stream from stdin, or from the environment with ``--env``.

    With ``--run-child`` this process is a run child instead: it reads one
    run message from stdin and writes one reply.

    Args:
        argv: Command-line arguments; ``sys.argv`` when unset.

    Returns:
        The process exit code.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    out = sys.stdout
    # User prints must never be mistaken for replies.
    sys.stdout = sys.stderr
    if RUN_CHILD_FLAG in args:
        reply = run_child(json.loads(sys.stdin.read()))
        out.write(REPLY_PREFIX + json.dumps(reply, default=_runner.side_info_json_default) + "\n")
        out.flush()
        return 0
    _forbid_inspection()
    lines: Iterable[str] = env_stream() if "--env" in args else sys.stdin
    serve(lines, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
