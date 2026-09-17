"""Tests for the ``claude``-compatible bridge that drives any harness for the upstream engines."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from .. import harness_bridge
from ..harness_bridge import (
    SessionOutcome,
    _cli_parser,
    install_shim,
    record_transcript,
    result_document,
    run_session,
)

_PLAIN = {"run_command": 'cat "$SKYNET_PROMPT_FILE"', "output_format": "plain", "files": {}, "env": {}}


def test_cli_parser_accepts_the_meta_harness_and_autoresearch_shapes() -> None:
    """Parse both upstream argv layouts without leaving unknown arguments behind."""
    meta, unknown = _cli_parser().parse_known_args(
        [
            "--print",
            "do the work",
            "--output-format",
            "json",
            "--model",
            "m1",
            "--session-id",
            "s1",
            "--disallowedTools=WebFetch,WebSearch",
            "--permission-mode",
            "bypassPermissions",
            "--effort",
            "high",
            "--max-budget-usd",
            "1.25",
        ]
    )
    assert unknown == []
    assert meta.prompt == ["do the work"]
    assert (meta.model, meta.session_id, meta.effort, meta.max_budget_usd) == ("m1", "s1", "high", "1.25")
    research, unknown = _cli_parser().parse_known_args(
        ["-p", "--output-format", "json", "--resume", "s1", "--settings", "{}", "--model", "m1", "continue"]
    )
    assert unknown == []
    assert research.resume == "s1"
    assert research.prompt == ["continue"]


def test_run_session_writes_files_restores_the_key_and_parses_the_answer(tmp_path: Path) -> None:
    """Materialize the launch in the workspace, swap in the real key and capture the harness answer."""
    proposer = {
        **_PLAIN,
        "run_command": 'cat "$SKYNET_PROMPT_FILE"; cat config.json; echo "$TOKEN"',
        "files": {"config.json": json.dumps({"key": harness_bridge.KEY_TOKEN})},
        "env": {"TOKEN": harness_bridge.KEY_TOKEN},
        "instructions_file": "AGENTS.md",
    }
    workspace = tmp_path / "work"
    os.environ[harness_bridge.KEY_ENV] = "real-key"
    try:
        outcome = run_session(
            proposer, workspace=workspace, prompt="hello", model="m1", session_dir=tmp_path / "session"
        )
    finally:
        del os.environ[harness_bridge.KEY_ENV]
    assert outcome.returncode == 0
    assert outcome.text == 'hello{"key": "real-key"}real-key'
    assert (workspace / "AGENTS.md").read_text().startswith("#")
    assert json.loads((workspace / "config.json").read_text()) == {"key": "real-key"}
    assert (tmp_path / "session" / "prompt-1.md").read_text() == "hello"
    assert (tmp_path / "session" / "run-1.stdout").exists()


def test_run_session_reports_timeouts_and_budget_overruns(tmp_path: Path) -> None:
    """Kill a harness that outlives its timeout and stop one whose priced usage exceeds the budget."""
    slow = {**_PLAIN, "run_command": "sleep 5"}
    outcome = run_session(
        slow, workspace=tmp_path / "w1", prompt="x", model="m", session_dir=tmp_path / "s1", timeout_seconds=0.2
    )
    assert outcome.timed_out is True
    assert outcome.returncode != 0
    event = json.dumps(
        {"type": "message_end", "message": {"role": "assistant", "content": [], "usage": {"input": 1000, "output": 0}}}
    )
    spender = {
        **_PLAIN,
        "output_format": "pi",
        "price": {"input": 0.01, "output": 0.0},
        "run_command": f"echo '{event}'; sleep 5; echo late",
    }
    outcome = run_session(
        spender, workspace=tmp_path / "w2", prompt="x", model="m", session_dir=tmp_path / "s2", max_cost_usd=1.0
    )
    assert outcome.budget_exceeded is True
    assert outcome.usage == {"input_tokens": 1000, "output_tokens": 0}
    assert outcome.cost_usd == pytest.approx(10.0)
    assert outcome.duration_seconds < 4


def test_result_document_and_transcript_match_what_upstream_reads(tmp_path: Path) -> None:
    """Emit a Claude-shaped result and a per-project transcript that ``collect_usage`` can price."""
    outcome = SessionOutcome(
        text="answer",
        stdout="",
        stderr="",
        returncode=0,
        usage={"input_tokens": 7, "output_tokens": 3},
        cost_usd=0.5,
        duration_seconds=1.5,
    )
    document = result_document("sid", "m1", outcome)
    assert document["type"] == "result"
    assert document["is_error"] is False
    assert document["result"] == "answer"
    assert document["session_id"] == "sid"
    assert document["total_cost_usd"] == 0.5
    assert document["modelUsage"]["m1"]["inputTokens"] == 7
    assert document["modelUsage"]["m1"]["outputTokens"] == 3
    home = tmp_path / "home"
    os.environ["HOME"] = str(home)
    try:
        record_transcript("sid", tmp_path / "work", "m1", outcome.usage)
    finally:
        os.environ["HOME"] = str(Path.home())
    transcripts = list((home / ".claude" / "projects").rglob("sid.jsonl"))
    assert len(transcripts) == 1
    line = json.loads(transcripts[0].read_text().splitlines()[0])
    assert line["message"]["model"] == "m1"
    assert line["message"]["usage"]["input_tokens"] == 7
    assert line["message"]["usage"]["output_tokens"] == 3


def test_shim_resumes_by_restating_the_opening_prompt(tmp_path: Path) -> None:
    """Replay the first task before the follow-up nudge because other harnesses cannot resume a session id."""
    home = tmp_path / "home"
    workspace = tmp_path / "work"
    workspace.mkdir()
    shim_dir = install_shim(home, Path(harness_bridge.__file__).resolve(), sys.executable)
    config = tmp_path / "proposer.json"
    config.write_text(json.dumps({**_PLAIN, "model": "m1"}))
    env = {
        **os.environ,
        "HOME": str(home),
        harness_bridge.CONFIG_ENV: str(config),
        "PATH": f"{shim_dir}{os.pathsep}{os.environ['PATH']}",
    }
    first = subprocess.run(
        ["claude", "--print", "first task", "--output-format", "json", "--session-id", "s1"],
        cwd=workspace,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(first.stdout)["result"] == "first task"
    second = subprocess.run(
        ["claude", "-p", "--output-format", "json", "--resume", "s1", "keep going"],
        cwd=workspace,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    replayed = json.loads(second.stdout)["result"]
    assert replayed.startswith("first task")
    assert replayed.endswith("keep going")
    assert (home / harness_bridge.SESSIONS_DIR / "s1" / "prompt-2.md").exists()
    rejected = subprocess.run(
        ["claude", "--print", "x", "--output-format", "text"],
        cwd=workspace,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert rejected.returncode == 1
    assert "unsupported --output-format" in rejected.stderr
