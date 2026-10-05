"""Copy what a sandboxed command writes to stderr into the run log.

A sandbox, and every file in it, is gone once the run ends, so its stderr is
the only record of why something inside it failed. Every session's ``run`` goes
through :func:`logged_command`: stderr lines stream to :data:`stream_logger` at
DEBUG while the command runs, and a command that fails, times out or raises
logs a WARNING with its last lines on :data:`logger`. Each record carries the
sandbox's job as ``sandbox_owner``; the worker routes records by it into that
job's run log, and the optimization subprocess forwards them as log events.

Sandbox output is untrusted, so it is bounded, stripped of terminal control
sequences, and scrubbed of every secret the command was given.
"""

from __future__ import annotations

import functools
import logging
import re
import threading
from collections import deque
from collections.abc import Callable, Iterable, Mapping
from typing import Any

logger = logging.getLogger(__name__)
# Streamed lines reach only the run-log handlers attached here, never the
# process's own console, which would otherwise carry every sandbox's stderr.
stream_logger = logging.getLogger(f"{__name__}.stream")
stream_logger.propagate = False
stream_logger.setLevel(logging.DEBUG)

_STREAMED_LINES = 200
_LINE_CHARS = 1000
_TAIL_LINES = 40
_LABEL_CHARS = 120
# Shorter values (ports, flags, "1") are not secrets, and scrubbing them would mangle ordinary text.
_SECRET_MIN_CHARS = 8
_CONTROL = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]")


class SandboxOutputLog:
    """The log record of one sandboxed command's stderr."""

    def __init__(self, command: str, secrets: Iterable[str], owner: str | None = None) -> None:
        """Prepare to log one command.

        Args:
            command: The shell command line, shortened into the log label.
            secrets: Values the command can see; each is replaced before logging.
            owner: Job the sandbox belongs to, set on every record as ``sandbox_owner``.
        """
        self._extra = {"sandbox_owner": owner}
        self._secrets = sorted({value for value in secrets if len(value) >= _SECRET_MIN_CHARS}, key=len, reverse=True)
        first = command.strip().splitlines()[0] if command.strip() else ""
        self.label = self._clean(first[:_LABEL_CHARS] + ("…" if len(first) > _LABEL_CHARS else ""))
        self._pending = ""
        self._streamed = 0
        self._suppressed = 0
        self._tail: deque[str] = deque(maxlen=_TAIL_LINES)
        self._lock = threading.Lock()

    def _clean(self, line: str) -> str:
        """Redact secrets, drop control sequences and cap the length of one line.

        Args:
            line: Raw output line.

        Returns:
            The line as it may be logged.
        """
        for secret in self._secrets:
            line = line.replace(secret, "[redacted]")
        line = _CONTROL.sub("", line)
        return line if len(line) <= _LINE_CHARS else line[:_LINE_CHARS] + "…"

    def _line(self, line: str) -> None:
        """Stream one complete stderr line, within the per-command cap.

        Args:
            line: Raw stderr line without its newline.
        """
        if not line.strip():
            return
        clean = self._clean(line)
        self._tail.append(clean)
        if self._streamed < _STREAMED_LINES:
            self._streamed += 1
            stream_logger.debug("[sandbox] %s", clean, extra=self._extra)
        else:
            self._suppressed += 1

    def feed(self, text: str) -> None:
        """Take a stderr chunk, which may hold partial lines.

        Args:
            text: Newly written stderr.
        """
        with self._lock:
            self._pending += text
            *lines, self._pending = self._pending.split("\n")
            for line in lines:
                self._line(line)

    def tee(self, on_output: Callable[[str, str], None] | None) -> Callable[[str, str], None] | None:
        """Wrap the caller's output sink so stderr is logged as it streams.

        A command run without a sink is logged from its result instead: adding
        a sink would make the Vercel session read its output files on every poll.

        Args:
            on_output: The caller's sink, or ``None``.

        Returns:
            A sink that logs stderr and then calls the caller's, or ``None``.
        """
        if on_output is None:
            return None

        def sink(stream: str, text: str) -> None:
            """Log a stderr chunk, then hand every chunk on unchanged."""
            if stream == "stderr":
                self.feed(text)
            on_output(stream, text)

        return sink

    def finish(self, result: Any, *, streamed: bool) -> None:
        """Log the rest of stderr and, when the command failed, a summary with its tail.

        Args:
            result: The command's ``CommandResult``.
            streamed: Whether stderr already went through :meth:`tee`.
        """
        if not streamed:
            self.feed(result.stderr)
        with self._lock:
            if self._pending:
                self._line(self._pending)
                self._pending = ""
        if result.exit_code == 0 and not result.timed_out:
            return
        state = "timed out" if result.timed_out else f"exited {result.exit_code}"
        self._summary(logging.WARNING, f"{state}: {self.label}")

    def failed(self, error: BaseException) -> None:
        """Log what the command wrote before it raised.

        Args:
            error: The exception leaving ``run``.
        """
        with self._lock:
            if self._pending:
                self._line(self._pending)
                self._pending = ""
        self._summary(logging.WARNING, f"raised {type(error).__name__}: {self.label}")

    def _summary(self, level: int, headline: str) -> None:
        """Log one record with the headline and the last stderr lines.

        Args:
            level: Logging level.
            headline: What happened to which command.
        """
        lines = list(self._tail)
        note = f" ({self._suppressed} earlier lines not streamed)" if self._suppressed else ""
        body = "\n".join(lines) if lines else "(no stderr)"
        logger.log(level, "[sandbox] command %s%s\n%s", headline, note, body, extra=self._extra)


def logged_command(run: Callable[..., Any]) -> Callable[..., Any]:
    """Log the stderr of every command a session's ``run`` executes.

    Args:
        run: A ``SandboxSession.run`` implementation.

    Returns:
        The same method, with its command's stderr logged.
    """

    @functools.wraps(run)
    def wrapper(
        self: Any,
        command: str,
        *,
        env: Mapping[str, str] | None = None,
        timeout_seconds: float | None = None,
        on_output: Callable[[str, str], None] | None = None,
    ) -> Any:
        """Run the command with its stderr logged, keeping the method's own contract."""
        session_env = getattr(self, "_env", None)
        secrets = [*(env or {}).values(), *(session_env.values() if isinstance(session_env, Mapping) else ())]
        record = SandboxOutputLog(command, secrets, getattr(self, "log_owner", None))
        sink = record.tee(on_output)
        try:
            result = run(self, command, env=env, timeout_seconds=timeout_seconds, on_output=sink)
        except BaseException as error:
            record.failed(error)
            raise
        record.finish(result, streamed=sink is not None)
        return result

    return wrapper
