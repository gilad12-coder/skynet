"""Verify upstream native-process transport, isolation and usage reconciliation."""

from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import tarfile
import tomllib
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from core.billing.pricing import model_token_costs
from core.billing.runtime import UsagePendingError
from core.exceptions import ServiceError
from core.models.blackbox import BlackboxProposer, BlackboxTarget
from core.service_gateway.language_models import total_tokens_from_history, usage_by_model_from_history
from core.service_gateway.optimization.cost_ceiling import CostCeilingExceededError

from .. import harness_bridge, native_runner, native_runtime
from ..harness import GatewayConfig, build_launch, launch_payload
from ..native_runtime import NativeOptions, _bootstrap_command, check_native_runtime, run_native_engine
from ..protocol import EvalServer, ScorerAbortError, Task
from ..sandbox import CommandResult, SandboxSpec


class FakeSession:
    """Run a scripted child dialogue without provisioning infrastructure."""

    def __init__(self, *, timeout: bool = False, incomplete_usage: bool = False) -> None:
        """Set the desired execution outcome.

        Args:
            timeout: Whether the child command reaches its deadline.
            incomplete_usage: Whether proposer usage remains unreconciled.
        """
        self.files: dict[str, str] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.closed = False
        self.timeout = timeout
        self.incomplete_usage = incomplete_usage
        self.no_incumbent = False
        self.candidate: Any = "better"

    def write_files(self, files: dict[str, str]) -> None:
        """Persist files as an in-memory child filesystem.

        Args:
            files: Relative paths and text contents.
        """
        self.files.update(files)

    def read_file(self, path: str) -> str | None:
        """Read one child file.

        Args:
            path: Child-relative path.

        Returns:
            Stored text, or ``None``.
        """
        return self.files.get(path)

    def run(self, command: str, **kwargs: Any) -> CommandResult:
        """Emit fragmented and repeated requests during the execution command.

        Args:
            command: Installation or runner command.
            **kwargs: Runtime timeout, environment and output callback.

        Returns:
            The scripted process outcome.
        """
        self.calls.append((command, kwargs))
        if len(self.calls) == 1:
            return CommandResult(exit_code=0)
        payload = json.loads(self.files["native_input.json"])
        request_id = "a" * 32
        request = {"id": request_id, "candidate": self.candidate, "example": {"id": "case"}}
        line = f"SKYNET_NATIVE_RPC {payload['nonce']} {json.dumps(request)}\n"
        sink = kwargs["on_output"]
        sink("stdout", "unrelated upstream log\n" + line[:17])
        sink("stdout", line[17:])
        sink("stdout", line)
        response = json.loads(self.files[f"rpc/{request_id}.json"])
        if "score" in response:
            progress = {"candidate_id": 0, "candidate": self.candidate, "score": response["score"], "total_evals": 1}
            sink("stdout", f"SKYNET_NATIVE_PROGRESS {payload['nonce']} {json.dumps(progress)}\n")
        document = {
            "best_candidate": self.candidate,
            "best_score": response.get("score"),
            "total_evals": 1,
            "metadata": {"adapter_cost": 0.01},
            "usage_by_model": {"claude-test": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}},
            "usage_complete": not self.incomplete_usage,
        }
        if "error" in response:
            document["error"] = response["error"]
        if self.no_incumbent:
            document["best_candidate"] = payload["task"]["seed_candidate"] or ""
            document["best_score"] = None
        self.files["native_result.json"] = json.dumps(document)
        return CommandResult(exit_code=0, timed_out=self.timeout)

    def close(self) -> None:
        """Record that the runtime was destroyed."""
        self.closed = True


class FakeRuntime:
    """Expose a scripted process session through the real runtime protocol."""

    injects_headers = True

    def __init__(self, session: FakeSession) -> None:
        """Retain the session supplied by a test.

        Args:
            session: Fake process filesystem and dialogue.
        """
        self.session = session
        self.spec: SandboxSpec | None = None

    def open(self, spec: SandboxSpec) -> FakeSession:
        """Capture runtime creation arguments.

        Args:
            spec: Process environment, identity and gateway injection.

        Returns:
            The scripted session.
        """
        self.spec = spec
        return self.session


