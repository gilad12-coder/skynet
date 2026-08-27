"""Agent-target scoring: run the harness in a sandbox, then score the run record.

Every evaluation of an agent target is one sandbox. The wrapper writes the
harness under test (the version) and the case into a fresh box, installs
and runs the agent, collects what it produced, destroys the box, and hands
a run record to the user's scorer in place of the case. The scorer judges
what the agent did — its answer, transcript, exit code, an optional
in-sandbox check — rather than the version text itself.
"""

from __future__ import annotations

import json
import logging
import posixpath
import re
import threading
import time
from typing import Any

from ....config import Settings
from ....exceptions import ServiceError
from ....models.blackbox import BlackboxTarget
from .harness import ANSWER_FILE, PROMPT_FILE, GatewayConfig, HarnessLaunch, build_launch
from .protocol import Candidate, ScorerFn, SideInfo
from .sandbox import CommandResult, SandboxRuntime, SandboxSession, SandboxSpec, sandbox_unavailable_reason

logger = logging.getLogger(__name__)

_GATEWAY_MISSING = (
    "Agent targets need a model gateway the sandboxes can reach: set BLACKBOX_AGENT_GATEWAY_URL and "
    "BLACKBOX_AGENT_GATEWAY_API_KEY (or LITELLM_PROXY_URL and LITELLM_PROXY_API_KEY)."
)

# Case keys that carry the task text for the agent, in priority order.
PROMPT_KEYS = ("prompt", "task", "input", "question", "instruction")
# Case keys with meaning to the runner rather than the agent.
FILES_KEY = "files"
CHECK_KEY = "check_command"
# Time allowed for installing the harness, the case's setup and its check, on top of the run timeout.
_SETUP_ALLOWANCE_SECONDS = 600.0
# Vercel's ceiling on a sandbox's lifetime (45 minutes).
_MAX_LIFETIME_SECONDS = 2_700.0
_OUTPUT_CHARS = 20_000
_TRANSCRIPT_CHARS = 4_000
_STEP_CHARS = 6_000
_FEEDBACK_OUTPUT_CHARS = 2_000
_FEEDBACK_TRANSCRIPT_CHARS = 1_500
_CHECK_OUTPUT_CHARS = 2_000
_NAME_UNSAFE = re.compile(r"[^a-z0-9-]+")


def gateway_from_settings(settings: Settings) -> GatewayConfig | None:
    """Resolve where sandboxed harnesses send their model calls, or ``None`` when unset.

    The dedicated agent-gateway settings win; the LiteLLM proxy settings are
    the fallback, since that proxy already fronts managed inference.

    Args:
        settings: The backend settings.

    Returns:
        The gateway, or ``None`` when no URL/key pair is configured.
    """
    url = settings.blackbox_agent_gateway_url or settings.litellm_proxy_url
    key = settings.blackbox_agent_gateway_api_key or settings.litellm_proxy_api_key
    if not url or key is None:
        return None
    return GatewayConfig(url=url.rstrip("/"), api_key=key.get_secret_value())


def agent_target_unavailable_reason(settings: Settings) -> str | None:
    """Explain why this deployment cannot run agent targets, or return ``None``.

    Args:
        settings: The backend settings.

    Returns:
        A user-facing reason (no sandboxes, or no gateway), or ``None``.
    """
    reason = sandbox_unavailable_reason(settings)
    if reason is not None:
        return reason
    if gateway_from_settings(settings) is None:
        return _GATEWAY_MISSING
    return None


def safe_relative_path(path: Any) -> str:
    """Normalize a workspace-relative path, refusing anything that could escape it.

    Args:
        path: The path as the case or version gave it.

    Returns:
        The normalized relative path.

    Raises:
        ServiceError: When the path is empty, absolute, or climbs out of the workspace.
    """
    if not isinstance(path, str) or not path.strip():
        raise ServiceError("file paths must be non-empty strings")
    normalized = posixpath.normpath(path.strip())
    if normalized.startswith(("/", "../")) or normalized in (".", ".."):
        raise ServiceError(f"file path '{path}' must stay inside the workspace")
    return normalized


def candidate_files(candidate: Candidate, instructions_file: str) -> dict[str, str]:
    """Map a version onto the files it becomes in the sandbox.

    Args:
        candidate: Text (the harness's instruction file) or named parts (one file each).
        instructions_file: Where the harness reads its instructions.

    Returns:
        Relative path → content.
    """
    if isinstance(candidate, str):
        return {instructions_file: candidate}
    return {safe_relative_path(path): text for path, text in candidate.items()}


