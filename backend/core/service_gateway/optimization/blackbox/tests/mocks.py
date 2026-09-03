"""Shared fakes for the black-box tests: a deterministic scorer, reflection LM and sandbox runtime."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from ..protocol import Candidate, EngineContext, EvalServer, Result, SideInfo, Task
from ..sandbox import CommandResult, OutputSink, SandboxSpec

VOWELS = "aeiou"

# A scorer for agent targets: it judges what the agent wrote, which the
# runner hands over in place of the case.
AGENT_OUTPUT_SCORER_CODE = """
def score(candidate, case=None):
    output = (case or {}).get("output") or ""
    vowels = sum(ch in "aeiou" for ch in output)
    return vowels / max(1, len(output)), {"vowels": vowels, "seen_case": (case or {}).get("case")}
"""

# Scorer source in the shape users submit; the in-process twin below keeps
# the engine tests free of the sandbox.
VOWEL_SCORER_CODE = """
def score(candidate, case=None):
    text = candidate if isinstance(candidate, str) else " ".join(candidate.values())
    vowels = sum(ch in "aeiou" for ch in text)
    return vowels / max(1, len(text)), {"vowels": vowels}
"""


def vowel_scorer(candidate: Candidate, case: Any = None) -> tuple[float, SideInfo]:
    """Score a candidate by its vowel density, ignoring the case.

    Args:
        candidate: Text or named parts.
        case: Ignored.

    Returns:
        Vowel density in ``[0, 1]`` and the raw vowel count.
    """
    text = candidate if isinstance(candidate, str) else " ".join(candidate.values())
    vowels = sum(ch in VOWELS for ch in text)
    return vowels / max(1, len(text)), {"vowels": vowels}


class FakeReflectionLM:
    """Stands in for ``dspy.LM``: every call proposes a vowel-denser text.

    Records ``history`` entries with a ``usage`` block so the service's
    token accounting has something to read.
    """

    def __init__(self, model: str = "fake/model", *, improving: bool = True) -> None:
        """Create the fake.

        Args:
            model: Model id reported to the usage helpers.
            improving: When False every proposal is vowel-free, so nothing
                ever beats a seed that has a vowel.
        """
        self.model = model
        self.improving = improving
        self.history: list[dict[str, Any]] = []
        self.prompts: list[str] = []

    def __call__(
        self,
        prompt: str | list[dict[str, Any]] | None = None,
        *args: Any,
        messages: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> list[str]:
        """Return one fenced completion, as the engines expect.

        Args:
            prompt: The engine's reflection text or positional chat messages.
            *args: Ignored.
            messages: Chat messages passed by the upstream model transport.
            **kwargs: Ignored.

        Returns:
            A single-element completion list.
        """
        chat = prompt if isinstance(prompt, list) else messages
        text_prompt = (
            prompt if isinstance(prompt, str) else "\n".join(str(message.get("content", "")) for message in chat or [])
        )
        self.prompts.append(text_prompt)
        self.history.append({"prompt": text_prompt, "usage": {"prompt_tokens": 10, "completion_tokens": 5}})
        text = ("aeiou " * len(self.history)).strip() if self.improving else "xyz"
        return [f"```\n{text}\n```"]


def make_ctx(run_dir: str, lm: FakeReflectionLM | None = None, **overrides: Any) -> EngineContext:
    """Build an ``EngineContext`` over a fake LM.

    Args:
        run_dir: Workspace for engine state.
        lm: The reflection LM fake; a fresh improving one when unset.
        **overrides: Extra ``EngineContext`` fields.

    Returns:
        The context.
    """
    lm = lm or FakeReflectionLM()
    return EngineContext(reflection_lm=lambda prompt: str(lm(prompt)[0]), run_dir=run_dir, **overrides)


class ScriptedEngine:
    """Engine that scores a fixed list of candidates, then returns the best or raises.

    Args:
        name: Catalog id to report.
        candidates: Versions to score through the server, in order.
        error: Exception to raise after scoring, if any.
    """

    def __init__(self, name: str, candidates: list[str], *, error: BaseException | None = None) -> None:
        """Create the engine."""
        self.name = name
        self._candidates = candidates
        self._error = error
        self.calls: list[Task] = []

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Score the scripted candidates and hand back the server's best.

        Args:
            task: Recorded on ``calls`` so tests can inspect the seed.
            server: Budgeted scorer for this lane.
            ctx: Ignored.

        Returns:
            The best candidate the server saw.

        Raises:
            BaseException: The configured ``error``, after scoring.
        """
        self.calls.append(task)
        for candidate in self._candidates:
            server.evaluate(candidate, None)
        if self._error is not None:
            raise self._error
        best = server.best_candidate
        assert best is not None
        return Result(best_candidate=best, best_score=server.best_score, total_evals=server.used)


