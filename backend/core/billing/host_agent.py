"""Parent side of a host-CLI proposer turn, run on the user's own subscription.

In local mode a black-box proposer can be the user's own coding CLI (Codex,
Claude Code or Droid). The sandbox never reaches the CLI itself. Its shim
(:mod:`core.worker.host_agent_shim`) sends the workspace to the gateway's
``/v1/_host_agent`` capability. This module unpacks that archive into a fresh
copy under ``local_state_dir``, runs the CLI there with provider API keys
removed from its environment, and sends the edited tree back. The CLI never
runs in the user's original folder.

The guest is untrusted. The CLI and its permission come only from the run's
stored proposer settings, given to :func:`bind_host_agent` by the worker, and
only the token minted for that proposer reaches the capability. Agent config
in the copy (``.claude/``, ``.codex/``, ``.factory/``, MCP files) is removed
before the CLI starts, and a ``workspace_only`` turn runs under a macOS
``sandbox-exec`` profile that denies reads and writes in the user's home
except the turn's own directory and the CLI's install paths.

The turn is recorded in the run's budget at zero cost: the user's
subscription pays, not the wallet.
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import io
import json
import logging
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
import uuid
import weakref
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, cast

from ..config import Settings
from ..i18n import t_locale
from ..local.cli_catalog import CliProvider, cli_model_arg, parse_subscription_model_id
from ..local.cli_probe import cli_binary, read_cli_limits, write_cli_limit
from ..worker.host_agent_shim import excluded_path
from .cli_runners import cli_env, limit_error
from .model_dispatch import ModelHTTPResult
from .model_gateway import ROUTE_KEY, ModelGateway
from .operation_pricing import ChargePolicy, operation_quote
from .runtime import PaidResult

logger = logging.getLogger(__name__)

HOST_AGENT_PATH = "/v1/_host_agent"
HOST_CLIS: tuple[CliProvider, ...] = ("codex", "claude", "droid")
# Droid has no flag that skips the user's own config, hooks and MCP servers,
# so it cannot run isolated and is refused as a host proposer.
ISOLATED_HOST_CLIS: tuple[CliProvider, ...] = ("codex", "claude")
HostPermission = Literal["workspace_only", "full_access"]
HOST_PERMISSIONS: tuple[HostPermission, ...] = ("workspace_only", "full_access")
HOST_AGENT_TOKEN_KEY = "host_agent_token"
SANDBOX_EXEC = Path("/usr/bin/sandbox-exec")
RATE_LIMITED_CODE = "subscription.rate_limited"
FAILED_KEY = "blackbox.host_agent_failed"
RATE_LIMITED_KEY = "blackbox.host_agent_rate_limited"
# The guest relay and the gateway refuse larger request bodies, so a bigger
# archive could never have arrived; the bound keeps a compressed bomb small too.
MAX_REQUEST_BYTES = 32 * 1024 * 1024
MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
MAX_MEMBERS = 50_000
_TRANSCRIPT_TAIL_CHARS = 4000


@dataclass(frozen=True)
class HostAgentFailure:
    """A host turn that must end the run, with the user-facing reason."""

    code: str
    message: str
    cli: str
    reset_at: str | None = None


class HostAgentRequestError(ValueError):
    """Raised for a request the capability refuses before any CLI runs."""


_failures: weakref.WeakKeyDictionary[ModelGateway, HostAgentFailure] = weakref.WeakKeyDictionary()
_failures_lock = threading.Lock()


def host_cli_argv(
    cli: CliProvider,
    permission: str,
    binary: str,
    workdir: Path,
    model_arg: str | None,
    prompt_file: Path | None = None,
) -> list[str]:
    """Build the CLI command for one turn.

    Codex and Claude Code read the prompt on stdin; Droid reads ``prompt_file``.

    Args:
        cli: Which CLI runs the turn.
        permission: ``workspace_only`` keeps edits inside ``workdir``;
            ``full_access`` turns the CLI's own sandbox off.
        binary: Resolved CLI executable.
        workdir: The copied workspace.
        model_arg: The CLI's own model name, or None for its default.
        prompt_file: Prompt file outside ``workdir``, for Droid.

    Returns:
        The argv list.

    Raises:
        HostAgentRequestError: When the CLI or permission is unknown.
    """
    if permission not in HOST_PERMISSIONS:
        raise HostAgentRequestError(f"Unknown host permission {permission!r}.")
    full = permission == "full_access"
    if cli == "codex":
        mode = ["--dangerously-bypass-approvals-and-sandbox"] if full else ["--sandbox", "workspace-write"]
        # The copy is not a git checkout, and codex refuses to run outside one
        # without this flag.
        argv = [binary, "exec", "--json", *mode, "--skip-git-repo-check", "-C", str(workdir)]
    elif cli == "claude":
        mode = "bypassPermissions" if full else "acceptEdits"
        argv = [binary, "-p", "--output-format", "json", "--permission-mode", mode]
    elif cli == "droid":
        mode = ["--skip-permissions-unsafe"] if full else ["--auto", "low"]
        argv = [binary, "exec", "-o", "json", *mode, "--cwd", str(workdir)]
        if prompt_file is not None:
            argv += ["-f", str(prompt_file)]
    else:
        raise HostAgentRequestError(f"Unknown host CLI {cli!r}.")
    if model_arg:
        argv += ["--model", model_arg]
    return argv


def _model_arg(cli: CliProvider, model: str) -> str | None:
    """Map the proposer's model id to the CLI's ``--model`` value.

    Args:
        cli: The CLI that runs the turn.
        model: ``subscription/<cli>/<slug>``, a plain catalog slug, or empty.

    Returns:
        The CLI's model name, or None to let the CLI use its own default.
    """
    model = model.removeprefix("openrouter/")
    parsed = parse_subscription_model_id(model)
    slug = parsed[1] if parsed else model
    if not slug:
        return None
    try:
        return cli_model_arg(cli, slug)
    except ValueError:
        return None


def _extract(archive_bytes: bytes, destination: Path) -> None:
    """Unpack an untrusted guest archive into ``destination`` only.

    Args:
        archive_bytes: Gzip tar from the sandbox.
        destination: Empty directory that becomes the CLI's workspace.

    Raises:
        HostAgentRequestError: When the archive is unreadable, too large, or escapes ``destination``.
    """
    try:
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
            members = archive.getmembers()
            if len(members) > MAX_MEMBERS or sum(member.size for member in members) > MAX_EXTRACTED_BYTES:
                raise HostAgentRequestError("The workspace is too large for a host agent turn.")
            archive.extractall(destination, filter="data")
    except (tarfile.TarError, OSError, EOFError) as error:
        raise HostAgentRequestError(f"The workspace archive is invalid: {error}") from error


def strip_agent_config(workdir: Path) -> None:
    """Remove launch files and every CLI's project config from the copy.

    Project settings, hooks and MCP servers would run on the Mac, outside the
    sandbox, so none may come from the guest.

    Args:
        workdir: The copied workspace, before the CLI starts.
    """
    for path in sorted(workdir.rglob("*"), key=lambda item: len(item.parts)):
        if not excluded_path(path.relative_to(workdir)) or not os.path.lexists(path):
            continue
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()


def _safe_link(workdir: Path, path: Path) -> bool:
    """Tell whether a link in the copy stays inside the copy.

    Args:
        workdir: The copied workspace.
        path: A symbolic link under ``workdir``.

    Returns:
        True for a relative link whose target resolves inside ``workdir``.
    """
    target = path.readlink()
    if target.is_absolute():
        return False
    resolved = os.path.normpath(path.parent / target)
    return os.path.commonpath([resolved, str(workdir)]) == str(workdir)


def _pack(workdir: Path) -> bytes:
    """Archive the edited copy without following links.

    Launch files, agent config, special files and links that leave the copy
    stay out, so the guest never receives a path into the Mac.

    Args:
        workdir: The CLI's workspace after the turn.

    Returns:
        Gzip tar bytes.
    """
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path in sorted(workdir.rglob("*")):
            relative = path.relative_to(workdir)
            if excluded_path(relative):
                continue
            if path.is_symlink():
                if not _safe_link(workdir, path):
                    logger.warning("Host agent: dropped a link that leaves the copy")
                    continue
            elif not (path.is_file() or path.is_dir()):
                continue
            archive.add(path, arcname=relative.as_posix(), recursive=False)
    return buffer.getvalue()


def _real(path: Path | str) -> str:
    """Return the real path, as Seatbelt compares real paths only.

    Args:
        path: Any path.

    Returns:
        The absolute path with every link resolved.
    """
    return os.path.realpath(path)


def tool_roots(binary: str) -> list[str]:
    """Return the directories a CLI must read to start.

    Covers the command's own directory, its install tree and, for a script,
    its interpreter's install tree (for example a Node install for Codex).

    Args:
        binary: Absolute path of the CLI command.

    Returns:
        Real directory paths.
    """
    roots = {_real(Path(binary).parent)}
    real = Path(_real(binary))
    parts = real.parts
    if "node_modules" in parts:
        index = parts.index("node_modules")
        prefix = parts[: index - 1] if index > 0 and parts[index - 1] == "lib" else parts[:index]
        roots.add(str(Path(*prefix)))
    else:
        roots.add(str(real.parent.parent))
    try:
        with real.open("rb") as handle:
            first = handle.readline(512)
    except OSError:
        first = b""
    if first.startswith(b"#!"):
        words = first[2:].decode("utf-8", "replace").split()
        interpreter = (
            words[1] if words and Path(words[0]).name == "env" and len(words) > 1 else words[0] if words else ""
        )
        found = shutil.which(interpreter) if interpreter else None
        if found:
            roots.add(str(Path(_real(found)).parent.parent))
    return sorted(roots)


def confine(argv: list[str], *, home: Path | str, writable: list[str], readable: list[str]) -> list[str]:
    """Wrap a command in a macOS sandbox that hides the user's home.

    Inside ``home`` the command may read and write only ``writable`` and read
    only ``readable``; everything else there is denied. File metadata stays
    readable so path lookups and ``getcwd`` work. Paths outside ``home`` and
    the network stay open: the CLI needs system libraries and its provider.

    Args:
        argv: The CLI command.
        home: The user's home directory.
        writable: Directories the turn owns (the copy, its temp home).
        readable: The CLI's install directories.

    Returns:
        The ``sandbox-exec`` command.

    Raises:
        HostAgentRequestError: When ``sandbox-exec`` is not available.
    """
    if sys.platform != "darwin" or not SANDBOX_EXEC.exists():
        raise HostAgentRequestError("workspace_only host agents need macOS sandbox-exec.")
    params = {"HOME_DIR": _real(home)}
    write_rules = []
    for index, path in enumerate(writable):
        params[f"W{index}"] = _real(path)
        write_rules.append(f'(subpath (param "W{index}"))')
    read_rules = []
    for index, path in enumerate(readable):
        params[f"R{index}"] = _real(path)
        read_rules.append(f'(subpath (param "R{index}"))')
    profile = [
        "(version 1)",
        "(allow default)",
        '(deny file-read-data file-read-xattr file-write* (subpath (param "HOME_DIR")))',
    ]
    if read_rules:
        profile.append(f"(allow file-read-data file-read-xattr {' '.join(read_rules)})")
    if write_rules:
        profile.append(f"(allow file-read-data file-read-xattr file-write* {' '.join(write_rules)})")
    defines = [item for key, value in params.items() for item in ("-D", f"{key}={value}")]
    return [str(SANDBOX_EXEC), "-p", "\n".join(profile), *defines, *argv]


def _stop_group(pid: int) -> None:
    """Kill a CLI's whole process group, children included.

    Args:
        pid: The group leader, started in its own session.
    """
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pid, signal.SIGKILL)


def run_group(
    argv: list[str], *, cwd: Path, env: dict[str, str], stdin: str, timeout: float
) -> subprocess.CompletedProcess[str]:
    """Run a command in its own session and kill its whole group when it ends.

    A CLI starts tools and helpers of its own, so a timeout that killed only
    the direct child would leave them running on the Mac.

    Args:
        argv: The command.
        cwd: Working directory.
        env: Full environment.
        stdin: Text written to standard input.
        timeout: Seconds before the group is killed.

    Returns:
        The finished process with its captured output.

    Raises:
        subprocess.TimeoutExpired: When the command ran longer than ``timeout``.
        OSError: When the command could not start.
    """
    process = subprocess.Popen(
        argv,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        _stop_group(process.pid)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            # A helper that left the group still holds the output pipes.
            process.kill()
        raise
    finally:
        _stop_group(process.pid)
    return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)


def _json_documents(stdout: str) -> list[dict[str, Any]]:
    """Read every JSON object a CLI printed, whole-output or one per line.

    Args:
        stdout: Captured CLI output.

    Returns:
        Decoded objects in output order.
    """
    try:
        whole = json.loads(stdout)
    except ValueError:
        whole = None
    if isinstance(whole, dict):
        return [whole]
    documents = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            documents.append(value)
    return documents


def parse_cli_output(cli: CliProvider, stdout: str) -> tuple[str, dict[str, Any], str | None]:
    """Pull the final text, token usage and any error out of a CLI's JSON output.

    Args:
        cli: The CLI that printed ``stdout``.
        stdout: Captured CLI output.

    Returns:
        ``(text, usage, error)``. ``usage`` has ``prompt_tokens``,
        ``completion_tokens`` and ``model_ms``; ``error`` is the CLI's own
        failure message, or None.
    """
    text, error = "", None
    prompt_tokens = completion_tokens = 0
    model_ms: int | None = None
    documents = _json_documents(stdout)
    if cli == "codex":
        for event in documents:
            kind = event.get("type")
            item = event.get("item") or {}
            if kind == "item.completed" and item.get("type") == "agent_message":
                text = str(item.get("text") or "")
            elif kind == "turn.completed":
                usage = event.get("usage") or {}
                prompt_tokens += int(usage.get("input_tokens") or 0)
                completion_tokens += int(usage.get("output_tokens") or 0)
            elif kind == "turn.failed":
                error = str((event.get("error") or {}).get("message") or "The turn failed.")
            elif kind == "error":
                error = str(event.get("message") or "The CLI reported an error.")
    else:
        result = next((doc for doc in reversed(documents) if doc.get("type") == "result"), None)
        if result is None and documents:
            result = documents[-1]
        result = result or {}
        text = str(result.get("result") or "")
        usage = result.get("usage") or {}
        prompt_tokens = int(usage.get("input_tokens") or 0) + int(usage.get("cache_read_input_tokens") or 0)
        prompt_tokens += int(usage.get("cache_creation_input_tokens") or 0)
        completion_tokens = int(usage.get("output_tokens") or 0)
        duration = result.get("duration_api_ms", result.get("duration_ms"))
        model_ms = int(duration) if isinstance(duration, int | float) else None
        if result.get("is_error") or result.get("subtype", "success") != "success":
            error = text or str(result.get("subtype") or "The CLI reported an error.")
    return text, {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "model_ms": model_ms}, error


def _recorded_cap(settings: Settings, cli: str) -> datetime | None:
    """Return when a cap recorded for ``cli`` ends, while it is still in force.

    Args:
        settings: Settings with ``local_state_dir``.
        cli: The CLI about to run.

    Returns:
        The reset time, or None when no cap is in force.
    """
    try:
        stamp = (read_cli_limits(settings).get(cli) or {}).get("reset_at")
        reset = datetime.fromisoformat(str(stamp)) if stamp else None
    except (OSError, ValueError):
        return None
    if reset is None:
        return None
    reset = reset if reset.tzinfo else reset.replace(tzinfo=UTC)
    return reset if reset > datetime.now(UTC) else None


def _workspace_root(settings: Settings) -> Path:
    """Return the directory that holds every host-agent copy.

    Args:
        settings: Settings with ``local_state_dir``.

    Returns:
        ``<local_state_dir>/workspaces``.

    Raises:
        HostAgentRequestError: When local mode or its state directory is not configured.
    """
    if not settings.local_mode or not settings.local_state_dir:
        raise HostAgentRequestError("Host agents need local mode with a local state directory.")
    return Path(settings.local_state_dir).expanduser().resolve() / "workspaces"


def _error(code: str, message: str, *, reset_at: str | None = None, transcript: str = "") -> dict[str, Any]:
    """Build an error response in the capability's contract shape.

    Args:
        code: Stable failure code.
        message: Human-readable detail.
        reset_at: ISO time a usage cap ends, if any.
        transcript: Tail of the CLI's output.

    Returns:
        The response document.
    """
    return {
        "status": "error",
        "result_tar_b64": "",
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0, "model_ms": None},
        "transcript_tail": transcript[-_TRANSCRIPT_TAIL_CHARS:],
        "error": {"code": code, "reset_at": reset_at, "message": message},
    }


def _command(binary: str, env: dict[str, str]) -> str:
    """Resolve the CLI command to an absolute path.

    Args:
        binary: The configured command name or path.
        env: The CLI's environment, for its ``PATH``.

    Returns:
        The absolute path.

    Raises:
        HostAgentRequestError: When the command is not installed.
    """
    found = shutil.which(binary, path=env.get("PATH"))
    if found is None:
        raise HostAgentRequestError(f"The CLI command {binary!r} was not found.")
    return str(Path(found).absolute())


def run_host_agent(
    body: dict, settings: Settings, *, cli: CliProvider, permission: HostPermission, job: str = "run"
) -> dict:
    """Run one host-CLI turn on a copy of the guest workspace.

    Args:
        body: ``{model, prompt, workspace_tar_b64}`` from the guest. Any
            ``cli`` or ``permission`` it names is ignored.
        settings: Local-mode settings (CLI paths, state dir, timeout).
        cli: The CLI from the run's stored proposer settings.
        permission: The permission from the run's stored proposer settings.
        job: Folder name that groups this run's copies.

    Returns:
        ``{status, result_tar_b64, usage, transcript_tail, error?}``.
    """
    if cli not in ISOLATED_HOST_CLIS:
        return _error(FAILED_KEY, f"The {cli} CLI cannot run isolated as a host proposer.")
    if permission not in HOST_PERMISSIONS:
        return _error(FAILED_KEY, f"Unknown host permission {permission!r}.")
    try:
        root = _workspace_root(settings)
        archive = base64.b64decode(str(body.get("workspace_tar_b64") or ""), validate=True)
    except (HostAgentRequestError, binascii.Error) as error:
        return _error(FAILED_KEY, str(error))
    capped_until = _recorded_cap(settings, cli)
    if capped_until is not None:
        message = f"{cli} is capped until {capped_until.isoformat()}"
        return _error(RATE_LIMITED_CODE, message, reset_at=capped_until.isoformat())
    safe_job = "".join(char for char in job if char.isalnum() or char in "-_") or "run"
    turn = root / safe_job / uuid.uuid4().hex
    workdir = turn / "workspace"
    workdir.mkdir(parents=True)
    # Kept beside the copy, not in it, so the prompt never lands in the result tree.
    prompt_file = turn / "prompt.md"
    prompt = str(body.get("prompt") or "")
    try:
        _extract(archive, workdir)
        strip_agent_config(workdir)
        env = cli_env(settings)
        binary = _command(cli_binary(cli, settings), env)
        if cli == "droid":
            prompt_file.write_text(prompt, encoding="utf-8")
        argv = host_cli_argv(
            cli,
            permission,
            binary,
            workdir,
            _model_arg(cli, str(body.get("model") or "")),
            prompt_file if cli == "droid" else None,
        )
        if permission == "workspace_only":
            argv = confine(argv, home=Path.home(), writable=[str(turn)], readable=tool_roots(binary))
        started = time.monotonic()
        try:
            completed = run_group(
                argv,
                cwd=workdir,
                env=env,
                stdin="" if cli == "droid" else prompt,
                timeout=settings.host_agent_timeout_seconds,
            )
        except subprocess.TimeoutExpired:
            return _error(FAILED_KEY, f"The {cli} turn ran longer than {settings.host_agent_timeout_seconds:.0f}s.")
        except OSError as error:
            return _error(FAILED_KEY, f"The {cli} CLI could not start: {error}")
        elapsed_ms = int((time.monotonic() - started) * 1000)
        text, usage, cli_error = parse_cli_output(cli, completed.stdout)
        transcript = text or completed.stdout or completed.stderr
        if completed.returncode != 0 and cli_error is None:
            cli_error = (completed.stderr or completed.stdout).strip()[-2000:] or f"exit status {completed.returncode}"
        if cli_error is not None:
            capped = limit_error(cli, f"{cli_error}\n{completed.stderr}")
            if capped is not None:
                reset_at = capped.reset_at.isoformat() if capped.reset_at else None
                if capped.reset_at is not None:
                    try:
                        write_cli_limit(settings, cli, capped.reset_at, capped.message)
                    except (OSError, ValueError):
                        logger.warning("Host agent: could not record the %s usage cap", cli, exc_info=True)
                return _error(RATE_LIMITED_CODE, capped.message, reset_at=reset_at, transcript=transcript)
            return _error(FAILED_KEY, cli_error[:2000], transcript=transcript)
        return {
            "status": "ok",
            "result_tar_b64": base64.b64encode(_pack(workdir)).decode("ascii"),
            "usage": {**usage, "model_ms": usage["model_ms"] or elapsed_ms, "cost": 0.0},
            "transcript_tail": transcript[-_TRANSCRIPT_TAIL_CHARS:],
        }
    except HostAgentRequestError as error:
        return _error(FAILED_KEY, str(error))
    finally:
        shutil.rmtree(turn, ignore_errors=True)


def host_proposer(payload: dict[str, Any]) -> tuple[CliProvider, HostPermission] | None:
    """Read the host CLI and permission from a run's stored proposer settings.

    Args:
        payload: The stored run payload (black-box ``proposer`` or unified
            ``optimizer.proposer``).

    Returns:
        ``(cli, permission)``, or None when the proposer runs in the sandbox.
    """
    optimizer = payload.get("optimizer")
    proposer = payload.get("proposer") or (optimizer.get("proposer") if isinstance(optimizer, dict) else None)
    if not isinstance(proposer, dict) or proposer.get("host_cli") is None:
        return None
    permission = proposer.get("host_permission") or "workspace_only"
    return cast(CliProvider, proposer["host_cli"]), cast(HostPermission, permission)


def attach_host_agent_token(payload: dict[str, Any], token: str) -> None:
    """Hand the host proposer's token to the guest beside its proposer route.

    Args:
        payload: The protected payload, mutated in place.
        token: The token :func:`bind_host_agent` minted.

    Raises:
        ValueError: When the payload has no proposer route.
    """
    config = payload.get("reflection_model_config")
    if not isinstance(config, dict) and isinstance(payload.get("models"), dict):
        config = payload["models"].get("reflection_model")
    route = ((config or {}).get("extra") or {}).get(ROUTE_KEY) if isinstance(config, dict) else None
    if not isinstance(route, dict):
        raise ValueError("A host CLI proposer needs its proposer model route.")  # noqa: TRY004 - a bad payload, not a bad argument type
    route[HOST_AGENT_TOKEN_KEY] = token


def host_agent_failure(gateway: ModelGateway) -> HostAgentFailure | None:
    """Return the host turn failure that must end this gateway's run, if any.

    Args:
        gateway: The run's parent gateway.

    Returns:
        The first recorded failure, or None.
    """
    with _failures_lock:
        return _failures.get(gateway)


def failure_message(failure: HostAgentFailure) -> str:
    """Render the run's failure message for a host turn.

    Args:
        failure: The recorded failure.

    Returns:
        English text naming the CLI and, for a usage cap, its reset time.
    """
    if failure.code == RATE_LIMITED_CODE:
        return t_locale("en", RATE_LIMITED_KEY, cli=failure.cli, reset_at=failure.reset_at or "unknown")
    return t_locale("en", FAILED_KEY, cli=failure.cli, detail=failure.message)


def _bearer(headers: dict[str, str]) -> str:
    """Return the caller's token from its forwarded headers.

    Args:
        headers: Lower-cased request headers.

    Returns:
        The bearer or ``x-api-key`` token, or an empty string.
    """
    return headers.get("authorization", "").removeprefix("Bearer ") or headers.get("x-api-key", "")


def _reply(status: int, document: dict[str, Any]) -> ModelHTTPResult:
    """Encode a capability answer.

    Args:
        status: HTTP status.
        document: Response document.

    Returns:
        The JSON response.
    """
    return ModelHTTPResult(status, "application/json", json.dumps(document).encode())


def bind_host_agent(gateway: ModelGateway, settings: Settings, *, cli: str, permission: str) -> str:
    """Serve ``/v1/_host_agent`` for one run whose proposer is a host CLI.

    The worker calls this only for a run whose stored proposer names a host
    CLI, with that CLI and permission. The guest cannot choose either. Only
    the token returned here reaches the capability; a model route token is
    refused. Each turn is recorded through the run's budget at zero cost. A
    usage cap is remembered on the gateway so the worker can end the run with
    ``blackbox.host_agent_rate_limited``.

    Args:
        gateway: The run's parent gateway.
        settings: Local-mode settings.
        cli: The proposer's host CLI from the run settings.
        permission: The proposer's host permission from the run settings.

    Returns:
        The token the host proposer's shim must present.

    Raises:
        ValueError: Outside local mode, or for a CLI or permission that cannot run.
    """
    if not settings.local_mode:
        raise ValueError("Host agents are available only in local mode.")
    if cli not in HOST_CLIS or permission not in HOST_PERMISSIONS:
        raise ValueError(f"Unknown host proposer {cli!r} with permission {permission!r}.")
    if cli not in ISOLATED_HOST_CLIS:
        raise ValueError(
            f"The {cli} CLI cannot run isolated from the user's own config, so it cannot be a host proposer."
        )
    trusted_cli = cast(CliProvider, cli)
    trusted_permission = cast(HostPermission, permission)
    token = secrets.token_urlsafe(32)
    runtime = gateway.runtime
    policy = ChargePolicy("subscription_model")

    def handle(raw: bytes, headers: dict[str, str]) -> ModelHTTPResult:
        """Run one turn under the run's budget and answer in the contract shape.

        Args:
            raw: Request body bytes.
            headers: Forwarded protocol headers.

        Returns:
            The JSON response; 403 for any other token, 429 for a usage cap,
            413 for an oversized workspace.
        """
        if not secrets.compare_digest(_bearer(headers), token):
            return _reply(403, _error("forbidden", "This capability needs the host proposer's token."))
        if len(raw) > MAX_REQUEST_BYTES:
            return _reply(413, _error(FAILED_KEY, "The workspace is too large for a host agent turn."))
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return _reply(400, _error(FAILED_KEY, "The host agent request is not a JSON object."))
        request = {"cli": trusted_cli, "model": body.get("model"), "permission": trusted_permission}
        quote = operation_quote(
            {**request, "path": HOST_AGENT_PATH, "nonce": uuid.uuid4().hex},
            Decimal(0),
            policy,
            {"source": "host_agent", "cli": trusted_cli},
        )

        def dispatch() -> PaidResult[dict[str, Any]]:
            """Run the CLI; the subscription pays, so the settled cost is zero."""
            document = run_host_agent(
                body, settings, cli=trusted_cli, permission=trusted_permission, job=str(runtime.budget_id)
            )
            usage = document["usage"]
            evidence = {
                "source": "host_agent",
                "cli": trusted_cli,
                "status": document["status"],
                "prompt_tokens": usage["prompt_tokens"],
                "completion_tokens": usage["completion_tokens"],
                "model_ms": usage["model_ms"],
            }
            return PaidResult(document, Decimal(0), evidence)

        document = runtime.execute(
            quote,
            policy,
            dispatch,
            operation_key=f"host_agent:{uuid.uuid4().hex}",
            cost_kind="model",
            role="proposer",
        )
        error = document.get("error") or {}
        status = 200
        if document["status"] != "ok":
            status = 429 if error.get("code") == RATE_LIMITED_CODE else 502
            failure = HostAgentFailure(
                code=str(error.get("code")),
                message=str(error.get("message") or ""),
                cli=trusted_cli,
                reset_at=error.get("reset_at"),
            )
            if failure.code == RATE_LIMITED_CODE:
                with _failures_lock:
                    _failures.setdefault(gateway, failure)
        return _reply(status, document)

    gateway.bind_capability(HOST_AGENT_PATH, handle, token=token)
    return token
