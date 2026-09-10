"""Verify the guest refuses an image that differs from its worker and says how."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from core.worker import isolated_runner
from core.worker.checkpoint_compat import runtime_identity


def test_guest_names_the_mismatched_identity_parts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]
) -> None:
    """Stop before authored code and list the parts the image and worker disagree on.

    Args:
        tmp_path: Guest request staging directory.
        monkeypatch: Runner and argument substitutions.
        capfd: Captures the framed event the guest writes to its real stdout.
    """
    expected = runtime_identity()
    expected["python"] = "0.0.0"
    expected["dependencies"]["gepa"] = "0.0.0"
    request = tmp_path / "request.json"
    request.write_text(
        json.dumps({"payload": {}, "artifact_id": "g1", "nonce": "fixture", "runtime_identity": expected})
    )

    def unexpected(*_args: Any, **_kwargs: Any) -> None:
        """Fail if authored code runs on an incompatible image."""
        raise AssertionError("the guest ran the optimizer on an incompatible image")

    monkeypatch.setattr(isolated_runner, "run_service_in_subprocess", unexpected)
    monkeypatch.setattr(isolated_runner.sys, "argv", ["isolated_runner", str(request)])
    isolated_runner.main()

    line = capfd.readouterr().out.strip()
    prefix = f"{isolated_runner.EVENT_PREFIX}fixture "
    assert line.startswith(prefix)
    event = json.loads(line[len(prefix) :])
    assert event["type"] == "error"
    assert event["error"].startswith(isolated_runner.INCOMPATIBLE_IMAGE_MESSAGE)
    assert "python: " in event["error"]
    assert "gepa: " in event["error"]
    assert event["error"].count("0.0.0 in the worker") == 2
    assert "source_sha256" not in event["error"]


def test_matching_identity_runs_the_optimizer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Let the guest proceed when its identity equals the worker's.

    Args:
        tmp_path: Guest request staging directory.
        monkeypatch: Runner and argument substitutions.
    """
    request = tmp_path / "request.json"
    request.write_text(
        json.dumps({"payload": {}, "artifact_id": "g1", "nonce": "fixture", "runtime_identity": runtime_identity()})
    )
    observed: list[str] = []

    def run(payload: dict[str, Any], artifact_id: str, events: Any, start_method: str) -> None:
        """Record that the optimizer entry point was reached."""
        observed.append(artifact_id)

    monkeypatch.setattr(isolated_runner, "run_service_in_subprocess", run)
    monkeypatch.setattr(isolated_runner.sys, "argv", ["isolated_runner", str(request)])
    isolated_runner.main()
    assert observed == ["g1"]