class FakeSandboxSession:
    """In-memory sandbox: remembers written files, records commands, answers each from a script.

    Args:
        script: Maps a command line to its outcome; unmatched commands exit 0.
        produces: Files a command drops into the box after it runs, keyed by
            the command line — how the agent's answer file appears.
    """

    def __init__(
        self,
        *,
        script: Callable[[str], CommandResult] | None = None,
        produces: Mapping[str, Mapping[str, str]] | None = None,
    ) -> None:
        """Create the session."""
        self.files: dict[str, str] = {}
        self.commands: list[str] = []
        self.closed = False
        self._script = script or (lambda command: CommandResult(exit_code=0, stdout="ok"))
        self._produces = produces or {}

    def write_files(self, files: Mapping[str, str]) -> None:
        """Record written files.

        Args:
            files: Relative path → content.
        """
        self.files.update(files)

    def run(
        self,
        command: str,
        *,
        env: Mapping[str, str] | None = None,
        timeout_seconds: float | None = None,
        on_output: OutputSink | None = None,
    ) -> CommandResult:
        """Record ``command``, drop any files it produces, and return its scripted result.

        Args:
            command: The shell command line.
            env: Ignored.
            timeout_seconds: Ignored.

        Returns:
            The scripted outcome.
        """
        self.commands.append(command)
        self.files.update(self._produces.get(command, {}))
        return self._script(command)

    def read_file(self, path: str) -> str | None:
        """Return the recorded file, or ``None``.

        Args:
            path: Relative file path.

        Returns:
            The file's text, or ``None``.
        """
        return self.files.get(path)

    def close(self) -> None:
        """Mark the session closed."""
        self.closed = True


class FakeSandboxRuntime:
    """Sandbox runtime that hands out fresh :class:`FakeSandboxSession` instances.

    Args:
        session_factory: Builds a session per :meth:`open`; a default
            clean-exit session that answers ``done`` when unset.
        injects_headers: Whether the runtime claims a header-injecting network edge.
    """

    def __init__(
        self, session_factory: Callable[[], FakeSandboxSession] | None = None, *, injects_headers: bool = False
    ) -> None:
        """Create the runtime."""
        self.injects_headers = injects_headers
        self.specs: list[SandboxSpec] = []
        self.sessions: list[FakeSandboxSession] = []
        self._factory = session_factory or (
            lambda: FakeSandboxSession(produces={"run-agent": {"output/answer.txt": "done"}})
        )

    def open(self, spec: SandboxSpec) -> FakeSandboxSession:
        """Record ``spec`` and return a fresh session.

        Args:
            spec: The requested sandbox spec.

        Returns:
            A new fake session.
        """
        self.specs.append(spec)
        session = self._factory()
        self.sessions.append(session)
        return session


class FakeGateway:
    """OpenAI-compatible chat endpoint on localhost: records every request, answers from a script.

    Args:
        reply: The completion text, or a function of the request body that returns it.
        usage: ``(prompt_tokens, completion_tokens)`` reported with every success.
        statuses: HTTP error statuses to answer with, in order, before succeeding.
    """

    def __init__(
        self,
        reply: str | Callable[[dict[str, Any]], str] = "0.5",
        *,
        usage: tuple[int, int] = (3, 1),
        statuses: list[int] | None = None,
    ) -> None:
        """Bind a server to a free localhost port without starting it."""
        self.requests: list[dict[str, Any]] = []
        self._reply = reply
        self._usage = usage
        self._statuses = list(statuses or [])
        self._lock = threading.Lock()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeGatewayHandler)
        self._server.gateway = self  # type: ignore[attr-defined]
        # A short poll interval keeps shutdown() (and thus every test) from waiting out the default 0.5s.
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)

    @property
    def url(self) -> str:
        """The base URL a client is given (``/chat/completions`` is appended by the caller)."""
        return f"http://127.0.0.1:{self._server.server_address[1]}/v1"

    def __enter__(self) -> FakeGateway:
        """Start serving."""
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        """Stop serving."""
        self._server.shutdown()
        self._server.server_close()

    def answer(self, request: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """Record ``request`` and pick the status and body to send back.

        Args:
            request: ``path``, ``authorization`` header and decoded ``body``.

        Returns:
            The HTTP status and JSON body.
        """
        with self._lock:
            self.requests.append(request)
            if self._statuses:
                return self._statuses.pop(0), {"error": "try again"}
        text = self._reply(request["body"]) if callable(self._reply) else self._reply
        prompt_tokens, completion_tokens = self._usage
        return 200, {
            "choices": [{"message": {"role": "assistant", "content": text}}],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
        }


class _FakeGatewayHandler(BaseHTTPRequestHandler):
    """Hands every POST to the owning :class:`FakeGateway`."""

    def do_POST(self) -> None:
        """Decode the JSON body and write the scripted answer."""
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        gateway: FakeGateway = self.server.gateway  # type: ignore[attr-defined]
        status, payload = gateway.answer(
            {"path": self.path, "authorization": self.headers.get("Authorization"), "body": body}
        )
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        """Keep the test output free of access-log lines."""