def case_files(case: Any) -> dict[str, str]:
    """Return the files a case ships into the sandbox.

    Args:
        case: The case; only a dict with a ``files`` mapping contributes.

    Returns:
        Relative path → content.

    Raises:
        ServiceError: When ``files`` is not a mapping or a path is unsafe.
    """
    if not isinstance(case, dict):
        return {}
    files = case.get(FILES_KEY) or {}
    if not isinstance(files, dict):
        raise ServiceError(f"case '{FILES_KEY}' must map relative paths to text")
    return {safe_relative_path(path): str(content) for path, content in files.items()}


def case_prompt(case: Any) -> str:
    """Render the task text the agent reads, with the answer-file instruction appended.

    Args:
        case: The case; the first of :data:`PROMPT_KEYS` present is the task
            text, otherwise the case is shown as JSON.

    Returns:
        The prompt file's content.
    """
    text: str | None = None
    if isinstance(case, dict):
        for key in PROMPT_KEYS:
            value = case.get(key)
            if isinstance(value, str) and value.strip():
                text = value
                break
        if text is None:
            visible = {key: value for key, value in case.items() if key not in (FILES_KEY, CHECK_KEY)}
            text = json.dumps(visible, indent=2, default=str)
    elif case is not None:
        text = str(case)
    else:
        text = "Follow the instructions you were given."
    return (
        f"{text.rstrip()}\n\n---\n"
        f"When you are done, write your final answer to `{ANSWER_FILE}` (create the directory if needed). "
        "Only that file is scored."
    )


def _clip(text: str, limit: int) -> str:
    """Keep the head of ``text``.

    Args:
        text: Any text.
        limit: Maximum characters.

    Returns:
        ``text`` or its first ``limit`` characters with an ellipsis.
    """
    return text if len(text) <= limit else text[:limit] + "…"


def _tail(text: str, limit: int) -> str:
    """Keep the tail of ``text``.

    Args:
        text: Any text.
        limit: Maximum characters.

    Returns:
        ``text`` or its last ``limit`` characters with an ellipsis.
    """
    return text if len(text) <= limit else "…" + text[-limit:]


def _format_step(label: str, result: CommandResult) -> str:
    """Render one command's outcome for the transcript.

    Args:
        label: ``install``, ``setup``, ``run`` or ``check``.
        result: The command's outcome.

    Returns:
        A bounded transcript block.
    """
    status = f"exit={result.exit_code}" + (" (timed out)" if result.timed_out else "")
    body = "\n".join(part for part in (result.stdout.rstrip(), result.stderr.rstrip()) if part)
    return f"[{label}] {status}\n{_tail(body, _STEP_CHARS)}".rstrip()


