"""Tests for the local Docker sandbox runtime used in local mode."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from core.config import Settings
from core.exceptions import ServiceError
from core.i18n import t
from core.worker.vercel_dspy import _require_image_protocol

from ..docker_sandbox import (
    DOCKER_JOB_LABEL,
    DockerSandboxRuntime,
    DockerSandboxSession,
    docker_sandbox_unavailable_reason,
)
from ..native_runtime import native_runtime_unavailable_reason
from ..sandbox import (
    _RUNTIME_OVERRIDE,
    JOB_TAG,
    SandboxSpec,
    sandbox_runtime_from_settings,
    sandbox_unavailable_reason,
    scorer_runtime_from_settings,
)
from ..sandbox_broker import SandboxBroker

_IMAGE = "sha256:" + "a" * 64
_LIVE_IMAGE = os.environ.get("APP_LOCAL_SANDBOX_IMAGE", "")
_SETTINGS_ENV = (
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
    "APP_LOCAL_MODE",
    "SKYNET_LOCAL_MODE",
    "APP_LOCAL_SANDBOX_IMAGE",
    "SKYNET_LOCAL_SANDBOX_IMAGE",
    "APP_DOCKER_BIN",
    "SKYNET_DOCKER_BIN",
    "RAILWAY_ENVIRONMENT_NAME",
)

# The fake CLI records each call's argv and answers like a healthy daemon,
# unless FAKE_DOCKER_FAIL names a subcommand that should fail.
_FAKE_DOCKER = """#!{python}
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_DOCKER_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
command = " ".join(args[:2]) if args[:1] == ["image"] else args[0]
if command in os.environ.get("FAKE_DOCKER_FAIL", "").split(","):
    sys.stderr.write("Error response from daemon: refused\\n")
    sys.exit(1)
if command == "run":
    print("c0ffee" * 10)
elif command == "ps":
    print("box1")
    print("box2")
elif command == "inspect":
    print("null")
