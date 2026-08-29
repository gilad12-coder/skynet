"""Sandbox runtime for agent targets: one throwaway microVM per scorer run.

The optimizer never enters a sandbox. For every evaluation it opens a
fresh Vercel Sandbox, writes the harness under test and the case into it,
runs the agent there, reads the result back and destroys the box — so
versions cannot see each other or the worker's filesystem, and nothing
survives a run. :class:`SandboxRuntime` / :class:`SandboxSession` are the
seams the tests fake; :class:`VercelSandboxRuntime` is the real one, and
:class:`LocalSubprocessRuntime` is the development stand-in that runs the
same commands in a temp directory on the worker host — with no isolation
from it, which is why :func:`scorer_runtime_from_settings` only picks it
when a deployment has no Vercel credentials or asks for it outright.
"""

from __future__ import annotations

import contextlib
import logging
import math
import os
import posixpath
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

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
_KILL_GRACE_SECONDS = 15.0
# Every sandbox carries this tag so stragglers from a crashed worker can be found and destroyed.
SANDBOX_TAG = {"skynet": "blackbox"}
_PACKAGE_MISSING = "The vercel-sandbox package is not installed."
_CREDENTIALS_MISSING = "Agent sandboxes are not configured: set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID."
# The local runtime hands user code a bare environment: the interpreter that
# runs the worker, a private HOME/TMPDIR, and the host's CA bundle overrides
# so its HTTPS calls verify the same way — never the worker's secrets.
_LOCAL_ENV_PASSTHROUGH = ("SSL_CERT_FILE", "SSL_CERT_DIR")
_LOCAL_KILLED_EXIT_CODE = 137
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
        self, command: str, *, env: Mapping[str, str] | None = None, timeout_seconds: float | None = None
    ) -> CommandResult:
        """Run ``command`` through ``bash -lc`` in the working directory and wait for it.

        Args:
            command: Shell command line.
            env: Extra environment for this command.
            timeout_seconds: Kill the command after this long.

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
        """Destroy the sandbox. Never raises."""
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


class VercelSandboxSession:
    """Session over one Vercel sandbox, bound to the SDK session that created it."""

    def __init__(self, box: Any, api_session: Any) -> None:
        """Wrap an open sandbox.

        Args:
            box: The SDK's managed sandbox handle.
            api_session: The entered ``vercel.api.session`` context that owns it.
        """
        self._box = box
        self._api_session = api_session
        self._cwd = box.cwd

    def write_files(self, files: Mapping[str, str]) -> None:
        """Write text files at paths relative to the working directory, creating parents.

        Args:
            files: Relative path → content.
        """
        for path, text in files.items():
            parent = posixpath.dirname(path)
            if parent:
                self._box.fs.mkdir(parent, cwd=self._cwd, recursive=True)
            self._box.fs.write_text(path, text, cwd=self._cwd)

    def run(
        self, command: str, *, env: Mapping[str, str] | None = None, timeout_seconds: float | None = None
    ) -> CommandResult:
        """Run ``command`` through ``bash -lc`` in the working directory and wait for it.

        Args:
            command: Shell command line.
            env: Extra environment for this command.
            timeout_seconds: Kill the command after this long.

        Returns:
            Exit code, captured output and whether the timeout fired.
        """
        wrapped = command
        kill_after = None
        if timeout_seconds is not None:
            seconds = max(1, math.ceil(timeout_seconds))
            wrapped = f"timeout --signal=KILL {seconds}s bash -lc {shlex.quote(command)}"
            kill_after = seconds + _KILL_GRACE_SECONDS
        completed = self._box.run_process(
            "bash",
            ["-lc", wrapped],
            cwd=self._cwd,
            env=dict(env) if env else None,
            kill_after=kill_after,
            capture_output=True,
        )
        return CommandResult(
            exit_code=completed.returncode,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
            timed_out=timeout_seconds is not None and completed.returncode in _TIMEOUT_EXIT_CODES,
        )

    def read_file(self, path: str) -> str | None:
        """Return the text of ``path`` (relative to the working directory), or ``None`` when absent.

        Args:
            path: Relative file path.

        Returns:
            The file's text, or ``None``.
        """
        if not self._box.fs.exists(path, cwd=self._cwd):
            return None
        return self._box.fs.read_text(path, cwd=self._cwd)

    def close(self) -> None:
        """Destroy the sandbox and leave the SDK session. Never raises."""
        try:
            self._box.__exit__(None, None, None)
        except Exception:
            logger.exception("failed to destroy sandbox %s", getattr(self._box, "name", "?"))
        finally:
            try:
                self._api_session.__exit__(None, None, None)
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

    def __init__(self, credentials: VercelCredentials, *, image: str) -> None:
        """Bind the runtime to explicit credentials.

        Args:
            credentials: Token, team and project the sandboxes are created under.
            image: Image the boxes boot from unless their spec names one.

        Raises:
            ServiceError: When the SDK is not installed.
        """
        if vercel_sync is None or vercel_api is None:
            raise ServiceError(_PACKAGE_MISSING)
        self._credentials = credentials
        self._image = image

    def open(self, spec: SandboxSpec) -> SandboxSession:
        """Create a sandbox per ``spec``.

        Args:
            spec: Lifetime, environment, image, header injection and labels for the sandbox.

        Returns:
            The session over the new sandbox.
        """
        creds = self._credentials
        options = vercel_sync.SandboxServiceOptions(
            credentials_factory=lambda: vercel_sync.SandboxCredentials(
                token=creds.token, team_id=creds.team_id, project_id=creds.project_id
            )
        )
        # The SDK finds its credentials through a context variable bound by
        # ``session()``, so the context is entered here and left in ``close()``;
        # everything in between happens on the calling thread.
        api_session = vercel_api.session(service_options=[options])
        api_session.__enter__()
        try:
            box = vercel_sync.create_sandbox(
                name=spec.name,
                image=spec.image or self._image,
                execution_time_limit=spec.lifetime_seconds,
                env=dict(spec.env) or None,
                network_policy=_network_policy(spec.inject_headers),
                tags={**SANDBOX_TAG, **spec.tags},
            )
        except BaseException:
            api_session.__exit__(None, None, None)
            raise
        return VercelSandboxSession(box, api_session)


class LocalSubprocessSession:
    """Session over a temp directory on the worker host: a development stand-in, not a security boundary.

    Commands run through ``bash -c`` as the worker's own user with a scrubbed
    environment; the directory is removed on :meth:`close`.
    """

    def __init__(self, spec: SandboxSpec) -> None:
        """Create the working directory and the environment commands inherit.

        Args:
            spec: Environment for the sandbox; lifetime and labels are ignored
                because per-command timeouts already bound local work.
        """
        self._dir = Path(tempfile.mkdtemp(prefix="skynet-sandbox-")).resolve()
        (self._dir / "tmp").mkdir()
        interpreter_bin = str(Path(sys.executable).resolve().parent)
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
        self, command: str, *, env: Mapping[str, str] | None = None, timeout_seconds: float | None = None
    ) -> CommandResult:
        """Run ``command`` through ``bash -c`` in the working directory and wait for it.

        Args:
            command: Shell command line.
            env: Extra environment for this command.
            timeout_seconds: Kill the command (and everything it spawned) after this long.

        Returns:
            Exit code, captured output and whether the timeout fired.
        """
        process = subprocess.Popen(
            ["bash", "-c", command],
            cwd=self._dir,
            env={**self._env, **(env or {})},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            _kill_process_group(process.pid)
            stdout, stderr = process.communicate()
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


def sandbox_unavailable_reason(settings: Settings) -> str | None:
    """Explain why this deployment cannot create agent sandboxes, or return ``None``.

    Args:
        settings: The backend settings.

    Returns:
        A user-facing reason, or ``None`` when sandboxes can be created.
    """
    if vercel_sync is None or vercel_api is None:
        return _PACKAGE_MISSING
    if not (settings.vercel_token and settings.vercel_team_id and settings.vercel_project_id):
        return _CREDENTIALS_MISSING
    return None


def sandbox_runtime_from_settings(settings: Settings) -> VercelSandboxRuntime | None:
    """Build the Vercel runtime from settings, or return ``None`` when unconfigured.

    Args:
        settings: The backend settings.

    Returns:
        A runtime, or ``None`` when :func:`sandbox_unavailable_reason` is set.
    """
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
    """Pick where python scorers run, per ``BLACKBOX_SCORER_RUNTIME``.

    ``vercel`` insists on Vercel sandboxes, ``local`` on the worker host, and
    ``auto`` takes Vercel when it is configured and the host otherwise.

    Args:
        settings: The backend settings.

    Returns:
        The runtime scorers open their sandboxes with.

    Raises:
        ServiceError: When ``vercel`` is required but not configured.
    """
    mode = settings.blackbox_scorer_runtime
    if mode == "local":
        return LocalSubprocessRuntime()
    runtime = sandbox_runtime_from_settings(settings)
    if runtime is not None:
        return runtime
    if mode == "vercel":
        raise ServiceError(sandbox_unavailable_reason(settings) or _CREDENTIALS_MISSING)
    return LocalSubprocessRuntime()
