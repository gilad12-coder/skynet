"""Run one completion on a local coding CLI under the user's own subscription.

Each runner starts the CLI once, without provider API keys in its environment,
so the CLI bills the signed-in subscription and never a key a developer left
in the shell. Runners only read: no tools, no file writes, no session state.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from ..config import Settings
from ..local import cli_probe

_LIMIT_TEXT = re.compile(
    r"usage limit|rate limit|rate-limit|hit your limit|limit reached|limit exceeded|quota|too many requests",
    re.IGNORECASE,
)
_EPOCH_RESET = re.compile(r"\|\s*(\d{10})\b")
_ISO_RESET = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?")
_CLOCK_RESET = re.compile(
    r"(?:resets?|try again|available again)\s*(?:at|after|on)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?",
    re.IGNORECASE,
)
_TRANSIENT_TEXT = re.compile(
    r"overloaded|timed? ?out|temporar|connection|network|econnreset|503|502|500|529", re.IGNORECASE
)


@dataclass(frozen=True)
class CliCompletion:
    """One finished CLI answer and the usage the CLI reported for it."""

    text: str
    prompt_tokens: int
    completion_tokens: int
    model_ms: int | None
    raw: dict[str, Any] = field(default_factory=dict)


class SubscriptionRateLimitedError(Exception):
    """Report that a CLI's subscription reached its usage cap."""

    def __init__(self, provider: str, reset_at: datetime | None, message: str) -> None:
        """Keep the capped provider, when the cap ends, and the CLI's own words.

        Args:
            provider: The capped CLI.
            reset_at: When the cap ends, in UTC, or ``None`` when the CLI did not say.
            message: The CLI's message, for the user.
        """
        super().__init__(message)
        self.provider = provider
        self.reset_at = reset_at
        self.message = message


class CliRunError(Exception):
    """Report a CLI call that gave no usable answer."""

    def __init__(self, provider: str, message: str, *, transient: bool) -> None:
        """Keep the provider, a short reason, and whether a retry can help.

        Args:
            provider: The CLI that failed.
            message: A short reason, without prompt text.
            transient: True when the same call can succeed on a retry.
        """
        super().__init__(message)
        self.provider = provider
        self.message = message
        self.transient = transient


def cli_env(settings: Settings) -> dict[str, str]:
    """Return this process's environment without provider API keys.

    Args:
        settings: Application settings (kept for a stable runner signature).

    Returns:
        A copy of ``os.environ`` without the keys in ``cli_probe.STRIPPED_ENV_KEYS``.
    """
    del settings
    return cli_probe.cli_env()


def parse_reset_at(text: str, *, now: datetime | None = None) -> datetime | None:
    """Read when a usage cap ends from a CLI's limit message.

    Args:
        text: The CLI's message.
        now: The current time, for a clock-only reset such as ``resets 3pm``.

    Returns:
        The reset time in UTC, or ``None`` when the message names none.
    """
    current = now or datetime.now(UTC)
    epoch = _EPOCH_RESET.search(text)
    if epoch:
        return datetime.fromtimestamp(int(epoch.group(1)), UTC)
    stamp = _ISO_RESET.search(text)
    if stamp:
        try:
            value = datetime.fromisoformat(stamp.group(0))
        except ValueError:
            value = None
        if value is not None:
            return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)
    clock = _CLOCK_RESET.search(text)
    if clock:
        hour, minute, meridiem = int(clock.group(1)), int(clock.group(2) or 0), (clock.group(3) or "").lower()
        if meridiem == "pm" and hour < 12:
            hour += 12
        if meridiem == "am" and hour == 12:
            hour = 0
        if hour > 23 or minute > 59:
            return None
        # The CLIs print the reset in the user's own clock, which is this machine's.
        local = current.astimezone()
        reset = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if reset <= local:
            reset += timedelta(days=1)
        return reset.astimezone(UTC)
    return None


def limit_error(provider: str, text: str) -> SubscriptionRateLimitedError | None:
    """Return a cap error when a CLI's message says the subscription is capped.

    Args:
        provider: The CLI that wrote the message.
        text: The CLI's message or output.

    Returns:
        The cap error, or ``None`` when the message is not about a cap.
    """
    if not text or not _LIMIT_TEXT.search(text):
        return None
    return SubscriptionRateLimitedError(provider, parse_reset_at(text), text.strip()[:500])


def _failure(provider: str, text: str) -> Exception:
    """Classify a failed call as a cap, a transient failure, or a final failure.

    Args:
        provider: The CLI that failed.
        text: Its error text.

    Returns:
        The exception for the caller to raise.
    """
    capped = limit_error(provider, text)
    if capped is not None:
        return capped
    message = text.strip()[:500] or f"{provider} returned no answer"
    return CliRunError(provider, message, transient=bool(_TRANSIENT_TEXT.search(text)))


