"""Turn repository versions into ready checkouts inside one parent-owned sandbox.

The trusted parent owns this box, not the guest that hosts the agent, so a
run's secrets reach the scorer without ever sharing a filesystem with the
agent that writes the versions.

The box may open with network access to package registries so the setup
command can install dependencies. Setup runs once, on the starting commit and
without the run's secrets; the box's network is then switched off and the
switch checked from inside before any version is laid out. Every version
starts from a copy of that prepared tree and runs no setup of its own.
"""

from __future__ import annotations

import shlex
import threading
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

from .repo_tree import archive_chunks, patch_violations
from .sandbox import CommandResult, OutputSink, SandboxRuntime, SandboxSession, SandboxSpec

REPO_DIR = ".skynet-repo"
BASE_DIR = f"{REPO_DIR}/base"
WORK_DIR = f"{REPO_DIR}/work"
PREPARED_DIR = f"{REPO_DIR}/prepared"
PATCH_FILE = f"{REPO_DIR}/version.patch"
_SETUP_TIMEOUT_SECONDS = 1_800.0
_GIT_IDENTITY = "-c user.name=skynet -c user.email=skynet@localhost -c commit.gpgsign=false"
_PROBE_TIMEOUT_SECONDS = 120.0
_PROBE_ATTEMPTS = 5
_PROBE_OK = "skynet-network-closed"


class RepoSetupError(RuntimeError):
    """The repository could not be prepared, so no version can be scored."""


class NetworkCutoffError(RuntimeError):
    """The scoring box's network could not be switched off and confirmed; the run must stop."""


def _probe_command(hosts: Iterable[str]) -> str:
    """Build the in-box check that every formerly allowed host is now unreachable.

    A connection that opens is the only evidence of an open network, so the
    check passes only when it finishes and prints its marker with none open.
    It retries a few times because a policy change can take a moment to land.

    Args:
        hosts: Hosts the box could reach before the switch.

    Returns:
        A shell command printing ``_PROBE_OK`` once no host accepts a connection.
    """
    checks = " ".join(
        f"if timeout 5 bash -c {shlex.quote(f'exec 3<>/dev/tcp/{host}/443')} 2>/dev/null; then open=1; fi;"
        for host in hosts
    )
    return (
        f"for attempt in $(seq {_PROBE_ATTEMPTS}); do open=0; {checks}"
        f' if [ "$open" = 0 ]; then echo {_PROBE_OK}; exit 0; fi; sleep 2; done; exit 1'
    )


@dataclass(frozen=True)
class Checkout:
    """One version laid out on disk, or the reason it could not be."""

    path: str | None
    problems: tuple[str, ...] = ()


def redact(text: str, secrets: Iterable[str]) -> str:
    """Hide every secret value a command could have printed.

    Args:
        text: Command output or scorer feedback.
        secrets: Values to hide; short ones are skipped, since masking them
            would scramble ordinary output.

    Returns:
        The text with each secret replaced by ``[secret]``.
    """
    for value in sorted({value for value in secrets if len(value) >= 6}, key=len, reverse=True):
        text = text.replace(value, "[secret]")
    return text


def _tail(result: CommandResult, limit: int = 4_000) -> str:
    """Keep the end of a command's output, where failures usually are.

    Args:
        result: Finished command.
        limit: Most characters kept.

    Returns:
        The combined output's last ``limit`` characters.
    """
    combined = "\n".join(part for part in (result.stdout, result.stderr) if part).strip()
    return combined[-limit:]


