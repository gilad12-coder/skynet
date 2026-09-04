"""Sandbox runtimes for optimizers, scorers, and agent targets.

Protected jobs enter one parent-owned Vercel sandbox before the
optimizer starts. Scorer and agent commands then use private workspaces inside
that boundary so they do not create duplicate managed-sandbox charges.
:class:`SandboxRuntime` / :class:`SandboxSession` are the seams tests fake;
:class:`VercelSandboxRuntime` is the managed provider implementation, and
:class:`LocalSubprocessRuntime` remains an explicit test adapter.
"""

from __future__ import annotations

import contextlib
import contextvars
import logging
import math
import os
import posixpath
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Protocol

import httpx

from ....billing.operation_pricing import json_fingerprint
from ....billing.runtime import BudgetRuntime
from ....billing.vercel_usage import VercelUsageReservation
from ....config import Settings
from ....exceptions import ServiceError

# The SDK is a declared dependency, but an air-gap build vendored from an
# older requirements file must degrade to "agent targets unavailable", not
# fail to import the worker.
try:
    from vercel import api as vercel_api
    from vercel.sandbox import NetworkPolicy, NetworkPolicyRule, NetworkPolicyTransform
    from vercel.sandbox import sync as vercel_sync
except ImportError:  # pragma: no cover
    vercel_api = None
    vercel_sync = None
    NetworkPolicy = NetworkPolicyRule = NetworkPolicyTransform = None

logger = logging.getLogger(__name__)

# ``timeout --signal=KILL`` exits 124 when it fired; 137 is the shell dying of the KILL itself.
_TIMEOUT_EXIT_CODES = frozenset({124, 137})
# Slack past the in-sandbox timeout before the service kills the wrapper as well.
KILL_GRACE_SECONDS = 15.0
# Detached processes are watched with short status polls; the delay doubles from
# the floor to the cap so quick commands return fast and long runs poll gently.
_POLL_FLOOR_SECONDS = 1.0
_POLL_CAP_SECONDS = 8.0
# Client-side last resort past ``kill_after`` before declaring the process lost.
_POLL_DEADLINE_SLACK_SECONDS = 60.0
# Where a command's wrapper records its exit code for the poll to find.
_EXIT_FILE_PREFIX = "/tmp/.skynet-exit-"
# A detached command's output is redirected here and read back while it runs.
_OUTPUT_FILE_PREFIX = "/tmp/.skynet-output-"
# Called with the stream name (``stdout``/``stderr``) and each new piece of output.
OutputSink = Callable[[str, str], None]
_BRIEF_COMMAND_CHARS = 80
# Every sandbox carries this tag so stragglers from a crashed worker can be found and destroyed.
SANDBOX_TAG = {"skynet": "blackbox"}
JOB_TAG = "skynet_job"
_STOPPABLE_STATUSES = frozenset({"pending", "running"})
_NAME_UNSAFE = re.compile(r"[^a-z0-9-]+")
_NAME_MAX_CHARS = 60
_NAME_SUFFIX_CHARS = 8
_PACKAGE_MISSING = "The vercel-sandbox package is not installed."
_CREDENTIALS_MISSING = "Agent sandboxes are not configured: set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID."
# The local runtime hands user code a bare environment: the interpreter that
# runs the worker, a private HOME/TMPDIR, and the host's CA bundle overrides
# so its HTTPS calls verify the same way — never the worker's secrets.
_LOCAL_ENV_PASSTHROUGH = ("SSL_CERT_FILE", "SSL_CERT_DIR")
_LOCAL_KILLED_EXIT_CODE = 137
_BUDGET_RELAY_ENV = "SKYNET_BUDGET_RELAY_URL"
_TOOL_RELAY_ENV = "SKYNET_TOOL_RELAY_TOKEN"
_RELAY_ENDPOINT_ENVS = ("OPENAI_BASE_URL", "SKYNET_GATEWAY_URL")
# A custom network policy denies every host it does not list; this entry keeps the
# network open, so only the header injection distinguishes it from ``allow-all``.
_ANY_HOST = "*"


