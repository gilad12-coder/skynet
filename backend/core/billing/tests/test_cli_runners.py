"""Tests for the claude, codex and droid subscription runners, run against fake CLI scripts."""

from __future__ import annotations

import json
import stat
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from core.billing import cli_runners
from core.billing.cli_runners import CliRunError, SubscriptionRateLimitedError, parse_reset_at
from core.config import Settings, settings

# Sanitized from real CLI runs (claude 2.1.306, codex-cli 0.163.0, droid 0.231.0).
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
DROID_SUCCESS = {
    "type": "result",
    "subtype": "success",
    "is_error": False,
    "duration_ms": 3344,
    "num_turns": 1,
    "result": "pong",
    "usage": {
        "input_tokens": 13423,
        "output_tokens": 5,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    },
}
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
            "droid_bin": str(tmp_path / "droid"),
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
    assert call["argv"][:6] == ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--model"]
    assert call["argv"][-1] == "-"
    assert "--output-schema" in call["argv"]
    assert call["stdin"] == "ping"
    assert not set(API_KEYS) & set(call["env"])


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


def test_droid_reads_the_prompt_file_and_result(tmp_path: Path) -> None:
    """Pass the prompt as a file without ``--auto`` and read droid's result object."""
    fake_cli(
        tmp_path,
        "droid",
        f"argv_file = argv[argv.index('-f') + 1]\nassert open(argv_file).read() == 'ping'\n{printing(DROID_SUCCESS)}",
    )
    completion = cli_runners.run_droid("claude-haiku-4-5-20251001", "ping", None, local_settings(tmp_path), tmp_path)
    assert completion.text == "pong"
    assert (completion.prompt_tokens, completion.completion_tokens, completion.model_ms) == (13423, 5, 3344)
    [call] = calls(tmp_path, "droid")
    assert call["argv"][:4] == ["exec", "-o", "json", "--model"]
    assert "--auto" not in call["argv"]
    assert not set(API_KEYS) & set(call["env"])


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


def test_timeout_is_transient(tmp_path: Path) -> None:
    """Stop a CLI at the call timeout and allow a retry."""
    fake_cli(tmp_path, "droid", "time.sleep(10)")
    with pytest.raises(CliRunError) as caught:
        cli_runners.run_droid("glm-5.3", "ping", None, local_settings(tmp_path, cli_call_timeout_seconds=0.5), tmp_path)
    assert caught.value.transient


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