class ReadinessSession(FakeSession):
    """Report dependency checks without executing an optimizer or an evaluator."""

    def __init__(self, *, fail: bool = False, pending: bool = False, bootstrap: CommandResult | None = None) -> None:
        """Select a runtime readiness failure, a scripted bootstrap result or unresolved final sandbox usage."""
        super().__init__()
        self.fail = fail
        self.pending = pending
        self.bootstrap = bootstrap

    def run(self, command: str, **kwargs: Any) -> CommandResult:
        """Capture offline runtime probes and return the required explicit success marker."""
        self.calls.append((command, kwargs))
        if self.bootstrap is not None and len(self.calls) == 1:
            return self.bootstrap
        return CommandResult(exit_code=1 if self.fail else 0, stdout='{"ready": true, "autosaddler": true}\n')

    def close(self) -> None:
        """Always record closure while preserving an unresolved sandbox usage signal."""
        self.closed = True
        if self.pending:
            raise UsagePendingError("readiness usage pending")


def test_native_readiness_checks_selected_isolation_without_search(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Probe the managed native image without model or scorer requests.

    Args:
        monkeypatch: Pytest fixture for replacing the pinned source archive.
    """
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "verified-source")
    session = ReadinessSession()
    adapter = FakeRuntime(session)
    options = NativeOptions(
        runtime="vercel",
        model="test/model",
        gateway=GatewayConfig(url="http://127.0.0.1:9000/v1", api_key="scoped"),
        budget_route={"url": "http://127.0.0.1:9000/v1", "token": "scoped"},
        sandbox_runtime=adapter,
        max_token_cost=1,
    )
    assert check_native_runtime(options) == {
        "runtime": "vercel",
        "gepa_source": native_runtime.GEPA_SOURCE,
        "meta_harness_source": native_runtime.META_HARNESS_REVISION,
        "autoresearch_source": native_runtime.AUTORESEARCH_REVISION,
        "autosaddler_source": native_runtime.AUTOSADDLER_REVISION,
        "autosaddler_ready": True,
        "claude_version": native_runtime.CLAUDE_VERSION,
    }
    assert adapter.spec.network_disabled is True
    assert "native_input.json" not in session.files
    assert "native_result.json" not in session.files
    assert session.files["native_source.tar.gz.b64"] == "verified-source"
    commands = "\n".join(command for command, _kwargs in session.calls)
    assert "npm install" not in commands
    assert "pip install" not in commands
    assert "bwrap_prefix" not in commands
    assert "engine.run" not in commands
    assert "--print" not in commands
    assert "scoped" not in str(session.calls)
    assert session.closed


@pytest.mark.parametrize("pending", [False, True])
def test_native_readiness_does_not_hide_failure_or_pending_usage(
    monkeypatch: pytest.MonkeyPatch, pending: bool
) -> None:
    """Fail readiness for missing dependencies and keep unresolved usage pending."""
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "verified-source")
    session = ReadinessSession(fail=not pending, pending=pending)
    options = NativeOptions(
        runtime="vercel",
        model="test/model",
        gateway=GatewayConfig(url="http://127.0.0.1:9000/v1", api_key="scoped"),
        budget_route={"url": "http://127.0.0.1:9000/v1", "token": "scoped"},
        sandbox_runtime=FakeRuntime(session),
        max_token_cost=1,
    )
    with pytest.raises(UsagePendingError if pending else ServiceError):
        check_native_runtime(options)
    assert session.closed


@pytest.mark.parametrize(
    ("bootstrap", "detail"),
    [
        (
            CommandResult(
                exit_code=1,
                stderr='Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n'
                "AssertionError: Native optimizers need Python 3.11 or newer\n",
            ),
            "The check exited with status 1: AssertionError: Native optimizers need Python 3.11 or newer",
        ),
        (CommandResult(exit_code=124, timed_out=True), "The check timed out after 60s."),
        (CommandResult(exit_code=2), "The check exited with status 2 and no output."),
    ],
)
def test_native_readiness_failure_names_the_broken_step(
    monkeypatch: pytest.MonkeyPatch, bootstrap: CommandResult, detail: str
) -> None:
    """Surface the failing bootstrap step instead of a bare dependency verdict.

    Args:
        monkeypatch: Pytest fixture for replacing the pinned source archive.
        bootstrap: Scripted result of the offline dependency bootstrap.
        detail: Expected explanation appended to the readiness error.
    """
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "verified-source")
    session = ReadinessSession(bootstrap=bootstrap)
    options = NativeOptions(
        runtime="vercel",
        model="test/model",
        gateway=GatewayConfig(url="http://127.0.0.1:9000/v1", api_key="scoped"),
        budget_route={"url": "http://127.0.0.1:9000/v1", "token": "scoped"},
        sandbox_runtime=FakeRuntime(session),
        max_token_cost=1,
    )
    with pytest.raises(ServiceError) as failure:
        check_native_runtime(options)
    assert str(failure.value) == f"The selected native runtime lacks its required pinned offline dependencies. {detail}"
    assert len(session.calls) == 1
    assert session.closed


def test_native_python_floor_matches_pyproject_and_admits_the_host() -> None:
    """Keep the offline bootstrap floor at requires-python so an image built for this host passes it."""
    pyproject = tomllib.loads((Path(__file__).resolve().parents[5] / "pyproject.toml").read_text())
    requires = pyproject["project"]["requires-python"]
    assert requires.startswith(">=")
    assert tuple(int(part) for part in requires[2:].split(".")) == native_runtime.PYTHON_FLOOR
    assert sys.version_info >= native_runtime.PYTHON_FLOOR
    protected = _bootstrap_command("vercel", protected=True)
    assert f"sys.version_info >= {native_runtime.PYTHON_FLOOR!r}" in protected
    assert "3, 11, 8" not in protected
    assert "3, 11, 8" not in _bootstrap_command("vercel")


def _context(tmp_path: Path, runtime: FakeRuntime, kind: str = "vercel") -> SimpleNamespace:
    """Build only the engine context fields this transport needs.

    Args:
        tmp_path: Artifact destination.
        runtime: Injected deterministic runtime.
        kind: Runtime selection sent to the child.

    Returns:
        An engine-compatible context with native options.
    """
    return SimpleNamespace(
        native_options=NativeOptions(
            kind, "claude-test", GatewayConfig("https://gateway.example/v1", "secret"), 1.0, sandbox_runtime=runtime
        ),
        run_dir=str(tmp_path),
        concurrency=2,
        max_iterations=1,
        stop_at_score=None,
    )


def test_native_transport_preserves_engine_choice_and_scores_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The managed sandbox preserves engine identity and deduplicates paid scoring.

    Args:
        tmp_path: Artifact destination.
        monkeypatch: Pytest fixture for replacing the pinned source archive.
    """
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "source")
    session = FakeSession()
    runtime = FakeRuntime(session)
    calls: list[tuple[str, Any]] = []

    def score(candidate: str, example: Any) -> tuple[float, dict[str, Any]]:
        """Record the actual evaluator call."""
        calls.append((candidate, example))
        return 0.75, {"feedback": "improved"}

    ctx = _context(tmp_path, runtime)
    progress: list[dict[str, Any]] = []
    ctx.progress_callback = lambda event, metrics: progress.append(metrics)
    result = run_native_engine(
        "meta_harness", Task("seed", train_set=[{"id": "case"}]), EvalServer(score, max_evals=3), ctx
    )

    assert calls == [("better", {"id": "case"})]
    assert result.best_candidate == "better"
    assert result.best_score == 0.75
    assert json.loads(session.files["native_input.json"])["sandbox"] is False
    assert "test_set" not in json.loads(session.files["native_input.json"])["task"]
    assert "secret" not in session.files["native_input.json"]
    assert session.calls[1][1]["env"]["ANTHROPIC_AUTH_TOKEN"] == "skynet-managed"
    assert runtime.spec.inject_headers == {"gateway.example": {"Authorization": "Bearer secret"}}
    assert ctx.native_options.usage_by_model["claude-test"]["total_tokens"] == 13
    assert progress[0]["score"] == 0.75
    assert progress[0]["parent_id"] is None
    assert session.closed


