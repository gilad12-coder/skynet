"""Tests for the Vercel sandbox runtime: command wrapping, teardown and availability."""

from __future__ import annotations

import contextvars
import logging
import threading
from typing import Any

import httpx
import pytest

from core.config import Settings
from core.exceptions import ServiceError

from .. import sandbox as sandbox_mod
from ..sandbox import (
    _CREDENTIALS_MISSING,
    _PACKAGE_MISSING,
    KILL_GRACE_SECONDS,
    SANDBOX_TAG,
    CommandResult,
    SandboxSpec,
    VercelCredentials,
    VercelSandboxRuntime,
    VercelSandboxSession,
    sandbox_runtime_from_settings,
    sandbox_unavailable_reason,
    unique_sandbox_name,
)

# The Vercel SDK is a declared dependency; skip the settings-availability
# tests on a build that vendored an older requirements file without it.
_SDK_PRESENT = sandbox_mod.vercel_sync is not None and sandbox_mod.vercel_api is not None
_needs_sdk = pytest.mark.skipif(not _SDK_PRESENT, reason="the Vercel Sandbox SDK is not installed")

_VERCEL_ENV = (
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
    "VERCEL_SANDBOX_IMAGE",
    "VERCEL_SANDBOX_MAX_LIFETIME_SECONDS",
    "BLACKBOX_AGENT_GATEWAY_URL",
    "BLACKBOX_AGENT_GATEWAY_API_KEY",
    "LITELLM_PROXY_URL",
    "LITELLM_PROXY_API_KEY",
)


def _settings(monkeypatch: pytest.MonkeyPatch, **values: Any) -> Settings:
    """Build a Settings with the sandbox env cleared, then the given overrides.

    Ignores the developer's ``.env`` file too, so a locally configured
    Vercel token cannot leak into the assertions.

    Args:
        monkeypatch: Pytest fixture.
        **values: Field overrides.

    Returns:
        The settings.
    """
    for name in _VERCEL_ENV:
        monkeypatch.delenv(name, raising=False)
    return Settings(_env_file=None, **values)


class _FakeReader:
    """One-shot text reader over a captured stream."""

    def __init__(self, text: str) -> None:
        """Hold the stream's full text."""
        self._text = text

    def read(self) -> str:
        """Return the whole stream."""
        return self._text


class _FakeProcess:
    """Fake detached SDK process that finishes after a set number of refreshes."""

    def __init__(self, returncode: int, stdout: str = "", stderr: str = "", polls_to_finish: int = 0) -> None:
        """Configure the outcome and how many refreshes it takes to appear."""
        self._final = returncode
        self._left = polls_to_finish
        self.returncode: int | None = returncode if polls_to_finish == 0 else None
        self.stdout = _FakeReader(stdout)
        self.stderr = _FakeReader(stderr)
        self.refreshes = 0
        self.killed = False

    def refresh(self) -> None:
        """Advance one poll, revealing the exit code once due."""
        self.refreshes += 1
        self._left -= 1
        if self._left <= 0 and not self.killed:
            self.returncode = self._final

    def kill(self) -> None:
        """Record the kill."""
        self.killed = True


class _FakeTime:
    """Deterministic stand-in for the sandbox module's ``time``."""

    def __init__(self, step: float = 0.0) -> None:
        """Start the clock at zero, advancing ``step`` per ``monotonic`` call."""
        self.now = 0.0
        self._step = step
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        """Return the current time, then advance it."""
        value = self.now
        self.now += self._step
        return value

    def sleep(self, seconds: float) -> None:
        """Record the requested delay without waiting."""
        self.sleeps.append(seconds)


class _FakeFs:
    """In-memory filesystem for a fake sandbox."""

    def __init__(self) -> None:
        """Start empty."""
        self.files: dict[str, str] = {}
        self.made: list[str] = []

    def mkdir(self, path: str, cwd: str | None = None, recursive: bool = False) -> None:
        """Record a created directory."""
        self.made.append(path)

    def write_text(self, path: str, text: str, cwd: str | None = None) -> None:
        """Store a file."""
        self.files[path] = text

    def exists(self, path: str, cwd: str | None = None) -> bool:
        """Report whether a file was stored."""
        return path in self.files

    def read_text(self, path: str, cwd: str | None = None) -> str:
        """Return a stored file."""
        return self.files[path]