@dataclass(frozen=True)
class SandboxSpec:
    """What a session needs to open a sandbox."""

    lifetime_seconds: float
    env: Mapping[str, str] = field(default_factory=dict)
    name: str | None = None
    tags: Mapping[str, str] = field(default_factory=dict)
    # Container image; the runtime's default when unset.
    image: str | None = None
    # Host → headers the network edge adds to the box's requests to that host, so a
    # secret reaches a service without ever entering the box.
    inject_headers: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    network_disabled: bool = False
    vcpus: int = 2
    operation_key: str | None = None


@dataclass(frozen=True)
class CommandResult:
    """Outcome of one command inside a sandbox."""

    exit_code: int
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        """Return True when the command exited 0."""
        return self.exit_code == 0


class SandboxSession(Protocol):
    """One open sandbox: write files, run commands, read results, destroy."""

    def write_files(self, files: Mapping[str, str]) -> None:
        """Write text files at paths relative to the working directory, creating parents.

        Args:
            files: Relative path → content.
        """
        ...

    def run(
        self,
        command: str,
        *,
        env: Mapping[str, str] | None = None,
        timeout_seconds: float | None = None,
        on_output: OutputSink | None = None,
    ) -> CommandResult:
        """Run ``command`` through ``bash -lc`` in the working directory and wait for it.

        Args:
            command: Shell command line.
            env: Extra environment for this command.
            timeout_seconds: Kill the command after this long.
            on_output: Receives each new piece of output while the command runs.

        Returns:
            Exit code, captured output and whether the timeout fired.
        """
        ...

    def read_file(self, path: str) -> str | None:
        """Return the text of ``path`` (relative to the working directory), or ``None`` when absent.

        Args:
            path: Relative file path.

        Returns:
            The file's text, or ``None``.
        """
        ...

    def close(self) -> None:
        """Destroy the sandbox and reconcile any protected usage."""
        ...


class SandboxRuntime(Protocol):
    """Creates sandboxes."""

    # Whether ``SandboxSpec.inject_headers`` is honoured; without a network edge the
    # caller has to hand the box its secrets some other way.
    injects_headers: bool

    def open(self, spec: SandboxSpec) -> SandboxSession:
        """Create a sandbox per ``spec``.

        Args:
            spec: Lifetime, environment, image, header injection and labels for the sandbox.

        Returns:
            The session over the new sandbox.
        """
        ...


@dataclass(frozen=True)
class VercelCredentials:
    """Explicit Vercel credentials, so the worker never depends on the SDK's env lookup."""

    token: str
    team_id: str
    project_id: str


_RUNTIME_OVERRIDE: contextvars.ContextVar[SandboxRuntime | None] = contextvars.ContextVar(
    "skynet_sandbox_runtime", default=None
)


def current_sandbox_runtime() -> SandboxRuntime | None:
    """Return the trusted runtime bound to this isolated child or setup request."""
    return _RUNTIME_OVERRIDE.get()


@contextlib.contextmanager
def sandbox_runtime_context(runtime: SandboxRuntime) -> Iterator[SandboxRuntime]:
    """Bind sandbox factories to an authenticated parent without copying its credentials.

    Args:
        runtime: Parent-controlled runtime or child RPC capability.

    Yields:
        The bound runtime for this operation context.
    """
    token = _RUNTIME_OVERRIDE.set(runtime)
    try:
        yield runtime
    finally:
        _RUNTIME_OVERRIDE.reset(token)


