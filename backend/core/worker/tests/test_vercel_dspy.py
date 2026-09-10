"""Verify managed DSPy execution transports results and recovery state without host execution."""

from __future__ import annotations

import base64
import io
import json
import logging
import queue
import tarfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from core.exceptions import DETERMINISTIC_FAILURE, INFRASTRUCTURE_INTERRUPTION
from core.service_gateway.optimization.blackbox.sandbox import CommandResult
from core.worker import vercel_dspy
from core.worker.checkpoint_compat import runtime_identity, source_digest


class FakeSession:
    """Emulate only the declared remote session transport with no provider calls."""

    def __init__(self) -> None:
        """Start an empty managed workspace."""
        self.files: dict[str, str] = {}
        self.closed = False
        self.path = "gepa_state.bin"

    def write_files(self, files: dict[str, str]) -> None:
        """Record the staged request."""
        self.files.update(files)

    def run(self, command: str, **kwargs: Any) -> CommandResult:
        """Emit fragmented checkpoint and successful optimizer frames."""
        [request_path] = [path for path in self.files if path.endswith("/request.json")]
        [archive_path] = [path for path in self.files if path.endswith("/source.tgz.b64")]
        assert command.index(f"base64 -d {archive_path} | tar -xzf -") < command.index("core.worker.isolated_runner")
        request = json.loads(self.files[request_path])
        assert "_budget_gateway_descriptor" not in request["payload"]
        assert request["runtime_identity"]["gepa_revision"] == "0632cdb5dcc052e690eab439e1b4a7e3e9cfe407"
        prefix = f"{vercel_dspy.EVENT_PREFIX}{request['nonce']} "
        events = []
        if request["export_checkpoints"]:
            events.append(
                {"type": "checkpoint_file", "path": self.path, "data": base64.b64encode(b"checkpoint").decode()}
            )
        events.append({"type": "result", "result": {"program": "done"}})
        text = "".join(prefix + json.dumps(event) + "\n" for event in events)
        for chunk in [text[:15], text[15:61], text[61:]]:
            kwargs["on_output"]("stdout", chunk)
        assert "core.worker.isolated_runner" in command
        return CommandResult(0)

    def close(self) -> None:
        """Confirm cleanup even when checkpoint validation fails."""
        self.closed = True