def test_protected_managed_runtime_does_not_nest_upstream_jail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Use the already isolated outer sandbox as the native engine boundary.

    Args:
        tmp_path: Artifact destination inside the outer sandbox.
        monkeypatch: Pinned source fixture.
    """
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "source")
    session = FakeSession()
    runtime = FakeRuntime(session)
    runtime.protected = True
    runtime.injects_headers = False
    run_native_engine(
        "meta_harness",
        Task("seed", train_set=[{"id": "case"}]),
        EvalServer(lambda *_: (0.75, {}), max_evals=3),
        _context(tmp_path, runtime),
    )
    assert json.loads(session.files["native_input.json"])["sandbox"] is False
    assert session.closed


def test_parent_scorer_abort_survives_child_transport(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The original parent failure propagates after available usage is retained and teardown runs."""
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "source")
    session = FakeSession()
    ctx = _context(tmp_path, FakeRuntime(session))
    error = ScorerAbortError("dataset service is unavailable")

    def score(candidate: str, example: Any) -> tuple[float, dict[str, Any]]:
        """Reject evaluation with the exact exception the caller must receive."""
        raise error

    with pytest.raises(ScorerAbortError) as raised:
        run_native_engine("autoresearch", Task("seed"), EvalServer(score, max_evals=3), ctx)
    assert raised.value is error
    assert ctx.native_options.usage_by_model["claude-test"]["total_tokens"] == 13
    assert session.closed