class SandboxAgentScorer:
    """Scorer wrapper for agent targets: one sandbox per ``(version, case)``.

    Callable like any scorer. The wrapped scorer receives the run record
    where it would receive the case; the record keeps the case under
    ``"case"``.
    """

    def __init__(
        self,
        scorer: ScorerFn,
        *,
        runtime: SandboxRuntime,
        target: BlackboxTarget,
        gateway: GatewayConfig,
        job_id: str | None = None,
    ) -> None:
        """Bind the wrapper to a sandbox runtime and the job's target.

        Args:
            scorer: The user's scorer, called with ``(version, run_record)``.
            runtime: Creates the sandboxes.
            target: Harness, model, timeouts and commands.
            gateway: Where the harness sends its model calls.
            job_id: Tags the sandboxes with the job, when known.
        """
        self._scorer = scorer
        self._runtime = runtime
        self._target = target
        self._launch: HarnessLaunch = build_launch(target, gateway)
        self._job_id = job_id
        # Sandboxes run in parallel, but the user's scorer (a metric-sandbox
        # process or a remote call) is not promised to be thread-safe.
        self._scorer_lock = threading.Lock()

    def __call__(self, candidate: Candidate, case: Any = None) -> tuple[float, SideInfo]:
        """Run the agent on ``case`` with ``candidate`` as its harness, then score the record.

        Args:
            candidate: The harness version.
            case: The task the agent works on.

        Returns:
            The score and the scorer's side information plus the run's feedback.
        """
        record = self.run(candidate, case)
        with self._scorer_lock:
            score, side_info = self._scorer(candidate, record)
        return score, {**side_info, **self.feedback(record)}

    @staticmethod
    def feedback(record: dict[str, Any]) -> SideInfo:
        """Distill a run record into what a proposer needs to see.

        Args:
            record: A run record from :meth:`run`.

        Returns:
            Bounded output, transcript tail, exit code, usage and any error/check.
        """
        feedback: SideInfo = {
            "agent_output": _clip(record["output"] or "", _FEEDBACK_OUTPUT_CHARS),
            "transcript_tail": _tail(record["transcript"], _FEEDBACK_TRANSCRIPT_CHARS),
            "exit_code": record["exit_code"],
            "elapsed_seconds": record["elapsed_seconds"],
            "usage": record["usage"],
        }
        if record["error"] is not None:
            feedback["error"] = record["error"]
        if record["check"] is not None:
            feedback["check"] = record["check"]
        return feedback

    def run(self, candidate: Candidate, case: Any = None) -> dict[str, Any]:
        """Run the agent once in a fresh sandbox and return the run record.

        Args:
            candidate: The harness version.
            case: The task the agent works on.

        Returns:
            ``case``, ``output`` (the answer file, else the parsed final
            message), ``transcript``, ``exit_code``, ``timed_out``,
            ``elapsed_seconds``, ``check``, ``usage`` and ``error``.

        Raises:
            ServiceError: When the version or case ships an unsafe path.
            Exception: Whatever the sandbox runtime raises when the box cannot
                be created or driven; the eval server turns that into a floor score.
        """
        launch = self._launch
        files = {
            **launch.files,
            **candidate_files(candidate, launch.instructions_file),
            **case_files(case),
            PROMPT_FILE: case_prompt(case),
        }
        spec = SandboxSpec(
            lifetime_seconds=min(self._target.timeout_seconds + _SETUP_ALLOWANCE_SECONDS, _MAX_LIFETIME_SECONDS),
            env=launch.env,
            name=self._sandbox_name(),
            tags={"skynet_job": self._job_id} if self._job_id else {},
        )
        record: dict[str, Any] = {
            "case": case,
            "output": None,
            "transcript": "",
            "exit_code": None,
            "timed_out": False,
            "elapsed_seconds": 0.0,
            "check": None,
            "usage": {},
            "error": None,
        }
        transcript: list[str] = []
        started = time.perf_counter()
        session = self._runtime.open(spec)
        try:
            self._execute(session, files, case, record, transcript)
        finally:
            session.close()
            record["transcript"] = _tail("\n".join(transcript), _TRANSCRIPT_CHARS)
            record["elapsed_seconds"] = round(time.perf_counter() - started, 3)
        return record

    def _execute(
        self,
        session: SandboxSession,
        files: dict[str, str],
        case: Any,
        record: dict[str, Any],
        transcript: list[str],
    ) -> None:
        """Drive one open sandbox through install → setup → run → check.

        Args:
            session: The open sandbox.
            files: Everything to write before the first command.
            case: The task, for its optional ``check_command``.
            record: Filled in place.
            transcript: Appended with one block per command.
        """
        session.write_files(files)
        for label, command in (("install", self._launch.install_command), ("setup", self._target.setup_command)):
            if not command:
                continue
            result = session.run(command, timeout_seconds=_SETUP_ALLOWANCE_SECONDS)
            transcript.append(_format_step(label, result))
            if not result.ok:
                record["exit_code"], record["timed_out"] = result.exit_code, result.timed_out
                record["error"] = f"{label} command failed (exit {result.exit_code})"
                return
        result = session.run(self._launch.run_command, timeout_seconds=self._target.timeout_seconds)
        transcript.append(_format_step("run", result))
        record["exit_code"], record["timed_out"] = result.exit_code, result.timed_out
        answer = session.read_file(ANSWER_FILE)
        parsed, usage = self._launch.parse_output(result.stdout)
        record["usage"] = usage
        output = answer if answer is not None and answer.strip() else parsed
        record["output"] = None if output is None else _clip(output, _OUTPUT_CHARS)
        if result.timed_out:
            record["error"] = f"agent timed out after {self._target.timeout_seconds:g}s"
        elif not result.ok:
            record["error"] = f"agent exited with code {result.exit_code}"
        elif record["output"] is None:
            record["error"] = "agent produced no answer"
        check = case.get(CHECK_KEY) if isinstance(case, dict) else None
        if isinstance(check, str) and check.strip():
            checked = session.run(check, timeout_seconds=_SETUP_ALLOWANCE_SECONDS)
            transcript.append(_format_step("check", checked))
            record["check"] = {
                "passed": checked.ok,
                "exit_code": checked.exit_code,
                "output": _tail(
                    "\n".join(part for part in (checked.stdout, checked.stderr) if part), _CHECK_OUTPUT_CHARS
                ),
            }

    def _sandbox_name(self) -> str:
        """Return a sandbox name that carries the job id in a form Vercel accepts."""
        raw = f"skynet-{self._job_id or 'blackbox'}".lower()
        return _NAME_UNSAFE.sub("-", raw).strip("-")[:60]
