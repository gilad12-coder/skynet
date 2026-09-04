"""Verify upstream native-process transport, isolation and usage reconciliation."""

from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import tarfile
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from core.exceptions import ServiceError
from core.service_gateway.language_models import total_tokens_from_history, usage_by_model_from_history
from core.service_gateway.optimization.cost_ceiling import CostCeilingExceededError

from .. import native_runner, native_runtime
from ..harness import GatewayConfig
from ..native_runtime import NativeOptions, run_native_engine
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
        request = {"id": request_id, "candidate": "better", "example": {"id": "case"}}
        line = f"SKYNET_NATIVE_RPC {payload['nonce']} {json.dumps(request)}\n"
        sink = kwargs["on_output"]
        sink("stdout", "unrelated upstream log\n" + line[:17])
        sink("stdout", line[17:])
        sink("stdout", line)
        response = json.loads(self.files[f"rpc/{request_id}.json"])
        if "score" in response:
            progress = {"candidate_id": 0, "candidate": "better", "score": response["score"], "total_evals": 1}
            sink("stdout", f"SKYNET_NATIVE_PROGRESS {payload['nonce']} {json.dumps(progress)}\n")
        document = {
            "best_candidate": "better",
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


@pytest.mark.parametrize(("kind", "sandbox"), [("worker", True), ("vercel", False)])
def test_native_transport_preserves_engine_choice_and_scores_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str, sandbox: bool
) -> None:
    """Runtime choice changes isolation while duplicate delivery never repeats paid scoring."""
    monkeypatch.setattr(native_runtime, "_source_archive", lambda: "source")
    session = FakeSession()
    runtime = FakeRuntime(session)
    calls: list[tuple[str, Any]] = []

    def score(candidate: str, example: Any) -> tuple[float, dict[str, Any]]:
        """Record the actual evaluator call."""
        calls.append((candidate, example))
        return 0.75, {"feedback": "improved"}

    ctx = _context(tmp_path, runtime, kind)
    progress: list[dict[str, Any]] = []
    ctx.progress_callback = lambda event, metrics: progress.append(metrics)
    result = run_native_engine(
        "meta_harness", Task("seed", train_set=[{"id": "case"}]), EvalServer(score, max_evals=3), ctx
    )

    assert calls == [("better", {"id": "case"})]
    assert result.best_candidate == "better"
    assert result.best_score == 0.75
    assert json.loads(session.files["native_input.json"])["sandbox"] is sandbox
    assert "test_set" not in json.loads(session.files["native_input.json"])["task"]
    assert "secret" not in session.files["native_input.json"]
    assert session.calls[1][1]["env"]["ANTHROPIC_AUTH_TOKEN"] == "skynet-managed"
    assert runtime.spec.inject_headers == {"gateway.example": {"Authorization": "Bearer secret"}}
    assert ctx.native_options.usage_by_model["claude-test"]["total_tokens"] == 13
    assert progress[0]["score"] == 0.75
    assert progress[0]["parent_id"] is None
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
    options = NativeOptions("worker", "claude-test", GatewayConfig("https://gateway.example", "key"), 1.0)
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
        ("autoresearch", "untested"),
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
        " pathlib.Path('best_candidate.txt').write_text(os.environ.get('FAKE_FINAL_CANDIDATE','better'))\n"
        "else:\n"
        " pathlib.Path('agents/better.txt').write_text('better')\n"
        " pathlib.Path('state/pending_eval_iter1.json').write_text(json.dumps({'candidates':[{'name':'better','file':'agents/better.txt'}]}))\n"
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
    if variant == "untested":
        env["FAKE_FINAL_CANDIDATE"] = "untested"
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
            response = {"error": "parent scorer failed"} if abort else {"score": score, "info": {}}
            (tmp_path / "rpc" / f"{request['id']}.json").write_text(json.dumps(response))
            requests += 1
        stderr = process.stderr.read()
        assert process.wait(timeout=25) == int(abort or variant == "untested"), (
            tmp_path / "native_result.json"
        ).read_text() + stderr
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    result = json.loads((tmp_path / "native_result.json").read_text())
    assert (tmp_path / "invocations.txt").read_text().splitlines() == ["called"]
    if abort:
        assert "parent scorer failed" in result["error"]
        assert result["usage_by_model"]["claude-test"]["total_tokens"] == 10
        return
    if variant == "untested":
        assert "fidelity check failed" in result["error"]
        assert result["best_candidate"] == "untested"
        assert result["usage_by_model"]["claude-test"]["total_tokens"] == 10
        return
    assert requests == (4 if engine_id == "meta_harness" else 2 if variant == "repeated" else 1)
    assert result["best_candidate"] == "better"
    assert result["best_score"] == (1.0 if variant == "repeated" else 0.8)
    assert result["usage_by_model"]["claude-test"]["total_tokens"] == 10
    assert result["usage_complete"] is True
    assert (tmp_path / "native_artifacts.tar.gz.b64").stat().st_size > 0
