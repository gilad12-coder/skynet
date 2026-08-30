"""Tests for the in-sandbox runner: the stdlib-only module shipped into every scorer box."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from .. import runner
from ..runner import (
    GatewayClient,
    Image,
    ScorerError,
    accepts_case,
    image_content_part,
    load_scorer_from_code,
    normalize_score,
    run_call,
    scorer_messages,
    side_info_json_default,
)
from .mocks import FakeGateway

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(PNG_BYTES).decode("ascii")
_LLM_SCORER = (
    "def score(candidate, case=None):\n    return float(llm(candidate, case['input'])), {'asked': candidate}\n"
)
_SYSTEM_PYTHON = Path("/usr/bin/python3")
_INTERPRETERS = [sys.executable] + ([str(_SYSTEM_PYTHON)] if _SYSTEM_PYTHON.is_file() else [])


class _WithScore:
    """Object exposing a numeric ``score`` attribute."""

    score = 0.25


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (0.5, (0.5, {})),
        (1, (1.0, {})),
        (True, (1.0, {})),
        ((0.5, {"feedback": "ok"}), (0.5, {"feedback": "ok"})),
        ([0.5, "just text"], (0.5, {"feedback": "just text"})),
        ({"score": 0.75, "note": "n"}, (0.75, {"note": "n"})),
        (_WithScore(), (0.25, {})),
    ],
)
def test_normalize_score_accepts_documented_shapes(raw: Any, expected: tuple[float, dict[str, Any]]) -> None:
    """Every documented return shape normalizes to ``(score, side_info)``.

    Args:
        raw: What the scorer returned.
        expected: The normalized pair.
    """
    assert normalize_score(raw) == expected


@pytest.mark.parametrize("raw", ["0.5", None, {"feedback": "no score"}, (0.5, {}, "extra")])
def test_normalize_score_rejects_other_shapes(raw: Any) -> None:
    """Anything else is a scorer contract violation.

    Args:
        raw: An unsupported return value.
    """
    with pytest.raises(ScorerError, match="scorer must return"):
        normalize_score(raw)


def test_load_scorer_prefers_score_then_metric_then_single_function() -> None:
    """Entrypoint lookup order: ``score``, ``metric``, the only function defined."""
    both = "def metric(c, x=None): return 0.0\ndef score(c, x=None): return 1.0\n"
    metric_only = "def metric(c, x=None): return 0.5\n"
    single = "import math\ndef judge(c, x=None): return 0.75\n"

    assert load_scorer_from_code(both)("x") == 1.0
    assert load_scorer_from_code(metric_only)("x") == 0.5
    assert load_scorer_from_code(single)("x") == 0.75


def test_load_scorer_ignores_imported_and_injected_functions() -> None:
    """Neither imports nor the injected helpers count as the user's single function."""
    code = "from math import sqrt\ndef judge(c, x=None): return 1.0\n"

    assert load_scorer_from_code(code, helpers={"llm": lambda *a, **k: ""})("x") == 1.0


@pytest.mark.parametrize(
    ("code", "message"),
    [
        ("def !!!", "syntax error"),
        ("raise RuntimeError('boom')", "failed to load: RuntimeError: boom"),
        ("x = 1", "must define a function named 'score"),
        ("def a(c): return 1\ndef b(c): return 2\n", "must define a function named 'score"),
    ],
)
def test_load_scorer_reports_unusable_code(code: str, message: str) -> None:
    """Broken or ambiguous scorer code raises a ``ScorerError`` naming the problem.

    Args:
        code: The scorer source.
        message: Expected fragment of the error.
    """
    with pytest.raises(ScorerError, match=message):
        load_scorer_from_code(code)


def test_accepts_case_reads_the_positional_arity() -> None:
    """``score(candidate)`` gets no case; ``score(candidate, case)`` and ``score(*args)`` do."""
    assert accepts_case(load_scorer_from_code("def score(candidate): return 1")) is False
    assert accepts_case(load_scorer_from_code("def score(candidate, case): return 1")) is True
    assert accepts_case(load_scorer_from_code("def score(*args): return 1")) is True
    assert accepts_case(load_scorer_from_code("def score(candidate, *, case=None): return 1")) is False


