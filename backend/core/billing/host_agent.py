"""Parent side of a host-CLI proposer turn, run on the user's own subscription.

In local mode a black-box proposer can be the user's own coding CLI (Codex,
Claude Code or Droid). The sandbox never reaches the CLI itself. Its shim
(:mod:`core.worker.host_agent_shim`) sends the workspace to the gateway's
``/v1/_host_agent`` capability. This module unpacks that archive into a fresh
copy under ``local_state_dir``, runs the CLI there with provider API keys
removed from its environment, and sends the edited tree back. The CLI never
runs in the user's original folder.

The turn is recorded in the run's budget at zero cost: the user's
subscription pays, not the wallet.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import logging
import shutil
import subprocess
import tarfile
import threading
import time
import uuid
import weakref
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from ..config import Settings
from ..i18n import t_locale
from ..local.cli_catalog import CliProvider, cli_model_arg, parse_subscription_model_id
from ..local.cli_probe import cli_binary, read_cli_limits, write_cli_limit
from .cli_runners import cli_env, limit_error
from .model_dispatch import ModelHTTPResult
from .model_gateway import ModelGateway
from .operation_pricing import ChargePolicy, operation_quote
from .runtime import PaidResult

logger = logging.getLogger(__name__)

HOST_AGENT_PATH = "/v1/_host_agent"
HOST_CLIS: tuple[CliProvider, ...] = ("codex", "claude", "droid")
HOST_PERMISSIONS = ("workspace_only", "full_access")
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


def _pack(workdir: Path) -> bytes:
    """Archive the edited copy without following links.

    Args:
        workdir: The CLI's workspace after the turn.

    Returns:
        Gzip tar bytes.
    """
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path in sorted(workdir.rglob("*")):
            archive.add(path, arcname=path.relative_to(workdir).as_posix(), recursive=False)
    return buffer.getvalue()


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


def run_host_agent(body: dict, settings: Settings, *, job: str = "run") -> dict:
    """Run one host-CLI turn on a copy of the guest workspace.

    Args:
        body: ``{cli, model, prompt, permission, workspace_tar_b64}``.
        settings: Local-mode settings (CLI paths, state dir, timeout).
        job: Folder name that groups this run's copies.

    Returns:
        ``{status, result_tar_b64, usage, transcript_tail, error?}``.
    """
    cli = body.get("cli")
    if cli not in HOST_CLIS:
        return _error(FAILED_KEY, f"Unknown host CLI {cli!r}.")
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
    workdir = root / safe_job / uuid.uuid4().hex
    workdir.mkdir(parents=True)
    # Kept beside the copy, not in it, so the prompt never lands in the result tree.
    prompt_file = workdir.with_name(f"{workdir.name}.prompt.md")
    prompt = str(body.get("prompt") or "")
    try:
        _extract(archive, workdir)
        if cli == "droid":
            prompt_file.write_text(prompt, encoding="utf-8")
        argv = host_cli_argv(
            cli,
            str(body.get("permission") or "workspace_only"),
            cli_binary(cli, settings),
            workdir,
            _model_arg(cli, str(body.get("model") or "")),
            prompt_file if cli == "droid" else None,
        )
        started = time.monotonic()
        try:
            completed = subprocess.run(
                argv,
                cwd=workdir,
                env=cli_env(settings),
                input="" if cli == "droid" else prompt,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=settings.host_agent_timeout_seconds,
                check=False,
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
        shutil.rmtree(workdir, ignore_errors=True)
        prompt_file.unlink(missing_ok=True)


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


def bind_host_agent(gateway: ModelGateway, settings: Settings) -> None:
    """Serve ``/v1/_host_agent`` on this run's gateway (local mode only).

    Each turn is recorded through the run's budget at zero cost. A usage cap
    is remembered on the gateway so the worker can end the run with
    ``blackbox.host_agent_rate_limited``.

    Args:
        gateway: The run's parent gateway.
        settings: Local-mode settings.

    Raises:
        ValueError: When local mode is off.
    """
    if not settings.local_mode:
        raise ValueError("Host agents are available only in local mode.")
    runtime = gateway.runtime
    policy = ChargePolicy("subscription_model")

    def handle(raw: bytes, headers: dict[str, str]) -> ModelHTTPResult:
        """Run one turn under the run's budget and answer in the contract shape.

        Args:
            raw: Request body bytes.
            headers: Forwarded protocol headers.

        Returns:
            The JSON response; 429 for a usage cap, 413 for an oversized workspace.
        """
        if len(raw) > MAX_REQUEST_BYTES:
            document = _error(FAILED_KEY, "The workspace is too large for a host agent turn.")
            return ModelHTTPResult(413, "application/json", json.dumps(document).encode())
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        if not isinstance(body, dict):
            document = _error(FAILED_KEY, "The host agent request is not a JSON object.")
            return ModelHTTPResult(400, "application/json", json.dumps(document).encode())
        request = {key: body.get(key) for key in ("cli", "model", "permission")} | {"path": HOST_AGENT_PATH}
        quote = operation_quote(
            {**request, "nonce": uuid.uuid4().hex},
            Decimal(0),
            policy,
            {"source": "host_agent", "cli": str(body.get("cli"))},
        )

        def dispatch() -> PaidResult[dict[str, Any]]:
            """Run the CLI; the subscription pays, so the settled cost is zero."""
            document = run_host_agent(body, settings, job=str(runtime.budget_id))
            usage = document["usage"]
            evidence = {
                "source": "host_agent",
                "cli": str(body.get("cli")),
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
                cli=str(body.get("cli")),
                reset_at=error.get("reset_at"),
            )
            if failure.code == RATE_LIMITED_CODE:
                with _failures_lock:
                    _failures.setdefault(gateway, failure)
        return ModelHTTPResult(status, "application/json", json.dumps(document).encode())

    gateway.bind_capability(HOST_AGENT_PATH, handle)