def _int(value: Any) -> int:
    """Return a non-negative token count, or 0 when ``value`` is not one."""
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) and value > 0 else 0


def _run(provider: str, argv: list[str], prompt: str | None, settings: Settings, cwd: Path) -> tuple[str, str]:
    """Run a CLI once and return its stdout and stderr.

    Args:
        provider: The CLI, for error reports.
        argv: The full command.
        prompt: Text sent on stdin, or ``None`` for none.
        settings: Application settings (environment and timeout).
        cwd: The directory the CLI runs in.

    Returns:
        ``(stdout, stderr)``.

    Raises:
        CliRunError: When the binary is missing or the call times out.
    """
    try:
        done = subprocess.run(
            argv,
            input=prompt if prompt is not None else "",
            capture_output=True,
            text=True,
            cwd=cwd,
            env=cli_env(settings),
            timeout=settings.cli_call_timeout_seconds,
            check=False,
        )
    except FileNotFoundError as error:
        raise CliRunError(provider, f"{provider} is not installed", transient=False) from error
    except subprocess.TimeoutExpired as error:
        raise CliRunError(provider, f"{provider} timed out", transient=True) from error
    if done.returncode != 0 and not done.stdout.strip():
        raise _failure(provider, done.stderr)
    return done.stdout, done.stderr


def _json_object(provider: str, stdout: str, stderr: str) -> dict[str, Any]:
    """Parse a CLI's single JSON result object.

    Args:
        provider: The CLI, for error reports.
        stdout: Its standard output.
        stderr: Its standard error.

    Returns:
        The parsed object.

    Raises:
        SubscriptionRateLimitedError: When the output is a plain cap message.
        CliRunError: When the output is not a JSON object.
    """
    try:
        value = json.loads(stdout.strip().splitlines()[-1]) if stdout.strip() else None
    except ValueError:
        value = None
    if not isinstance(value, dict):
        raise _failure(provider, f"{stdout}\n{stderr}")
    return value


def run_claude(
    model_arg: str, prompt: str, json_schema: Mapping[str, Any] | None, settings: Settings, cwd: Path
) -> CliCompletion:
    """Answer one prompt with ``claude -p``.

    Args:
        model_arg: The CLI's ``--model`` value.
        prompt: The full prompt.
        json_schema: A JSON schema the answer must match, or ``None``.
        settings: Application settings.
        cwd: The directory the CLI runs in.

    Returns:
        The completion.

    Raises:
        SubscriptionRateLimitedError: When the subscription is capped.
        CliRunError: When the call fails.
    """
    # Never ``--bare``: it ignores the subscription login and wants an API key.
    # The isolation flags keep the user's own settings, MCP servers and skills
    # out of the prompt; with them a large personal setup overflows the context.
    argv = [
        cli_probe.cli_binary("claude", settings),
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--model",
        model_arg,
    ]
    if json_schema is not None:
        argv += ["--json-schema", json.dumps(json_schema)]
    stdout, stderr = _run("claude", argv, prompt, settings, cwd)
    raw = _json_object("claude", stdout, stderr)
    if raw.get("is_error"):
        raise _failure("claude", str(raw.get("result") or stderr))
    structured = raw.get("structured_output")
    text = json.dumps(structured) if structured is not None else str(raw.get("result") or "")
    usage = raw.get("usage") if isinstance(raw.get("usage"), dict) else {}
    prompt_tokens = (
        _int(usage.get("input_tokens"))
        + _int(usage.get("cache_read_input_tokens"))
        + _int(usage.get("cache_creation_input_tokens"))
    )
    api_ms = raw.get("duration_api_ms")
    return CliCompletion(
        text=text,
        prompt_tokens=prompt_tokens,
        completion_tokens=_int(usage.get("output_tokens")),
        model_ms=_int(api_ms) if isinstance(api_ms, int | float) and api_ms > 0 else None,
        raw=raw,
    )


def run_codex(
    model_arg: str, prompt: str, json_schema: Mapping[str, Any] | None, settings: Settings, cwd: Path
) -> CliCompletion:
    """Answer one prompt with ``codex exec`` in a read-only sandbox.

    Args:
        model_arg: The CLI's ``--model`` value.
        prompt: The full prompt, sent on stdin.
        json_schema: A JSON schema the answer must match, or ``None``.
        settings: Application settings.
        cwd: The directory the CLI runs in.

    Returns:
        The completion; ``model_ms`` is the time from the first event to ``turn.completed``.

    Raises:
        SubscriptionRateLimitedError: When the subscription is capped.
        CliRunError: When the call fails.
    """
    with tempfile.TemporaryDirectory(prefix="skynet-codex-") as scratch:
        argv = [
            cli_probe.cli_binary("codex", settings),
            "exec",
            "--json",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--model",
            model_arg,
        ]
        if json_schema is not None:
            schema_path = Path(scratch) / "schema.json"
            schema_path.write_text(json.dumps(json_schema), encoding="utf-8")
            argv += ["--output-schema", str(schema_path)]
        argv.append("-")
        return _stream_codex(argv, prompt, settings, cwd)


