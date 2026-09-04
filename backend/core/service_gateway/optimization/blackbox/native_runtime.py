"""Run pinned upstream agent engines in a worker jail or a managed sandbox."""

from __future__ import annotations

import base64
import io
import json
import math
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from importlib.metadata import distribution
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from ....config import Settings, settings
from ....exceptions import ServiceError
from . import native_runner
from .agent_eval import gateway_from_settings
from .feedback import emit_candidate
from .harness import GatewayConfig
from .protocol import BudgetExhaustedError, EngineContext, EvalServer, Result, Task
from .runner import side_info_json_default
from .sandbox import (
    LocalSubprocessRuntime,
    SandboxRuntime,
    SandboxSession,
    SandboxSpec,
    sandbox_runtime_from_settings,
    sandbox_unavailable_reason,
    unique_sandbox_name,
)

GEPA_SOURCE = "0632cdb5dcc052e690eab439e1b4a7e3e9cfe407"
CLAUDE_VERSION = "2.1.259"
_RUNNER_FILE = "native_runner.py"
_INPUT_FILE = "native_input.json"
_RESULT_FILE = "native_result.json"
_ARTIFACT_FILE = "native_artifacts.tar.gz.b64"
_INSTALL_ALLOWANCE = 600.0
_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
_RPC_PREFIX = "SKYNET_NATIVE_RPC "
_UUID = re.compile(r"^[0-9a-f]{32}$")


@dataclass(frozen=True)
class NativeOptions:
    """Bind an upstream proposer to its selected runtime and model gateway."""

    runtime: Literal["worker", "vercel"]
    model: str
    gateway: GatewayConfig = field(repr=False)
    max_token_cost: float
    timeout_seconds: float = 2400.0
    sandbox_runtime: SandboxRuntime | None = None
    usage_by_model: dict[str, dict[str, int]] = field(default_factory=dict)
    usage_lock: Any = field(default_factory=threading.Lock, repr=False, compare=False)

    @property
    def history(self) -> list[dict[str, Any]]:
        """Expose proposer tokens to the existing language-model usage reader.

        Returns:
            Usage entries with separate cache counters retained for settlement.
        """
        with self.usage_lock:
            return [{"model": model, "usage": dict(usage)} for model, usage in self.usage_by_model.items()]


