"""Drive the real AutoSaddler runner against the pinned upstream engine with a scripted agent."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from .. import autosaddler_runner, native_runtime

# The runner needs the pinned upstream package on Python 3.12, which the
# backend venv does not carry; point this at an interpreter that has it.
_PYTHON_ENV = "SKYNET_AUTOSADDLER_PYTHON"

_WRAPPER = '''
import importlib.util, json, sys, traceback
from pathlib import Path
from autosaddler.v2.core.domain import Cost, canonical_json
from autosaddler.v2.prompting.models import SessionResult, Usage

spec = importlib.util.spec_from_file_location("autosaddler_runner", sys.argv[2])
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class ScriptedProvider:
    """Answer every upstream session with a schema-valid, vowel-adding patch."""

    def __init__(self, config):
        self.config = config
        Path("sessions.log").touch()

    async def run(self, request):
        kind = request.spec.kind
        context = json.loads(request.spec.workspace_files[".autosaddler/session_context.json"])
        if kind == "diagnose_patch":
            assert ".autosaddler/training_evidence.json" in request.spec.workspace_files
            components = json.loads((request.workspace / "candidate.json").read_text())
            output = {
                "schema_version": "skynet-autosaddler-diagnosis/v1",
                "intent": "add vowels",
                "diagnosis": "too few vowels",
                "expected_effect": "higher density",
                "updates": {name: text + "aaa" for name, text in components.items()},
            }
        elif kind == "evolve":
            output = {
                "schema_version": "skynet-autosaddler-evolution/v1",
                "parent_ids": [context["candidate_ids"][-1]],
                "component_sources": {},
                "rationale": "continue from the newest accepted candidate",
            }
        else:
            output = {"schema_version": "skynet-autosaddler-reflection/v1", "lessons": []}
        with Path("sessions.log").open("a") as log:
            log.write(kind + "\\n")
        usage = Usage(input_tokens=5, output_tokens=3, model=self.config.model)
        return SessionResult(
            status="completed",
            structured_output=output,
            raw_response=canonical_json(output),
            tool_calls=(),
            usage=(usage,),
            cost=Cost(sessions=1, input_tokens=5, output_tokens=3),
        )


runner.ClaudeAgentProvider = ScriptedProvider
original_execute = runner.execute


def execute(payload):
    """Keep the traceback of a failure visible to the test."""
    try:
        return original_execute(payload)
    except Exception:
        traceback.print_exc()
        raise


runner.execute = execute
sys.exit(runner.main())
'''


def _upstream_python() -> str | None:
    """Find an interpreter that can import the pinned upstream package.

    Returns:
        The interpreter path, or ``None`` when no candidate carries AutoSaddler on Python 3.12+.
    """
    for candidate in (os.environ.get(_PYTHON_ENV), sys.executable):
        if not candidate:
            continue
        probe = subprocess.run(
            [candidate, "-c", "import sys, autosaddler.v2.core.engine; assert sys.version_info >= (3, 12)"],
            capture_output=True,
            timeout=60,
            check=False,
        )
        if probe.returncode == 0:
            return candidate
    return None


def _vowel_fraction(text: str) -> float:
    """Score text by its vowel density.

    Args:
        text: Candidate text.

    Returns:
        Vowel fraction in ``[0, 1]``.
    """
    return sum(ch in "aeiou" for ch in text) / max(1, len(text))


def test_runner_climbs_with_upstream_engine_and_reports_usage(tmp_path: Path) -> None:
    """Run the pinned upstream loop end to end: sessions, parent scoring, acceptance and artifacts."""
    python = _upstream_python()
    if python is None:
        pytest.skip(f"set {_PYTHON_ENV} to a Python 3.12 interpreter with the pinned autosaddler package")
    (tmp_path / "rpc").mkdir()
    (tmp_path / "wrapper.py").write_text(_WRAPPER)
    payload = {
        "nonce": "testnonce",
        "engine_id": "autosaddler",
        "model": "claude-test",
        "sandbox": False,
        "max_token_cost": 0.05,
        "max_evals": 12,
        "max_concurrency": 1,
        "max_iterations": 2,
        "timeout_seconds": 60,
        "source": native_runtime.AUTOSADDLER_REVISION,
        "task": {
            "name": "test",
            "seed_candidate": "bcd",
            "objective": "maximize vowel density",
            "train_set": [{"id": "a"}, {"id": "b"}],
            "val_set": [{"id": "c"}],
        },
    }
    (tmp_path / "input.json").write_text(json.dumps(payload))
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(tmp_path),
        "PYTHONUNBUFFERED": "1",
        "ANTHROPIC_BASE_URL": "http://gateway.invalid/v1",
    }
    process = subprocess.Popen(
        [python, "wrapper.py", "input.json", autosaddler_runner.__file__],
        cwd=tmp_path,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    scored: list[tuple[str, str]] = []
    try:
        for line in process.stdout:
            if not line.startswith("SKYNET_NATIVE_RPC testnonce "):
                continue
            request = json.loads(line.split(" ", 2)[2])
            scored.append((request["candidate"], request["example"]["id"]))
            response = {"score": _vowel_fraction(request["candidate"]), "info": {"feedback": "counted"}}
            (tmp_path / "rpc" / f"{request['id']}.json").write_text(json.dumps(response))
        stderr = process.stderr.read()
        result_file = tmp_path / "native_result.json"
        assert process.wait(timeout=60) == 0, (result_file.read_text() if result_file.exists() else "") + stderr
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()

    result = json.loads((tmp_path / "native_result.json").read_text())
    assert "error" not in result, result
    assert result["best_candidate"] == "bcdaaaaaa"
    assert result["best_score"] == pytest.approx(_vowel_fraction("bcdaaaaaa"))
    assert result["total_evals"] == len(scored)
    assert {example for _, example in scored} == {"a", "b", "c"}
    assert result["metadata"]["iterations"] == 2
    sessions = (tmp_path / "sessions.log").read_text().split()
    assert sessions.count("diagnose_patch") == 2
    assert result["usage_by_model"]["claude-test"]["total_tokens"] == 8 * len(sessions)
    assert result["usage_complete"] is True
    assert (tmp_path / "native_artifacts.tar.gz.b64").stat().st_size > 0
    assert (tmp_path / "autosaddler-run" / "result.json").exists()