class _FakeBox:
    """Fake managed sandbox handle."""

    def __init__(
        self, returncode: int = 0, stdout: str = "", stderr: str = "", polls_to_finish: int = 0
    ) -> None:
        """Configure the process result the box returns."""
        self.cwd = "/work"
        self.fs = _FakeFs()
        self.name = "box"
        self.runs: list[dict[str, Any]] = []
        self.exited = False
        self.process: _FakeProcess | None = None
        self._returncode = returncode
        self._stdout = stdout
        self._stderr = stderr
        self._polls_to_finish = polls_to_finish

    def create_process(
        self,
        program: str,
        args: list[str],
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        kill_after: float | None = None,
    ) -> _FakeProcess:
        """Record the invocation and hand back a detached fake process."""
        self.runs.append({"program": program, "args": args, "env": env, "kill_after": kill_after})
        self.process = _FakeProcess(self._returncode, self._stdout, self._stderr, self._polls_to_finish)
        return self.process

    def __exit__(self, *args: Any) -> None:
        """Mark the box destroyed."""
        self.exited = True


class _FakeApiSession:
    """Fake ``vercel.api.session`` context."""

    def __init__(self, *, fail_on_exit: bool = False) -> None:
        """Track lifecycle."""
        self.entered = False
        self.exited = False
        self._fail_on_exit = fail_on_exit

    def __enter__(self) -> _FakeApiSession:
        """Enter the context."""
        self.entered = True
        return self

    def __exit__(self, *args: Any) -> bool:
        """Leave the context, optionally raising."""
        self.exited = True
        if self._fail_on_exit:
            raise RuntimeError("api session teardown blew up")
        return False


_ACTIVE = contextvars.ContextVar("fake_vercel_active_session", default=None)


class _TokenApiSession(_FakeApiSession):
    """Fake session that binds and resets a real context variable, as the SDK does."""

    def __enter__(self) -> _TokenApiSession:
        """Bind the variable and remember the token."""
        self._token = _ACTIVE.set(self)
        super().__enter__()
        return self

    def __exit__(self, *args: Any) -> bool:
        """Reset the variable, which only works in the context that set it."""
        _ACTIVE.reset(self._token)
        return super().__exit__(*args)


def test_run_wraps_in_timeout_and_flags_timeouts() -> None:
    """A timed command is wrapped in ``timeout --signal=KILL`` and 124 reads as a timeout."""
    box = _FakeBox(returncode=124)
    session = VercelSandboxSession(box, _FakeApiSession(), contextvars.copy_context())

    result = session.run("sleep 99", timeout_seconds=5)

    assert box.runs[0]["args"][0] == "-lc"
    assert box.runs[0]["args"][1].startswith("timeout --signal=KILL 5s bash -lc ")
    assert box.runs[0]["kill_after"] == 5 + KILL_GRACE_SECONDS
    assert result.timed_out is True
    assert result.exit_code == 124


def test_run_without_timeout_is_not_wrapped() -> None:
    """A command with no timeout runs bare and a 124 exit is not called a timeout."""
    box = _FakeBox(returncode=124, stdout="hi")
    session = VercelSandboxSession(box, _FakeApiSession(), contextvars.copy_context())

    result = session.run("echo hi")

    assert box.runs[0]["args"] == ["-lc", "echo hi"]
    assert box.runs[0]["kill_after"] is None
    assert result.timed_out is False
    assert result.stdout == "hi"


