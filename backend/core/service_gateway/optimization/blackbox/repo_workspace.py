"""Turn repository versions into ready checkouts inside one parent-owned sandbox.

The trusted parent owns this box, not the guest that hosts the agent, so a
run's secrets reach the setup command and the scorer without ever sharing a
filesystem with the agent that writes the versions.
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
PATCH_FILE = f"{REPO_DIR}/version.patch"
_SETUP_TIMEOUT_SECONDS = 1_800.0
_GIT_IDENTITY = "-c user.name=skynet -c user.email=skynet@localhost -c commit.gpgsign=false"


@dataclass(frozen=True)
class Checkout:
    """One version laid out on disk and set up, or the reason it could not be."""

    path: str | None
    problems: tuple[str, ...] = ()
    setup_log: str = ""


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
    """Unpack a repository snapshot once, then rebuild a clean checkout for every version.

    Every version starts from a fresh copy of the pristine tree, so nothing one
    version's code or setup writes into the checkout reaches the next. Calls
    are serialized: versions are scored one at a time.
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
            spec: Lifetime, labels and network policy for the box.
            archive: Packed tree from :func:`fetch_snapshot`.
            editable_paths: Files and folders versions may change.
            readonly_paths: Submodules and Git LFS files.
            setup_command: Shell command run in each checkout before scoring.
            secrets: Environment the setup command and scorer receive.
        """
        self._runtime = runtime
        self._spec = spec
        self._archive = archive
        self._editable = tuple(editable_paths)
        self._readonly = tuple(readonly_paths)
        self._setup = (setup_command or "").strip() or None
        self._secrets = dict(secrets)
        self._session: SandboxSession | None = None
        self._lock = threading.Lock()

    @property
    def secrets(self) -> dict[str, str]:
        """Return the environment versions run with."""
        return dict(self._secrets)

    def session(self) -> SandboxSession:
        """Return the open box, unpacking the snapshot into it on first use.

        Returns:
            The box holding the pristine tree under ``BASE_DIR``.

        Raises:
            RuntimeError: When the snapshot cannot be unpacked.
        """
        if self._session is not None:
            return self._session
        session = self._runtime.open(self._spec)
        try:
            parts = []
            for index, chunk in enumerate(archive_chunks(self._archive)):
                name = f"{REPO_DIR}/tree.{index:04d}.b64"
                session.write_files({name: chunk})
                parts.append(name)
            files = " ".join(shlex.quote(part) for part in parts)
            result = session.run(
                f"set -e; mkdir -p {BASE_DIR}; cat {files} | base64 -d | tar -xzf - -C {BASE_DIR}; rm -f {files};"
                f" cd {BASE_DIR}; git init -q; git add -A -f; git {_GIT_IDENTITY} commit -q --allow-empty -m base",
                timeout_seconds=_SETUP_TIMEOUT_SECONDS,
            )
            if not result.ok:
                raise RuntimeError(f"The repository could not be unpacked: {_tail(result)}")
        except BaseException:
            session.close()
            raise
        self._session = session
        return session

    def checkout(self, patch: str, *, on_output: OutputSink | None = None) -> Checkout:
        """Lay out one version and run the setup command in it.

        Args:
            patch: The version as ``git diff --binary`` against the snapshot.
            on_output: Receives redacted setup output as it streams.

        Returns:
            The checkout's path, relative to the box, or why the version is
            not allowed or did not set up.
        """
        problems = patch_violations(patch, self._editable, self._readonly)
        if problems:
            return Checkout(path=None, problems=tuple(problems))
        with self._lock:
            session = self.session()
            session.write_files({PATCH_FILE: patch})
            applied = session.run(
                f"set -e; rm -rf {WORK_DIR}; cp -a {BASE_DIR} {WORK_DIR}; cd {WORK_DIR};"
                f" if [ -s ../version.patch ]; then git apply --binary --whitespace=nowarn ../version.patch; fi",
                timeout_seconds=_SETUP_TIMEOUT_SECONDS,
            )
            if not applied.ok:
                return Checkout(path=None, problems=(f"The change does not apply cleanly: {_tail(applied)}",))
            if self._setup is None:
                return Checkout(path=WORK_DIR)
            sink: OutputSink | None = None
            if on_output is not None:
                secrets = list(self._secrets.values())

                def sink(stream: str, piece: str) -> None:
                    """Forward one piece of setup output with secrets hidden.

                    Args:
                        stream: ``stdout`` or ``stderr``.
                        piece: New output.
                    """
                    on_output(stream, redact(piece, secrets))

            setup = session.run(
                f"cd {WORK_DIR} && {self._setup}",
                env=self._secrets or None,
                timeout_seconds=_SETUP_TIMEOUT_SECONDS,
                on_output=sink,
            )
            log = redact(_tail(setup), self._secrets.values())
            if setup.timed_out:
                return Checkout(path=None, problems=("The setup command ran out of time.",), setup_log=log)
            if not setup.ok:
                return Checkout(
                    path=None, problems=(f"The setup command failed (exit {setup.exit_code}).",), setup_log=log
                )
            return Checkout(path=WORK_DIR, setup_log=log)

    def close(self) -> None:
        """Destroy the box."""
        with self._lock:
            if self._session is not None:
                session, self._session = self._session, None
                session.close()