def test_image_content_part_reads_every_documented_shape(tmp_path: Path) -> None:
    """Bytes, paths, URLs, base64, ``Image`` objects and ready parts all become ``image_url`` parts."""
    file_path = tmp_path / "view.jpg"
    file_path.write_bytes(b"\xff\xd8\xff" + b"\x00" * 8)
    part = {"type": "image_url", "image_url": {"url": "https://x/y.png"}}
    assert image_content_part(part) is part
    assert image_content_part(PNG_BYTES)["image_url"]["url"] == PNG_DATA_URL
    assert image_content_part(bytearray(PNG_BYTES))["image_url"]["url"] == PNG_DATA_URL
    assert image_content_part(PNG_DATA_URL)["image_url"]["url"] == PNG_DATA_URL
    assert image_content_part("https://x/y.png")["image_url"]["url"] == "https://x/y.png"
    assert image_content_part(str(file_path))["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert image_content_part(base64.b64encode(PNG_BYTES).decode("ascii"))["image_url"]["url"] == PNG_DATA_URL
    assert image_content_part(Image(base64_data="aGk=", media_type="image/png"))["type"] == "image_url"


def test_image_content_part_rejects_what_it_cannot_read() -> None:
    """Unreadable images name the helper argument in the error."""
    with pytest.raises(ScorerError, match=r"llm\(images=\.\.\.\)"):
        image_content_part(42)
    with pytest.raises(ScorerError, match=r"llm\(images=\.\.\.\)"):
        image_content_part("not base64 at all!!")
    with pytest.raises(ScorerError, match="url, a path or base64_data"):
        Image().to_openai_content_part()


def test_scorer_messages_attach_images_to_the_user_turn() -> None:
    """``prompt`` alone is the user turn; with ``input`` it becomes the system turn; images ride on the user turn."""
    assert scorer_messages("hi") == [{"role": "user", "content": "hi"}]
    assert scorer_messages("system", "case input") == [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "case input"},
    ]
    messages = scorer_messages("Rate this", images=PNG_BYTES)
    assert messages == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Rate this"},
                {"type": "image_url", "image_url": {"url": PNG_DATA_URL}},
            ],
        }
    ]
    with_input = scorer_messages("system", "case input", images=[PNG_BYTES, PNG_BYTES])
    assert with_input[0] == {"role": "system", "content": "system"}
    assert [part["type"] for part in with_input[1]["content"]] == ["text", "image_url", "image_url"]


def test_side_info_json_default_inlines_images_as_data_urls() -> None:
    """Images serialize as data URLs; anything else falls back to ``str()``."""
    assert side_info_json_default(Image(base64_data="aGk=", media_type="image/png")) == "data:image/png;base64,aGk="
    assert side_info_json_default(object()).startswith("<object object")


def test_gateway_client_posts_chat_completions_and_records_usage() -> None:
    """One call is one bearer-authenticated POST carrying the model, sampling options and chat."""
    with FakeGateway(reply="judged", usage=(7, 2)) as gateway:
        llm = GatewayClient(gateway.url + "/", "gpt-x", api_key="k", temperature=0.2, max_tokens=64, timeout_seconds=5)

        assert llm("system", "user text") == "judged"

    [request] = gateway.requests
    assert request["path"] == "/v1/chat/completions"
    assert request["authorization"] == "Bearer k"
    assert request["body"] == {
        "model": "gpt-x",
        "messages": [{"role": "system", "content": "system"}, {"role": "user", "content": "user text"}],
        "temperature": 0.2,
        "max_tokens": 64,
    }
    assert llm.usage == [{"prompt_tokens": 7, "completion_tokens": 2, "total_tokens": 9}]