@pytest.mark.parametrize(
    ("timeout", "incomplete", "match"), [(True, False, "runtime limit"), (False, True, "reconciled")]
)
def test_native_timeout_and_missing_usage_fail_without_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, timeout: bool, incomplete: bool, match: str
) -> None:
    """A failed native execution never switches to a different local algorithm."""
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "source")
    session = FakeSession(timeout=timeout, incomplete_usage=incomplete)
    ctx = _context(tmp_path, FakeRuntime(session))
    with pytest.raises(ServiceError, match=match):
        run_native_engine("autoresearch", Task("seed"), EvalServer(lambda *_: (1.0, {}), max_evals=2), ctx)
    assert len(session.calls) == 2
    assert session.closed


def test_native_usage_ledger_survives_lane_replacement() -> None:
    """Auto lanes share cumulative proposer usage when their cost caps differ."""
    options = NativeOptions("vercel", "claude-test", GatewayConfig("https://gateway.example", "key"), 1.0)
    lane = replace(options, max_token_cost=0.25)
    native_runtime._record_usage(
        lane, {"claude-test": {"prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10}}
    )
    assert total_tokens_from_history(options) == 10
    assert usage_by_model_from_history(options) == {"claude-test": (8, 2)}


@pytest.mark.parametrize("seed", [None, "seed"])
def test_native_without_aggregate_preserves_only_an_existing_seed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seed: str | None
) -> None:
    """An unscored empty output cannot become the result of a seedless run."""
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "source")
    session = FakeSession()
    session.no_incumbent = True
    ctx = _context(tmp_path, FakeRuntime(session))
    server = EvalServer(lambda *_: (1.0, {}), max_evals=2)
    if seed is None:
        with pytest.raises(ServiceError, match="fully evaluated candidate"):
            run_native_engine("autoresearch", Task(seed), server, ctx)
    else:
        result = run_native_engine("autoresearch", Task(seed), server, ctx)
        assert result.best_candidate == seed
        assert result.best_score is None
    assert session.closed


@pytest.mark.parametrize("boundary", ["before", "after"])
def test_parent_rpc_checks_cumulative_budget_at_both_boundaries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, boundary: str
) -> None:
    """A known credit stop propagates even when RPC runs outside DSPy's context."""
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "source")
    session = FakeSession()
    ctx = _context(tmp_path, FakeRuntime(session))
    events: list[str] = []
    failure = CostCeilingExceededError("credits spent")

    def check() -> None:
        """Reject the configured evaluation boundary."""
        events.append("check")
        if boundary == "before" or "score" in events:
            raise failure

    def score(candidate: str, example: Any) -> tuple[float, dict[str, Any]]:
        """Record whether paid evaluation was admitted."""
        events.append("score")
        return 1.0, {}

    ctx.check_budget = check
    with pytest.raises(CostCeilingExceededError) as raised:
        run_native_engine("autoresearch", Task("seed"), EvalServer(score, max_evals=2), ctx)
    assert raised.value is failure
    assert events == (["check"] if boundary == "before" else ["check", "score", "check"])
    assert session.closed


def test_linux_cancellation_uses_procfs_when_ps_is_unavailable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Kill only the runner's descendants using kernel parent ids without procps."""
    for pid, parent in ((100, 1), (101, 100), (102, 101), (200, 1)):
        directory = tmp_path / str(pid)
        directory.mkdir()
        (directory / "status").write_text(f"Name:\ttest\nPPid:\t{parent}\n")
    monkeypatch.setattr(native_runner, "_PROC_ROOT", tmp_path)
    monkeypatch.setattr(native_runner.os, "getpid", lambda: 100)
    killed: list[int] = []
    monkeypatch.setattr(native_runner.os, "kill", lambda pid, signal: killed.append(pid))

    def no_ps(*args: Any, **kwargs: Any) -> None:
        """Reject accidental use of a binary absent from minimal images."""
        raise AssertionError("ps is unavailable")

    monkeypatch.setattr(native_runner.subprocess, "run", no_ps)
    native_runner._stop_children()
    assert killed == [102, 101]


def test_usage_prefers_cli_summaries_and_deduplicates_transcript_messages(tmp_path: Path) -> None:
    """Session mirrors and repeated assistant updates do not inflate token usage."""
    summary = {"session_id": "mh", "modelUsage": {"claude-test": {"inputTokens": 10, "outputTokens": 4}}}
    (tmp_path / "iter1_stdout.json").write_text(json.dumps(summary))
    mh_message = {
        "type": "assistant",
        "sessionId": "mh",
        "message": {"id": "m1", "model": "claude-test", "usage": {"input_tokens": 10, "output_tokens": 4}},
    }
    ar_message = {
        "type": "assistant",
        "sessionId": "ar",
        "message": {
            "id": "m2",
            "model": "claude-test",
            "usage": {"input_tokens": 3, "output_tokens": 2, "cache_read_input_tokens": 5},
        },
    }
    (tmp_path / "session.jsonl").write_text("\n".join(map(json.dumps, [mh_message, ar_message, ar_message])))
    usage = native_runner.collect_usage([tmp_path, tmp_path], "fallback")
    assert usage["claude-test"] == {
        "prompt_tokens": 13,
        "completion_tokens": 6,
        "cache_read_input_tokens": 5,
        "cache_creation_input_tokens": 0,
        "total_tokens": 24,
    }