def test_run_polls_a_slow_process_with_growing_delays(monkeypatch: pytest.MonkeyPatch) -> None:
    """A process that takes a while is watched with doubling sleeps, then its logs are read."""
    box = _FakeBox(returncode=0, stdout="out", stderr="err", polls_to_finish=3)
    session = VercelSandboxSession(box, _FakeApiSession(), contextvars.copy_context())
    clock = _FakeTime()
    monkeypatch.setattr(sandbox_mod, "time", clock)

    result = session.run("make things")

    assert box.process is not None
    assert box.process.refreshes == 3
    assert clock.sleeps == [1.0, 2.0, 4.0]
    assert result.exit_code == 0
    assert result.stdout == "out"
    assert result.stderr == "err"


def test_run_kills_a_process_that_outlives_its_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    """A process still running past kill_after plus slack is killed and reported as lost."""
    box = _FakeBox(returncode=0, polls_to_finish=10**9)
    session = VercelSandboxSession(box, _FakeApiSession(), contextvars.copy_context())
    monkeypatch.setattr(sandbox_mod, "time", _FakeTime(step=30.0))

    with pytest.raises(ServiceError, match="outlived"):
        session.run("sleep forever", timeout_seconds=5)

    assert box.process is not None
    assert box.process.killed is True


def test_write_files_creates_parents_and_read_file_round_trips() -> None:
    """Writing a nested path makes its parent; reading a missing path returns None."""
    box = _FakeBox()
    session = VercelSandboxSession(box, _FakeApiSession(), contextvars.copy_context())

    session.write_files({"a/b/c.txt": "content", "top.txt": "x"})

    assert box.fs.files["a/b/c.txt"] == "content"
    assert "a/b" in box.fs.made
    assert session.read_file("a/b/c.txt") == "content"
    assert session.read_file("missing.txt") is None


def test_close_destroys_the_box_and_never_raises() -> None:
    """Close exits the box and the API session even when teardown throws."""
    box = _FakeBox()
    api_session = _FakeApiSession(fail_on_exit=True)
    session = VercelSandboxSession(box, api_session, contextvars.copy_context())

    session.close()

    assert box.exited is True
    assert api_session.exited is True


class _FakeSync:
    """Fake ``vercel.sandbox.sync`` module."""

    def __init__(self, box: _FakeBox) -> None:
        """Hold the box to hand back and record calls."""
        self._box = box
        self.created: dict[str, Any] = {}
        self.credentials: dict[str, Any] = {}

    def SandboxServiceOptions(self, credentials_factory: Any) -> Any:  # noqa: N802 - SDK name
        """Capture the credentials factory and invoke it once."""
        self.credentials = credentials_factory()
        return "options"

    def SandboxCredentials(self, token: str, team_id: str, project_id: str) -> dict[str, str]:  # noqa: N802
        """Return the credentials as a dict."""
        return {"token": token, "team_id": team_id, "project_id": project_id}

    def create_sandbox(
        self,
        name: str | None,
        image: str | None,
        execution_time_limit: float,
        env: dict[str, str] | None,
        network_policy: Any,
        tags: dict[str, str],
    ) -> _FakeBox:
        """Record the sandbox request and return the box."""
        self.created = {
            "name": name,
            "image": image,
            "lifetime": execution_time_limit,
            "env": env,
            "network_policy": network_policy,
            "tags": tags,
        }
        return self._box


class _FakeApi:
    """Fake ``vercel.api`` module."""

    def __init__(self, session: _FakeApiSession) -> None:
        """Hold the session to hand back."""
        self._session = session
        self.service_options: Any = None
        self.httpx_client_factory: Any = None

    def session(self, service_options: Any = None, httpx_client_factory: Any = None) -> _FakeApiSession:
        """Return the fake session, recording the options and client factory."""
        self.service_options = service_options
        self.httpx_client_factory = httpx_client_factory
        return self._session


