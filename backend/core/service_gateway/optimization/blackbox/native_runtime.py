"""Run pinned upstream agent engines in a managed sandbox."""

from __future__ import annotations

import base64
import io
import json
import math
import os
import re
import shlex
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

from ....billing.model_gateway import raise_gateway_stop
from ....billing.pricing import model_token_costs
from ....billing.runtime import UsagePendingError
from ....config import Settings, settings
from ....exceptions import ServiceError
from ....models.blackbox import BLACKBOX_HARNESS_CLAUDE_CODE, BlackboxProposer, BlackboxTarget
from ..budget_stop import BudgetReached
from . import harness_bridge, native_runner
from .agent_eval import gateway_from_settings
from .feedback import emit_candidate
from .harness import GatewayConfig, build_launch, launch_payload, pinned_harness_check
from .protocol import BudgetExhaustedError, EngineContext, EvalServer, Result, Task
from .runner import side_info_json_default
from .sandbox import (
    CommandResult,
    SandboxRuntime,
    SandboxSession,
    SandboxSpec,
    current_sandbox_runtime,
    sandbox_runtime_from_settings,
    sandbox_unavailable_reason,
    unique_sandbox_name,
)
from .upstream import (
    AUTORESEARCH_REVISION,
    AUTORESEARCH_SOURCE,
    AUTOSADDLER_REVISION,
    AUTOSADDLER_SOURCE,
    META_HARNESS_REVISION,
    META_HARNESS_SOURCE,
)

GEPA_SOURCE = "0632cdb5dcc052e690eab439e1b4a7e3e9cfe407"
CLAUDE_VERSION = "2.1.259"
# The guest must already carry the parent's exact Python patch version (checkpoint_compat identity),
# so the native floor only restates pyproject's requires-python. A stricter floor here contradicts
# any image built to match a host below it and fails every readiness check on that host.
PYTHON_FLOOR = (3, 11)
_RUNNER_FILE = "native_runner.py"
_INPUT_FILE = "native_input.json"
_RESULT_FILE = "native_result.json"
_ARTIFACT_FILE = "native_artifacts.tar.gz.b64"
_INSTALL_ALLOWANCE = 600.0
_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
_RPC_PREFIX = "SKYNET_NATIVE_RPC "
_UUID = re.compile(r"^[0-9a-f]{32}$")
NATIVE_ENGINES = frozenset({"meta_harness", "autoresearch", "autosaddler"})
_UPSTREAMS = {
    "meta_harness": (META_HARNESS_SOURCE, META_HARNESS_REVISION),
    "autoresearch": (AUTORESEARCH_SOURCE, AUTORESEARCH_REVISION),
    "autosaddler": (AUTOSADDLER_SOURCE, AUTOSADDLER_REVISION),
}
_AUTOSADDLER_RUNNER_FILE = "autosaddler_runner.py"
_BRIDGE_FILE = "harness_bridge.py"
_ENGINES_FILE = "native_engines.py"
_PROMPTS_DIR = "upstream_prompts"
_AUTOSADDLER_PLUGIN_DIR = "autosaddler_plugin"
# Upstream AutoSaddler v2 declares Python 3.12+ (its usage dataclasses rely on
# 3.12 default semantics), so its guest carries its own interpreter and a
# fully pinned, dependency-free install of exactly what the v2 core imports.
AUTOSADDLER_PYTHON_FLOOR = (3, 12)
_AUTOSADDLER_PYTHON = "3.12.12"
_AUTOSADDLER_PINS = (
    f"autosaddler @ https://github.com/microsoft/AutoSaddler/archive/{AUTOSADDLER_REVISION}.tar.gz",
    "annotated-types==0.8.0",
    "anyio==4.15.1",
    "attrs==26.1.0",
    "cffi==2.1.1",
    "claude-agent-sdk==0.2.152",
    "click==8.5.0",
    "cryptography==50.0.1",
    "h11==0.16.0",
    "httpcore2==2.13.0",
    "httpx2==2.13.0",
    "idna==3.19",
    "jsonschema==4.26.0",
    "jsonschema-specifications==2025.9.1",
    "mcp==2.2.0",
    "mcp-types==2.2.0",
    "opentelemetry-api==1.44.0",
    "pycparser==3.0",
    "pydantic==2.13.5",
    "pydantic_core==2.46.5",
    "PyJWT==2.14.0",
    "python-multipart==0.0.32",
    "PyYAML==6.0.3",
    "referencing==0.37.0",
    "rpds-py==2026.6.3",
    "sniffio==1.3.1",
    "sse-starlette==3.4.11",
    "starlette==1.6.0",
    "truststore==0.10.4",
    "typing_extensions==4.16.0",
    "typing-inspection==0.4.4",
    "uvicorn==0.53.0",
)


