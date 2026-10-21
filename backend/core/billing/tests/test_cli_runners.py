"""Tests for the claude and codex subscription runners, run against fake CLI scripts."""

from __future__ import annotations

import json
import os
import stat
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from core.billing import cli_runners
from core.billing.cli_runners import CliRunError, SubscriptionRateLimitedError, parse_reset_at
from core.config import Settings, settings

# Sanitized from real CLI runs (claude 2.1.306, codex-cli 0.163.0).
CLAUDE_SUCCESS = {
    "type": "result",
    "subtype": "success",
    "is_error": False,
    "duration_ms": 1351,
    "duration_api_ms": 1326,
    "num_turns": 1,
    "result": "pong",
    "stop_reason": "end_turn",
    "total_cost_usd": 0.00046369000000000005,
    "terminal_reason": "completed",
    "usage": {
        "input_tokens": 2,
        "cache_creation_input_tokens": 2275,
        "cache_read_input_tokens": 649,
        "output_tokens": 4,
    },
}
CODEX_EVENTS = [
    {"type": "thread.started", "thread_id": "thread-fixture"},
    {"type": "item.completed", "item": {"id": "item_0", "type": "error", "message": "hook trust warning"}},
    {"type": "turn.started"},
    {"type": "item.completed", "item": {"id": "item_3", "type": "agent_message", "text": "pong"}},
    {
        "type": "turn.completed",
        "usage": {
            "input_tokens": 29250,
            "cached_input_tokens": 13184,
            "cache_write_input_tokens": 0,
            "output_tokens": 43,
            "reasoning_output_tokens": 36,
        },
    },
]
API_KEYS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY")


def fake_cli(directory: Path, name: str, behavior: str) -> Path:
    """Write an executable fake CLI that logs each call, then runs ``behavior``.

    The script appends ``{argv, env, stdin, cwd}`` to ``<directory>/<name>.log``
    as one JSON line. ``behavior`` is Python that may read ``argv`` and ``stdin``.

    Args:
        directory: Where the script and its log go.
        name: The script name.
        behavior: Python statements that write the CLI's output and exit.

    Returns:
        The script path.
    """
    log = directory / f"{name}.log"
    script = directory / name
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys, time\n"
        "argv = sys.argv[1:]\n"
        "stdin = sys.stdin.read()\n"
        f"with open({str(log)!r}, 'a') as handle:\n"
        "    handle.write(json.dumps({'argv': argv, 'env': dict(os.environ), 'stdin': stdin, 'cwd': os.getcwd()}) + '\\n')\n"
        f"{behavior}\n",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script


def calls(directory: Path, name: str) -> list[dict[str, Any]]:
    """Return the calls a fake CLI logged.

    Args:
        directory: The fake CLI's directory.
        name: The script name.

    Returns:
        One record per call, oldest first.
    """
    log = directory / f"{name}.log"
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def printing(value: Any) -> str:
    """Return fake-CLI behavior that prints ``value`` as one JSON line."""
    return f"print(json.dumps({value!r}))"


def local_settings(tmp_path: Path, **overrides: Any) -> Settings:
    """Return local-mode settings whose CLIs are fake scripts in ``tmp_path``.

    Args:
        tmp_path: The test's directory.
        **overrides: More settings fields.

    Returns:
        A settings copy.
    """
    return settings.model_copy(
        update={
            "local_mode": True,
            "local_state_dir": str(tmp_path / "state"),
            "claude_bin": str(tmp_path / "claude"),
            "codex_bin": str(tmp_path / "codex"),
            "cli_fallback_order": "",
            "cli_max_concurrency": 2,
            "cli_call_timeout_seconds": 30.0,
            **overrides,
        }
    )


@pytest.fixture(autouse=True)
def _parent_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    """Put provider keys in the parent environment, as a developer shell might."""
    for key in API_KEYS:
        monkeypatch.setenv(key, "parent-secret")


def test_claude_uses_the_subscription_and_reads_usage(tmp_path: Path) -> None:
    """Send the prompt on stdin with isolation flags and no keys, and read the real result shape."""
    fake_cli(tmp_path, "claude", printing(CLAUDE_SUCCESS))
    completion = cli_runners.run_claude("claude-haiku-4-5", "ping", None, local_settings(tmp_path), tmp_path)
    assert completion.text == "pong"
    assert completion.prompt_tokens == 2 + 2275 + 649
    assert completion.completion_tokens == 4
    assert completion.model_ms == 1326
    [call] = calls(tmp_path, "claude")
    assert "--bare" not in call["argv"]
    assert call["argv"][:3] == ["-p", "--output-format", "json"]
    assert call["argv"][call["argv"].index("--model") + 1] == "claude-haiku-4-5"
    for flag in ("--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"):
        assert flag in call["argv"]
    assert call["stdin"] == "ping"
    assert not set(API_KEYS) & set(call["env"])


