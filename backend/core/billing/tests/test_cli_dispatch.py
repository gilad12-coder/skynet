"""Tests for the subscription dispatcher: answer shape, caps, fallback, concurrency and streaming."""

from __future__ import annotations

import json
import threading
import time
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import httpx
import pytest

from core import config
from core.billing import cli_dispatch
from core.billing.cli_dispatch import CliDispatcher, local_subscription_route
from core.billing.operation_pricing import UnpricedOperationError
from core.billing.tests.test_cli_runners import CLAUDE_SUCCESS, DROID_SUCCESS, calls, fake_cli, local_settings, printing
from core.local.cli_probe import read_cli_limits

MODEL = "anthropic/claude-haiku-4.5"
PROMPT_PRICE = Decimal("0.000001")
COMPLETION_PRICE = Decimal("0.000005")
REQUEST = {"model": MODEL, "messages": [{"role": "user", "content": "ping"}]}
CAPPED = "print('Claude AI usage limit reached|1893456000')\nsys.exit(1)"


@pytest.fixture(autouse=True)
def _fixture_prices(monkeypatch: pytest.MonkeyPatch) -> None:
    """Price every model at fixed list prices and skip the back-off waits."""
    monkeypatch.setattr(cli_dispatch, "_list_prices", lambda model: (PROMPT_PRICE, COMPLETION_PRICE))
    monkeypatch.setattr(cli_dispatch, "_sleep", lambda seconds: None)
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"):
        monkeypatch.setenv(key, "parent-secret")


def _body(result) -> dict:
    """Return a JSON answer body."""
    return json.loads(result.body)


def test_chat_completion_has_the_openai_shape_and_list_price(tmp_path: Path) -> None:
    """Answer in the chat completion shape with usage priced at tokens times the list price."""
    fake_cli(tmp_path, "claude", printing(CLAUDE_SUCCESS))
    result = CliDispatcher(None, "claude", MODEL, "judge", local_settings(tmp_path)).dispatch(
        "/chat/completions", REQUEST
    )
    assert result.status == 200
    body = _body(result)
    assert body["object"] == "chat.completion"
    assert body["model"] == MODEL
    assert body["choices"][0]["message"] == {"role": "assistant", "content": "pong"}
    usage = body["usage"]
    prompt_tokens = 2 + 2275 + 649
    assert (usage["prompt_tokens"], usage["completion_tokens"]) == (prompt_tokens, 4)
    assert usage["cost"] == pytest.approx(float(PROMPT_PRICE * prompt_tokens + COMPLETION_PRICE * 4))
    assert usage["token_source"] == "subscription"
    assert usage["cli_provider"] == "claude"
    assert usage["model_ms"] == 1326
    [call] = calls(tmp_path, "claude")
    assert "--bare" not in call["argv"]
    assert not {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"} & set(call["env"])


def test_cap_answers_429_and_records_the_reset(tmp_path: Path) -> None:
    """Answer a capped call with 429 and its reset time, and write cli_limits.json."""
    fake_cli(tmp_path, "claude", CAPPED)
    settings = local_settings(tmp_path)
    result = CliDispatcher(None, "claude", MODEL, "judge", settings).dispatch("/chat/completions", REQUEST)
    assert result.status == 429
    error = _body(result)["error"]
    assert error["code"] == "subscription.rate_limited"
    assert error["provider"] == "claude"
    assert error["reset_at"] == datetime.fromtimestamp(1893456000, UTC).isoformat()
    assert (tmp_path / "state" / "cli_limits.json").exists()
    assert datetime.fromisoformat(read_cli_limits(settings)["claude"]["reset_at"]) == datetime.fromtimestamp(
        1893456000, UTC
    )


def test_recorded_cap_skips_the_cli_until_it_resets(tmp_path: Path) -> None:
    """Do not start a CLI whose recorded cap is still in force."""
    fake_cli(tmp_path, "claude", CAPPED)
    settings = local_settings(tmp_path)
    dispatcher = CliDispatcher(None, "claude", MODEL, "judge", settings)
    dispatcher.dispatch("/chat/completions", REQUEST)
    assert dispatcher.dispatch("/chat/completions", REQUEST).status == 429
    assert len(calls(tmp_path, "claude")) == 1


def test_capped_cli_falls_back_to_the_next_cli(tmp_path: Path) -> None:
    """Serve a capped claude call from droid when the fallback order names it."""
    fake_cli(tmp_path, "claude", CAPPED)
    fake_cli(tmp_path, "droid", printing(DROID_SUCCESS))
    settings = local_settings(tmp_path, cli_fallback_order="claude,droid")
    result = CliDispatcher(None, "claude", MODEL, "judge", settings).dispatch("/chat/completions", REQUEST)
    assert result.status == 200
    assert _body(result)["usage"]["cli_provider"] == "droid"
    [call] = calls(tmp_path, "droid")
    assert call["argv"][call["argv"].index("--model") + 1] == "claude-haiku-4-5-20251001"


def test_fallback_skips_a_cli_without_the_model(tmp_path: Path) -> None:
    """Skip codex, which cannot run a Claude model, and report the cap."""
    fake_cli(tmp_path, "claude", CAPPED)
    fake_cli(tmp_path, "codex", "raise SystemExit('codex must not run')")
    settings = local_settings(tmp_path, cli_fallback_order="claude,codex")
    result = CliDispatcher(None, "claude", MODEL, "judge", settings).dispatch("/chat/completions", REQUEST)
    assert result.status == 429
    assert calls(tmp_path, "codex") == []


def test_transient_failure_is_retried(tmp_path: Path) -> None:
    """Retry an overloaded call and answer from the retry."""
    marker = tmp_path / "failed-once"
    fake_cli(
        tmp_path,
        "claude",
        f"marker = {str(marker)!r}\n"
        "if not os.path.exists(marker):\n"
        "    open(marker, 'w').close()\n"
        "    sys.stderr.write('API Error: 529 overloaded')\n"
        "    sys.exit(1)\n"
        f"{printing(CLAUDE_SUCCESS)}",
    )
    result = CliDispatcher(None, "claude", MODEL, "judge", local_settings(tmp_path)).dispatch(
        "/chat/completions", REQUEST
    )
    assert result.status == 200
    assert len(calls(tmp_path, "claude")) == 2


def test_final_failure_answers_502(tmp_path: Path) -> None:
    """Answer a failed call with 502 and the CLI's short reason."""
    fake_cli(tmp_path, "claude", "sys.stderr.write('Invalid model name')\nsys.exit(1)")
    result = CliDispatcher(None, "claude", MODEL, "judge", local_settings(tmp_path)).dispatch(
        "/chat/completions", REQUEST
    )
    assert result.status == 502
    assert _body(result)["error"]["code"] == "subscription.cli_failed"
    assert len(calls(tmp_path, "claude")) == 1


def test_third_concurrent_call_waits_for_a_slot(tmp_path: Path) -> None:
    """Run at most two calls at once when ``cli_max_concurrency`` is 2."""
    fake_cli(tmp_path, "claude", f"time.sleep(0.6)\n{printing(CLAUDE_SUCCESS)}")
    dispatcher = CliDispatcher(None, "claude", MODEL, "judge", local_settings(tmp_path, cli_max_concurrency=2))
    finished: list[float] = []
    started = time.monotonic()

    def call() -> None:
        """Make one call and record when it ended."""
        assert dispatcher.dispatch("/chat/completions", REQUEST).status == 200
        finished.append(time.monotonic() - started)

    threads = [threading.Thread(target=call) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    finished.sort()
    assert len(finished) == 3
    assert finished[2] - finished[0] >= 0.5


def test_stream_answers_valid_sse(tmp_path: Path) -> None:
    """Answer ``stream: true`` with JSON chunks, usage on the last one, and ``[DONE]``."""
    fake_cli(tmp_path, "claude", printing(CLAUDE_SUCCESS))
    dispatcher = CliDispatcher(None, "claude", MODEL, "judge", local_settings(tmp_path))
    result = dispatcher.dispatch("/chat/completions", {**REQUEST, "stream": True})
    assert result.status == 200
    assert result.content_type == "text/event-stream"
    events = [line.removeprefix("data: ") for line in result.body.decode().split("\n\n") if line]
    assert events[-1] == "[DONE]"
    chunks = [json.loads(event) for event in events[:-1]]
    assert "".join(chunk["choices"][0]["delta"].get("content", "") for chunk in chunks) == "pong"
    assert chunks[-1]["usage"]["token_source"] == "subscription"


def test_schema_request_reaches_the_cli(tmp_path: Path) -> None:
    """Pass a ``json_schema`` response format to the CLI as its schema."""
    fake_cli(tmp_path, "claude", printing({**CLAUDE_SUCCESS, "structured_output": {"ok": True}}))
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}}
    request = {**REQUEST, "response_format": {"type": "json_schema", "json_schema": {"name": "x", "schema": schema}}}
    result = CliDispatcher(None, "claude", MODEL, "judge", local_settings(tmp_path)).dispatch(
        "/chat/completions", request
    )
    assert json.loads(_body(result)["choices"][0]["message"]["content"]) == {"ok": True}
    [call] = calls(tmp_path, "claude")
    assert json.loads(call["argv"][call["argv"].index("--json-schema") + 1]) == schema