def unique_sandbox_name(stem: str) -> str:
    """Return ``stem`` in a form Vercel accepts, with a random suffix that keeps every open apart.

    Vercel refuses to create a sandbox whose name is still taken in the
    project, and a job opens boxes from several holdout threads at once (one
    per case) and again on every retry, so a name derived from the job id
    alone collides. The suffix survives the length cap: trimming falls on the
    stem, never on the part that makes the name unique.

    Args:
        stem: The readable part, normally carrying the job id.

    Returns:
        ``<stem>-<8 hex chars>``: lower-case, ``[a-z0-9-]`` only, at most 60 characters.
    """
    safe = _NAME_UNSAFE.sub("-", stem.lower()).strip("-")
    head = safe[: _NAME_MAX_CHARS - _NAME_SUFFIX_CHARS - 1].rstrip("-")
    return f"{head}-{uuid.uuid4().hex[:_NAME_SUFFIX_CHARS]}"


def _brief(command: str) -> str:
    """Shorten ``command`` for an error message.

    Args:
        command: The shell command line.

    Returns:
        Its first line, cut to a readable length.
    """
    head = command.strip().splitlines()[0] if command.strip() else ""
    return head if len(head) <= _BRIEF_COMMAND_CHARS else head[: _BRIEF_COMMAND_CHARS - 1] + "…"


@dataclass
class _OutputFile:
    """One output stream of a detached command: the file it goes to and the text read so far."""

    path: str
    text: str = ""