"""


def _settings(monkeypatch: pytest.MonkeyPatch, **values: Any) -> Settings:
    """Build settings from a clean environment, ignoring the developer's ``.env``.

    Args:
        monkeypatch: Pytest fixture.
        **values: Settings fields to set.

    Returns:
        A fresh ``Settings`` instance.
    """
    for name in _SETTINGS_ENV:
        monkeypatch.delenv(name, raising=False)
    if values.get("local_mode"):
        monkeypatch.setenv("API_HOST", "127.0.0.1")
    return Settings(_env_file=None, **values)


@pytest.fixture
def fake_docker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, Path]:
    """Install a recording fake Docker CLI.

    Args:
        tmp_path: Pytest temporary directory.
        monkeypatch: Pytest fixture.

    Returns:
        The fake CLI's path and the file its calls are logged to.
    """
    binary = tmp_path / "docker"
    binary.write_text(_FAKE_DOCKER.format(python=sys.executable))
    binary.chmod(0o755)
    log = tmp_path / "calls.jsonl"
    log.touch()
    monkeypatch.setenv("FAKE_DOCKER_LOG", str(log))
    monkeypatch.delenv("FAKE_DOCKER_FAIL", raising=False)
    return str(binary), log


def _calls(log: Path) -> list[list[str]]:
    """Read every recorded fake CLI call.

    Args:
        log: The fake CLI's call log.

    Returns:
        Each call's argv after the binary.
    """
    return [json.loads(line) for line in log.read_text().splitlines()]


def _flag_values(argv: list[str], flag: str) -> list[str]:
    """Collect every value passed after ``flag``.

    Args:
        argv: A recorded call.
        flag: The option name.

    Returns:
        The values, in order.
    """
    return [argv[index + 1] for index, item in enumerate(argv) if item == flag]


def test_open_starts_an_offline_read_only_box_labelled_with_its_job(fake_docker: tuple[str, Path]) -> None:
    """Pin the exact isolation flags: no network, no published ports, read-only root, job label."""
    binary, log = fake_docker
    runtime = DockerSandboxRuntime(_IMAGE, docker_bin=binary)

    session = runtime.open(SandboxSpec(lifetime_seconds=90.2, env={"A": "1"}, tags={JOB_TAG: "job-7"}, vcpus=2))

    assert isinstance(session, DockerSandboxSession)
    assert session.container == "c0ffee" * 10
    (argv,) = _calls(log)
    assert argv[:5] == ["run", "-d", "--rm", "--init", "--name"]
    assert _flag_values(argv, "--network") == ["none"]
    assert not {"-p", "--publish", "--publish-all", "-P", "--privileged", "-v", "--volume", "--mount"} & set(argv)
    assert "--read-only" in argv
    assert _flag_values(argv, "--cap-drop") == ["ALL"]
    assert _flag_values(argv, "--security-opt") == ["no-new-privileges"]
    assert _flag_values(argv, "--cpus") == ["2"]
    assert _flag_values(argv, "--memory") == ["4096m"]
    assert _flag_values(argv, "--pids-limit") == ["1024"]
    assert [mount.split(":")[0] for mount in _flag_values(argv, "--tmpfs")] == ["/workspace", "/tmp"]
    assert _flag_values(argv, "-w") == ["/workspace"]
    assert _flag_values(argv, "-e") == ["HOME=/workspace", "TMPDIR=/tmp", "A=1"]
    assert set(_flag_values(argv, "--label")) == {"skynet=blackbox", "skynet_job=job-7", f"{DOCKER_JOB_LABEL}=job-7"}
    assert argv[-4:] == ["--entrypoint", "sleep", _IMAGE, "91"]
    assert runtime.billable is False
    assert runtime.injects_headers is False


def test_open_uses_the_bridge_network_only_for_allowlisted_hosts(fake_docker: tuple[str, Path]) -> None:
    """A parent setup box that needs registries joins bridge; every other box stays offline."""
    binary, log = fake_docker
    runtime = DockerSandboxRuntime(_IMAGE, docker_bin=binary)

    runtime.open(SandboxSpec(lifetime_seconds=60, allowed_hosts=("pypi.org",), image="sha256:" + "b" * 64))

    (argv,) = _calls(log)
    assert _flag_values(argv, "--network") == ["bridge"]
    assert argv[-2] == "sha256:" + "b" * 64


@pytest.mark.parametrize(
    "spec",
    [
        SandboxSpec(lifetime_seconds=60, inject_headers={"api.example.com": {"Authorization": "x"}}),
        SandboxSpec(lifetime_seconds=60, network_disabled=True, allowed_hosts=("pypi.org",)),
        SandboxSpec(lifetime_seconds=0),
        SandboxSpec(lifetime_seconds=float("inf")),
        SandboxSpec(lifetime_seconds=60, vcpus=3),
    ],
)
def test_open_refuses_specs_a_local_box_cannot_honour(fake_docker: tuple[str, Path], spec: SandboxSpec) -> None:
    """Refuse header injection, contradictory networks and out-of-profile bounds before Docker runs."""
    binary, log = fake_docker
    with pytest.raises(ServiceError):
        DockerSandboxRuntime(_IMAGE, docker_bin=binary).open(spec)
    assert _calls(log) == []


def test_open_reports_a_daemon_refusal(fake_docker: tuple[str, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    """Carry Docker's own error line into the failure."""
    binary, _ = fake_docker
    monkeypatch.setenv("FAKE_DOCKER_FAIL", "run")
    with pytest.raises(ServiceError, match="refused"):
        DockerSandboxRuntime(_IMAGE, docker_bin=binary).open(SandboxSpec(lifetime_seconds=60))


def test_stop_job_sandboxes_removes_every_box_under_the_job_label(fake_docker: tuple[str, Path]) -> None:
    """Sweep by the ``skynet.job`` label and count each removed box."""
    binary, log = fake_docker

    assert DockerSandboxRuntime(_IMAGE, docker_bin=binary).stop_job_sandboxes("job-7") == 2

    assert _calls(log) == [
        ["ps", "-q", "--filter", f"label={DOCKER_JOB_LABEL}=job-7"],
        ["rm", "-f", "box1"],
        ["rm", "-f", "box2"],
    ]


def test_session_commands_address_the_container(fake_docker: tuple[str, Path]) -> None:
    """Run, read and close through ``docker exec`` and ``docker rm``; close only once."""
    binary, log = fake_docker
    session = DockerSandboxSession(binary, "box1", env={}, owner=None)

    result = session.run("echo hi", env={"K": "V"}, timeout_seconds=4.5)
    session.read_file("out/a.txt")
    session.close()
    session.close()

    run, read, remove = _calls(log)
    assert result.ok
    timeout = ["timeout", "--signal=KILL", "5s"]
    assert run == ["exec", "-w", "/workspace", "-e", "K=V", "box1", *timeout, "bash", "-lc", "echo hi"]
    assert read[:4] == ["exec", "-w", "/workspace", "box1"]
    assert read[-1] == "out/a.txt"
    assert remove == ["rm", "-f", "box1"]