def native_runtime_unavailable_reason(runtime: str, settings: Settings) -> str | None:
    """Explain whether the selected native execution environment can launch.

    Args:
        runtime: Requested worker or Vercel execution environment.
        settings: Deployment gateway and managed-sandbox configuration.

    Returns:
        An actionable unavailability reason, or ``None`` when checks pass.
    """
    if runtime not in ("worker", "vercel"):
        return "Choose a worker or Vercel runtime for this optimizer."
    if gateway_from_settings(settings) is None:
        return "Native optimizers require a configured model gateway."
    if runtime == "vercel":
        return sandbox_unavailable_reason(settings)
    if sys.version_info < (3, 11, 8):
        return "Worker optimizers require Python 3.11.8 or newer."
    binary = shutil.which("claude")
    if binary is None:
        return f"Worker optimizers require Claude Code {CLAUDE_VERSION}."
    try:
        version = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=5, check=False)
        if version.returncode or version.stdout.split(" ", 1)[0] != CLAUDE_VERSION:
            return f"Worker optimizers require Claude Code {CLAUDE_VERSION}."
        if platform.system() == "Linux":
            bwrap = shutil.which("bwrap")
            if bwrap is None:
                return "Worker optimizers require bubblewrap for process isolation."
            jail = subprocess.run(
                [bwrap, "--ro-bind", "/", "/", "--unshare-uts", "/bin/true"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            if jail.returncode:
                return "Worker process isolation is unavailable: bubblewrap cannot create a namespace."
    except (OSError, subprocess.TimeoutExpired):
        return "The worker native optimizer runtime could not pass its launch checks."
    return None


def _source_archive() -> str:
    """Package the installed, verified upstream source without resolving new dependencies.

    Returns:
        Base64 tar archive containing only the installed GEPA Python sources.

    Raises:
        ServiceError: When the worker was not built from the approved commit.
    """
    package = distribution("gepa")
    provenance = json.loads(package.read_text("direct_url.json") or "{}")
    if provenance.get("vcs_info", {}).get("commit_id") != GEPA_SOURCE:
        raise ServiceError(f"Native optimizers require GEPA commit {GEPA_SOURCE}.")
    root = Path(package.locate_file("gepa"))
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for source in sorted(root.rglob("*.py")):
            if source.is_symlink():
                raise ServiceError("The pinned GEPA source contains a symbolic link.")
            archive.add(source, arcname=str(Path("gepa") / source.relative_to(root)), recursive=False)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _bootstrap_command(runtime: str) -> str:
    """Build installation and preflight commands with immutable package versions.

    Args:
        runtime: Selected worker or managed execution environment.

    Returns:
        Shell command that prepares the isolated source and runtime.
    """
    prepare = (
        "set -eu; mkdir -p .claude .cache .local native_vendor rpc; "
        "test -f .claude.json || printf '{}' > .claude.json; "
    )
    if runtime == "vercel":
        prepare += (
            'export HOME="$PWD"; '
            'export PATH="$HOME/.local/bin:$PATH"; '
            "if python3 -c 'import sys; sys.exit(sys.version_info < (3, 11, 8))' 2>/dev/null; then "
            "command -v python3 > native-python.txt; else "
            "python3 -m pip install --disable-pip-version-check --no-deps --user uv==0.9.13; "
            '"$HOME/.local/bin/uv" python install 3.11.9; '
            '"$HOME/.local/bin/uv" python find 3.11.9 > native-python.txt; fi; '
            "node -e 'if (+process.versions.node.split(\".\")[0] < 22) process.exit(1)'; "
            f'if ! claude --version 2>/dev/null | grep -q "^{re.escape(CLAUDE_VERSION)} "; then '
            f'npm install --global --prefix "$HOME/.local" @anthropic-ai/claude-code@{CLAUDE_VERSION}; fi; '
        )
    else:
        prepare += "command -v python3 > native-python.txt; "
    extract = (
        "import base64,io,pathlib,tarfile; "
        "data=base64.b64decode(pathlib.Path('native_source.tar.gz.b64').read_text()); "
        "tarfile.open(fileobj=io.BytesIO(data),mode='r:gz').extractall('native_vendor',filter='data')"
    )
    prepare += (
        f'"$(cat native-python.txt)" -c {shlex.quote(extract)}; '
        f'claude --version | grep -q "^{re.escape(CLAUDE_VERSION)} "; '
        f'"$(cat native-python.txt)" -c '
        + shlex.quote(
            "import sys; assert sys.version_info >= (3, 11, 8), 'Native optimizers need Python 3.11.8 or newer'"
        )
    )
    if runtime == "worker":
        prepare += '; if [ "$(uname -s)" = Linux ]; then command -v bwrap >/dev/null; fi'
    return prepare


class _EvaluatorMailbox:
    """Translate child evaluator requests without exposing an inbound service."""

    def __init__(
        self,
        session: SandboxSession,
        server: EvalServer,
        nonce: str,
        progress_callback: Any = None,
        check_budget: Any = None,
    ) -> None:
        """Bind the transport to one parent evaluator.

        Args:
            session: Running process filesystem and command connection.
            server: Parent budgeted evaluation authority.
            nonce: Per-process framing token.
            progress_callback: Optional job trajectory sink.
            check_budget: Direct cumulative-spend guard, including on reader threads.
        """
        self.session = session
        self.server = server
        self.nonce = nonce
        self.progress_callback = progress_callback
        self.check_budget = check_budget
        self.error: Exception | None = None
        self._buffer = ""
        self._responses: dict[str, str] = {}
        self._lock = threading.Lock()

    def on_output(self, stream: str, text: str) -> None:
        """Process complete request lines while tolerating split output chunks.

        Args:
            stream: Process stdout or stderr.
            text: Newly available output.
        """
        if stream != "stdout":
            return
        with self._lock:
            self._buffer += text
            while "\n" in self._buffer:
                line, self._buffer = self._buffer.split("\n", 1)
                try:
                    if line.startswith(f"{_RPC_PREFIX}{self.nonce} "):
                        self._respond(json.loads(line.split(" ", 2)[2]))
                    elif line.startswith(f"SKYNET_NATIVE_PROGRESS {self.nonce} "):
                        self._progress(json.loads(line.split(" ", 2)[2]))
                except Exception as exc:
                    # LocalSubprocessRuntime delivers output on a reader thread;
                    # raising there would abandon the child waiting for its reply.
                    self.error = self.error or exc

    def _progress(self, event: dict[str, Any]) -> None:
        """Emit only completed aggregate checkpoints reported by upstream.

        Args:
            event: Candidate and aggregate score reported by upstream log_progress.
        """
        score = event.get("score")
        if not isinstance(score, float | int) or not math.isfinite(score):
            return
        emit_candidate(
            self.progress_callback,
            candidate_id=str(event["candidate_id"]),
            parent_id=None,
            generation=0,
            score=float(score),
            per_example=[],
            candidate=event["candidate"],
            discovered_at_evals=int(event["total_evals"]),
            iteration=None,
        )

    def _respond(self, request: dict[str, Any]) -> None:
        """Evaluate a request once and persist its response.

        Args:
            request: Nonce-framed candidate, example and request identity.

        Raises:
            ServiceError: When a child sends an invalid request identity.
        """
        request_id = request.get("id", "")
        if not isinstance(request_id, str) or not _UUID.fullmatch(request_id):
            raise ServiceError("Native evaluator request has an invalid identity.")
        if request_id not in self._responses:
            if self.error is not None:
                response: dict[str, Any] = {"error": "Evaluation already stopped."}
            else:
                try:
                    candidate = request["candidate"]
                    if not isinstance(candidate, str):
                        raise ServiceError("Native agent engines require a text candidate.")
                    if self.check_budget is not None:
                        self.check_budget()
                    score, info = self.server.evaluate(candidate, request.get("example"))
                    if self.check_budget is not None:
                        self.check_budget()
                    response = {"score": score, "info": info}
                except Exception as exc:
                    self.error = exc
                    response = {"error": "The parent evaluator stopped this run."}
            try:
                self._responses[request_id] = json.dumps(response, default=side_info_json_default, allow_nan=False)
            except (TypeError, ValueError) as exc:
                self.error = self.error or exc
                self._responses[request_id] = json.dumps({"error": "The parent evaluator returned invalid feedback."})
        self.session.write_files({f"rpc/{request_id}.json": self._responses[request_id]})


def _restore_artifacts(session: SandboxSession, destination: Path) -> None:
    """Copy bounded regular-file artifacts out before destroying the runtime.

    Args:
        session: Completed process filesystem.
        destination: Job-owned destination for upstream raw histories.

    Raises:
        ServiceError: When the archive escapes its destination or exceeds its bound.
    """
    encoded = session.read_file(_ARTIFACT_FILE)
    if not encoded:
        return
    destination.mkdir(parents=True, exist_ok=True)
    total = 0
    with tarfile.open(fileobj=io.BytesIO(base64.b64decode(encoded)), mode="r:gz") as archive:
        for member in archive:
            target = (destination / member.name).resolve()
            if not target.is_relative_to(destination.resolve()) or not member.isfile():
                raise ServiceError("Native artifact archive contains an unsafe path.")
            total += member.size
            if total > _MAX_ARTIFACT_BYTES:
                raise ServiceError("Native artifacts exceed the 64 MiB transfer limit.")
            source = archive.extractfile(member)
            if source is not None:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read())


def _record_usage(options: NativeOptions, usage: dict[str, Any]) -> None:
    """Accumulate proposer tokens even when a completed child reports failure.

    Args:
        options: Run-scoped usage ledger.
        usage: Per-model token counts recovered from native CLI artifacts.
    """
    with options.usage_lock:
        for model, counts in usage.items():
            if not isinstance(counts, dict):
                continue
            destination = options.usage_by_model.setdefault(model, {})
            for name, value in counts.items():
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    destination[name] = destination.get(name, 0) + value


def run_native_engine(engine_id: str, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
    """Execute an unchanged upstream agent engine in the selected isolated process.

    Args:
        engine_id: Upstream ``meta_harness`` or ``autoresearch`` identifier.
        task: Seed and visible training/validation examples.
        server: Skynet evaluator and shared evaluation budget.
        ctx: Run context containing native execution options.

    Returns:
        Upstream incumbent, aggregate score, usage and artifact provenance.

    Raises:
        ServiceError: When configuration, installation or the native engine fails.
        Exception: The original parent evaluator exception, without retrying it.
    """
    options = ctx.native_options
    if options is None or options.runtime not in ("worker", "vercel"):
        raise ServiceError("Choose a worker or Vercel runtime for this optimizer.")
    if engine_id not in ("meta_harness", "autoresearch") or not task.str_mode:
        raise ServiceError("Native agent engines require a single text candidate.")
    if server.remaining <= 0:
        raise BudgetExhaustedError("The native optimizer evaluation budget is exhausted.")
    if not math.isfinite(options.max_token_cost) or options.max_token_cost <= 0:
        raise ServiceError("Native optimizers require a positive proposer cost limit.")
    if not math.isfinite(options.timeout_seconds) or options.timeout_seconds <= 0:
        raise ServiceError("Native optimizers require a positive timeout.")
    if not options.gateway.url or not options.gateway.api_key:
        raise ServiceError("Native optimizers require a configured model gateway.")
    runtime = options.sandbox_runtime
    if runtime is None:
        runtime = LocalSubprocessRuntime() if options.runtime == "worker" else sandbox_runtime_from_settings(settings)
    if runtime is None:
        raise ServiceError(sandbox_unavailable_reason(settings) or "Vercel runtime is unavailable.")
    nonce = uuid.uuid4().hex
    artifacts_dir = Path(ctx.run_dir) / f"{engine_id}-native-{nonce[:8]}"
    gateway_host = urlsplit(options.gateway.url).hostname
    headers = (
        {gateway_host: {"Authorization": f"Bearer {options.gateway.api_key}"}}
        if runtime.injects_headers and gateway_host
        else {}
    )
    source = _source_archive()
    lifetime = options.timeout_seconds + _INSTALL_ALLOWANCE
    if options.runtime == "vercel":
        lifetime = min(lifetime, settings.vercel_sandbox_max_lifetime_seconds)
    spec = SandboxSpec(
        lifetime_seconds=lifetime,
        env={"PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        name=unique_sandbox_name(f"skynet-{engine_id}"),
        inject_headers=headers,
    )
    session = runtime.open(spec)
    opened = time.monotonic()
    mailbox = _EvaluatorMailbox(
        session, server, nonce, getattr(ctx, "progress_callback", None), getattr(ctx, "check_budget", None)
    )
    try:
        payload = {
            "nonce": nonce,
            "source": GEPA_SOURCE,
            "engine_id": engine_id,
            "model": options.model,
            "sandbox": options.runtime == "worker",
            "max_token_cost": options.max_token_cost,
            "max_evals": server.remaining,
            "max_concurrency": ctx.concurrency,
            "max_iterations": ctx.max_iterations,
            "stop_at_score": ctx.stop_at_score,
            "timeout_seconds": options.timeout_seconds,
            "task": {
                "name": engine_id,
                "seed_candidate": task.seed_candidate,
                "objective": task.objective or "",
                "background": task.background or "",
                "train_set": task.train_set or None,
                "val_set": task.val_set or None,
            },
        }
        session.write_files(
            {
                _RUNNER_FILE: Path(native_runner.__file__).read_text(encoding="utf-8"),
                _INPUT_FILE: json.dumps(payload, default=side_info_json_default),
                "native_source.tar.gz.b64": source,
            }
        )
        installed = session.run(
            _bootstrap_command(options.runtime), timeout_seconds=min(_INSTALL_ALLOWANCE, lifetime - 1.0)
        )
        if not installed.ok or installed.timed_out:
            detail = (installed.stderr or installed.stdout)[-2000:]
            raise ServiceError(f"Native optimizer runtime setup failed: {detail}")
        env = {
            "ANTHROPIC_BASE_URL": options.gateway.url.removesuffix("/v1"),
            "ANTHROPIC_AUTH_TOKEN": "skynet-managed" if headers else options.gateway.api_key,
            "DISABLE_AUTOUPDATER": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CI": "1",
            "NO_COLOR": "1",
        }
        command = (
            'export HOME="$PWD"; export PATH="$HOME/.local/bin:$PATH"; '
            'export PYTHONPATH="$PWD/native_vendor"; '
            f'exec "$(cat native-python.txt)" {_RUNNER_FILE} {_INPUT_FILE}'
        )
        timeout = min(options.timeout_seconds, lifetime - (time.monotonic() - opened) - 1.0)
        if timeout <= 0:
            raise ServiceError("Native optimizer runtime expired while preparing dependencies.")
        payload["timeout_seconds"] = timeout
        session.write_files({_INPUT_FILE: json.dumps(payload, default=side_info_json_default)})
        completed = session.run(command, env=env, timeout_seconds=timeout, on_output=mailbox.on_output)
        text = session.read_file(_RESULT_FILE)
        document = json.loads(text) if text else {}
        usage = document.get("usage_by_model", {})
        _record_usage(options, usage)
        artifact_error: Exception | None = None
        try:
            _restore_artifacts(session, artifacts_dir)
        except Exception as exc:
            artifact_error = exc
        if mailbox.error is not None:
            raise mailbox.error
        if artifact_error is not None:
            raise artifact_error
        if completed.timed_out:
            raise ServiceError("Native optimizer exceeded its runtime limit.")
        if not completed.ok or document.get("error") or not document:
            detail = str(document.get("error") or completed.stderr[-2000:] or "No result was produced.")
            raise ServiceError(f"Native optimizer failed: {detail.replace(options.gateway.api_key, '[redacted]')}")
        if not document.get("usage_complete", False):
            raise ServiceError("Native optimizer usage could not be reconciled from its CLI artifacts.")
        if document.get("best_score") is None and (
            task.seed_candidate is None or document.get("best_candidate") != task.seed_candidate
        ):
            raise ServiceError("The upstream optimizer stopped before producing a fully evaluated candidate.")
        metadata = dict(document.get("metadata", {}))
        metadata.update(
            {
                "upstream_source": f"git+https://github.com/gepa-ai/gepa@{GEPA_SOURCE}",
                "upstream_revision": GEPA_SOURCE,
                "runtime": options.runtime,
                "native_artifacts_dir": str(artifacts_dir),
                "native_usage_by_model": usage,
                "native_usage_complete": document.get("usage_complete", False),
            }
        )
        return Result(
            best_candidate=document["best_candidate"],
            best_score=document.get("best_score"),
            total_evals=document.get("total_evals", 0),
            metadata=metadata,
        )
    finally:
        session.close()