class VercelSandboxSession:
    """Session over one Vercel sandbox, bound to the SDK session that created it."""

    def __init__(
        self, box: Any, api_session: Any, context: contextvars.Context, usage: VercelUsageReservation | None = None
    ) -> None:
        """Wrap an open sandbox.

        Args:
            box: The SDK's managed sandbox handle.
            api_session: The entered ``vercel.api.session`` context that owns it.
            context: The ``contextvars`` context ``api_session`` was entered in.
            usage: Optional pre-dispatch reservation and trusted provider usage collector.
        """
        self._box = box
        # The named-sandbox handle silently resumes stopped VMs. An exact session
        # cannot create another billable lifetime behind the admission boundary.
        self._session = box.current_session
        if self._session is None:
            raise ServiceError("Vercel did not return the sandbox's exact execution session.")
        self._api_session = api_session
        self._context = context
        self._cwd = box.cwd
        self._usage = usage
        self._closed = False

    def write_files(self, files: Mapping[str, str]) -> None:
        """Write text files at paths relative to the working directory, creating parents.

        Args:
            files: Relative path → content.
        """
        for path, text in files.items():
            parent = posixpath.dirname(path)
            if parent:
                self._session.fs.mkdir(parent, cwd=self._cwd, recursive=True)
            self._session.fs.write_text(path, text, cwd=self._cwd)

    def run(
        self,
        command: str,
        *,
        env: Mapping[str, str] | None = None,
        timeout_seconds: float | None = None,
        on_output: OutputSink | None = None,
    ) -> CommandResult:
        """Run ``command`` through ``bash -lc`` in the working directory and wait for it.

        The process runs detached and is watched with short polls instead of
        one streamed response: Vercel's edge drops a response that stays open
        and silent for minutes, which killed long agent runs midway with
        "missing final metadata". A plain status read never carries a detached
        process's exit code either (the runtime only settles it on a blocking
        wait, which the edge cuts off the same way), so the wrapper records the
        code in a file and the poll watches for that file. Output goes to files
        in the box for the same reason: each poll reads what has landed since
        the last one and hands the new part to ``on_output``, and the files are
        the command's captured output once it exits.

        Args:
            command: Shell command line.
            env: Extra environment for this command.
            timeout_seconds: Kill the command after this long.
            on_output: Receives each new piece of output at every poll.

        Returns:
            Exit code, captured output and whether the timeout fired.

        Raises:
            ServiceError: If the process outlives its kill deadline.
        """
        inner = f"bash -lc {shlex.quote(command)}"
        kill_after = None
        deadline = None
        seconds = None
        if timeout_seconds is not None:
            seconds = max(1, math.ceil(timeout_seconds))
            inner = f"timeout --signal=KILL {seconds}s {inner}"
            kill_after = seconds + KILL_GRACE_SECONDS
            deadline = time.monotonic() + kill_after + _POLL_DEADLINE_SLACK_SECONDS
        token = uuid.uuid4().hex
        sentinel = f"{_EXIT_FILE_PREFIX}{token}"
        streams = {name: _OutputFile(f"{_OUTPUT_FILE_PREFIX}{token}.{name}") for name in ("stdout", "stderr")}
        started = time.monotonic()
        process = self._session.create_process(
            "bash",
            ["-lc", f"{inner} > {streams['stdout'].path} 2> {streams['stderr'].path}; echo $? > {sentinel}"],
            cwd=self._cwd,
            env=dict(env) if env else None,
            kill_after=kill_after,
        )
        delay = _POLL_FLOOR_SECONDS
        exit_code = None
        while exit_code is None:
            if deadline is not None and time.monotonic() > deadline:
                with contextlib.suppress(Exception):
                    process.kill()
                overrun = time.monotonic() - started - seconds
                raise ServiceError(
                    f"command still running {overrun:.0f}s past its {seconds}s timeout: {_brief(command)}"
                )
            time.sleep(delay)
            delay = min(delay * 2, _POLL_CAP_SECONDS)
            exit_code = self._recorded_exit_code(sentinel)
            if on_output is not None:
                self._forward_output(streams, on_output)
        self._forward_output(streams, on_output)
        return CommandResult(
            exit_code=exit_code,
            stdout=streams["stdout"].text,
            stderr=streams["stderr"].text,
            timed_out=timeout_seconds is not None and exit_code in _TIMEOUT_EXIT_CODES,
        )

    def _forward_output(self, streams: Mapping[str, _OutputFile], on_output: OutputSink | None) -> None:
        """Re-read the command's output files and hand anything new to ``on_output``.

        Args:
            streams: The output files, by stream name.
            on_output: The sink, or ``None`` to only refresh the captured text.
        """
        for name, stream in streams.items():
            text = stream.text
            with contextlib.suppress(Exception):
                if self._session.fs.exists(stream.path):
                    text = self._session.fs.read_text(stream.path) or ""
            # A shorter read is a stale replica or a race with the shell; keep what was seen.
            if len(text) <= len(stream.text):
                continue
            new = text[len(stream.text) :]
            stream.text = text
            if on_output is not None:
                on_output(name, new)

    def _recorded_exit_code(self, sentinel: str) -> int | None:
        """Return the exit code the wrapper wrote to ``sentinel``, or ``None`` while the command runs.

        Args:
            sentinel: Absolute path of the wrapper's exit-code file.

        Returns:
            The exit code once it has landed, else ``None``.
        """
        if not self._session.fs.exists(sentinel):
            return None
        # The shell creates the file before it writes the code, so an empty read is "not yet".
        text = self._session.fs.read_text(sentinel).strip()
        return int(text) if text.isdigit() else None

    def read_file(self, path: str) -> str | None:
        """Return the text of ``path`` (relative to the working directory), or ``None`` when absent.

        Args:
            path: Relative file path.

        Returns:
            The file's text, or ``None``.
        """
        if not self._session.fs.exists(path, cwd=self._cwd):
            return None
        return self._session.fs.read_text(path, cwd=self._cwd)

    def close(self) -> None:
        """Stop exactly one session, destroy its sandbox, and settle final usage.

        Raises:
            UsagePendingError: When paid usage cannot yet be reconciled.
            BudgetError: When trusted usage violates the reserved bounds.
        """
        if self._closed:
            return
        self._closed = True
        try:
            if self._usage is None:
                try:
                    self._box.__exit__(None, None, None)
                except Exception:
                    logger.exception("failed to destroy sandbox %s", getattr(self._box, "name", "?"))
            else:
                try:
                    self._session.stop()
                except Exception:
                    logger.exception("failed to confirm stopped sandbox %s", self._box.name)
                try:
                    self._box.destroy()
                except Exception:
                    logger.exception("failed to destroy sandbox %s", self._box.name)
                self._usage.settle()
        finally:
            try:
                self._context.run(self._api_session.__exit__, None, None, None)
            except Exception:
                logger.exception("failed to close the Vercel API session")