def test_claude_prefers_structured_output_for_a_schema(tmp_path: Path) -> None:
    """Pass the schema flag and answer with the structured value."""
    fake_cli(tmp_path, "claude", printing({**CLAUDE_SUCCESS, "result": "", "structured_output": {"answer": 1}}))
    schema = {"type": "object", "properties": {"answer": {"type": "integer"}}}
    completion = cli_runners.run_claude("claude-haiku-4-5", "q", schema, local_settings(tmp_path), tmp_path)
    assert json.loads(completion.text) == {"answer": 1}
    [call] = calls(tmp_path, "claude")
    assert json.loads(call["argv"][call["argv"].index("--json-schema") + 1]) == schema


def test_claude_limit_result_is_a_rate_limit_with_its_reset(tmp_path: Path) -> None:
    """Turn an error result about the usage limit into a cap with a parsed reset time."""
    message = "Claude AI usage limit reached|1893456000"
    fake_cli(tmp_path, "claude", printing({**CLAUDE_SUCCESS, "is_error": True, "result": message}) + "\nsys.exit(1)")
    with pytest.raises(SubscriptionRateLimitedError) as caught:
        cli_runners.run_claude("claude-haiku-4-5", "ping", None, local_settings(tmp_path), tmp_path)
    assert caught.value.provider == "claude"
    assert caught.value.reset_at == datetime.fromtimestamp(1893456000, UTC)


def test_codex_reads_the_event_stream(tmp_path: Path) -> None:
    """Read the last agent message and turn usage, in a read-only sandbox, with the prompt on stdin."""
    events = "\n".join(json.dumps(event) for event in CODEX_EVENTS)
    fake_cli(tmp_path, "codex", f"print({events!r})")
    schema = {"type": "object"}
    completion = cli_runners.run_codex("gpt-5.6-luna", "ping", schema, local_settings(tmp_path), tmp_path)
    assert completion.text == "pong"
    assert (completion.prompt_tokens, completion.completion_tokens) == (29250, 43)
    assert completion.model_ms is not None
    [call] = calls(tmp_path, "codex")
    assert call["argv"][:5] == ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check"]
    for feature in ("shell_tool", "unified_exec", "code_mode_host", "view_image"):
        assert call["argv"][call["argv"].index(feature) - 1] == "--disable"
    assert 'web_search="disabled"' in call["argv"]
    assert call["argv"][-1] == "-"
    assert "--output-schema" in call["argv"]
    assert call["stdin"] == "ping"
    assert not set(API_KEYS) & set(call["env"])