def _stream_codex(argv: list[str], prompt: str, settings: Settings, cwd: Path) -> CliCompletion:
    """Run codex, time its events as they arrive, and read the last answer.

    Args:
        argv: The full command.
        prompt: Text sent on stdin.
        settings: Application settings.
        cwd: The directory the CLI runs in.

    Returns:
        The completion.

    Raises:
        SubscriptionRateLimitedError: When the subscription is capped.
        CliRunError: When the call fails.
    """
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=cwd,
            env=cli_env(settings),
        )
    except FileNotFoundError as error:
        raise CliRunError("codex", "codex is not installed", transient=False) from error
    timer = threading.Timer(settings.cli_call_timeout_seconds, process.kill)
    timer.start()
    errors: list[str] = []
    stderr_lines: list[str] = []
    reader = threading.Thread(target=lambda: stderr_lines.extend(process.stderr), daemon=True)
    reader.start()
    first: float | None = None
    finished: float | None = None
    text = ""
    usage: dict[str, Any] = {}
    try:
        assert process.stdin is not None
        assert process.stdout is not None
        process.stdin.write(prompt)
        process.stdin.close()
        for line in process.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            first = first if first is not None else time.monotonic()
            kind = event.get("type")
            item = event.get("item") if isinstance(event.get("item"), dict) else {}
            if kind == "item.completed" and item.get("type") == "agent_message":
                text = str(item.get("text") or "")
            elif kind == "turn.completed":
                finished = time.monotonic()
                usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}
            elif kind == "turn.failed":
                error = event.get("error")
                errors.append(str(error.get("message") if isinstance(error, dict) else error))
            elif kind == "error":
                errors.append(str(event.get("message") or ""))
        process.wait()
    finally:
        timer.cancel()
        reader.join(timeout=5)
    if process.returncode is not None and process.returncode < 0 and finished is None:
        raise CliRunError("codex", "codex timed out", transient=True)
    if finished is None:
        raise _failure("codex", "\n".join(errors) or "".join(stderr_lines))
    return CliCompletion(
        text=text,
        prompt_tokens=_int(usage.get("input_tokens")),
        completion_tokens=_int(usage.get("output_tokens")),
        model_ms=round((finished - first) * 1000) if first is not None else None,
        raw={"usage": usage},
    )


def run_droid(
    model_arg: str, prompt: str, json_schema: Mapping[str, Any] | None, settings: Settings, cwd: Path
) -> CliCompletion:
    """Answer one prompt with ``droid exec`` in its default read-only mode.

    Args:
        model_arg: The CLI's ``--model`` value.
        prompt: The full prompt.
        json_schema: A JSON schema the answer must match, or ``None``.
        settings: Application settings.
        cwd: The directory the CLI runs in.

    Returns:
        The completion.

    Raises:
        SubscriptionRateLimitedError: When the subscription is capped.
        CliRunError: When the call fails.
    """
    if json_schema is not None:
        # droid has no schema flag, so the schema travels in the prompt.
        prompt = f"{prompt}\n\nAnswer with only a JSON value that matches this JSON schema:\n{json.dumps(json_schema)}"
    with tempfile.TemporaryDirectory(prefix="skynet-droid-") as scratch:
        prompt_path = Path(scratch) / "prompt.txt"
        prompt_path.write_text(prompt, encoding="utf-8")
        # No ``--auto``: droid then stays read-only.
        argv = [
            cli_probe.cli_binary("droid", settings),
            "exec",
            "-o",
            "json",
            "--model",
            model_arg,
            "-f",
            str(prompt_path),
        ]
        stdout, stderr = _run("droid", argv, None, settings, cwd)
    raw = _json_object("droid", stdout, stderr)
    if raw.get("is_error"):
        raise _failure("droid", str(raw.get("result") or stderr))
    usage = raw.get("usage") if isinstance(raw.get("usage"), dict) else {}
    duration = raw.get("duration_ms")
    return CliCompletion(
        text=str(raw.get("result") or ""),
        prompt_tokens=_int(usage.get("input_tokens")) + _int(usage.get("cache_read_input_tokens")),
        completion_tokens=_int(usage.get("output_tokens")),
        model_ms=_int(duration) if isinstance(duration, int | float) and duration > 0 else None,
        raw=raw,
    )


RUNNERS = {"claude": run_claude, "codex": run_codex, "droid": run_droid}
