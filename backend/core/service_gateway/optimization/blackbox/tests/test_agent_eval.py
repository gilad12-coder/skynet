"""Tests for agent-target scoring: path safety, case rendering, the sandbox run and gateway resolution."""

from __future__ import annotations

from typing import Any

import pytest

from core.config import Settings
from core.exceptions import ServiceError
from core.models.blackbox import BLACKBOX_HARNESS_CUSTOM, BLACKBOX_TARGET_AGENT, BlackboxTarget

from .. import agent_eval as agent_eval_mod
from ..agent_eval import (
    _GATEWAY_MISSING,
    SandboxAgentScorer,
    agent_target_unavailable_reason,
    candidate_files,
    case_files,
    case_prompt,
    gateway_from_settings,
    safe_relative_path,
)
from ..harness import ANSWER_FILE, PROMPT_FILE, GatewayConfig
from ..sandbox import CommandResult
from .mocks import FakeSandboxRuntime, FakeSandboxSession

_GATEWAY = GatewayConfig(url="https://gw.example/v1", api_key="secret-key")


def _target(**overrides: Any) -> BlackboxTarget:
    """Build a custom agent target that runs ``run-agent``.

    Args:
        **overrides: Field overrides.

    Returns:
        The target.
    """
    fields: dict[str, Any] = {
        "kind": BLACKBOX_TARGET_AGENT,
        "harness": BLACKBOX_HARNESS_CUSTOM,
        "model": "m",
        "run_command": "run-agent",
    }
    fields.update(overrides)
    return BlackboxTarget(**fields)


def _scorer_of(
    runtime: FakeSandboxRuntime, target: BlackboxTarget, scorer: Any = None, *, job_id: str | None = "job-1"
):
    """Wrap ``scorer`` in a :class:`SandboxAgentScorer` over ``runtime``.

    Args:
        runtime: The fake sandbox runtime.
        target: The agent target.
        scorer: The user's scorer; a constant one when unset.
        job_id: Job id for tagging.

    Returns:
        The wrapped scorer.
    """
    scorer = scorer or (lambda candidate, case: (0.0, {}))
    return SandboxAgentScorer(scorer, runtime=runtime, target=target, gateway=_GATEWAY, job_id=job_id)


def _runtime_of(session: FakeSandboxSession) -> FakeSandboxRuntime:
    """Return a runtime that always opens ``session``.

    Args:
        session: The session to hand out.

    Returns:
        The runtime.
    """
    return FakeSandboxRuntime(session_factory=lambda: session)


def test_safe_relative_path_normalizes_and_rejects_escapes() -> None:
    """Relative paths are normalized; anything that could escape the workspace is refused."""
    assert safe_relative_path("./a/b") == "a/b"
    assert safe_relative_path("a/./b/") == "a/b"
    assert safe_relative_path("a/c/../d") == "a/d"

    for bad in ("/etc/passwd", "..", "../x", "a/../../x", ".", "", "   ", 123, None):
        with pytest.raises(ServiceError):
            safe_relative_path(bad)


def test_candidate_files_maps_text_and_named_parts() -> None:
    """A text version becomes the instructions file; a dict version becomes its safe parts."""
    assert candidate_files("hello", "AGENTS.md") == {"AGENTS.md": "hello"}
    assert candidate_files({"./AGENTS.md": "x", "docs/y.md": "y"}, "AGENTS.md") == {"AGENTS.md": "x", "docs/y.md": "y"}

    with pytest.raises(ServiceError):
        candidate_files({"../escape": "x"}, "AGENTS.md")


def test_case_files_only_from_a_files_mapping() -> None:
    """Only a dict case with a ``files`` mapping contributes files, stringifying contents."""
    assert case_files("a string") == {}
    assert case_files({"prompt": "hi"}) == {}
    assert case_files({"files": {"a.txt": 5}}) == {"a.txt": "5"}

    with pytest.raises(ServiceError, match="must map relative paths"):
        case_files({"files": ["not", "a", "map"]})


def test_case_prompt_prefers_task_keys_then_json_then_default() -> None:
    """The task text comes from the first prompt key, else the case as JSON, else a default."""
    assert case_prompt({"task": "T", "prompt": "P"}).startswith("P")
    assert case_prompt({"prompt": "   ", "task": "real"}).startswith("real")

    rendered = case_prompt({"foo": "bar", "files": {"a": "b"}, "check_command": "c"})
    assert '"foo": "bar"' in rendered
    assert "check_command" not in rendered
    assert "files" not in rendered.split("---")[0]

    assert case_prompt(None).startswith("Follow the instructions you were given.")
    assert case_prompt("just do it").startswith("just do it")