def test_artifact_restore_rejects_parent_traversal(tmp_path: Path) -> None:
    """An upstream-produced artifact cannot write outside the job artifact directory."""
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as archive:
        member = tarfile.TarInfo("../escape.txt")
        member.size = 1
        archive.addfile(member, io.BytesIO(b"x"))
    session = FakeSession()
    session.files["native_artifacts.tar.gz.b64"] = base64.b64encode(data.getvalue()).decode()
    with pytest.raises(ServiceError, match="unsafe path"):
        native_runtime._restore_artifacts(session, tmp_path / "job")
    assert not (tmp_path / "escape.txt").exists()


@pytest.mark.parametrize(
    ("engine_id", "variant"),
    [
        ("autoresearch", "success"),
        ("meta_harness", "success"),
        ("meta_harness", "abort"),
        ("autoresearch", "repeated"),
    ],
)
def test_real_native_runner_drives_upstream_with_fake_cli(tmp_path: Path, engine_id: str, variant: str) -> None:
    """Exercise real upstream HTTP evaluation and session artifacts without any model or sandbox costs."""
    abort = variant == "abort"
    binary = tmp_path / "bin"
    binary.mkdir()
    fake_cli = binary / "claude"
    fake_cli.write_text(
        f"#!{sys.executable}\n"
        "import json, os, pathlib, re, sys, urllib.request\n"
        "with (pathlib.Path.home()/'invocations.txt').open('a') as history: history.write('called\\n')\n"
        "args=sys.argv[1:]; session=args[args.index('--session-id')+1]\n"
        "if pathlib.Path('eval.sh').exists():\n"
        " script=pathlib.Path('eval.sh').read_text(); url=re.search(r'SERVER_URL=\"([^\"]+)\"',script).group(1)\n"
        " request=urllib.request.Request(url+'/evaluate',data=json.dumps({'candidate':'better'}).encode(),"
        "headers={'Content-Type':'application/json'})\n"
        " urllib.request.urlopen(request).read()\n"
        " if os.environ.get('FAKE_REPEAT'): urllib.request.urlopen(request).read()\n"
        "else:\n"
        " assert '--tools' in args and '--append-system-prompt' in args\n"
        " pathlib.Path('agents/better.txt').write_text('better')\n"
        " pathlib.Path('logs/run/pending_eval.json').write_text(json.dumps({'candidates':[{'name':'better','file':'agents/better.txt'}]}))\n"
        "out=pathlib.Path.home()/'.claude/projects/test'; out.mkdir(parents=True,exist_ok=True)\n"
        "message={'type':'assistant','sessionId':session,'message':{'id':'m1','model':'claude-test',"
        "'usage':{'input_tokens':7,'output_tokens':3}}}\n"
        "(out/(session+'.jsonl')).write_text(json.dumps(message)+'\\n')\n"
        "print(json.dumps({'total_cost_usd':0.01,'session_id':session,"
        "'modelUsage':{'claude-test':{'inputTokens':7,'outputTokens':3}}}))\n"
    )
    fake_cli.chmod(0o755)
    (tmp_path / "rpc").mkdir()
    payload = {
        "nonce": "testnonce",
        "engine_id": engine_id,
        "model": "claude-test",
        "sandbox": False,
        "max_token_cost": 0.05,
        "max_evals": 4,
        "max_concurrency": 1,
        "max_iterations": 3 if abort else 1,
        "timeout_seconds": 20,
        "task": {"name": "test", "seed_candidate": "seed"},
    }
    if engine_id == "meta_harness":
        payload["task"]["train_set"] = [{"id": "a"}, {"id": "b"}]
    (tmp_path / "input.json").write_text(json.dumps(payload))
    env = {"PATH": f"{binary}{os.pathsep}/usr/bin:/bin", "HOME": str(tmp_path), "PYTHONUNBUFFERED": "1"}
    if variant == "repeated":
        env["FAKE_REPEAT"] = "1"
    process = subprocess.Popen(
        [sys.executable, native_runner.__file__, "input.json"],
        cwd=tmp_path,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    requests = 0
    try:
        for line in process.stdout:
            if not line.startswith("SKYNET_NATIVE_RPC testnonce "):
                continue
            request = json.loads(line.split(" ", 2)[2])
            score = 0.8 if request["candidate"] == "better" else float(request["example"]["id"] == "a")
            if variant == "repeated" and requests == 0:
                score = 1.0
            failing = abort and request["candidate"] == "better"
            response = {"error": "parent scorer failed"} if failing else {"score": score, "info": {}}
            (tmp_path / "rpc" / f"{request['id']}.json").write_text(json.dumps(response))
            requests += 1
        stderr = process.stderr.read()
        assert process.wait(timeout=25) == int(abort), (tmp_path / "native_result.json").read_text() + stderr
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    result = json.loads((tmp_path / "native_result.json").read_text())
    assert (tmp_path / "invocations.txt").read_text().splitlines() == ["called"]
    if abort:
        assert "parent scorer failed" in result["error"]
        assert result["interrupted_incumbent"]["best_candidate"] == "seed"
        assert result["interrupted_incumbent"]["best_score"] == 0.5
        assert result["usage_by_model"]["claude-test"]["total_tokens"] == 10
        return
    assert requests == (4 if engine_id == "meta_harness" else 2 if variant == "repeated" else 1)
    assert result["best_candidate"] == "better"
    assert result["best_score"] == (1.0 if variant == "repeated" else 0.8)
    assert result["usage_by_model"]["claude-test"]["total_tokens"] == 10
    assert result["usage_complete"] is True
    assert (tmp_path / "native_artifacts.tar.gz.b64").stat().st_size > 0


def test_autosaddler_bootstrap_pins_upstream_into_a_python_312_venv() -> None:
    """Install the pinned AutoSaddler revision on its own interpreter instead of the GEPA archive."""
    command = _bootstrap_command("vercel", engine_id="autosaddler")
    assert f"uv venv --python {native_runtime._AUTOSADDLER_PYTHON} native_venv" in command
    assert "uv pip install --python native_venv/bin/python --no-deps" in command
    assert native_runtime.AUTOSADDLER_REVISION in command
    assert f"sys.version_info >= {native_runtime.AUTOSADDLER_PYTHON_FLOOR!r}" in command
    assert "import autosaddler.v2.core.engine" in command
    assert "native_source.tar.gz.b64" not in command
    protected = _bootstrap_command("vercel", protected=True, engine_id="autosaddler")
    assert "uv venv" not in protected
    assert f"sys.version_info >= {native_runtime.AUTOSADDLER_PYTHON_FLOOR!r}" in protected
    assert "import autosaddler.v2.core.engine" in protected


def test_autosaddler_runner_files_bundle_the_scenario_plugin() -> None:
    """Ship the self-contained runner with every prompt and skill of the Skynet plugin."""
    files = native_runtime._runner_files("autosaddler")
    assert set(files) == {
        "autosaddler_runner.py",
        "harness_bridge.py",
        "autosaddler_plugin/SYSTEM.md",
        "autosaddler_plugin/prompts/diagnose_patch.md",
        "autosaddler_plugin/prompts/evolve.md",
        "autosaddler_plugin/prompts/reflect.md",
        "autosaddler_plugin/skills/candidate-patch/SKILL.md",
        "autosaddler_plugin/skills/patch-verification/SKILL.md",
    }
    assert all(text.strip() for text in files.values())
    assert set(native_runtime._runner_files("meta_harness")) == {
        "native_runner.py",
        "native_engines.py",
        "harness_bridge.py",
        "upstream_prompts/meta_harness/SKILL.md",
        "upstream_prompts/meta_harness/LICENSE",
        "upstream_prompts/meta_harness/NOTICE.md",
        "upstream_prompts/autoresearch/program.md",
        "upstream_prompts/autoresearch/NOTICE.md",
    }


def test_autosaddler_transport_scores_named_parts_without_the_gepa_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Send the AutoSaddler runner and plugin, accept a parts candidate and record the upstream revision."""
    monkeypatch.setattr(native_runtime, "_source_archive", MagicMock(side_effect=AssertionError("unused")))
    session = FakeSession()
    session.candidate = {"system": "better", "user": "ask"}
    runtime = FakeRuntime(session)
    calls: list[tuple[Any, Any]] = []

    def score(candidate: Any, example: Any) -> tuple[float, dict[str, Any]]:
        """Record the parts candidate the parent scored."""
        calls.append((candidate, example))
        return 0.75, {}

    task = Task({"system": "seed", "user": "ask"}, train_set=[{"id": "a"}], val_set=[{"id": "b"}])
    result = run_native_engine("autosaddler", task, EvalServer(score, max_evals=3), _context(tmp_path, runtime))

    assert calls == [({"system": "better", "user": "ask"}, {"id": "case"})]
    assert result.best_candidate == {"system": "better", "user": "ask"}
    assert result.metadata["upstream_source"] == native_runtime.AUTOSADDLER_SOURCE
    assert result.metadata["upstream_revision"] == native_runtime.AUTOSADDLER_REVISION
    payload = json.loads(session.files["native_input.json"])
    assert payload["source"] == native_runtime.AUTOSADDLER_REVISION
    assert payload["task"]["seed_candidate"] == {"system": "seed", "user": "ask"}
    assert "native_source.tar.gz.b64" not in session.files
    assert "autosaddler_plugin/SYSTEM.md" in session.files
    assert "autosaddler_runner.py" in session.calls[1][0]
    assert "native_runner.py" not in session.calls[1][0]
    assert session.closed


def test_autosaddler_transport_rejects_a_candidate_of_the_wrong_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Refuse to score text when the task carries named parts instead of crashing the scorer."""
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "source")
    session = FakeSession()
    runtime = FakeRuntime(session)
    scorer = MagicMock(return_value=(0.5, {}))
    task = Task({"system": "seed", "user": "ask"}, train_set=[{"id": "a"}], val_set=[{"id": "b"}])
    with pytest.raises(ServiceError, match="invalid candidate shape"):
        run_native_engine("autosaddler", task, EvalServer(scorer, max_evals=3), _context(tmp_path, runtime))
    scorer.assert_not_called()