def test_runtime_open_creates_a_tagged_sandbox(monkeypatch: pytest.MonkeyPatch) -> None:
    """``open`` enters the API session and creates a sandbox merging the base tag."""
    box = _FakeBox()
    api_session = _FakeApiSession()
    fake_sync = _FakeSync(box)
    fake_api = _FakeApi(api_session)
    monkeypatch.setattr(sandbox_mod, "vercel_sync", fake_sync)
    monkeypatch.setattr(sandbox_mod, "vercel_api", fake_api)
    runtime = VercelSandboxRuntime(VercelCredentials(token="t", team_id="team", project_id="proj"), image="img")

    session = runtime.open(SandboxSpec(lifetime_seconds=630, env={"K": "v"}, name="job-1", tags={"skynet_job": "1"}))

    client = fake_api.httpx_client_factory()
    assert isinstance(client, httpx.Client)
    assert client.timeout.read == 630
    assert client.timeout.connect == 60.0
    client.close()
    assert api_session.entered is True
    assert fake_sync.created["lifetime"] == 630
    assert fake_sync.created["env"] == {"K": "v"}
    assert fake_sync.created["name"] == "job-1"
    assert fake_sync.created["tags"] == {**SANDBOX_TAG, "skynet_job": "1"}
    assert fake_sync.created["image"] == "img"
    assert fake_sync.created["network_policy"] is None
    assert fake_sync.credentials == {"token": "t", "team_id": "team", "project_id": "proj"}
    assert isinstance(session, VercelSandboxSession)


@_needs_sdk
def test_runtime_open_pins_the_spec_image_and_injects_headers_at_the_edge(monkeypatch: pytest.MonkeyPatch) -> None:
    """A spec's image wins over the runtime's, and header injection is a custom policy that still allows every host."""
    fake_sync = _FakeSync(_FakeBox())
    monkeypatch.setattr(sandbox_mod, "vercel_sync", fake_sync)
    monkeypatch.setattr(sandbox_mod, "vercel_api", _FakeApi(_FakeApiSession()))
    runtime = VercelSandboxRuntime(VercelCredentials(token="t", team_id="team", project_id="proj"), image="img")

    assert runtime.injects_headers is True
    runtime.open(
        SandboxSpec(lifetime_seconds=1, image="custom", inject_headers={"gw.example": {"Authorization": "Bearer k"}})
    )

    assert fake_sync.created["image"] == "custom"
    policy = fake_sync.created["network_policy"]
    assert policy.mode == "custom"
    assert list(policy.allow["*"]) == []
    [rule] = policy.allow["gw.example"]
    [transform] = rule.transform
    assert transform.headers == {"Authorization": "Bearer k"}


def test_runtime_open_closes_the_api_session_when_creation_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """A create failure leaves the API session and re-raises."""
    api_session = _FakeApiSession()

    class _BrokenSync(_FakeSync):
        """Sync whose create fails."""

        def create_sandbox(self, *args: Any, **kwargs: Any) -> _FakeBox:
            """Fail like the SDK rejecting the request."""
            raise RuntimeError("no capacity")

    monkeypatch.setattr(sandbox_mod, "vercel_sync", _BrokenSync(_FakeBox()))
    monkeypatch.setattr(sandbox_mod, "vercel_api", _FakeApi(api_session))
    runtime = VercelSandboxRuntime(VercelCredentials(token="t", team_id="team", project_id="proj"), image="img")

    with pytest.raises(RuntimeError, match="no capacity"):
        runtime.open(SandboxSpec(lifetime_seconds=10))
    assert api_session.exited is True


