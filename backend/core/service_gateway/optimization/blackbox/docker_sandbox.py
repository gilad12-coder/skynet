"""Local Docker sandbox runtime for the single-user Mac app (local mode).

In local mode the protected parent opens its boxes as containers on this
machine instead of Vercel microVMs. The guest contract stays the same: files
and commands relative to a writable working directory, output streamed while
a command runs (the model mailbox answers guest requests mid-command), and no
network unless the parent asked for an allowlisted setup box. Containers run
with a read-only root filesystem, a fixed CPU and memory profile, a wall-time
limit and the ``skynet.job`` label the desktop shell and the worker sweep use
for cleanup. Local sandboxes are never billed, so the budget is never charged.
"""

from __future__ import annotations

import io
import json
import logging
import math
import posixpath
import shutil
import subprocess
import tarfile
import threading
import time
from collections.abc import Mapping

from ....billing.runtime import BudgetRuntime
from ....config import Settings
from ....exceptions import ServiceError
from ....i18n import t

# sandbox.py's settings factories build this runtime in local mode, so the two
# modules import each other; names are read from the module at call time.
from . import sandbox
from .sandbox_log import logged_command

logger = logging.getLogger(__name__)

# The desktop shell sweeps leftover boxes by this label on quit (plan §1.7).
DOCKER_JOB_LABEL = "skynet.job"
WORKSPACE_DIR = "/workspace"
# The image's root stays read-only; only these tmpfs mounts are writable.
# Docker's tmpfs default is noexec, which would break native venvs and scripts.
_TMPFS_MOUNTS = (
    f"{WORKSPACE_DIR}:rw,exec,nosuid,mode=1777,size=4g",
    "/tmp:rw,exec,nosuid,mode=1777,size=1g",
)
_PIDS_LIMIT = 1024
_CLI_TIMEOUT_SECONDS = 60.0
_PROBE_TIMEOUT_SECONDS = 10.0
_MISSING_FILE_EXIT = 3
_READ_FILE_SCRIPT = f'test -f "$1" || exit {_MISSING_FILE_EXIT}; exec cat -- "$1"'
_ALLOWLIST_NETWORK = "bridge"