def test_remote_result_and_checkpoint_stream(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Mirror real event framing and close the managed session on success."""
    session = FakeSession()
    specs = []

    class Runtime:
        """Capture the requested managed image and network profile."""

        def __init__(self, url: str, token: str) -> None:
            """Accept only the parent's opaque descriptor."""
            assert token == "control"

        def open(self, spec: Any) -> FakeSession:
            """Return one fake paid session without any live execution."""
            specs.append(spec)
            return session

    monkeypatch.setattr(vercel_dspy, "RemoteSandboxRuntime", Runtime)
    events: queue.Queue = queue.Queue()
    payload = {
        "_gepa_log_dir": str(tmp_path),
        "_budget_gateway_descriptor": {
            "url": "http://127.0.0.1:9876",
            "control_token": "control",
            "image": "backend@sha256:" + "a" * 64,
            "lifetime_seconds": 600,
        },
    }
    vercel_dspy.run_vercel_dspy(payload, "job-g2", events, "spawn")
    assert session.closed
    assert specs[0].network_disabled
    assert specs[0].operation_key == "dspy:job-g2"
    assert (tmp_path / "gepa_state.bin").read_bytes() == b"checkpoint"
    assert events.get_nowait() == {"type": "result", "result": {"program": "done"}}
    assert events.empty()
    session.path = "../escaped.bin"
    session.closed = False
    vercel_dspy.run_vercel_dspy(payload, "job-g3", events, "spawn")
    assert session.closed
    assert events.get_nowait()["type"] == "error"
    assert not (tmp_path.parent / "escaped.bin").exists()


def test_remote_preflight_never_reads_submitted_checkpoint_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exclude supervisor checkpoint files from setup even if a private field reaches the runner."""
    marker = tmp_path / "gepa_state.bin"
    marker.write_bytes(b"parent-only")
    session = FakeSession()
    monkeypatch.setattr(vercel_dspy, "RemoteSandboxRuntime", lambda *_args: SimpleNamespace(open=lambda _spec: session))
    events: queue.Queue = queue.Queue()
    vercel_dspy.run_vercel_dspy(
        {
            "_preflight": {"scope": "evaluation"},
            "_gepa_log_dir": str(tmp_path),
            "_budget_gateway_descriptor": {
                "url": "http://127.0.0.1:9876",
                "control_token": "control",
                "image": "backend@sha256:" + "a" * 64,
                "lifetime_seconds": 600,
            },
        },
        "setup",
        events,
        "spawn",
    )
    request = json.loads(session.files[next(path for path in session.files if path.endswith("/request.json"))])
    assert "_gepa_log_dir" not in request["payload"]
    assert request["checkpoints"] == {}
    assert request["export_checkpoints"] is False
    assert marker.read_bytes() == b"parent-only"
    assert session.closed
    assert events.get_nowait() == {"type": "preflight_phase", "phase": "evaluator"}
    assert events.get_nowait()["type"] == "result"


def test_parent_ships_the_source_its_identity_covers(tmp_path: Path) -> None:
    """Unpack the staged archive and hash it the way a guest does.

    Args:
        tmp_path: Stand-in for the guest's session directory.
    """
    archive = base64.b64decode(vercel_dspy._source_archive())
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        tar.extractall(tmp_path, filter="data")
    assert source_digest(tmp_path / "core") == runtime_identity()["source_sha256"]
    assert (tmp_path / "core/worker/isolated_runner.py").is_file()
    assert (tmp_path / "core/i18n_locales/he.json").is_file()
    assert not list((tmp_path / "core").rglob("tests"))
    assert not list((tmp_path / "core").rglob("__pycache__"))


class CrashingSession(FakeSession):
    """Die before the entrypoint, the way an image missing this revision's modules does."""

    def __init__(self, stderr: str) -> None:
        """Keep the traceback the guest would print."""
        super().__init__()
        self.stderr = stderr

    def run(self, command: str, **kwargs: Any) -> CommandResult:
        """Stream only stderr and exit 1 without framing any event."""
        kwargs["on_output"]("stderr", self.stderr)
        return CommandResult(1, stderr=self.stderr)


@pytest.mark.parametrize(
    ("stderr", "expected", "kind"),
    [
        (
            "Traceback (most recent call last):\n"
            '  File "/app/core/worker/isolated_runner.py", line 26, in <module>\n'
            "    from core.worker.preflight import run_dspy_preflight\n"
            "ModuleNotFoundError: No module named 'core.service_gateway.datasets.split_counts'\n",
            "The sandbox backend image is incompatible with this worker revision and runtime. "
            "ModuleNotFoundError: No module named 'core.service_gateway.datasets.split_counts'",
            DETERMINISTIC_FAILURE,
        ),
        (
            "Traceback (most recent call last):\n"
            '  File "<frozen runpy>", line 198, in _run_module_as_main\n'
            "PermissionError: [Errno 13] Permission denied: '/app/.deno'\n",
            "The Vercel optimizer exited without a complete result (exit 1). "
            "PermissionError: [Errno 13] Permission denied: '/app/.deno'",
            INFRASTRUCTURE_INTERRUPTION,
        ),
    ],
)
def test_guest_crash_names_its_cause(
    stderr: str, expected: str, kind: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Carry the guest's last stderr line into the failure and keep the traceback in the log."""
    session = CrashingSession(stderr)
    monkeypatch.setattr(vercel_dspy, "RemoteSandboxRuntime", lambda *_args: SimpleNamespace(open=lambda _spec: session))
    events: queue.Queue = queue.Queue()
    with caplog.at_level(logging.ERROR, logger="core.worker.vercel_dspy"):
        vercel_dspy.run_vercel_dspy(
            {
                "_budget_gateway_descriptor": {
                    "url": "http://127.0.0.1:9876",
                    "control_token": "control",
                    "image": "backend@sha256:" + "a" * 64,
                    "lifetime_seconds": 600,
                },
            },
            "job-crash",
            events,
            "spawn",
        )
    assert session.closed
    event = events.get_nowait()
    assert event["type"] == "error"
    assert event["error"] == expected
    assert event["failure_kind"] == kind
    assert "Traceback (most recent call last):" in caplog.text
    assert events.empty()