@pytest.mark.parametrize("path", ["/etc/passwd", "../escape", ""])
def test_session_refuses_paths_outside_the_workspace(fake_docker: tuple[str, Path], path: str) -> None:
    """Keep file access inside the working directory."""
    binary, _ = fake_docker
    session = DockerSandboxSession(binary, "box1", env={}, owner=None)
    with pytest.raises(ValueError):
        session.write_files({path: "x"})
    with pytest.raises(ValueError):
        session.read_file(path)


def test_unavailable_reason_explains_a_missing_cli(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Name Docker as the missing piece when its CLI is not installed."""
    settings = _settings(monkeypatch, docker_bin=str(tmp_path / "missing"), local_sandbox_image=_IMAGE)
    assert docker_sandbox_unavailable_reason(settings) == t("sandbox.docker_unavailable")


@pytest.mark.parametrize(
    ("fail", "image", "key"),
    [
        ("info", _IMAGE, "sandbox.docker_unavailable"),
        ("", "", "sandbox.docker_image_missing"),
        ("image inspect", _IMAGE, "sandbox.docker_image_missing"),
    ],
)
def test_unavailable_reason_explains_a_stopped_daemon_or_missing_image(
    fake_docker: tuple[str, Path], monkeypatch: pytest.MonkeyPatch, fail: str, image: str, key: str
) -> None:
    """Tell a stopped daemon apart from an image that is not built yet."""
    binary, _ = fake_docker
    monkeypatch.setenv("FAKE_DOCKER_FAIL", fail)
    settings = _settings(monkeypatch, docker_bin=binary, local_sandbox_image=image)
    assert docker_sandbox_unavailable_reason(settings) == t(key)


def test_local_mode_settings_build_docker_and_never_vercel(
    fake_docker: tuple[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Local mode opens Docker boxes without any Vercel credential configured."""
    binary, _ = fake_docker
    settings = _settings(monkeypatch, local_mode=True, docker_bin=binary, local_sandbox_image=_IMAGE)
    # The package conftest binds a host-subprocess runtime; this test checks
    # the settings resolver itself, so it clears that binding.
    token = _RUNTIME_OVERRIDE.set(None)
    try:
        assert isinstance(sandbox_runtime_from_settings(settings), DockerSandboxRuntime)
        assert isinstance(scorer_runtime_from_settings(settings), DockerSandboxRuntime)
    finally:
        _RUNTIME_OVERRIDE.reset(token)

    assert sandbox_unavailable_reason(settings) is None
    assert native_runtime_unavailable_reason("docker", settings) is None
    assert native_runtime_unavailable_reason("vercel", settings) is None


def test_hosted_settings_refuse_the_docker_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    """A hosted deployment keeps Vercel as its only sandbox, whatever Docker is installed."""
    settings = _settings(monkeypatch, vercel_token="token", vercel_team_id="team", vercel_project_id="project")
    token = _RUNTIME_OVERRIDE.set(None)
    try:
        assert not isinstance(sandbox_runtime_from_settings(settings), DockerSandboxRuntime)
    finally:
        _RUNTIME_OVERRIDE.reset(token)

    assert native_runtime_unavailable_reason("docker", settings) is not None


def test_broker_accepts_a_bare_local_image_without_a_vercel_quote(fake_docker: tuple[str, Path]) -> None:
    """The broker skips the Vercel price check for a free local runtime and its bare image id."""
    binary, _ = fake_docker
    broker = SandboxBroker(DockerSandboxRuntime(_IMAGE, docker_bin=binary), image=_IMAGE, max_lifetime_seconds=60)
    broker.close()


# --- Live Docker -----------------------------------------------------------

_live = pytest.mark.skipif(
    shutil.which("docker") is None or not _LIVE_IMAGE,
    reason="needs a Docker CLI and APP_LOCAL_SANDBOX_IMAGE set to a built local sandbox image",
)


def _container_exists(container: str) -> bool:
    """Check whether Docker still knows ``container``.

    Args:
        container: Container id.

    Returns:
        True while the container exists.
    """
    return subprocess.run(["docker", "inspect", container], capture_output=True, check=False).returncode == 0


@pytest.fixture
def live_session() -> Iterator[DockerSandboxSession]:
    """Open one real box on the local sandbox image and remove it afterwards.

    Yields:
        The open session.
    """
    session = DockerSandboxRuntime(_LIVE_IMAGE).open(
        SandboxSpec(lifetime_seconds=300, name="skynet-test", tags={JOB_TAG: "sky113-test"})
    )
    assert isinstance(session, DockerSandboxSession)
    try:
        yield session
    finally:
        session.close()


@pytest.mark.docker
@_live
def test_live_box_writes_reads_and_streams(live_session: DockerSandboxSession) -> None:
    """Write files, stream output while the command runs, and read results back."""
    live_session.write_files({"src/a.txt": "alpha\n", "b.txt": "beta"})
    arrivals: list[tuple[str, float]] = []

    result = live_session.run(
        "cat src/a.txt; sleep 2; echo late >&2; echo done > out.txt",
        timeout_seconds=30,
        on_output=lambda stream, line: arrivals.append((line, time.monotonic())),
    )

    assert result.ok
    assert result.stdout == "alpha\n"
    assert result.stderr == "late\n"
    assert arrivals[-1][1] - arrivals[0][1] >= 1.5
    assert live_session.read_file("out.txt") == "done\n"
    assert live_session.read_file("b.txt") == "beta"
    assert live_session.read_file("missing.txt") is None


@pytest.mark.docker
@_live
def test_live_box_files_can_be_written_while_a_command_runs(live_session: DockerSandboxSession) -> None:
    """A mailbox answer lands while the guest still waits for it."""
    waiter = threading.Thread(
        target=lambda: arrivals.append(
            live_session.run(
                "for i in $(seq 50); do test -f reply && break; sleep 0.2; done; cat reply", timeout_seconds=30
            )
        )
    )
    arrivals: list[Any] = []
    waiter.start()
    time.sleep(1)
    live_session.write_files({"reply": "answer"})
    waiter.join()
    assert arrivals[0].stdout == "answer"


@pytest.mark.docker
@_live
def test_live_box_has_no_network_and_a_read_only_root(live_session: DockerSandboxSession) -> None:
    """Show the isolation: outbound requests fail and only the workspace and /tmp are writable."""
    curl = live_session.run("curl -sS --max-time 5 https://example.com || exit 7", timeout_seconds=30)
    python = live_session.run(
        "python3 -c \"import urllib.request; urllib.request.urlopen('http://1.1.1.1', timeout=5)\"",
        timeout_seconds=30,
    )
    writes = live_session.run(
        "touch /workspace/ok /tmp/ok && ! touch /app/blocked 2>/dev/null && ! touch /etc/blocked 2>/dev/null",
        timeout_seconds=30,
    )
    identity = live_session.run("echo $HOME; cat /proc/self/status | grep CapEff", timeout_seconds=30)

    assert curl.exit_code != 0
    assert not python.ok
    assert writes.ok, writes.stderr
    assert identity.stdout.splitlines()[0] == "/workspace"
    assert identity.stdout.split()[-1] == "0000000000000000"


@pytest.mark.docker
@_live
def test_live_box_times_out_and_close_removes_the_container(live_session: DockerSandboxSession) -> None:
    """Kill a command at its timeout, and remove the container on close."""
    result = live_session.run("sleep 30", timeout_seconds=1)
    assert result.timed_out

    live_session.close()
    assert not _container_exists(live_session.container)


@pytest.mark.docker
@_live
def test_live_image_speaks_this_workers_protocol(live_session: DockerSandboxSession) -> None:
    """The DSPy image check passes against the locally built image."""
    _require_image_protocol(live_session, 300)


@pytest.mark.docker
@_live
def test_live_stop_job_sandboxes_sweeps_leftover_boxes() -> None:
    """Remove a box the run never closed, by its job label."""
    runtime = DockerSandboxRuntime(_LIVE_IMAGE)
    session = runtime.open(SandboxSpec(lifetime_seconds=120, tags={JOB_TAG: "sky113-sweep"}))
    assert isinstance(session, DockerSandboxSession)

    assert runtime.stop_job_sandboxes("sky113-sweep") == 1
    assert not _container_exists(session.container)