@dataclass(frozen=True)
class NativeOptions:
    """Bind an upstream proposer to the managed runtime and model gateway."""

    runtime: Literal["vercel"]
    model: str
    gateway: GatewayConfig = field(repr=False)
    max_token_cost: float
    timeout_seconds: float = 2400.0
    proposer: BlackboxProposer = field(default_factory=BlackboxProposer)
    budget_route: dict[str, str] | None = field(default=None, repr=False)
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
        runtime: Requested execution environment.
        settings: Deployment gateway and managed-sandbox configuration.

    Returns:
        An actionable unavailability reason, or ``None`` when checks pass.
    """
    if runtime != "vercel":
        return "Production optimizations run in the managed Vercel sandbox."
    current = current_sandbox_runtime()
    if current is not None:
        return None
    if gateway_from_settings(settings) is None:
        return "Native optimizers require a configured model gateway."
    return sandbox_unavailable_reason(settings)


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


def _runner_files(engine_id: str) -> dict[str, str]:
    """Collect the sandbox-side runner plus the pinned upstream prompts or plugin it drives.

    Args:
        engine_id: Native engine being launched.

    Returns:
        Relative file paths mapped to their text.
    """
    bridge = {_BRIDGE_FILE: Path(harness_bridge.__file__).read_text(encoding="utf-8")}
    if engine_id != "autosaddler":
        engines = Path(native_runner.__file__).with_name(_ENGINES_FILE)
        files = {
            **bridge,
            _RUNNER_FILE: Path(native_runner.__file__).read_text(encoding="utf-8"),
            _ENGINES_FILE: engines.read_text(encoding="utf-8"),
        }
        prompts_root = engines.with_name(_PROMPTS_DIR)
        for asset in sorted(path for path in prompts_root.rglob("*") if path.is_file()):
            files[f"{_PROMPTS_DIR}/{asset.relative_to(prompts_root).as_posix()}"] = asset.read_text(encoding="utf-8")
        return files
    runner = Path(native_runner.__file__).with_name(_AUTOSADDLER_RUNNER_FILE)
    plugin_root = runner.with_name(_AUTOSADDLER_PLUGIN_DIR)
    files = {**bridge, _AUTOSADDLER_RUNNER_FILE: runner.read_text(encoding="utf-8")}
    for asset in sorted(plugin_root.rglob("*.md")):
        files[f"{_AUTOSADDLER_PLUGIN_DIR}/{asset.relative_to(plugin_root).as_posix()}"] = asset.read_text(
            encoding="utf-8"
        )
    return files


def _harness_setup(harness: str, install_command: str | None, *, protected: bool) -> tuple[str, str]:
    """Return the install step and the version assertion for the proposer harness.

    Args:
        harness: Proposer harness identifier.
        install_command: Launch install command for a built-in or custom harness.
        protected: Whether the offline image must already carry the harness.

    Returns:
        ``(install, check)`` shell fragments, each ending in ``"; "`` or empty.
    """
    if harness == BLACKBOX_HARNESS_CLAUDE_CODE:
        install = (
            f'if ! claude --version 2>/dev/null | grep -q "^{re.escape(CLAUDE_VERSION)} "; then '
            f'npm install --global --prefix "$HOME/.local" @anthropic-ai/claude-code@{CLAUDE_VERSION}; fi; '
        )
        return ("" if protected else install), f'claude --version | grep -q "^{re.escape(CLAUDE_VERSION)} "; '
    check = pinned_harness_check(harness)
    install = f"{install_command}; " if install_command and not protected else ""
    return install, (f"{check}; " if check else "")


def _bootstrap_command(
    runtime: str,
    *,
    protected: bool = False,
    engine_id: str = "meta_harness",
    harness: str = BLACKBOX_HARNESS_CLAUDE_CODE,
    install_command: str | None = None,
) -> str:
    """Build installation and preflight commands with immutable package versions.

    Args:
        runtime: Selected managed execution environment.
        protected: Require dependencies already present in the immutable offline image.
        engine_id: Native engine whose interpreter and packages are prepared.
        harness: Proposer harness the engine drives.
        install_command: Install step of a non-Claude proposer harness.

    Returns:
        Shell command that prepares the isolated source and runtime.
    """
    autosaddler = engine_id == "autosaddler"
    harness_install, harness_check = _harness_setup(harness, install_command, protected=protected)
    floor = AUTOSADDLER_PYTHON_FLOOR if autosaddler else PYTHON_FLOOR
    prepare = (
        "set -eu; mkdir -p .claude .cache .local native_vendor rpc; "
        "test -f .claude.json || printf '{}' > .claude.json; "
    )
    if not protected and autosaddler:
        pins = " ".join(shlex.quote(pin) for pin in _AUTOSADDLER_PINS)
        prepare += (
            'export HOME="$PWD"; '
            'export PATH="$HOME/.local/bin:$PATH"; '
            "if ! command -v uv > /dev/null 2>&1; then "
            "python3 -m pip install --disable-pip-version-check --no-deps --user uv==0.9.13; fi; "
            f"uv venv --python {_AUTOSADDLER_PYTHON} native_venv; "
            f"uv pip install --python native_venv/bin/python --no-deps {pins}; "
            'printf "%s\\n" "$PWD/native_venv/bin/python" > native-python.txt; '
            "node -e 'if (+process.versions.node.split(\".\")[0] < 22) process.exit(1)'; " + harness_install
        )
    elif not protected:
        prepare += (
            'export HOME="$PWD"; '
            'export PATH="$HOME/.local/bin:$PATH"; '
            f"if python3 -c 'import sys; sys.exit(sys.version_info < {PYTHON_FLOOR!r})' 2>/dev/null; then "
            "command -v python3 > native-python.txt; else "
            "python3 -m pip install --disable-pip-version-check --no-deps --user uv==0.9.13; "
            '"$HOME/.local/bin/uv" python install 3.11.9; '
            '"$HOME/.local/bin/uv" python find 3.11.9 > native-python.txt; fi; '
            "node -e 'if (+process.versions.node.split(\".\")[0] < 22) process.exit(1)'; " + harness_install
        )
    else:
        prepare += "command -v python3 > native-python.txt; "
    extract = (
        "import base64,io,pathlib,tarfile; "
        "data=base64.b64decode(pathlib.Path('native_source.tar.gz.b64').read_text()); "
        "tarfile.open(fileobj=io.BytesIO(data),mode='r:gz').extractall('native_vendor',filter='data')"
    )
    if not autosaddler:
        prepare += f'"$(cat native-python.txt)" -c {shlex.quote(extract)}; '
    prepare += (
        harness_check
        + '"$(cat native-python.txt)" -c '
        + shlex.quote(
            f"import sys; assert sys.version_info >= {floor!r}, "
            f"'Native optimizers need Python {'.'.join(map(str, floor))} or newer'"
        )
    )
    if autosaddler:
        prepare += '; "$(cat native-python.txt)" -c ' + shlex.quote("import autosaddler.v2.core.engine")
    if protected:
        prepare += "; node -e 'if (+process.versions.node.split(\".\")[0] < 22) process.exit(1)'"
    return prepare


def _failure_detail(result: CommandResult, timeout_seconds: float) -> str:
    """Summarize a failed readiness command so the setup check names what broke.

    Args:
        result: Completed command whose output would otherwise be discarded.
        timeout_seconds: Bound the command ran under.

    Returns:
        One sentence naming the timeout or the command's exit status and last output line.
    """
    if result.timed_out:
        return f"The check timed out after {timeout_seconds:.0f}s."
    lines = [line.strip() for line in f"{result.stdout}\n{result.stderr}".splitlines() if line.strip()]
    if not lines:
        return f"The check exited with status {result.exit_code} and no output."
    return f"The check exited with status {result.exit_code}: {lines[-1][:240]}"


def _selected_runtime(options: NativeOptions) -> SandboxRuntime:
    """Bind the selected proposer transport without falling back to an unisolated process.

    Args:
        options: Fixed runtime selection and scoped model route.

    Returns:
        The explicit runtime adapter or the matching deployment transport.
    """
    if options.sandbox_runtime is not None:
        return options.sandbox_runtime
    runtime = sandbox_runtime_from_settings(settings)
    if runtime is None:
        raise ServiceError(sandbox_unavailable_reason(settings) or "Vercel runtime is unavailable.")
    return runtime


def check_native_runtime(options: NativeOptions) -> dict[str, Any]:
    """Verify native dependencies inside the selected protected runtime without proposing a candidate.

    Args:
        options: Actual runtime selection with a scoped parent gateway capability.

    Returns:
        Confirmed immutable source, CLI version, engine imports and runtime selection.

    Raises:
        ServiceError: When the managed runtime or its pinned dependencies cannot launch.
        UsagePendingError: When the readiness sandbox's usage still requires reconciliation.
    """
    if options.budget_route is None or options.runtime != "vercel":
        raise ServiceError("Native readiness requires the protected Vercel execution authority.")
    source = _source_archive()
    runtime = _selected_runtime(options)
    lifetime = min(180.0, settings.vercel_sandbox_max_lifetime_seconds)
    session = runtime.open(
        SandboxSpec(
            lifetime_seconds=lifetime,
            network_disabled=True,
            name=unique_sandbox_name("skynet-native-readiness"),
            env={"PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        )
    )
    started = time.monotonic()
    try:
        session.write_files(
            {**_runner_files("meta_harness"), **_runner_files("autosaddler"), "native_source.tar.gz.b64": source}
        )
        install_timeout = min(60, lifetime - 1)
        installed = session.run(_bootstrap_command(options.runtime, protected=True), timeout_seconds=install_timeout)
        if not installed.ok or installed.timed_out:
            raise ServiceError(
                "The selected native runtime lacks its required pinned offline dependencies. "
                + _failure_detail(installed, install_timeout)
            )
        probe = (
            "import importlib.util,json,subprocess,sys; import native_runner, autosaddler_runner, native_engines; "
            "native_engines.check_assets(); "
            f"autosaddler=sys.version_info >= {AUTOSADDLER_PYTHON_FLOOR!r} "
            "and importlib.util.find_spec('autosaddler') is not None; "
            "prefix=[]; "
            "result=subprocess.run([*prefix,'claude','--version'],capture_output=True,text=True,timeout=20,check=True); "
            f"assert result.stdout.split(' ',1)[0] == {CLAUDE_VERSION!r}; "
            "print(json.dumps({'ready':True,'autosaddler':autosaddler}))"
        )
        remaining = lifetime - (time.monotonic() - started) - 1
        if remaining <= 0:
            raise ServiceError("The native readiness runtime expired during dependency checks.")
        probe_timeout = min(60, remaining)
        checked = session.run(
            'export HOME="$PWD"; export PYTHONPATH="$PWD/native_vendor"; '
            f'"$(cat native-python.txt)" -c {shlex.quote(probe)}',
            timeout_seconds=probe_timeout,
            env={"DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "CI": "1"},
        )
        ready = next(
            (json.loads(line) for line in checked.stdout.splitlines() if line.strip().startswith('{"ready": true')),
            None,
        )
        if not checked.ok or checked.timed_out or ready is None:
            raise ServiceError(
                "The selected native runtime cannot launch the pinned upstream engine dependencies. "
                + _failure_detail(checked, probe_timeout)
            )
        return {
            "runtime": options.runtime,
            "gepa_source": GEPA_SOURCE,
            "meta_harness_source": META_HARNESS_REVISION,
            "autoresearch_source": AUTORESEARCH_REVISION,
            "autosaddler_source": AUTOSADDLER_REVISION,
            "autosaddler_ready": bool(ready.get("autosaddler")),
            "claude_version": CLAUDE_VERSION,
        }
    finally:
        original_error = sys.exception()
        try:
            session.close()
        except UsagePendingError:
            if original_error is None:
                raise


class _EvaluatorMailbox:
    """Translate child evaluator requests without exposing an inbound service."""

    def __init__(
        self,
        session: SandboxSession,
        server: EvalServer,
        nonce: str,
        progress_callback: Any = None,
        check_budget: Any = None,
        str_mode: bool = True,
    ) -> None:
        """Bind the transport to one parent evaluator.

        Args:
            session: Running process filesystem and command connection.
            server: Parent budgeted evaluation authority.
            nonce: Per-process framing token.
            progress_callback: Optional job trajectory sink.
            check_budget: Direct cumulative-spend guard, including on reader threads.
            str_mode: Whether the task admits only text candidates rather than named parts.
        """
        self.str_mode = str_mode
        self.session = session
        self.server = server
        self.nonce = nonce
        self.progress_callback = progress_callback
        self.check_budget = check_budget
        self.error: BaseException | None = None
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
                    if not _candidate_shape_ok(candidate, self.str_mode):
                        raise ServiceError("Native evaluator request carries an invalid candidate shape.")
                    if self.check_budget is not None:
                        self.check_budget()
                    score, info = self.server.evaluate(candidate, request.get("example"))
                    if self.check_budget is not None:
                        self.check_budget()
                    response = {"score": score, "info": info}
                except (Exception, BudgetReached) as exc:
                    self.error = exc
                    response = {"error": "The parent evaluator stopped this run."}
                    if isinstance(exc, BudgetReached):
                        response["stop_reason"] = "budget_reached"
            try:
                self._responses[request_id] = json.dumps(response, default=side_info_json_default, allow_nan=False)
            except (TypeError, ValueError) as exc:
                self.error = self.error or exc
                self._responses[request_id] = json.dumps({"error": "The parent evaluator returned invalid feedback."})
        self.session.write_files({f"rpc/{request_id}.json": self._responses[request_id]})


def _candidate_shape_ok(candidate: Any, str_mode: bool) -> bool:
    """Check that a child candidate matches the task's text or named-parts shape.

    Args:
        candidate: Candidate value received from the child.
        str_mode: Whether the task admits only text candidates.

    Returns:
        ``True`` when the parent evaluator may score the candidate.
    """
    if str_mode:
        return isinstance(candidate, str)
    return (
        isinstance(candidate, dict)
        and bool(candidate)
        and all(isinstance(name, str) and isinstance(text, str) for name, text in candidate.items())
    )


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
    """Execute an unchanged upstream agent engine inside the managed sandbox.

    Args:
        engine_id: Upstream ``meta_harness``, ``autoresearch`` or ``autosaddler`` identifier.
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
    if options is None or options.runtime != "vercel":
        raise ServiceError("Native optimizers require the managed Vercel sandbox.")
    if engine_id not in NATIVE_ENGINES:
        raise ServiceError("Unsupported native optimizer.")
    autosaddler = engine_id == "autosaddler"
    if not autosaddler and not task.str_mode:
        raise ServiceError("Native agent engines require a single text candidate.")
    if autosaddler and task.seed_candidate is None:
        raise ServiceError("AutoSaddler requires a seed candidate to patch.")
    if autosaddler and len(task.train_set or []) + len(task.val_set or []) < 2:
        raise ServiceError("AutoSaddler needs at least two visible examples to diagnose and confirm patches.")
    if server.remaining <= 0:
        raise BudgetExhaustedError("The native optimizer evaluation budget is exhausted.")
    if not math.isfinite(options.max_token_cost) or options.max_token_cost <= 0:
        raise ServiceError("Native optimizers require a positive proposer cost limit.")
    if not math.isfinite(options.timeout_seconds) or options.timeout_seconds <= 0:
        raise ServiceError("Native optimizers require a positive timeout.")
    if not options.gateway.url or not options.gateway.api_key:
        raise ServiceError("Native optimizers require a configured model gateway.")
    runtime = _selected_runtime(options)
    nonce = uuid.uuid4().hex
    artifacts_dir = Path(ctx.run_dir) / f"{engine_id}-native-{nonce[:8]}"
    gateway_host = urlsplit(options.gateway.url).hostname
    headers = (
        {gateway_host: {"Authorization": f"Bearer {options.gateway.api_key}"}}
        if runtime.injects_headers and gateway_host
        else {}
    )
    source = None if autosaddler else _source_archive()
    upstream_source, upstream_revision = _UPSTREAMS[engine_id]
    runner_file = _AUTOSADDLER_RUNNER_FILE if autosaddler else _RUNNER_FILE
    proposer = options.proposer
    launch = build_launch(
        BlackboxTarget(
            kind="agent",
            harness=proposer.harness,
            model=options.model,
            install_command=proposer.install_command,
            run_command=proposer.run_command,
        ),
        GatewayConfig(url=options.gateway.url, api_key=harness_bridge.KEY_TOKEN),
        protected=options.budget_route is not None,
    )
    input_price, output_price = model_token_costs(options.model)
    lifetime = options.timeout_seconds + _INSTALL_ALLOWANCE
    lifetime = min(lifetime, settings.vercel_sandbox_max_lifetime_seconds)
    spec = SandboxSpec(
        lifetime_seconds=lifetime,
        env={"PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        name=unique_sandbox_name(f"skynet-{engine_id}"),
        inject_headers=headers,
    )
    session = runtime.open(spec)
    final_result: Result | None = None
    opened = time.monotonic()
    mailbox = _EvaluatorMailbox(
        session,
        server,
        nonce,
        getattr(ctx, "progress_callback", None),
        getattr(ctx, "check_budget", None),
        str_mode=task.str_mode,
    )
    try:
        payload = {
            "nonce": nonce,
            "source": upstream_revision,
            "engine_id": engine_id,
            "model": options.model,
            "sandbox": False,
            "max_token_cost": options.max_token_cost,
            "max_evals": server.remaining,
            "max_concurrency": ctx.concurrency,
            "max_iterations": ctx.max_iterations,
            "stop_at_score": ctx.stop_at_score,
            "timeout_seconds": options.timeout_seconds,
            "proposer": {
                **launch_payload(launch),
                "harness": proposer.harness,
                "model": options.model,
                "price": {"input": input_price, "output": output_price},
                "effort": proposer.effort,
                "max_thinking_tokens": proposer.max_thinking_tokens,
                "max_candidates_per_iter": proposer.max_candidates_per_iter,
                "ralph": proposer.ralph,
                "max_no_eval_seconds": proposer.max_no_eval_seconds,
            },
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
                **_runner_files(engine_id),
                _INPUT_FILE: json.dumps(payload, default=side_info_json_default),
                **({} if source is None else {"native_source.tar.gz.b64": source}),
            }
        )
        installed = session.run(
            _bootstrap_command(
                options.runtime,
                protected=options.budget_route is not None,
                engine_id=engine_id,
                harness=proposer.harness,
                install_command=launch.install_command,
            ),
            timeout_seconds=min(_INSTALL_ALLOWANCE, lifetime - 1.0),
        )
        if not installed.ok or installed.timed_out:
            detail = (installed.stderr or installed.stdout)[-2000:]
            raise ServiceError(f"Native optimizer runtime setup failed: {detail}")
        relay = os.environ.get("SKYNET_BUDGET_RELAY_URL")
        env = {
            "ANTHROPIC_BASE_URL": (relay or options.gateway.url).removesuffix("/v1"),
            "ANTHROPIC_AUTH_TOKEN": "skynet-managed" if headers else options.gateway.api_key,
            harness_bridge.KEY_ENV: "skynet-managed" if headers else options.gateway.api_key,
            "DISABLE_AUTOUPDATER": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CI": "1",
            "NO_COLOR": "1",
            **({"SKYNET_BUDGET_RELAY_URL": relay} if relay else {}),
        }
        command = (
            'export HOME="$PWD"; export PATH="$HOME/.local/bin:$PATH"; '
            'export PYTHONPATH="$PWD/native_vendor"; '
            f'exec "$(cat native-python.txt)" {runner_file} {_INPUT_FILE}'
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
            if isinstance(mailbox.error, BudgetReached) and document.get("best_score") is not None:
                mailbox.error.result = Result(
                    best_candidate=document["best_candidate"],
                    best_score=document["best_score"],
                    total_evals=document.get("total_evals", 0),
                    metadata={
                        **document.get("metadata", {}),
                        "upstream_source": upstream_source,
                        "native_artifacts_dir": str(artifacts_dir),
                        "native_usage_by_model": usage,
                    },
                )
                mailbox.error.evidence.update(
                    selection_scope="validation",
                    final_evaluation_completed=False,
                    final_evaluation_reason="budget_reached",
                )
            raise mailbox.error
        if artifact_error is not None:
            raise artifact_error
        if completed.timed_out:
            raise ServiceError("Native optimizer exceeded its runtime limit.")
        if options.budget_route is not None:
            try:
                raise_gateway_stop(options.budget_route)
            except BudgetReached as stop:
                incumbent = (
                    document if document.get("best_score") is not None else document.get("interrupted_incumbent", {})
                )
                if incumbent.get("best_score") is not None:
                    stop.result = Result(
                        best_candidate=incumbent["best_candidate"],
                        best_score=incumbent["best_score"],
                        total_evals=incumbent.get("total_evals", 0),
                        metadata={
                            **incumbent.get("metadata", {}),
                            "native_artifacts_dir": str(artifacts_dir),
                            "native_usage_by_model": usage,
                        },
                    )
                stop.evidence.update(final_evaluation_completed=False, final_evaluation_reason="budget_reached")
                raise
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
                "upstream_source": upstream_source,
                "upstream_revision": upstream_revision,
                "runtime": options.runtime,
                "native_artifacts_dir": str(artifacts_dir),
                "native_usage_by_model": usage,
                "native_usage_complete": document.get("usage_complete", False),
            }
        )
        final_result = Result(
            best_candidate=document["best_candidate"],
            best_score=document.get("best_score"),
            total_evals=document.get("total_evals", 0),
            metadata=metadata,
        )
        return final_result
    finally:
        active_error = sys.exception()
        try:
            session.close()
        except UsagePendingError:
            if final_result is not None:
                final_result.metadata["runtime_usage_pending"] = True
            elif active_error is None:
                raise
