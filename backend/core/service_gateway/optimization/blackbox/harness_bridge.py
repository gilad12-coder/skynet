"""Drive any Skynet agent harness as the proposer of an upstream engine.

The upstream engines expect a ``claude`` command line (Meta-Harness,
AutoResearch) or a provider object (AutoSaddler). This module ships into the
sandbox next to the runners, imports only the standard library, and turns one
proposer session into a harness launch: it writes the harness configuration
files and the prompt, runs the harness command, parses its transcript for the
final answer and token counts, and reports the outcome in the shape the
upstream code reads. Invoked as the ``claude`` executable it answers the
CLI's ``--print`` calling convention; imported, it exposes the same session
runner to the AutoSaddler provider.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

Usage = dict[str, int]

CONFIG_ENV = "SKYNET_PROPOSER_CONFIG"
KEY_ENV = "SKYNET_API_KEY"
# The serialized launch travels through the sandbox input file, so the gateway
# key is replaced by this token and only restored from the process environment.
KEY_TOKEN = "__SKYNET_API_KEY__"
SHIM_DIR = ".local/skynet-bin"
SESSIONS_DIR = ".skynet-bridge"
_SLUG_RE = re.compile(r"[^A-Za-z0-9-]")
_USAGE_KEYS = ("input_tokens", "output_tokens")
# The instruction file every harness reads on start; Claude Code has its own
# and reads the skills the upstream engines drop under ``.claude`` natively.
_POINTER_NOTE = (
    "# Workspace notes\n\n"
    "Project instructions and skills for this task, if any, live under `.claude/` in this directory: read "
    "`CLAUDE.md` and every `.claude/skills/*/SKILL.md` before starting, and follow them as if they were "
    "written for you.\n"
)
_RESUME_NOTE = (
    "\n\n---\n\nA previous session already worked on this task in this directory. Its files and progress are "
    "still here; continue from the current workspace state.\n\n"
)


def _json_lines(stdout: str) -> Iterator[dict[str, Any]]:
    """Yield every line of ``stdout`` that parses as a JSON object.

    Args:
        stdout: Captured harness output.

    Yields:
        Parsed event objects, skipping anything that is not JSON.
    """
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event


def _usage(input_tokens: Any, output_tokens: Any) -> Usage:
    """Normalize a token pair into the usage shape the run record carries.

    Args:
        input_tokens: Prompt tokens, or ``None``.
        output_tokens: Completion tokens, or ``None``.

    Returns:
        ``{"input_tokens": n, "output_tokens": m}`` with missing values as 0.
    """
    return {"input_tokens": int(input_tokens or 0), "output_tokens": int(output_tokens or 0)}


def _add_usage(total: Usage, extra: Usage) -> Usage:
    """Sum two usage records.

    Args:
        total: Running total.
        extra: Usage to add.

    Returns:
        The summed usage.
    """
    return {key: total.get(key, 0) + extra.get(key, 0) for key in _USAGE_KEYS}


def parse_plain_output(stdout: str) -> tuple[str | None, Usage]:
    """Treat the whole output as the answer; nothing reports usage.

    Args:
        stdout: Captured harness output.

    Returns:
        The stripped output (``None`` when empty) and an empty usage record.
    """
    text = stdout.strip()
    return (text or None), {}


def parse_pi_output(stdout: str) -> tuple[str | None, Usage]:
    """Read the last assistant message and summed usage from Pi's ``--mode json`` stream.

    Args:
        stdout: Captured harness output.

    Returns:
        The final assistant text (``None`` when absent) and the usage total.
    """
    text: str | None = None
    usage: Usage = {}
    for event in _json_lines(stdout):
        if event.get("type") != "message_end":
            continue
        message = event.get("message") or {}
        if message.get("role") != "assistant":
            continue
        parts = [part.get("text", "") for part in message.get("content") or [] if part.get("type") == "text"]
        if any(parts):
            text = "\n".join(part for part in parts if part).strip()
        used = message.get("usage") or {}
        usage = _add_usage(usage, _usage(used.get("input"), used.get("output")))
    return text, usage


def parse_codex_output(stdout: str) -> tuple[str | None, Usage]:
    """Read the last agent message and turn usage from ``codex exec --json``.

    Args:
        stdout: Captured harness output.

    Returns:
        The final agent text (``None`` when absent) and the usage total.
    """
    text: str | None = None
    usage: Usage = {}
    for event in _json_lines(stdout):
        kind = event.get("type")
        if kind == "item.completed":
            item = event.get("item") or {}
            if item.get("type") == "agent_message" and item.get("text"):
                text = str(item["text"]).strip()
        elif kind == "turn.completed":
            used = event.get("usage") or {}
            usage = _add_usage(usage, _usage(used.get("input_tokens"), used.get("output_tokens")))
    return text, usage


def parse_opencode_output(stdout: str) -> tuple[str | None, Usage]:
    """Read the last completed text part and summed step usage from ``opencode run --format json``.

    Args:
        stdout: Captured harness output.

    Returns:
        The final assistant text (``None`` when absent) and the usage total.
    """
    text: str | None = None
    usage: Usage = {}
    for event in _json_lines(stdout):
        kind = event.get("type")
        part = event.get("part") or {}
        if kind == "text" and part.get("text"):
            text = str(part["text"]).strip()
        elif kind == "step_finish":
            tokens = part.get("tokens") or {}
            usage = _add_usage(usage, _usage(tokens.get("input"), tokens.get("output")))
    return text, usage


def parse_claude_output(stdout: str) -> tuple[str | None, Usage]:
    """Read the result and usage from ``claude -p --output-format json``.

    Args:
        stdout: Captured harness output.

    Returns:
        The result text (``None`` when absent) and the usage total.
    """
    candidates = [stdout.strip(), *reversed(stdout.strip().splitlines())]
    for raw in candidates:
        try:
            payload = json.loads(raw)
        except ValueError:
            continue
        if isinstance(payload, dict) and "result" in payload:
            used = payload.get("usage") or {}
            result = payload.get("result")
            text = str(result).strip() if result else None
            return (text or None), _usage(used.get("input_tokens"), used.get("output_tokens"))
    return None, {}


PARSERS = {
    "plain": parse_plain_output,
    "pi": parse_pi_output,
    "codex": parse_codex_output,
    "opencode": parse_opencode_output,
    "claude": parse_claude_output,
}


def parse_output(output_format: str, stdout: str) -> tuple[str | None, Usage]:
    """Parse a harness transcript in the named format.

    Args:
        output_format: One of the ``PARSERS`` keys.
        stdout: Captured harness output.

    Returns:
        The final answer text (``None`` when absent) and the usage total.
    """
    return PARSERS[output_format](stdout)


def contained_path(root: Path, relative_path: str) -> Path:
    """Resolve a workspace-relative file path, refusing anything that escapes.

    Args:
        root: Workspace directory.
        relative_path: POSIX path relative to the workspace.

    Returns:
        The absolute path inside the workspace.

    Raises:
        ValueError: When the path is absolute or climbs out of the workspace.
    """
    path = PurePosixPath(relative_path)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Harness file path must be workspace-relative: {relative_path}")
    target = root.joinpath(*path.parts)
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Harness file escapes the workspace: {relative_path}")
    return target


def cost_usd(usage: Usage, price: dict[str, float] | None) -> float:
    """Price a usage record with the per-token rates the parent supplied.

    Args:
        usage: Token counts.
        price: ``{"input": usd, "output": usd}`` per token, or ``None`` when unknown.

    Returns:
        The estimated spend in USD; zero when no price is known.
    """
    if not price:
        return 0.0
    return usage.get("input_tokens", 0) * float(price.get("input", 0.0)) + usage.get("output_tokens", 0) * float(
        price.get("output", 0.0)
    )


@dataclass
class SessionOutcome:
    """What one harness session produced."""

    text: str | None
    stdout: str
    stderr: str
    returncode: int
    usage: Usage
    cost_usd: float
    duration_seconds: float
    timed_out: bool = False
    budget_exceeded: bool = False


@dataclass
class _Monitor:
    """Stream the harness output, stopping it once the session budget is spent."""

    process: subprocess.Popen[str]
    output_format: str
    price: dict[str, float] | None
    max_cost_usd: float | None
    chunks: list[str] = field(default_factory=list)
    budget_exceeded: bool = False

    def pump(self) -> None:
        """Read stdout to completion, re-pricing whenever a usage event may have arrived."""
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.chunks.append(line)
            if self.max_cost_usd is None or not self.price or "usage" not in line:
                continue
            _, usage = parse_output(self.output_format, "".join(self.chunks))
            if cost_usd(usage, self.price) > self.max_cost_usd:
                self.budget_exceeded = True
                _stop_group(self.process, signal.SIGTERM)


def _stop_group(process: subprocess.Popen[str], signum: int) -> None:
    """Signal the harness shell and every child it spawned.

    Args:
        process: The shell running the harness command, started in its own session.
        signum: Signal to deliver to the whole process group.
    """
    # Signalling only the shell would leave a child holding the stdout pipe open.
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signum)


def run_session(
    proposer: dict[str, Any],
    *,
    workspace: Path,
    prompt: str,
    model: str,
    session_dir: Path,
    max_cost_usd: float | None = None,
    timeout_seconds: float | None = None,
    extra_env: dict[str, str] | None = None,
) -> SessionOutcome:
    """Run one proposer session through the configured harness.

    Args:
        proposer: Serialized launch: ``run_command``, ``files``, ``env``,
            ``output_format``, ``instructions_file`` and optional ``price``.
        workspace: Directory the agent works in (the upstream work dir).
        prompt: Task prompt for this session.
        model: Model identifier the harness should route to.
        session_dir: Private directory for prompt, transcript and logs.
        max_cost_usd: Stop the harness once its priced usage exceeds this.
        timeout_seconds: Kill the harness after this many seconds.
        extra_env: Environment overrides layered on top of the launch env.

    Returns:
        The parsed answer, raw transcript, usage and exit status.
    """
    workspace.mkdir(parents=True, exist_ok=True)
    session_dir.mkdir(parents=True, exist_ok=True)
    api_key = os.environ.get(KEY_ENV, "")
    for relative_path, content in (proposer.get("files") or {}).items():
        target = contained_path(workspace, relative_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content.replace(KEY_TOKEN, api_key), encoding="utf-8")
    instructions = proposer.get("instructions_file")
    if instructions and instructions != "CLAUDE.md":
        pointer = contained_path(workspace, instructions)
        if not pointer.exists():
            pointer.write_text(_POINTER_NOTE, encoding="utf-8")
    attempt = len(list(session_dir.glob("prompt-*.md"))) + 1
    prompt_file = session_dir / f"prompt-{attempt}.md"
    prompt_file.write_text(prompt, encoding="utf-8")
    env = {
        **os.environ,
        **{name: value.replace(KEY_TOKEN, api_key) for name, value in (proposer.get("env") or {}).items()},
        **(extra_env or {}),
        "SKYNET_MODEL": model,
        "SKYNET_PROMPT_FILE": str(prompt_file),
        "SKYNET_ANSWER_FILE": str(session_dir / f"answer-{attempt}.txt"),
    }
    shell = shutil.which("bash") or "/bin/sh"
    started = time.monotonic()
    stderr_file = session_dir / f"run-{attempt}.stderr"
    with stderr_file.open("w", encoding="utf-8") as stderr:
        process = subprocess.Popen(
            [shell, "-c", proposer["run_command"].replace(KEY_TOKEN, api_key)],
            cwd=workspace,
            env=env,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
            errors="replace",
            start_new_session=True,
        )
        monitor = _Monitor(process, proposer.get("output_format", "plain"), proposer.get("price"), max_cost_usd)
        reader = threading.Thread(target=monitor.pump, daemon=True)
        reader.start()
        timed_out = False
        try:
            process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            _stop_group(process, signal.SIGKILL)
            process.wait()
        # A child forked while the first signal landed can outlive the shell and
        # keep the pipe open, so keep sweeping the group until the reader sees EOF.
        deadline = time.monotonic() + 5.0
        while (timed_out or monitor.budget_exceeded) and reader.is_alive() and time.monotonic() < deadline:
            _stop_group(process, signal.SIGKILL)
            reader.join(timeout=0.2)
        reader.join(timeout=30)
    stdout = "".join(monitor.chunks)
    (session_dir / f"run-{attempt}.stdout").write_text(stdout, encoding="utf-8")
    text, usage = parse_output(proposer.get("output_format", "plain"), stdout)
    return SessionOutcome(
        text=text,
        stdout=stdout,
        stderr=stderr_file.read_text(encoding="utf-8", errors="replace"),
        returncode=process.returncode,
        usage=usage,
        cost_usd=cost_usd(usage, proposer.get("price")),
        duration_seconds=time.monotonic() - started,
        timed_out=timed_out,
        budget_exceeded=monitor.budget_exceeded,
    )


def claude_project_slug(cwd: Path) -> str:
    """Mirror how the Claude CLI names a project's transcript directory.

    Args:
        cwd: Working directory of the session.

    Returns:
        The directory name under ``~/.claude/projects``.
    """
    return _SLUG_RE.sub("-", str(cwd.resolve()))


def record_transcript(session_id: str, workspace: Path, model: str, usage: Usage) -> None:
    """Append a Claude-shaped transcript line so upstream usage readers find the session.

    Args:
        session_id: Session identifier the upstream engine assigned.
        workspace: Working directory of the session.
        model: Model the harness ran on.
        usage: Token counts of this invocation.
    """
    project = Path.home() / ".claude" / "projects" / claude_project_slug(workspace)
    project.mkdir(parents=True, exist_ok=True)
    entry = {
        "type": "assistant",
        "sessionId": session_id,
        "message": {
            "id": uuid.uuid4().hex,
            "model": model,
            "usage": {
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            },
        },
    }
    with (project / f"{session_id}.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def result_document(session_id: str, model: str, outcome: SessionOutcome) -> dict[str, Any]:
    """Shape a session outcome like ``claude --print --output-format json``.

    Args:
        session_id: Session identifier reported back to the caller.
        model: Model the harness ran on.
        outcome: Parsed session outcome.

    Returns:
        The result document the upstream engines parse.
    """
    is_error = outcome.returncode != 0 or outcome.timed_out or outcome.text is None
    input_tokens = outcome.usage.get("input_tokens", 0)
    output_tokens = outcome.usage.get("output_tokens", 0)
    detail = (outcome.stderr or outcome.stdout).strip()[-2000:]
    return {
        "type": "result",
        "subtype": "success" if not is_error else "error_during_execution",
        "is_error": is_error,
        "duration_ms": int(outcome.duration_seconds * 1000),
        "num_turns": 1,
        "result": outcome.text if outcome.text is not None else f"Harness exited with {outcome.returncode}: {detail}",
        "session_id": session_id,
        "total_cost_usd": outcome.cost_usd,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        },
        "modelUsage": {
            model: {
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "cacheReadInputTokens": 0,
                "cacheCreationInputTokens": 0,
                "costUSD": outcome.cost_usd,
            }
        },
    }


def _cli_parser() -> argparse.ArgumentParser:
    """Describe the subset of the Claude CLI surface the upstream engines use.

    Returns:
        A parser that tolerates unknown flags and keeps the prompt positional.
    """
    parser = argparse.ArgumentParser(prog="claude", add_help=False, allow_abbrev=False)
    for flag in ("--print", "-p", "--verbose", "--dangerously-skip-permissions", "--continue", "-c"):
        parser.add_argument(flag, action="store_true", dest=flag.strip("-").replace("-", "_"))
    for flag in (
        "--output-format",
        "--input-format",
        "--model",
        "--session-id",
        "--resume",
        "-r",
        "--settings",
        "--permission-mode",
        "--effort",
        "--max-budget-usd",
        "--max-turns",
        "--allowedTools",
        "--disallowedTools",
        "--tools",
        "--add-dir",
        "--append-system-prompt",
        "--system-prompt",
        "--mcp-config",
        "--agents",
    ):
        parser.add_argument(flag, dest=flag.strip("-").replace("-", "_"))
    parser.add_argument("prompt", nargs="*")
    return parser


def install_shim(home: Path, bridge_file: Path, python: str) -> Path:
    """Write a ``claude`` executable that forwards to this module.

    Args:
        home: Sandbox home directory.
        bridge_file: Absolute path of this module inside the sandbox.
        python: Interpreter that runs the bridge.

    Returns:
        The directory that must lead ``PATH``.
    """
    shim_dir = home / SHIM_DIR
    shim_dir.mkdir(parents=True, exist_ok=True)
    shim = shim_dir / "claude"
    shim.write_text(f'#!/bin/sh\nexec "{python}" "{bridge_file}" "$@"\n', encoding="utf-8")
    shim.chmod(0o755)
    return shim_dir


def main(argv: list[str]) -> int:
    """Answer one ``claude --print`` invocation with the configured harness.

    Args:
        argv: Command-line arguments after the program name.

    Returns:
        The process exit code: the harness's own code, or 1 for a bridge failure.
    """
    args, unknown = _cli_parser().parse_known_args(argv)
    if args.output_format not in (None, "json"):
        print(f"claude bridge: unsupported --output-format {args.output_format}", file=sys.stderr)
        return 1
    if unknown:
        print(f"claude bridge: ignoring unsupported arguments {unknown}", file=sys.stderr)
    config_path = os.environ.get(CONFIG_ENV)
    if not config_path:
        print(f"claude bridge: {CONFIG_ENV} is not set", file=sys.stderr)
        return 1
    proposer = json.loads(Path(config_path).read_text(encoding="utf-8"))
    resumed = args.resume or args.r
    session_id = args.session_id or resumed or uuid.uuid4().hex
    model = args.model or str(proposer.get("model") or os.environ.get("SKYNET_MODEL") or "")
    workspace = Path.cwd()
    session_dir = Path.home() / SESSIONS_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    prompt = " ".join(args.prompt).strip() or sys.stdin.read()
    opening = session_dir / "opening-prompt.md"
    if resumed and opening.exists():
        # No other harness resumes a Claude session by id: the workspace carries
        # the progress, so the follow-up restates the task before the nudge.
        prompt = opening.read_text(encoding="utf-8") + _RESUME_NOTE + prompt
    elif not opening.exists():
        opening.write_text(prompt, encoding="utf-8")
    max_cost = float(args.max_budget_usd) if args.max_budget_usd else None
    outcome = run_session(
        proposer,
        workspace=workspace,
        prompt=prompt,
        model=model,
        session_dir=session_dir,
        max_cost_usd=max_cost,
        timeout_seconds=proposer.get("timeout_seconds"),
    )
    record_transcript(session_id, workspace, model, outcome.usage)
    print(json.dumps(result_document(session_id, model, outcome)))
    sys.stdout.flush()
    return outcome.returncode if outcome.returncode is not None else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