def _network_policy(inject_headers: Mapping[str, Mapping[str, str]]) -> Any:
    """Build the policy that adds ``inject_headers`` at the network edge, or ``None`` for an open network.

    Args:
        inject_headers: Host → headers to add to the box's requests to that host.

    Returns:
        A custom ``NetworkPolicy`` that still allows every host, or ``None`` when nothing is injected.
    """
    if not inject_headers:
        return None
    rules = {
        host: (NetworkPolicyRule(transform=(NetworkPolicyTransform(headers=dict(headers)),)),)
        for host, headers in inject_headers.items()
    }
    return NetworkPolicy.custom(allow={_ANY_HOST: (), **rules})


class VercelSandboxRuntime:
    """Sandbox runtime over the Vercel Sandbox SDK."""

    injects_headers = True

    def __init__(self, credentials: VercelCredentials, *, image: str, budget: BudgetRuntime | None = None) -> None:
        """Bind the runtime to explicit credentials.

        Args:
            credentials: Token, team and project the sandboxes are created under.
            image: Image the boxes boot from unless their spec names one.
            budget: Shared authoritative budget for protected offline runs.

        Raises:
            ServiceError: When the SDK is not installed.
        """
        if vercel_sync is None or vercel_api is None:
            raise ServiceError(_PACKAGE_MISSING)
        self._credentials = credentials
        self._image = image
        self._budget = budget
        self.protected = budget is not None
        self.injects_headers = budget is None

    def open(self, spec: SandboxSpec) -> SandboxSession:
        """Create a sandbox per ``spec``.

        Args:
            spec: Lifetime, environment, image, header injection and labels for the sandbox.

        Returns:
            The session over the new sandbox.
        """
        if not math.isfinite(spec.lifetime_seconds) or spec.lifetime_seconds <= 0:
            raise ServiceError("The sandbox lifetime must be finite and positive.")
        if isinstance(spec.vcpus, bool) or spec.vcpus not in {1, *range(2, 33, 2)}:
            raise ServiceError("The sandbox must use 1 or an even number of vCPUs between 2 and 32.")
        if spec.network_disabled and spec.inject_headers:
            raise ServiceError("An offline sandbox cannot inject network credentials.")
        image = spec.image or self._image
        name = spec.name
        usage = None
        if self._budget is not None:
            if not spec.operation_key:
                raise ServiceError("A protected sandbox requires a stable operation identity.")
            name = (
                name
                or "skynet-"
                + json_fingerprint([self._budget.budget_id, self._budget.generation, spec.operation_key])[:48]
            )
            usage = VercelUsageReservation(
                self._budget,
                {
                    "name": name,
                    "image": image,
                    "lifetime_ms": math.ceil(spec.lifetime_seconds * 1000),
                    "vcpus": spec.vcpus,
                    "network_disabled": spec.network_disabled,
                    "ports": [],
                    "persistent": False,
                    "environment_fingerprint": json_fingerprint(dict(spec.env)),
                },
                operation_key=spec.operation_key,
            )
        creds = self._credentials
        options = vercel_sync.SandboxServiceOptions(
            credentials_factory=lambda: vercel_sync.SandboxCredentials(
                token=creds.token, team_id=creds.team_id, project_id=creds.project_id
            )
        )
        # The SDK finds its credentials through a context variable bound by
        # ``session()``. The bind and its reset must happen in one ``Context``,
        # yet a box is routinely opened on a holdout worker thread and closed
        # from the job's main thread, so each box gets a private copy of the
        # caller's context that ``close()`` re-enters. The box itself keeps a
        # reference to its service, so nothing after creation needs the
        # variable, and the copy leaves the caller's own context untouched.
        context = contextvars.copy_context()
        # The SDK's default HTTP client gives any read 60 seconds. Commands are
        # watched with short polls rather than one long stream, but the
        # post-exit log replay of a chatty command can still take longer, so
        # reads get the box lifetime — nothing in a box outlives the box.
        read_ceiling = max(spec.lifetime_seconds, 60.0)
        api_session = vercel_api.session(
            service_options=[options],
            httpx_client_factory=lambda: httpx.Client(
                timeout=httpx.Timeout(60.0, read=read_ceiling),
                event_hooks={"response": [usage.capture_response]} if usage is not None else None,
            ),
        )
        box = None
        try:
            context.run(api_session.__enter__)
            box = context.run(
                vercel_sync.create_sandbox,
                name=name,
                image=image,
                execution_time_limit=spec.lifetime_seconds,
                resources=vercel_sync.SandboxResources(vcpus=spec.vcpus, memory=spec.vcpus * 2048),
                persistent=False,
                ports=[],
                env=dict(spec.env) or None,
                network_policy=(
                    NetworkPolicy.deny_all() if spec.network_disabled else _network_policy(spec.inject_headers)
                ),
                tags={**SANDBOX_TAG, **spec.tags},
            )
            session = VercelSandboxSession(box, api_session, context, usage)
            if usage is not None:
                usage.confirm_created(box.current_session)
            return session
        except BaseException:
            if box is not None:
                with contextlib.suppress(Exception):
                    box.__exit__(None, None, None)
            if usage is not None:
                usage.pending()
            context.run(api_session.__exit__, None, None, None)
            raise

    def stop_job_sandboxes(self, job_id: str) -> int:
        """Stop every box still up under ``job_id``'s tag.

        A job's child process closes its own boxes on the way out, but a
        cancel or a stall kills that process before its ``finally`` blocks
        run, so the worker sweeps the job's boxes by tag once the child is
        gone. Boxes already stopping or stopped are left alone.

        Args:
            job_id: The job whose boxes to stop.

        Returns:
            How many boxes were stopped.
        """
        creds = self._credentials
        options = vercel_sync.SandboxServiceOptions(
            credentials_factory=lambda: vercel_sync.SandboxCredentials(
                token=creds.token, team_id=creds.team_id, project_id=creds.project_id
            )
        )
        query = vercel_sync.SandboxQueryByCreatedAt(tag=vercel_sync.TagFilter(key=JOB_TAG, value=job_id))
        stopped = 0
        with vercel_api.session(service_options=[options]):
            for box in vercel_sync.query_sandboxes(query=query, project_id=creds.project_id):
                if box.status not in _STOPPABLE_STATUSES:
                    continue
                try:
                    box.stop()
                except Exception as exc:  # isolation boundary: one box's failure must not end the sweep
                    logger.warning("could not stop sandbox %s of job %s: %s", box.name, job_id, exc)
                    continue
                logger.info("stopped sandbox %s of job %s", box.name, job_id)
                stopped += 1
        return stopped