def _docker(
    docker_bin: str, args: list[str], *, stdin: bytes | None = None, timeout: float = _CLI_TIMEOUT_SECONDS
) -> subprocess.CompletedProcess[bytes]:
    """Run one short Docker CLI command and capture its output.

    Args:
        docker_bin: Docker (or OrbStack) CLI path.
        args: Arguments after the binary.
        stdin: Bytes fed to the command's standard input.
        timeout: Wall-clock limit for the CLI call.

    Returns:
        The completed process with raw stdout and stderr.

    Raises:
        ServiceError: When the CLI is missing or does not answer in time.
    """
    try:
        return subprocess.run([docker_bin, *args], input=stdin, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as error:
        raise ServiceError(t("sandbox.docker_unavailable")) from error
    except subprocess.TimeoutExpired as error:
        raise ServiceError(f"docker {args[0]} did not answer within {timeout:.0f}s.") from error


def _stderr_line(result: subprocess.CompletedProcess[bytes]) -> str:
    """Return the last non-empty line Docker wrote to stderr.

    Args:
        result: A finished Docker CLI call.

    Returns:
        The line, cut to a readable length, or the exit status when stderr is empty.
    """
    lines = [line.strip() for line in result.stderr.decode(errors="replace").splitlines() if line.strip()]
    return lines[-1][:240] if lines else f"exit status {result.returncode}"


def _relative_path(path: str) -> str:
    """Keep a sandbox file path inside the working directory.

    Args:
        path: Path relative to the working directory.

    Returns:
        The normalized relative POSIX path.

    Raises:
        ValueError: When ``path`` is absolute or would escape the working directory.
    """
    normalized = posixpath.normpath(path)
    if not path or "\x00" in path or posixpath.isabs(normalized) or normalized.split("/")[0] == "..":
        raise ValueError(f"sandbox path escapes the working directory: {path!r}")
    return normalized


def _env_args(env: Mapping[str, str]) -> list[str]:
    """Turn an environment mapping into Docker ``-e`` arguments.

    Args:
        env: Non-secret guest environment; secrets never enter a guest.

    Returns:
        Alternating ``-e`` flags and ``NAME=value`` items.
    """
    args: list[str] = []
    for name, value in env.items():
        args += ["-e", f"{name}={value}"]
    return args


class DockerSandboxSession:
    """Session over one running container, addressed by its id."""

    def __init__(self, docker_bin: str, container: str, *, env: Mapping[str, str], owner: str | None) -> None:
        """Wrap a started container.

        Args:
            docker_bin: Docker CLI path.
            container: The container id ``docker run -d`` printed.
            env: The box's environment, kept so its values are redacted from logged output.
            owner: Job the box belongs to, which its logged output is routed to.
        """
        self._docker_bin = docker_bin
        self.container = container
        self._env = dict(env)
        self.log_owner = owner
        self._closed = False
        self._lock = threading.Lock()

    def write_files(self, files: Mapping[str, str]) -> None:
        """Write text files at paths relative to the working directory, creating parents.

        One tar stream per call keeps a many-file write to a single exec, and
        it runs beside an in-flight command because the model mailbox answers
        guest requests while that command still runs.

        Args:
            files: Relative path → content.

        Raises:
            ServiceError: When the container refuses the files.
        """
        if not files:
            return
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for path, text in files.items():
                data = text.encode("utf-8")
                info = tarfile.TarInfo(_relative_path(path))
                info.size = len(data)
                info.mode = 0o644
                info.mtime = int(time.time())
                archive.addfile(info, io.BytesIO(data))
        result = _docker(
            self._docker_bin,
            ["exec", "-i", "-w", WORKSPACE_DIR, self.container, "tar", "-x", "-f", "-", "--no-same-owner"],
            stdin=buffer.getvalue(),
        )
        if result.returncode != 0:
            raise ServiceError(f"Could not write files into the local sandbox: {_stderr_line(result)}")

    @logged_command
    def run(
        self,
        command: str,
        *,
        env: Mapping[str, str] | None = None,
        timeout_seconds: float | None = None,
        on_output: sandbox.OutputSink | None = None,
    ) -> sandbox.CommandResult:
        """Run ``command`` through ``bash -lc`` in the working directory and stream its output.

        Args:
            command: Shell command line.
            env: Extra environment for this command.
            timeout_seconds: Kill the command after this long.
            on_output: Receives each line of output as it is written.

        Returns:
            Exit code, captured output and whether the timeout fired.

        Raises:
            ServiceError: When the command outlives its kill deadline or Docker is missing.
        """
        inner = ["bash", "-lc", command]
        deadline = None
        seconds = None
        if timeout_seconds is not None:
            seconds = max(1, math.ceil(timeout_seconds))
            inner = ["timeout", "--signal=KILL", f"{seconds}s", *inner]
            deadline = seconds + sandbox.KILL_GRACE_SECONDS
        argv = [self._docker_bin, "exec", "-w", WORKSPACE_DIR, *_env_args(env or {}), self.container, *inner]
        try:
            process = subprocess.Popen(
                argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace", bufsize=1
            )
        except FileNotFoundError as error:
            raise ServiceError(t("sandbox.docker_unavailable")) from error
        # One reader per pipe hands each line to the caller as it lands; the
        # model mailbox must see a guest request while the command still runs.
        captured: dict[str, list[str]] = {"stdout": [], "stderr": []}
        readers = [
            threading.Thread(target=sandbox._pump, args=(name, pipe, captured[name], on_output), daemon=True)
            for name, pipe in (("stdout", process.stdout), ("stderr", process.stderr))
        ]
        for reader in readers:
            reader.start()
        try:
            process.wait(timeout=deadline)
        except subprocess.TimeoutExpired as error:
            process.kill()
            process.wait()
            raise ServiceError(
                f"command still running {sandbox.KILL_GRACE_SECONDS:.0f}s past its {seconds}s timeout: {sandbox._brief(command)}"
            ) from error
        finally:
            for reader in readers:
                reader.join()
        exit_code = process.returncode
        return sandbox.CommandResult(
            exit_code=exit_code,
            stdout="".join(captured["stdout"]),
            stderr="".join(captured["stderr"]),
            timed_out=timeout_seconds is not None and exit_code in sandbox._TIMEOUT_EXIT_CODES,
        )

    def read_file(self, path: str) -> str | None:
        """Return the text of ``path`` (relative to the working directory), or ``None`` when absent.

        Args:
            path: Relative file path.

        Returns:
            The file's text, or ``None``.

        Raises:
            ServiceError: When the container cannot be read.
        """
        result = _docker(
            self._docker_bin,
            ["exec", "-w", WORKSPACE_DIR, self.container, "sh", "-c", _READ_FILE_SCRIPT, "sh", _relative_path(path)],
        )
        if result.returncode == _MISSING_FILE_EXIT:
            return None
        if result.returncode != 0:
            raise ServiceError(f"Could not read {path!r} from the local sandbox: {_stderr_line(result)}")
        return result.stdout.decode("utf-8", errors="replace")

    def disable_network(self) -> None:
        """Detach the container from every network and confirm that only loopback is left.

        Raises:
            ServiceError: When Docker still reports a network on the container.
        """
        for network in self._networks():
            result = _docker(self._docker_bin, ["network", "disconnect", "--force", network, self.container])
            if result.returncode != 0:
                raise ServiceError(f"Could not switch the local sandbox's network off: {_stderr_line(result)}")
        if self._networks():
            raise ServiceError("Docker did not confirm that the scoring box's network is off.")

    def _networks(self) -> list[str]:
        """List the networks the container is attached to, other than ``none``.

        Returns:
            Network names.

        Raises:
            ServiceError: When Docker cannot inspect the container.
        """
        result = _docker(
            self._docker_bin, ["inspect", "--format", "{{json .NetworkSettings.Networks}}", self.container]
        )
        if result.returncode != 0:
            raise ServiceError(f"Could not inspect the local sandbox: {_stderr_line(result)}")
        networks = json.loads(result.stdout.decode() or "null") or {}
        return [name for name in networks if name != "none"]

    def close(self) -> None:
        """Remove the container. Never raises; local boxes carry no usage to settle."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
        try:
            result = _docker(self._docker_bin, ["rm", "-f", self.container])
        except ServiceError as error:
            logger.warning("could not remove local sandbox %s: %s", self.container[:12], error)
            return
        if result.returncode != 0 and b"No such container" not in result.stderr:
            logger.warning("could not remove local sandbox %s: %s", self.container[:12], _stderr_line(result))


class DockerSandboxRuntime:
    """Sandbox runtime over the local Docker daemon (local mode only)."""

    injects_headers = False

    def __init__(self, image: str, *, docker_bin: str = "docker", budget: BudgetRuntime | None = None) -> None:
        """Bind the runtime to a locally built image.

        Args:
            image: Image id (``sha256:<64 hex>``) the boxes boot from unless their spec names one.
            docker_bin: Docker CLI path; OrbStack works through the same CLI.
            budget: The run's budget when the runtime serves a protected run. It
                only marks the runtime protected: local boxes are never charged.
        """
        self._image = image
        self._docker_bin = docker_bin
        self.protected = budget is not None
        # The broker prices a Vercel box before it opens any; local boxes are free.
        self.billable = False

    def open(self, spec: sandbox.SandboxSpec) -> sandbox.SandboxSession:
        """Start one container per ``spec``.

        Args:
            spec: Lifetime, environment, image, network and labels for the box.

        Returns:
            The session over the new container.

        Raises:
            ServiceError: When the spec asks for something local boxes cannot
                honour, or Docker cannot start the container.
        """
        if not math.isfinite(spec.lifetime_seconds) or spec.lifetime_seconds <= 0:
            raise ServiceError("The sandbox lifetime must be finite and positive.")
        if isinstance(spec.vcpus, bool) or spec.vcpus not in {1, *range(2, 33, 2)}:
            raise ServiceError("The sandbox must use 1 or an even number of vCPUs between 2 and 32.")
        if spec.inject_headers:
            raise ServiceError("A local sandbox has no network edge to inject credentials with.")
        if spec.network_disabled and spec.allowed_hosts:
            raise ServiceError("An offline sandbox cannot reach allowlisted hosts.")
        owner = spec.tags.get(sandbox.JOB_TAG)
        labels = {**sandbox.SANDBOX_TAG, **spec.tags, **({DOCKER_JOB_LABEL: owner} if owner else {})}
        # The default for a box without hosts is offline: Docker has no edge
        # policy, so an open network would let the guest reach anything.
        network = _ALLOWLIST_NETWORK if spec.allowed_hosts else "none"
        argv = [
            "run",
            "-d",
            "--rm",
            "--init",
            "--name",
            sandbox.unique_sandbox_name(spec.name or "skynet-local"),
            "--network",
            network,
            "--cpus",
            str(spec.vcpus),
            "--memory",
            f"{spec.vcpus * 2048}m",
            "--pids-limit",
            str(_PIDS_LIMIT),
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            *[item for mount in _TMPFS_MOUNTS for item in ("--tmpfs", mount)],
            "-w",
            WORKSPACE_DIR,
            *_env_args({"HOME": WORKSPACE_DIR, "TMPDIR": "/tmp", **spec.env}),
            *[item for key, value in labels.items() for item in ("--label", f"{key}={value}")],
            "--entrypoint",
            "sleep",
            spec.image or self._image,
            # The box's only process is this timer, so the container (and
            # every command in it) ends when its lifetime does.
            str(math.ceil(spec.lifetime_seconds)),
        ]
        result = _docker(self._docker_bin, argv)
        container = result.stdout.decode().strip()
        if result.returncode != 0 or not container:
            raise ServiceError(f"Could not start the local sandbox: {_stderr_line(result)}")
        return DockerSandboxSession(self._docker_bin, container, env=spec.env, owner=owner)

    def stop_job_sandboxes(self, owner_id: str) -> int:
        """Remove every container still up under ``owner_id``'s label.

        Args:
            owner_id: The job whose boxes to remove.

        Returns:
            How many containers were removed.
        """
        listed = _docker(self._docker_bin, ["ps", "-q", "--filter", f"label={DOCKER_JOB_LABEL}={owner_id}"])
        if listed.returncode != 0:
            logger.warning("could not list local sandboxes of job %s: %s", owner_id, _stderr_line(listed))
            return 0
        stopped = 0
        for container in listed.stdout.decode().split():
            removed = _docker(self._docker_bin, ["rm", "-f", container])
            if removed.returncode != 0:
                logger.warning("could not remove local sandbox %s of job %s", container, owner_id)
                continue
            stopped += 1
        return stopped


def docker_sandbox_unavailable_reason(settings: Settings) -> str | None:
    """Explain why local Docker sandboxes cannot start, or return ``None``.

    Args:
        settings: The backend settings with the Docker CLI and local image id.

    Returns:
        A user-facing reason, or ``None`` when the daemon runs and the image exists.
    """
    if shutil.which(settings.docker_bin) is None:
        return t("sandbox.docker_unavailable")
    try:
        daemon = _docker(
            settings.docker_bin, ["info", "--format", "{{.ServerVersion}}"], timeout=_PROBE_TIMEOUT_SECONDS
        )
    except ServiceError:
        return t("sandbox.docker_unavailable")
    if daemon.returncode != 0:
        return t("sandbox.docker_unavailable")
    image = settings.local_sandbox_image
    if not image:
        return t("sandbox.docker_image_missing")
    try:
        found = _docker(settings.docker_bin, ["image", "inspect", "--format", "{{.Id}}", image])
    except ServiceError:
        return t("sandbox.docker_unavailable")
    if found.returncode != 0:
        return t("sandbox.docker_image_missing")
    return None


def docker_runtime_from_settings(settings: Settings, *, budget: BudgetRuntime | None = None) -> DockerSandboxRuntime:
    """Build the local Docker runtime from settings.

    Args:
        settings: The backend settings.
        budget: The run's budget when the runtime serves a protected run.

    Returns:
        The runtime over ``settings.local_sandbox_image``.
    """
    return DockerSandboxRuntime(settings.local_sandbox_image, docker_bin=settings.docker_bin, budget=budget)