def test_gateway_client_sends_images_and_raw_messages_without_a_key() -> None:
    """Images become content parts, ``messages=`` goes through verbatim, and no key means no header."""
    with FakeGateway() as gateway:
        llm = GatewayClient(gateway.url, "m")

        assert llm("Rate this", images=[PNG_BYTES]) == "0.5"
        raw = [{"role": "user", "content": "raw"}]
        assert llm(messages=raw) == "0.5"
        with pytest.raises(ScorerError, match="needs a prompt"):
            llm()
        with pytest.raises(ScorerError, match="list of chat messages"):
            llm(messages="nope")  # type: ignore[arg-type]

    first, second = gateway.requests
    assert first["authorization"] is None
    assert first["body"]["messages"][0]["content"][1]["image_url"]["url"] == PNG_DATA_URL
    assert second["body"] == {"model": "m", "messages": raw}


def test_gateway_client_retries_transient_statuses_and_gives_up_on_others(monkeypatch: pytest.MonkeyPatch) -> None:
    """5xx/429 answers are retried a few times; a 4xx is reported at once with the body."""
    monkeypatch.setattr(runner, "_BACKOFF_SECONDS", 0.0)
    with FakeGateway(statuses=[503, 429]) as gateway:
        assert GatewayClient(gateway.url, "m")("p") == "0.5"
    assert len(gateway.requests) == 3

    with (
        FakeGateway(statuses=[401]) as gateway,
        pytest.raises(ScorerError, match=r"HTTP 401: \{\"error\": \"try again\"\}"),
    ):
        GatewayClient(gateway.url, "m")("p")
    assert len(gateway.requests) == 1

    with FakeGateway(statuses=[500, 500, 500]) as gateway, pytest.raises(ScorerError, match="HTTP 500"):
        GatewayClient(gateway.url, "m")("p")
    assert len(gateway.requests) == 3