def _contained_environment(environment: Mapping[str, str], relay: str) -> dict[str, str]:
    """Route every supported model protocol to the outer sandbox mailbox.

    Args:
        environment: Command-specific non-secret environment.
        relay: Sandbox-local OpenAI-compatible relay ending in ``/v1``.

    Returns:
        Environment with provider endpoints replaced by the local mailbox.
    """
    result = dict(environment)
    result[_BUDGET_RELAY_ENV] = relay
    result["ANTHROPIC_BASE_URL"] = relay.removesuffix("/v1")
    for name in _RELAY_ENDPOINT_ENVS:
        result[name] = relay
    return result


class LocalSubprocessSession:
    """Session over a temp directory on the worker host: a development stand-in, not a security boundary.

    Commands run through ``bash -c`` as the worker's own user with a scrubbed
    environment; the directory is removed on :meth:`close`.
    """

    def __init__(self, spec: SandboxSpec, *, protected_relay: str | None = None) -> None:
        """Create the working directory and the environment commands inherit.

        Args:
            spec: Environment for the sandbox; lifetime and labels are ignored
                because per-command timeouts already bound local work.
            protected_relay: Outer sandbox mailbox forced onto nested commands.
        """
        self._dir = Path(tempfile.mkdtemp(prefix="skynet-sandbox-")).resolve()
        self._protected_relay = protected_relay
        (self._dir / "tmp").mkdir()
        # Not .resolve(): in a venv that follows the symlink to the base
        # interpreter, putting a python3 without the venv's packages on PATH.
        interpreter_bin = str(Path(sys.executable).parent)
        self._env: dict[str, str] = {
            "PATH": os.pathsep.join([interpreter_bin, os.environ.get("PATH", "/usr/bin:/bin")]),
            "HOME": str(self._dir),
            "TMPDIR": str(self._dir / "tmp"),
            "LANG": "C.UTF-8",
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            **{name: os.environ[name] for name in _LOCAL_ENV_PASSTHROUGH if name in os.environ},
            **spec.env,
        }

    @property
    def path(self) -> Path:
        """Return the working directory."""
        return self._dir

    def _resolve(self, path: str) -> Path:
        """Map a relative sandbox path onto the working directory.

        Args:
            path: Relative file path.

        Returns:
            The absolute path inside the working directory.

        Raises:
            ValueError: When ``path`` would escape the working directory.
        """
        target = (self._dir / path).resolve()
        if not target.is_relative_to(self._dir):
            raise ValueError(f"sandbox path escapes the working directory: {path!r}")
        return target

    def write_files(self, files: Mapping[str, str]) -> None:
        """Write text files at paths relative to the working directory, creating parents.

        Args:
            files: Relative path → content.
        """
        for path, text in files.items():
            target = self._resolve(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")

    def run(
        self,
        command: str,
        *,
        env: Mapping[str, str] | None = None,
        timeout_seconds: float | None = None,
        on_output: OutputSink | None = None,
    ) -> CommandResult:
        """Run ``command`` through ``bash -c`` in the working directory and wait for it.

        Args:
            command: Shell command line.
            env: Extra environment for this command.
            timeout_seconds: Kill the command (and everything it spawned) after this long.
            on_output: Receives each line of output as it is written.

        Returns:
            Exit code, captured output and whether the timeout fired.
        """
        command_environment = dict(env or {})
        if self._protected_relay is not None:
            command_environment = _contained_environment(command_environment, self._protected_relay)
        process = subprocess.Popen(
            ["bash", "-c", command],
            cwd=self._dir,
            env={**self._env, **command_environment},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            start_new_session=True,
        )
        # One reader per pipe: waiting on the process with both pipes idle
        # would deadlock once a pipe buffer fills, and the readers are what
        # hands output to the caller while the command still runs.
        captured: dict[str, list[str]] = {"stdout": [], "stderr": []}
        readers = [
            threading.Thread(target=_pump, args=(name, pipe, captured[name], on_output), daemon=True)
            for name, pipe in (("stdout", process.stdout), ("stderr", process.stderr))
        ]
        for reader in readers:
            reader.start()
        timed_out = False
        try:
            process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            _kill_process_group(process.pid)
            process.wait()
            timed_out = True
        for reader in readers:
            reader.join()
        stdout, stderr = "".join(captured["stdout"]), "".join(captured["stderr"])
        if timed_out:
            return CommandResult(exit_code=_LOCAL_KILLED_EXIT_CODE, stdout=stdout, stderr=stderr, timed_out=True)
        return CommandResult(exit_code=process.returncode, stdout=stdout, stderr=stderr)

    def read_file(self, path: str) -> str | None:
        """Return the text of ``path`` (relative to the working directory), or ``None`` when absent.

        Args:
            path: Relative file path.

        Returns:
            The file's text, or ``None``.
        """
        target = self._resolve(path)
        if not target.is_file():
            return None
        return target.read_text(encoding="utf-8")

    def close(self) -> None:
        """Remove the working directory. Never raises."""
        shutil.rmtree(self._dir, ignore_errors=True)


def _pump(name: str, pipe: Any, captured: list[str], on_output: OutputSink | None) -> None:
    """Read ``pipe`` line by line until it closes, keeping every line and forwarding it.

    Args:
        name: The stream name handed to ``on_output``.
        pipe: The text pipe to drain.
        captured: Receives every line, for the command's captured output.
        on_output: Receives each line as it arrives, when set.
    """
    with pipe:
        for line in iter(pipe.readline, ""):
            captured.append(line)
            if on_output is not None:
                on_output(name, line)


def _kill_process_group(pid: int) -> None:
    """Kill the session ``pid`` leads, tolerating a group that already exited.

    Args:
        pid: The group leader started with ``start_new_session=True``.
    """
    with contextlib.suppress(ProcessLookupError):
        os.killpg(pid, signal.SIGKILL)


class LocalSubprocessRuntime:
    """Sandbox runtime whose boxes are temp directories on the worker host."""

    injects_headers = False

    def open(self, spec: SandboxSpec) -> SandboxSession:
        """Create a working directory per ``spec``.

        Args:
            spec: Environment for the sandbox; lifetime and labels are ignored.

        Returns:
            The session over the new directory.
        """
        return LocalSubprocessSession(spec)


class ContainedSubprocessRuntime:
    """Create private command workspaces inside an existing protected sandbox."""

    injects_headers = False
    protected = True
    contained = True

    def open(self, spec: SandboxSpec) -> SandboxSession:
        """Open a local workspace while retaining only parent-issued relay capabilities.

        Args:
            spec: Command environment and lifetime already covered by the outer sandbox.

        Returns:
            A temporary subprocess session inside the current sandbox.

        Raises:
            ServiceError: When the outer supervisor did not install its model mailbox.
        """
        relay = os.environ.get(_BUDGET_RELAY_ENV)
        if not relay:
            raise ServiceError("Contained execution requires the protected model mailbox.")
        environment = _contained_environment(spec.env, relay)
        tool_token = os.environ.get(_TOOL_RELAY_ENV)
        if tool_token:
            environment[_TOOL_RELAY_ENV] = tool_token
        return LocalSubprocessSession(replace(spec, env=environment), protected_relay=relay)


def sandbox_unavailable_reason(settings: Settings) -> str | None:
    """Explain why this deployment cannot create agent sandboxes, or return ``None``.

    Args:
        settings: The backend settings.

    Returns:
        A user-facing reason, or ``None`` when sandboxes can be created.
    """
    if current_sandbox_runtime() is not None:
        return None
    if vercel_sync is None or vercel_api is None:
        return _PACKAGE_MISSING
    if not (settings.vercel_token and settings.vercel_team_id and settings.vercel_project_id):
        return _CREDENTIALS_MISSING
    return None


def sandbox_runtime_from_settings(settings: Settings) -> SandboxRuntime | None:
    """Build the Vercel runtime from settings, or return ``None`` when unconfigured.

    Args:
        settings: The backend settings.

    Returns:
        A runtime, or ``None`` when :func:`sandbox_unavailable_reason` is set.
    """
    if current_sandbox_runtime() is not None:
        return current_sandbox_runtime()
    if sandbox_unavailable_reason(settings) is not None:
        return None
    return VercelSandboxRuntime(
        VercelCredentials(
            token=settings.vercel_token.get_secret_value(),
            team_id=str(settings.vercel_team_id),
            project_id=str(settings.vercel_project_id),
        ),
        image=settings.vercel_sandbox_image,
    )


def scorer_runtime_from_settings(settings: Settings) -> SandboxRuntime:
    """Return the current contained runtime or the managed Vercel sandbox.

    Args:
        settings: The backend settings.

    Returns:
        The managed runtime scorers open their workspaces with.

    Raises:
        ServiceError: When the managed sandbox is not configured.
    """
    if current_sandbox_runtime() is not None:
        return current_sandbox_runtime()
    runtime = sandbox_runtime_from_settings(settings)
    if runtime is not None:
        return runtime
    raise ServiceError(sandbox_unavailable_reason(settings) or _CREDENTIALS_MISSING)