def test_other_paths_and_models_are_refused(tmp_path: Path) -> None:
    """Refuse another model, and answer 422 for a protocol a CLI cannot serve."""
    dispatcher = CliDispatcher(None, "claude", MODEL, "judge", local_settings(tmp_path))
    assert dispatcher.dispatch("/embeddings", REQUEST).status == 422
    with pytest.raises(UnpricedOperationError):
        dispatcher.dispatch("/chat/completions", {**REQUEST, "model": "anthropic/claude-opus-4.5"})


def test_outside_local_mode_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Refuse a subscription route when local mode is off."""
    with pytest.raises(UnpricedOperationError):
        CliDispatcher(None, "claude", MODEL, "judge", local_settings(tmp_path, local_mode=False))
    monkeypatch.setattr(config.settings, "local_mode", False)
    with pytest.raises(UnpricedOperationError):
        local_subscription_route(MODEL, "claude", "agent")


def test_unmapped_model_is_refused(tmp_path: Path) -> None:
    """Refuse a model the CLI cannot run."""
    with pytest.raises(UnpricedOperationError):
        CliDispatcher(None, "codex", MODEL, "judge", local_settings(tmp_path))


def test_local_route_serves_an_openai_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Serve API-side agents on a loopback route that needs its own token."""
    fake_cli(tmp_path, "claude", printing(CLAUDE_SUCCESS))
    monkeypatch.setattr(config, "settings", local_settings(tmp_path))
    monkeypatch.setattr(cli_dispatch, "_gateway", None)
    route = local_subscription_route(MODEL, "claude", "agent")
    assert local_subscription_route(MODEL, "claude", "agent")["token"] == route["token"]
    with httpx.Client(trust_env=False) as client:
        answer = client.post(
            f"{route['url']}/chat/completions", json=REQUEST, headers={"Authorization": f"Bearer {route['token']}"}
        )
        refused = client.post(f"{route['url']}/chat/completions", json=REQUEST, headers={"Authorization": "Bearer x"})
    assert answer.status_code == 200
    assert answer.json()["choices"][0]["message"]["content"] == "pong"
    assert refused.status_code == 401