def test_case_prompt_appends_the_answer_file_instruction() -> None:
    """Every rendered prompt tells the agent where to write its scored answer."""
    rendered = case_prompt({"prompt": "go"})
    assert ANSWER_FILE in rendered
    assert rendered.rstrip().endswith("Only that file is scored.")


def test_run_writes_the_version_and_case_then_records_a_clean_run() -> None:
    """A clean run writes files, runs the agent, prefers the answer file and closes the box."""
    runtime = FakeSandboxRuntime()
    scorer = _scorer_of(runtime, _target())

    record = scorer.run("AGENTS instructions", {"prompt": "do the thing"})

    session = runtime.sessions[0]
    assert session.files["AGENTS.md"] == "AGENTS instructions"
    assert session.files[PROMPT_FILE].startswith("do the thing")
    assert session.commands == ["run-agent"]
    assert session.closed is True
    assert record["output"] == "done"
    assert record["exit_code"] == 0
    assert record["timed_out"] is False
    assert record["error"] is None


def test_run_builds_a_tagged_named_spec_within_the_lifetime_ceiling() -> None:
    """The sandbox spec carries the lifetime, harness env, job name and job tag."""
    runtime = FakeSandboxRuntime()
    scorer = _scorer_of(runtime, _target(timeout_seconds=600), job_id="job-1")

    scorer.run("v", {"prompt": "p"})

    spec = runtime.specs[0]
    assert spec.lifetime_seconds == 1200
    assert spec.env["SKYNET_MODEL"] == "m"
    assert spec.name == "skynet-job-1"
    assert spec.tags == {"skynet_job": "job-1"}


def test_run_falls_back_to_parsed_stdout_when_no_answer_file() -> None:
    """With no answer file the parsed stdout is the output."""
    session = FakeSandboxSession(script=lambda command: CommandResult(exit_code=0, stdout="parsed answer"))
    scorer = _scorer_of(_runtime_of(session), _target())

    record = scorer.run("v", {"prompt": "p"})

    assert record["output"] == "parsed answer"
    assert record["error"] is None


def test_run_reports_when_the_agent_produces_no_answer() -> None:
    """No answer file and empty stdout is a no-answer error."""
    session = FakeSandboxSession(script=lambda command: CommandResult(exit_code=0, stdout=""))
    scorer = _scorer_of(_runtime_of(session), _target())

    record = scorer.run("v", {"prompt": "p"})

    assert record["output"] is None
    assert record["error"] == "agent produced no answer"


def test_run_reports_a_timeout() -> None:
    """A timed-out run is flagged with the run timeout in the error."""
    session = FakeSandboxSession(script=lambda command: CommandResult(exit_code=124, timed_out=True))
    scorer = _scorer_of(_runtime_of(session), _target(timeout_seconds=600))

    record = scorer.run("v", {"prompt": "p"})

    assert record["timed_out"] is True
    assert record["error"] == "agent timed out after 600s"


def test_run_reports_a_nonzero_exit() -> None:
    """A non-zero exit that did not time out is reported with the code."""
    session = FakeSandboxSession(script=lambda command: CommandResult(exit_code=3, stdout=""))
    scorer = _scorer_of(_runtime_of(session), _target())

    record = scorer.run("v", {"prompt": "p"})

    assert record["error"] == "agent exited with code 3"


def test_install_failure_short_circuits_the_run() -> None:
    """A failed install stops before the agent runs."""

    def script(command: str) -> CommandResult:
        return CommandResult(exit_code=1, stdout="boom") if command == "install-me" else CommandResult(exit_code=0)

    session = FakeSandboxSession(script=script)
    scorer = _scorer_of(_runtime_of(session), _target(install_command="install-me"))

    record = scorer.run("v", {"prompt": "p"})

    assert session.commands == ["install-me"]
    assert record["error"] == "install command failed (exit 1)"
    assert record["output"] is None


def test_setup_failure_short_circuits_the_run() -> None:
    """A failed case setup stops before the agent runs."""

    def script(command: str) -> CommandResult:
        return CommandResult(exit_code=2, stdout="nope") if command == "setup-me" else CommandResult(exit_code=0)

    session = FakeSandboxSession(script=script)
    scorer = _scorer_of(_runtime_of(session), _target(setup_command="setup-me"))

    record = scorer.run("v", {"prompt": "p"})

    assert session.commands == ["setup-me"]
    assert record["error"] == "setup command failed (exit 2)"


def test_check_command_is_recorded() -> None:
    """A case check runs after the agent and its outcome lands in the record."""

    def script(command: str) -> CommandResult:
        return CommandResult(exit_code=0, stdout="checked ok") if command == "verify" else CommandResult(exit_code=0)

    session = FakeSandboxSession(script=script, produces={"run-agent": {ANSWER_FILE: "answer"}})
    scorer = _scorer_of(_runtime_of(session), _target())

    record = scorer.run("v", {"prompt": "p", "check_command": "verify"})

    assert "verify" in session.commands
    assert record["check"] == {"passed": True, "exit_code": 0, "output": "checked ok"}