@pytest.mark.parametrize(
    ("task", "message"),
    [
        (Task(None, train_set=[{"id": "a"}, {"id": "b"}]), "requires a seed candidate"),
        (Task("seed", train_set=[{"id": "a"}]), "at least two visible examples"),
        (Task("seed"), "at least two visible examples"),
    ],
)
def test_autosaddler_transport_needs_a_seed_and_two_visible_examples(tmp_path: Path, task: Task, message: str) -> None:
    """Fail before launching a sandbox when upstream has nothing to patch or confirm against."""
    runtime = FakeRuntime(FakeSession())
    with pytest.raises(ServiceError, match=message):
        run_native_engine(
            "autosaddler", task, EvalServer(lambda *_: (0.5, {}), max_evals=3), _context(tmp_path, runtime)
        )
    assert runtime.spec is None


@pytest.mark.parametrize("engine_id", ["autoresearch", "meta_harness"])
def test_real_native_runner_drives_upstream_through_a_pi_proposer(tmp_path: Path, engine_id: str) -> None:
    """Run the unchanged upstream engines against a non-Claude harness through the ``claude`` shim."""
    binary = tmp_path / "bin"
    binary.mkdir()
    (binary / "python3").symlink_to(sys.executable)
    fake_pi = binary / "pi"
    fake_pi.write_text(
        f"#!{sys.executable}\n"
        "import json, os, pathlib, re, sys, urllib.request\n"
        "with (pathlib.Path.home()/'invocations.txt').open('a') as history: history.write(' '.join(sys.argv[1:7])+'\\n')\n"
        "assert pathlib.Path(os.environ['SKYNET_PROMPT_FILE']).read_text()\n"
        "assert os.environ['SKYNET_API_KEY'] == 'real-key' and os.environ['SKYNET_MODEL'] == 'claude-test'\n"
        "assert pathlib.Path('AGENTS.md').read_text() and json.loads(pathlib.Path('.skynet/pi/models.json').read_text())\n"
        "if pathlib.Path('eval.sh').exists():\n"
        " script=pathlib.Path('eval.sh').read_text(); url=re.search(r'SERVER_URL=\"([^\"]+)\"',script).group(1)\n"
        " request=urllib.request.Request(url+'/evaluate',data=json.dumps({'candidate':'better'}).encode(),"
        "headers={'Content-Type':'application/json'})\n"
        " urllib.request.urlopen(request).read()\n"
        "else:\n"
        " pathlib.Path('agents/better.txt').write_text('better')\n"
        " pathlib.Path('logs/run/pending_eval.json').write_text(json.dumps({'candidates':[{'name':'better','file':'agents/better.txt'}]}))\n"
        "print(json.dumps({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'done'}],"
        "'usage':{'input':7,'output':3}}}))\n"
    )
    fake_pi.chmod(0o755)
    (tmp_path / "rpc").mkdir()
    launch = build_launch(
        BlackboxTarget(kind="agent", harness="pi", model="claude-test"),
        GatewayConfig(url="https://gw.example/v1", api_key=harness_bridge.KEY_TOKEN),
    )
    payload = {
        "nonce": "testnonce",
        "engine_id": engine_id,
        "model": "claude-test",
        "sandbox": False,
        "max_token_cost": 0.05,
        "max_evals": 4,
        "max_concurrency": 1,
        "max_iterations": 1,
        "timeout_seconds": 20,
        "proposer": {
            **launch_payload(launch),
            "harness": "pi",
            "model": "claude-test",
            "price": {"input": 0.0, "output": 0.0},
            "effort": "high",
        },
        "task": {"name": "test", "seed_candidate": "seed"},
    }
    if engine_id == "meta_harness":
        payload["task"]["train_set"] = [{"id": "a"}, {"id": "b"}]
    (tmp_path / "input.json").write_text(json.dumps(payload))
    env = {
        "PATH": f"{binary}{os.pathsep}/usr/bin:/bin",
        "HOME": str(tmp_path),
        "PYTHONUNBUFFERED": "1",
        harness_bridge.KEY_ENV: "real-key",
    }
    process = subprocess.Popen(
        [sys.executable, native_runner.__file__, "input.json"],
        cwd=tmp_path,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        for line in process.stdout:
            if not line.startswith("SKYNET_NATIVE_RPC testnonce "):
                continue
            request = json.loads(line.split(" ", 2)[2])
            score = 0.8 if request["candidate"] == "better" else float(request["example"]["id"] == "a")
            (tmp_path / "rpc" / f"{request['id']}.json").write_text(json.dumps({"score": score, "info": {}}))
        stderr = process.stderr.read()
        assert process.wait(timeout=25) == 0, (tmp_path / "native_result.json").read_text() + stderr
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    result = json.loads((tmp_path / "native_result.json").read_text())
    invocations = (tmp_path / "invocations.txt").read_text().splitlines()
    assert len(invocations) == 1
    assert "--mode json" in invocations[0]
    assert result["best_candidate"] == "better"
    assert result["best_score"] == 0.8
    assert result["usage_by_model"]["claude-test"]["total_tokens"] == 10
    assert result["usage_complete"] is True
    assert (tmp_path / harness_bridge.SHIM_DIR / "claude").exists()
    assert harness_bridge.KEY_TOKEN not in next(tmp_path.rglob(".skynet/pi/models.json")).read_text()
    assert list((tmp_path / ".claude" / "projects").rglob("*.jsonl"))


def test_bootstrap_installs_only_the_selected_proposer_harness() -> None:
    """Skip the Claude CLI install and probe the chosen harness when the proposer is not Claude Code."""
    pi_bootstrap = _bootstrap_command("vercel", harness="pi", install_command="npm install -g pi@1.2.3")
    assert "npm install -g pi@1.2.3" in pi_bootstrap
    assert "@anthropic-ai/claude-code" not in pi_bootstrap
    assert "pi --version" in pi_bootstrap
    protected = _bootstrap_command("vercel", protected=True, harness="pi", install_command="npm install -g pi@1.2.3")
    assert "npm install" not in protected
    assert "pi --version" in protected
    custom = _bootstrap_command("vercel", harness="custom", install_command="pip install my-agent")
    assert "pip install my-agent" in custom
    assert "--version" not in custom.split("pip install my-agent", 1)[1].split("native-python", 1)[0]
    assert "@anthropic-ai/claude-code" in _bootstrap_command("vercel")


def test_run_native_engine_serializes_the_proposer_without_the_gateway_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ship the chosen harness launch and knobs in the payload while the key only travels through the env."""
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "source")
    session = FakeSession()
    runtime = FakeRuntime(session)
    ctx = _context(tmp_path, runtime)
    proposer = BlackboxProposer(harness="codex", effort="high", max_candidates_per_iter=3, ralph=False)
    ctx.native_options = replace(ctx.native_options, proposer=proposer)
    run_native_engine("autoresearch", Task("seed"), EvalServer(lambda c, e: (0.5, {}), max_evals=3), ctx)
    payload = json.loads(session.files["native_input.json"])
    assert payload["proposer"]["harness"] == "codex"
    assert payload["proposer"]["output_format"] == "codex"
    assert payload["proposer"]["effort"] == "high"
    assert payload["proposer"]["max_candidates_per_iter"] == 3
    assert payload["proposer"]["ralph"] is False
    assert list(payload["proposer"]["price"].values()) == list(model_token_costs("claude-test"))
    assert "secret" not in session.files["native_input.json"]
    assert harness_bridge.KEY_TOKEN in session.files["native_input.json"]
    assert session.calls[1][1]["env"][harness_bridge.KEY_ENV] == "skynet-managed"
    assert "codex --version" in session.calls[0][0]
    assert "@anthropic-ai/claude-code" not in session.calls[0][0]