class RepoWorkspace:
    """Unpack a repository snapshot once, prepare it, then rebuild a clean checkout for every version.

    Every version starts from a fresh copy of the prepared tree, so nothing one
    version's code writes into the checkout reaches the next. Calls are
    serialized: versions are scored one at a time.
    """

    def __init__(
        self,
        *,
        runtime: SandboxRuntime,
        spec: SandboxSpec,
        archive: Path,
        editable_paths: Iterable[str],
        readonly_paths: Iterable[str],
        setup_command: str | None,
        secrets: Mapping[str, str],
    ) -> None:
        """Bind a snapshot to a runtime without opening anything yet.

        Args:
            runtime: Where the box is opened.
            spec: Lifetime, labels and network policy for the box. A box that
                is not deny-all from the start is switched off after setup.
            archive: Packed tree from :func:`fetch_snapshot`.
            editable_paths: Files and folders versions may change.
            readonly_paths: Submodules and Git LFS files.
            setup_command: Shell command run once on the starting commit.
            secrets: Environment the scorer receives; setup never does.
        """
        self._runtime = runtime
        self._spec = spec
        self._archive = archive
        self._editable = tuple(editable_paths)
        self._readonly = tuple(readonly_paths)
        self._setup = (setup_command or "").strip() or None
        self._secrets = dict(secrets)
        self._session: SandboxSession | None = None
        self._failure: BaseException | None = None
        self._setup_log = ""
        self._lock = threading.Lock()

    @property
    def secrets(self) -> dict[str, str]:
        """Return the environment versions run with."""
        return dict(self._secrets)

    @property
    def setup_log(self) -> str:
        """Return the end of the setup command's output, once it has run."""
        return self._setup_log

    def session(self, *, on_output: OutputSink | None = None) -> SandboxSession:
        """Return the open box, preparing it on first use.

        Preparation unpacks the snapshot, runs the setup command once on a copy
        laid out where versions will live, keeps that as the prepared tree, and
        takes the box offline. A failure is remembered, so no later call
        reopens a box and nothing runs in one that was not taken offline.

        Args:
            on_output: Receives setup output as it streams.

        Returns:
            The offline box holding the prepared tree under ``PREPARED_DIR``.

        Raises:
            RepoSetupError: When the snapshot cannot be unpacked or set up.
            NetworkCutoffError: When the network cannot be switched off and confirmed.
        """
        if self._session is not None:
            return self._session
        if self._failure is not None:
            raise self._failure
        session = self._runtime.open(self._spec)
        try:
            self._prepare(session, on_output)
            if not self._spec.network_disabled:
                self._cut_network(session)
        except BaseException as error:
            self._failure = error
            session.close()
            raise
        self._session = session
        return session

    def _prepare(self, session: SandboxSession, on_output: OutputSink | None) -> None:
        """Unpack the snapshot and run the setup command once on the starting commit.

        Setup runs on a copy at ``WORK_DIR`` because tools such as virtualenvs
        and editable installs record absolute paths, and every version is laid
        out at that same path later. It gets no secrets: the box may still
        reach package registries while it runs.

        Args:
            session: The freshly opened box.
            on_output: Receives setup output as it streams.

        Raises:
            RepoSetupError: When the snapshot cannot be unpacked or set up.
        """
        parts = []
        for index, chunk in enumerate(archive_chunks(self._archive)):
            name = f"{REPO_DIR}/tree.{index:04d}.b64"
            session.write_files({name: chunk})
            parts.append(name)
        files = " ".join(shlex.quote(part) for part in parts)
        result = session.run(
            f"set -e; mkdir -p {BASE_DIR}; cat {files} | base64 -d | tar -xzf - -C {BASE_DIR}; rm -f {files};"
            f" cd {BASE_DIR}; git init -q; git add -A -f; git {_GIT_IDENTITY} commit -q --allow-empty -m base;"
            f" cd - >/dev/null; rm -rf {WORK_DIR} {PREPARED_DIR}; cp -a {BASE_DIR} {WORK_DIR}",
            timeout_seconds=_SETUP_TIMEOUT_SECONDS,
        )
        if not result.ok:
            raise RepoSetupError(f"The repository could not be unpacked: {_tail(result)}")
        if self._setup is not None:
            setup = session.run(
                f"cd {WORK_DIR} && {self._setup}", timeout_seconds=_SETUP_TIMEOUT_SECONDS, on_output=on_output
            )
            self._setup_log = redact(_tail(setup), self._secrets.values())
            if setup.timed_out:
                raise RepoSetupError(f"The setup command ran out of time.\n{self._setup_log}")
            if not setup.ok:
                raise RepoSetupError(f"The setup command failed (exit {setup.exit_code}).\n{self._setup_log}")
        moved = session.run(f"mv {WORK_DIR} {PREPARED_DIR}", timeout_seconds=_SETUP_TIMEOUT_SECONDS)
        if not moved.ok:
            raise RepoSetupError(f"The prepared repository could not be kept: {_tail(moved)}")

    def _cut_network(self, session: SandboxSession) -> None:
        """Switch the box offline and confirm it from inside before any version runs.

        Args:
            session: The prepared box.

        Raises:
            NetworkCutoffError: When the switch is unsupported, fails, or a
                formerly allowed host still accepts connections.
        """
        switch = getattr(session, "disable_network", None)
        if switch is None:
            raise NetworkCutoffError("This sandbox cannot switch its network off, so versions cannot run in it.")
        try:
            switch()
        except Exception as error:
            raise NetworkCutoffError(f"The scoring box's network could not be switched off: {error}") from error
        hosts = self._spec.allowed_hosts or ("pypi.org",)
        probe = session.run(_probe_command(hosts), timeout_seconds=_PROBE_TIMEOUT_SECONDS)
        if not probe.ok or _PROBE_OK not in probe.stdout:
            raise NetworkCutoffError("The scoring box could still reach the network after it was switched off.")

    def checkout(self, patch: str) -> Checkout:
        """Lay out one version on a copy of the prepared tree.

        Args:
            patch: The version as ``git diff --binary`` against the snapshot.

        Returns:
            The checkout's path, relative to the box, or why the version is
            not allowed or does not apply.
        """
        problems = patch_violations(patch, self._editable, self._readonly)
        if problems:
            return Checkout(path=None, problems=tuple(problems))
        with self._lock:
            session = self.session()
            session.write_files({PATCH_FILE: patch})
            applied = session.run(
                f"set -e; rm -rf {WORK_DIR}; cp -a {PREPARED_DIR} {WORK_DIR}; cd {WORK_DIR};"
                f" if [ -s ../version.patch ]; then git apply --binary --whitespace=nowarn ../version.patch; fi",
                timeout_seconds=_SETUP_TIMEOUT_SECONDS,
            )
            if not applied.ok:
                return Checkout(path=None, problems=(f"The change does not apply cleanly: {_tail(applied)}",))
            return Checkout(path=WORK_DIR)

    def close(self) -> None:
        """Destroy the box."""
        with self._lock:
            if self._session is not None:
                session, self._session = self._session, None
                session.close()