def test_unsafe_candidate_path_raises_before_opening_a_sandbox() -> None:
    """An unsafe version path fails before any box is created."""
    runtime = FakeSandboxRuntime()
    scorer = _scorer_of(runtime, _target())

    with pytest.raises(ServiceError):
        scorer.run({"../escape": "x"}, {"prompt": "p"})
    assert runtime.sessions == []


def test_call_scores_the_record_and_merges_feedback() -> None:
    """The wrapped scorer sees the run record and the feedback is merged into its side info."""
    seen: dict[str, Any] = {}

    def scorer_fn(candidate: Any, record: Any) -> tuple[float, dict[str, Any]]:
        seen["record"] = record
        return 0.5, {"note": "x"}

    runtime = FakeSandboxRuntime()
    scorer = _scorer_of(runtime, _target(), scorer_fn)

    score, side_info = scorer("version-text", {"prompt": "p"})

    assert score == 0.5
    assert side_info["note"] == "x"
    assert side_info["agent_output"] == "done"
    assert set(side_info) >= {"note", "agent_output", "transcript_tail", "exit_code", "elapsed_seconds", "usage"}
    assert seen["record"]["case"] == {"prompt": "p"}
    assert seen["record"]["output"] == "done"


def test_feedback_clips_output_and_tails_transcript() -> None:
    """Feedback bounds the output and transcript and carries any error and check."""
    record = {
        "output": "a" * 3000,
        "transcript": "b" * 2000,
        "exit_code": 0,
        "elapsed_seconds": 1.0,
        "usage": {"input_tokens": 1},
        "error": "boom",
        "check": {"passed": False},
    }

    feedback = SandboxAgentScorer.feedback(record)

    assert feedback["agent_output"] == "a" * 2000 + "…"
    assert feedback["transcript_tail"] == "…" + "b" * 1500
    assert feedback["error"] == "boom"
    assert feedback["check"] == {"passed": False}


def _gateway_settings(**values: Any) -> Settings:
    """Build settings with every gateway field cleared, then the given overrides.

    Init kwargs outrank the dotenv file, so this ignores any ambient LiteLLM config.

    Args:
        **values: Field overrides.

    Returns:
        The settings.
    """
    fields: dict[str, Any] = {
        "blackbox_agent_gateway_url": None,
        "blackbox_agent_gateway_api_key": None,
        "litellm_proxy_url": None,
        "litellm_proxy_api_key": None,
    }
    fields.update(values)
    return Settings(**fields)


def test_gateway_from_settings_prefers_the_dedicated_gateway() -> None:
    """The dedicated agent-gateway settings win over the LiteLLM fallback and lose the trailing slash."""
    settings = _gateway_settings(
        blackbox_agent_gateway_url="https://dedicated/",
        blackbox_agent_gateway_api_key="dk",
        litellm_proxy_url="https://litellm",
        litellm_proxy_api_key="lk",
    )

    gateway = gateway_from_settings(settings)

    assert gateway == GatewayConfig(url="https://dedicated", api_key="dk")


def test_gateway_from_settings_falls_back_to_litellm() -> None:
    """When the dedicated gateway is unset, the LiteLLM proxy is used."""
    settings = _gateway_settings(litellm_proxy_url="https://litellm/", litellm_proxy_api_key="lk")

    assert gateway_from_settings(settings) == GatewayConfig(url="https://litellm", api_key="lk")


def test_gateway_from_settings_is_none_without_a_url_or_key() -> None:
    """A missing URL or key yields no gateway."""
    assert gateway_from_settings(_gateway_settings()) is None
    assert gateway_from_settings(_gateway_settings(blackbox_agent_gateway_url="https://x")) is None
    assert gateway_from_settings(_gateway_settings(blackbox_agent_gateway_api_key="k")) is None


def test_agent_target_unavailable_reason_orders_sandbox_before_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing sandbox is reported first; then a missing gateway; then nothing."""
    monkeypatch.setattr(agent_eval_mod, "sandbox_unavailable_reason", lambda settings: "no sandbox")
    assert agent_target_unavailable_reason(_gateway_settings()) == "no sandbox"

    monkeypatch.setattr(agent_eval_mod, "sandbox_unavailable_reason", lambda settings: None)
    assert agent_target_unavailable_reason(_gateway_settings()) == _GATEWAY_MISSING

    configured = _gateway_settings(blackbox_agent_gateway_url="https://x", blackbox_agent_gateway_api_key="k")
    assert agent_target_unavailable_reason(configured) is None