def test_gateway_client_reports_unreachable_gateways(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dead endpoint surfaces as an ``llm()`` failure, not a raw socket error."""
    monkeypatch.setattr(runner, "_BACKOFF_SECONDS", 0.0)
    with FakeGateway() as gateway:
        url = gateway.url

    with pytest.raises(ScorerError, match=r"llm\(\) request failed"):
        GatewayClient(url, "m", timeout_seconds=2)("p")


def test_run_call_scores_and_serializes_side_info() -> None:
    """The output carries the score, JSON-plain side info (images as data URLs) and an empty usage list."""
    code = (
        "def score(candidate, case):\n"
        "    return len(candidate) / 10, {'length': len(candidate), 'render': Image(base64_data='aGk='), 'odd': {1}}\n"
    )

    result = run_call({"code": code, "candidate": "hello", "case": {"x": 1}, "gateway": None})

    assert result == {
        "score": 0.5,
        "side_info": {"length": 5, "render": "data:image/png;base64,aGk=", "odd": "{1}"},
        "error": None,
        "usage": [],
    }


def test_run_call_passes_case_only_when_the_function_takes_one() -> None:
    """A ``score(candidate)`` scorer is called without the case; ``score(candidate, case)`` gets it."""
    scores = [
        run_call({"code": code, "candidate": "abc", "case": {"weight": 2}})["score"]
        for code in (
            "def score(candidate): return len(candidate)",
            "def score(candidate, case): return case['weight'] * len(candidate)",
            "def score(*args): return len(args)",
        )
    ]

    assert scores == [3.0, 6.0, 2.0]


@pytest.mark.parametrize(
    ("code", "error"),
    [
        ("def score(c, case=None): raise ValueError('bad candidate')", "ValueError: bad candidate"),
        ("def score(c, case=None): raise SystemExit(3)", "SystemExit: 3"),
        ("def score(c, case=None): return 'nope'", "scorer must return"),
        ("def !!!", "scorer code has a syntax error"),
        (_LLM_SCORER, "This scorer calls llm() but no model was chosen in the Scorer step."),
    ],
)
def test_run_call_reports_scorer_failures_as_data(code: str, error: str) -> None:
    """Whatever the scorer does wrong lands in ``error``; the runner itself never raises.

    Args:
        code: The scorer source.
        error: Expected fragment of the reported error.
    """
    result = run_call({"code": code, "candidate": "x", "case": {"input": "i"}, "gateway": None})

    assert result["score"] is None
    assert error in result["error"]


def test_run_call_binds_llm_to_the_gateway_with_the_key_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``llm()`` posts to the payload's gateway, authenticates from the environment and reports its usage."""
    monkeypatch.setenv(runner.ENV_API_KEY, "env-key")
    with FakeGateway(reply="0.75", usage=(3, 1)) as gateway:
        payload = {
            "code": _LLM_SCORER,
            "candidate": "judge",
            "case": {"input": "text"},
            "gateway": {
                "url": gateway.url,
                "model": "m",
                "temperature": None,
                "max_tokens": None,
                "timeout_seconds": 5,
            },
        }

        result = run_call(payload)

    assert result == {
        "score": 0.75,
        "side_info": {"asked": "judge"},
        "error": None,
        "usage": [{"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}],
    }
    [request] = gateway.requests
    assert request["authorization"] == "Bearer env-key"
    assert request["body"]["messages"] == [{"role": "system", "content": "judge"}, {"role": "user", "content": "text"}]


def test_run_call_prefers_a_key_in_the_payload_over_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """An explicit ``api_key`` in the gateway section wins over ``SKYNET_API_KEY``."""
    monkeypatch.setenv(runner.ENV_API_KEY, "env-key")
    with FakeGateway() as gateway:
        run_call(
            {
                "code": _LLM_SCORER,
                "candidate": "j",
                "case": {"input": "t"},
                "gateway": {"url": gateway.url, "model": "m", "api_key": "inline"},
            }
        )

    assert gateway.requests[0]["authorization"] == "Bearer inline"


def test_run_call_reports_usage_even_when_the_scorer_fails_after_calling_llm() -> None:
    """Tokens spent before the scorer blew up are still billed."""
    code = "def score(c, case=None):\n    llm('p')\n    raise ValueError('late')\n"
    with FakeGateway() as gateway:
        result = run_call({"code": code, "candidate": "x", "gateway": {"url": gateway.url, "model": "m"}})

    assert result["error"] == "ValueError: late"
    assert result["usage"] == [{"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}]


@pytest.mark.parametrize("interpreter", _INTERPRETERS)
def test_main_runs_the_file_contract_end_to_end(tmp_path: Path, interpreter: str) -> None:
    """``python3 skynet_runner.py <call_dir>`` turns ``input.json`` into ``output.json`` on every supported interpreter.

    Args:
        tmp_path: Pytest fixture.
        interpreter: The python that runs the runner (the venv's, and the 3.9 system one when present).
    """
    call_dir = tmp_path / "calls" / "000001"
    call_dir.mkdir(parents=True)
    payload = {
        "code": "def score(candidate, case=None):\n    return 0.5, {'render': Image(base64_data='aGk=')}\n",
        "candidate": "x",
        "case": None,
        "gateway": None,
    }
    (call_dir / runner.INPUT_FILE).write_text(json.dumps(payload), encoding="utf-8")

    completed = subprocess.run(
        [interpreter, runner.__file__, str(call_dir)],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=tmp_path,
        env={"PATH": "/usr/bin:/bin", "HOME": str(tmp_path)},
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert json.loads((call_dir / runner.OUTPUT_FILE).read_text(encoding="utf-8")) == {
        "score": 0.5,
        "side_info": {"render": "data:image/png;base64,aGk="},
        "error": None,
        "usage": [],
    }
    assert not (call_dir / (runner.OUTPUT_FILE + ".part")).exists()


def test_main_wants_exactly_one_argument(capsys: pytest.CaptureFixture[str]) -> None:
    """Anything but a single call directory is a usage error."""
    assert runner.main([]) == 2
    assert runner.main(["a", "b"]) == 2
    assert "usage:" in capsys.readouterr().err