def test_runtime_open_keeps_the_api_session_in_a_private_context(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A box opened on a worker thread closes cleanly from another thread, and the worker's context stays clean."""
    api_session = _TokenApiSession()
    monkeypatch.setattr(sandbox_mod, "vercel_sync", _FakeSync(_FakeBox()))
    monkeypatch.setattr(sandbox_mod, "vercel_api", _FakeApi(api_session))
    runtime = VercelSandboxRuntime(VercelCredentials(token="t", team_id="team", project_id="proj"), image="img")
    opened: dict[str, Any] = {}

    def open_box() -> None:
        """Open the box and note what the worker sees bound afterwards."""
        opened["session"] = runtime.open(SandboxSpec(lifetime_seconds=10))
        opened["active_after_open"] = _ACTIVE.get()

    worker = threading.Thread(target=open_box)
    worker.start()
    worker.join()

    assert api_session.entered is True
    assert opened["active_after_open"] is None
    with caplog.at_level(logging.ERROR, logger=sandbox_mod.logger.name):
        opened["session"].close()
    assert api_session.exited is True
    assert caplog.records == []


def test_unique_sandbox_name_sanitizes_the_stem_and_keeps_the_suffix_under_the_cap() -> None:
    """The stem is lower-cased and reduced to ``[a-z0-9-]``; a long stem is trimmed, the suffix never."""
    name = unique_sandbox_name("Skynet_Job.1")

    assert name.startswith("skynet-job-1-")
    assert len(name) == len("skynet-job-1-") + 8

    long = unique_sandbox_name("skynet-" + "x" * 80)

    assert len(long) == 60
    assert long[:51] == ("skynet-" + "x" * 80)[:51]
    assert long[51] == "-"
    assert len(long[52:]) == 8


def test_unique_sandbox_name_differs_per_call() -> None:
    """Two boxes for one job never share a name, so parallel opens cannot collide on Vercel."""
    assert unique_sandbox_name("skynet-job-1") != unique_sandbox_name("skynet-job-1")


def test_runtime_construction_needs_the_sdk(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without the SDK, constructing the runtime is a typed error."""
    monkeypatch.setattr(sandbox_mod, "vercel_sync", None)
    monkeypatch.setattr(sandbox_mod, "vercel_api", None)

    with pytest.raises(ServiceError, match=_PACKAGE_MISSING):
        VercelSandboxRuntime(VercelCredentials(token="t", team_id="x", project_id="y"), image="img")


def test_unavailable_reason_reports_missing_package(monkeypatch: pytest.MonkeyPatch) -> None:
    """No SDK is reported before missing credentials."""
    monkeypatch.setattr(sandbox_mod, "vercel_sync", None)
    monkeypatch.setattr(sandbox_mod, "vercel_api", None)

    assert sandbox_unavailable_reason(_settings(monkeypatch, vercel_token="t")) == _PACKAGE_MISSING


@_needs_sdk
def test_unavailable_reason_reports_missing_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    """With the SDK present but no credentials, the reason names the env vars."""
    assert sandbox_unavailable_reason(_settings(monkeypatch)) == _CREDENTIALS_MISSING


@_needs_sdk
def test_configured_settings_yield_a_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    """Full credentials leave no reason and build a runtime; missing ones give None."""
    configured = _settings(monkeypatch, vercel_token="t", vercel_team_id="team", vercel_project_id="proj")

    assert sandbox_unavailable_reason(configured) is None
    assert isinstance(sandbox_runtime_from_settings(configured), VercelSandboxRuntime)
    assert sandbox_runtime_from_settings(_settings(monkeypatch)) is None


@_needs_sdk
def test_configured_settings_pick_the_sandbox_image(monkeypatch: pytest.MonkeyPatch) -> None:
    """Boxes boot from ``VERCEL_SANDBOX_IMAGE``, a current python image by default."""
    fake_sync = _FakeSync(_FakeBox())
    monkeypatch.setattr(sandbox_mod, "vercel_sync", fake_sync)
    monkeypatch.setattr(sandbox_mod, "vercel_api", _FakeApi(_FakeApiSession()))
    creds = {"vercel_token": "t", "vercel_team_id": "team", "vercel_project_id": "proj"}

    for image, expected in ((None, "vercel/sandbox/universal:latest"), ("my/img:1", "my/img:1")):
        overrides = {"vercel_sandbox_image": image} if image else {}
        runtime = sandbox_runtime_from_settings(_settings(monkeypatch, **creds, **overrides))
        assert runtime is not None
        runtime.open(SandboxSpec(lifetime_seconds=1))
        assert fake_sync.created["image"] == expected


def test_command_result_ok() -> None:
    """``ok`` is exit code zero."""
    assert CommandResult(exit_code=0).ok is True
    assert CommandResult(exit_code=1).ok is False
