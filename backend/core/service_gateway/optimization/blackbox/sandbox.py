"""Sandbox runtime for agent targets: one throwaway microVM per scorer run.

The optimizer never enters a sandbox. For every evaluation it opens a
fresh Vercel Sandbox, writes the harness under test and the case into it,
runs the agent there, reads the result back and destroys the box — so
versions cannot see each other or the worker's filesystem, and nothing
survives a run. :class:`SandboxRuntime` / :class:`SandboxSession` are the
seams the tests fake; :class:`VercelSandboxRuntime` is the real one.
"""

from __future__ import annotations

import logging
import math
import posixpath
import shlex
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from ....config import Settings
from ....exceptions import ServiceError

# The SDK is a declared dependency, but an air-gap build vendored from an
# older requirements file must degrade to "agent targets unavailable", not
# fail to import the worker.
try:
    from vercel import api as vercel_api
    from vercel.sandbox import sync as vercel_sync
except ImportError:  # pragma: no cover
    vercel_api = None
    vercel_sync = None

logger = logging.getLogger(__name__)

# ``timeout --signal=KILL`` exits 124 when it fired; 137 is the shell dying of the KILL itself.
_TIMEOUT_EXIT_CODES = frozenset({124, 137})
# Slack past the in-sandbox timeout before the service kills the wrapper as well.
_KILL_GRACE_SECONDS = 15.0
# Every sandbox carries this tag so stragglers from a crashed worker can be found and destroyed.
SANDBOX_TAG = {"skynet": "blackbox"}
_PACKAGE_MISSING = "The vercel-sandbox package is not installed."
_CREDENTIALS_MISSING = "Agent sandboxes are not configured: set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID."


@dataclass(frozen=True)
class SandboxSpec:
    """What a session needs to open a sandbox."""

    lifetime_seconds: float
    env: Mapping[str, str] = field(default_factory=dict)
    name: str | None = None
    tags: Mapping[str, str] = field(default_factory=dict)


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

    def open(self, spec: SandboxSpec) -> SandboxSession:
        """Create a sandbox per ``spec``.

        Args:
            spec: Lifetime, environment and labels for the sandbox.

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


class VercelSandboxRuntime:
    """Sandbox runtime over the Vercel Sandbox SDK."""

    def __init__(self, credentials: VercelCredentials) -> None:
        """Bind the runtime to explicit credentials.

        Args:
            credentials: Token, team and project the sandboxes are created under.

        Raises:
            ServiceError: When the SDK is not installed.
        """
        if vercel_sync is None or vercel_api is None:
            raise ServiceError(_PACKAGE_MISSING)
        self._credentials = credentials

    def open(self, spec: SandboxSpec) -> SandboxSession:
        """Create a sandbox per ``spec``.

        Args:
            spec: Lifetime, environment and labels for the sandbox.

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
                execution_time_limit=spec.lifetime_seconds,
                env=dict(spec.env) or None,
                tags={**SANDBOX_TAG, **spec.tags},
            )
        except BaseException:
            api_session.__exit__(None, None, None)
            raise
        return VercelSandboxSession(box, api_session)


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
        )
    )