def test_codex_runs_in_private_homes_and_keeps_a_refreshed_login(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Give codex a temporary HOME and CODEX_HOME with a login copy, and keep a login it refreshed."""
    user_home = tmp_path / "user"
    (user_home / ".codex").mkdir(parents=True)
    (user_home / ".codex" / "auth.json").write_text("old-login", encoding="utf-8")
    (user_home / ".codex" / "AGENTS.md").write_text("personal instructions", encoding="utf-8")
    monkeypatch.setenv("HOME", str(user_home))
    monkeypatch.delenv("CODEX_HOME")
    events = "\n".join(json.dumps(event) for event in CODEX_EVENTS)
    fake_cli(
        tmp_path,
        "codex",
        "auth = os.path.join(os.environ['CODEX_HOME'], 'auth.json')\n"
        "assert open(auth).read() == 'old-login'\n"
        "assert sorted(os.listdir(os.environ['CODEX_HOME'])) == ['auth.json']\n"
        "open(auth, 'w').write('new-login')\n"
        f"print({events!r})",
    )
    completion = cli_runners.run_codex("gpt-5.6-luna", "ping", None, local_settings(tmp_path), tmp_path)
    assert completion.text == "pong"
    [call] = calls(tmp_path, "codex")
    assert call["env"]["HOME"] != str(user_home)
    assert call["env"]["CODEX_HOME"] != str(user_home / ".codex")
    for flag in ("--ignore-user-config", "--ignore-rules", "--ephemeral", "mcp_servers={}"):
        assert flag in call["argv"]
    assert (user_home / ".codex" / "auth.json").read_text(encoding="utf-8") == "new-login"
    assert stat.S_IMODE((user_home / ".codex" / "auth.json").stat().st_mode) == 0o600
    assert not Path(call["env"]["CODEX_HOME"]).exists()


def test_claude_keeps_the_real_home_for_its_keychain_login(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep claude's real HOME, because its Keychain login works only from its own config folder."""
    user_home = tmp_path / "user"
    user_home.mkdir()
    monkeypatch.setenv("HOME", str(user_home))
    fake_cli(tmp_path, "claude", printing(CLAUDE_SUCCESS))
    cli_runners.run_claude("claude-haiku-4-5", "ping", None, local_settings(tmp_path), tmp_path)
    [call] = calls(tmp_path, "claude")
    assert call["env"]["HOME"] == str(user_home)
    assert call["argv"][call["argv"].index("--setting-sources") + 1] == ""


def test_codex_failed_turn_with_a_limit_is_a_rate_limit(tmp_path: Path) -> None:
    """Report a capped codex turn as a cap, not as a failed call."""
    failed = {
        "type": "turn.failed",
        "error": {"message": "You've hit your usage limit. Try again at 2030-01-01T00:00:00Z."},
    }
    fake_cli(tmp_path, "codex", printing(failed) + "\nsys.exit(1)")
    with pytest.raises(SubscriptionRateLimitedError) as caught:
        cli_runners.run_codex("gpt-5.6-luna", "ping", None, local_settings(tmp_path), tmp_path)
    assert caught.value.reset_at == datetime(2030, 1, 1, tzinfo=UTC)


def test_only_claude_and_codex_have_runners() -> None:
    """Keep droid out: it cannot run without the user's hooks, MCP servers, config or rules."""
    assert set(cli_runners.RUNNERS) == {"claude", "codex"}


def test_missing_binary_is_a_final_failure(tmp_path: Path) -> None:
    """Report a CLI that is not installed as a failure no retry can fix."""
    with pytest.raises(CliRunError) as caught:
        cli_runners.run_claude("claude-haiku-4-5", "ping", None, local_settings(tmp_path), tmp_path)
    assert not caught.value.transient


def test_overloaded_failure_is_transient(tmp_path: Path) -> None:
    """Mark an overloaded provider as a failure a retry can fix."""
    fake_cli(tmp_path, "claude", "sys.stderr.write('API Error: 529 overloaded')\nsys.exit(1)")
    with pytest.raises(CliRunError) as caught:
        cli_runners.run_claude("claude-haiku-4-5", "ping", None, local_settings(tmp_path), tmp_path)
    assert caught.value.transient


def test_timeout_is_final(tmp_path: Path) -> None:
    """Stop a CLI at the call timeout, and do not mark it for a retry: it would hang again."""
    fake_cli(tmp_path, "claude", "time.sleep(10)")
    with pytest.raises(CliRunError) as caught:
        cli_runners.run_claude(
            "claude-haiku-4-5", "ping", None, local_settings(tmp_path, cli_call_timeout_seconds=0.5), tmp_path
        )
    assert not caught.value.transient


def _gone(pid: int) -> bool:
    """Wait up to three seconds for a process to stop, and say whether it did."""
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False


@pytest.mark.parametrize(("name", "runner"), [("claude", cli_runners.run_claude), ("codex", cli_runners.run_codex)])
def test_timeout_stops_the_child_of_a_wrapper(tmp_path: Path, name: str, runner: Any) -> None:
    """Stop a wrapper's child at the timeout too, though it keeps the output pipe open."""
    pid_file = tmp_path / "child.pid"
    fake_cli(
        tmp_path,
        name,
        "import subprocess\n"
        "child = subprocess.Popen(['sleep', '30'])\n"
        f"open({str(pid_file)!r}, 'w').write(str(child.pid))\n"
        "child.wait()",
    )
    started = time.monotonic()
    with pytest.raises(CliRunError) as caught:
        runner("m", "ping", None, local_settings(tmp_path, cli_call_timeout_seconds=3.0), tmp_path)
    # The timeout, the kill grace, and slack for a loaded test machine; the child sleeps 30 s.
    assert time.monotonic() - started < 10
    assert caught.value.message == f"{name} timed out"
    assert _gone(int(pid_file.read_text()))


@pytest.mark.parametrize(("name", "runner"), [("claude", cli_runners.run_claude), ("codex", cli_runners.run_codex)])
def test_early_exit_with_a_long_prompt_keeps_the_cli_reason(tmp_path: Path, name: str, runner: Any) -> None:
    """Report a CLI that exits before it reads a long prompt as a failed call with its stderr."""
    script = tmp_path / name
    script.write_text(f"#!{sys.executable}\nimport sys\nsys.stderr.write('not logged in')\nsys.exit(1)\n")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    with pytest.raises(CliRunError) as caught:
        runner("m", "x" * 300_000, None, local_settings(tmp_path), tmp_path)
    assert "not logged in" in caught.value.message


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("usage limit reached|1893456000", datetime.fromtimestamp(1893456000, UTC)),
        ("limit reached, resets 2030-01-02T03:04:05+00:00", datetime(2030, 1, 2, 3, 4, 5, tzinfo=UTC)),
        ("no reset time here", None),
    ],
)
def test_parse_reset_at_reads_epoch_and_iso_stamps(text: str, expected: datetime | None) -> None:
    """Read the reset time from the forms the CLIs print."""
    assert parse_reset_at(text) == expected


def test_parse_reset_at_reads_a_clock_time_as_the_next_one() -> None:
    """Read ``resets 3pm`` as the next 3pm on this machine's clock."""
    now = datetime(2030, 1, 1, 12, 0, tzinfo=UTC)
    reset = parse_reset_at("You've hit your limit · resets 3pm", now=now)
    assert reset is not None
    assert now < reset <= now.replace(day=2, hour=12)
    assert reset.astimezone().hour == 15
