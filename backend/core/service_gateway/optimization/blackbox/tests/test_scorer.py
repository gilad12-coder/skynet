"""Tests for the python and remote scorer adapters."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import httpx
import pytest
from gepa.image import Image

from core.exceptions import ServiceError
from core.models.blackbox import BlackboxScorer

from .. import scorer as scorer_mod
from ..llm_helper import ScorerLLM, image_content_part, scorer_messages
from ..scorer import (
    RemoteScorer,
    build_python_scorer,
    build_scorer,
    load_scorer_from_code,
    normalize_score,
    side_info_json_default,
)


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
    with pytest.raises(ServiceError, match="scorer must return"):
        normalize_score(raw)


def test_load_scorer_prefers_score_then_metric_then_single_function() -> None:
    """Entrypoint lookup order: ``score``, ``metric``, the only function defined."""
    both = "def metric(c, x=None): return 0.0\ndef score(c, x=None): return 1.0\n"
    metric_only = "def metric(c, x=None): return 0.5\n"
    single = "import math\ndef judge(c, x=None): return 0.75\n"

    assert load_scorer_from_code(both)("x") == 1.0
    assert load_scorer_from_code(metric_only)("x") == 0.5
    assert load_scorer_from_code(single)("x") == 0.75


def test_load_scorer_ignores_imported_functions_when_picking_the_single_function() -> None:
    """Functions imported into the namespace do not count as the user's scorer."""
    code = "from math import sqrt\ndef judge(c, x=None): return 1.0\n"

    assert load_scorer_from_code(code)("x") == 1.0


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
    """Broken or ambiguous scorer code raises a ``ServiceError`` naming the problem.

    Args:
        code: The scorer source.
        message: Expected fragment of the error.
    """
    with pytest.raises(ServiceError, match=message):
        load_scorer_from_code(code)


def test_python_scorer_passes_case_only_when_the_function_takes_one() -> None:
    """A ``score(candidate)`` scorer is called without the case; ``score(candidate, case)`` gets it."""
    one_arg = build_python_scorer("def score(candidate): return len(candidate)")
    two_arg = build_python_scorer("def score(candidate, case): return case['weight'] * len(candidate)")
    var_arg = build_python_scorer("def score(*args): return len(args)")

    assert one_arg("abc", {"weight": 2}) == (3.0, {})
    assert two_arg("abc", {"weight": 2}) == (6.0, {})
    assert var_arg("abc", {"weight": 2}) == (2.0, {})


def test_python_scorer_normalizes_return_values() -> None:
    """The wrapped scorer applies ``normalize_score`` to whatever the user returns."""
    scorer = build_python_scorer("def score(c, case=None): return {'score': 0.5, 'why': 'ok'}")

    assert scorer("x", None) == (0.5, {"why": "ok"})


_SLOW_SCORER = "import time\ndef score(candidate, case=None):\n    time.sleep(2)\n    return 1.0\n"


def test_python_scorer_gives_up_on_calls_that_outrun_the_timeout() -> None:
    """A call slower than ``timeout_seconds`` raises ``TimeoutError`` instead of stalling the run."""
    scorer = build_python_scorer(_SLOW_SCORER, timeout_seconds=0.05)

    with pytest.raises(TimeoutError, match=r"exceeded the 0\.05s timeout"):
        scorer("x", None)


def test_python_scorer_keeps_results_and_errors_from_timed_calls() -> None:
    """Within the timeout, the user's return value and exceptions pass through unchanged."""
    fast = build_python_scorer("def score(c, case=None): return 0.5, {'ok': True}", timeout_seconds=5.0)
    failing = build_python_scorer("def score(c, case=None): raise ValueError('bad')", timeout_seconds=5.0)

    assert fast("x", None) == (0.5, {"ok": True})
    with pytest.raises(ValueError, match="bad"):
        failing("x", None)


class _FakeResponse:
    """Minimal stand-in for ``httpx.Response``."""

    def __init__(self, body: Any, *, status_error: bool = False, non_json: bool = False) -> None:
        """Create the fake.

        Args:
            body: What ``json()`` returns.
            status_error: Whether ``raise_for_status`` raises.
            non_json: Whether ``json()`` raises ``ValueError``.
        """
        self._body = body
        self._status_error = status_error
        self._non_json = non_json

    def raise_for_status(self) -> None:
        """Raise ``httpx.HTTPStatusError`` when configured to."""
        if self._status_error:
            request = httpx.Request("POST", "https://scorer.example/score")
            raise httpx.HTTPStatusError("500", request=request, response=httpx.Response(500, request=request))

    def json(self) -> Any:
        """Return the body, or raise when configured as non-JSON."""
        if self._non_json:
            raise ValueError("not json")
        return self._body


def test_remote_scorer_posts_candidate_and_case_with_bearer_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """The remote adapter sends the documented body and auth header and normalizes the reply."""
    captured: dict[str, Any] = {}

    def fake_post(url: str, *, json: Any, headers: dict[str, str], timeout: float) -> _FakeResponse:
        """Record the request and answer with a scored body."""
        captured.update(url=url, json=json, headers=headers, timeout=timeout)
        return _FakeResponse({"score": 0.9, "feedback": "fine"})

    monkeypatch.setattr(scorer_mod.httpx, "post", fake_post)
    scorer = RemoteScorer("https://scorer.example/score", secret="s3cret", timeout_seconds=7.5)

    assert scorer("hello", {"k": 1}) == (0.9, {"feedback": "fine"})
    assert captured == {
        "url": "https://scorer.example/score",
        "json": {"candidate": "hello", "case": {"k": 1}},
        "headers": {"Authorization": "Bearer s3cret"},
        "timeout": 7.5,
    }


def test_remote_scorer_omits_auth_header_without_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """No secret means no ``Authorization`` header."""
    captured: dict[str, Any] = {}
    monkeypatch.setattr(scorer_mod.httpx, "post", lambda url, **kw: captured.update(kw) or _FakeResponse(0.5))

    assert RemoteScorer("https://scorer.example", secret=None, timeout_seconds=1)("x") == (0.5, {})
    assert captured["headers"] == {}


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (_FakeResponse(None, status_error=True), "remote scorer request failed"),
        (_FakeResponse(None, non_json=True), "non-JSON body"),
        (_FakeResponse({"feedback": "no score"}), "scorer must return"),
    ],
)
def test_remote_scorer_reports_bad_replies(
    monkeypatch: pytest.MonkeyPatch, response: _FakeResponse, message: str
) -> None:
    """HTTP errors, non-JSON bodies and score-less bodies all become ``ServiceError``.

    Args:
        monkeypatch: Pytest fixture.
        response: The canned reply.
        message: Expected fragment of the error.
    """
    monkeypatch.setattr(scorer_mod.httpx, "post", lambda *a, **kw: response)

    with pytest.raises(ServiceError, match=message):
        RemoteScorer("https://scorer.example", secret=None, timeout_seconds=1)("x")


def test_remote_scorer_wraps_transport_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """Connection failures surface as ``ServiceError`` too."""

    def fail(*args: Any, **kwargs: Any) -> None:
        """Simulate a dead endpoint."""
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(scorer_mod.httpx, "post", fail)

    with pytest.raises(ServiceError, match="connection refused"):
        RemoteScorer("https://scorer.example", secret=None, timeout_seconds=1)("x")


def test_build_scorer_dispatches_on_kind() -> None:
    """``build_scorer`` returns a remote adapter for ``remote`` and a python wrapper otherwise."""
    remote = build_scorer(BlackboxScorer(kind="remote", url="https://scorer.example"))
    python = build_scorer(BlackboxScorer(metric_code="def score(c, case=None): return 1.0"))

    assert isinstance(remote, RemoteScorer)
    assert python("x", None) == (1.0, {})


_LLM_SCORER = (
    "def score(candidate, case=None):\n    return len(llm(candidate, case['input'])) / 10, {'asked': candidate}\n"
)


def test_python_scorer_gets_the_injected_llm_helper() -> None:
    """``llm`` is a name in the scorer's namespace, bound to whatever the caller passes in."""
    seen: list[tuple[str, str | None]] = []

    def fake_llm(prompt: str, input: str | None = None) -> str:
        seen.append((prompt, input))
        return "y" * 10

    scorer = build_python_scorer(_LLM_SCORER, llm=fake_llm)

    assert scorer("judge", {"input": "text"}) == (1.0, {"asked": "judge"})
    assert seen == [("judge", "text")]


def test_llm_helper_is_never_picked_as_the_scorer() -> None:
    """Injecting ``llm`` does not confuse the single-function fallback."""
    scorer = build_python_scorer("def grade(candidate): return 0.5", llm=lambda prompt, input=None: "")

    assert scorer("x", None) == (0.5, {})


def test_scorer_without_a_model_gets_a_clear_error_from_llm() -> None:
    """Without a model, calling ``llm()`` explains which step to fix."""
    scorer = build_python_scorer(_LLM_SCORER)

    with pytest.raises(ServiceError, match="no model was chosen in the Scorer step"):
        scorer("judge", {"input": "text"})


def test_build_scorer_forwards_the_llm_helper() -> None:
    """``build_scorer`` hands the helper to python scorers."""
    scorer = build_scorer(
        BlackboxScorer(metric_code="def score(c, case=None): return float(llm('p'))"),
        llm=lambda prompt, input=None: "0.75",
    )

    assert scorer("x", None) == (0.75, {})


def test_build_scorer_bounds_python_scorers_by_the_spec_timeout() -> None:
    """The spec's ``timeout_seconds`` applies to python scorers, not only remote ones."""
    scorer = build_scorer(BlackboxScorer(metric_code=_SLOW_SCORER, timeout_seconds=0.05))

    with pytest.raises(TimeoutError, match=r"exceeded the 0\.05s timeout"):
        scorer("x", None)


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(PNG_BYTES).decode("ascii")


class RecordingLM:
    """A stand-in ``dspy.LM`` that records the messages it was called with."""

    def __init__(self) -> None:
        self.calls: list[list[dict[str, Any]]] = []

    def __call__(self, prompt: str | None = None, *, messages: list[dict[str, Any]] | None = None) -> list[str]:
        assert prompt is None
        assert messages is not None
        self.calls.append(messages)
        return ["judged"]


def test_image_content_part_reads_every_documented_shape(tmp_path: Path) -> None:
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
    with pytest.raises(ServiceError, match=r"llm\(images=\.\.\.\)"):
        image_content_part(42)
    with pytest.raises(ServiceError, match=r"llm\(images=\.\.\.\)"):
        image_content_part("not base64 at all!!")


def test_scorer_messages_attach_images_to_the_user_turn() -> None:
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


def test_scorer_llm_sends_images_and_raw_messages() -> None:
    lm = RecordingLM()
    llm = ScorerLLM(lm)  # type: ignore[arg-type]
    assert llm("Rate this", images=[PNG_BYTES]) == "judged"
    assert lm.calls[-1][0]["content"][1]["image_url"]["url"] == PNG_DATA_URL
    raw = [{"role": "user", "content": "raw"}]
    assert llm(messages=raw) == "judged"
    assert lm.calls[-1] is raw
    with pytest.raises(ServiceError, match="needs a prompt"):
        llm()
    with pytest.raises(ServiceError, match="list of chat messages"):
        llm(messages="nope")  # type: ignore[arg-type]


def test_python_scorer_can_put_images_into_side_info() -> None:
    code = (
        "def score(candidate, case):\n    return 1.0, {'render': Image(base64_data='aGk=', media_type='image/png')}\n"
    )
    score, side_info = build_python_scorer(code, llm=None)("c", {})
    assert score == 1.0
    assert side_info["render"].to_openai_content_part()["image_url"]["url"] == "data:image/png;base64,aGk="


def test_side_info_json_default_inlines_images_as_data_urls() -> None:
    assert side_info_json_default(Image(base64_data="aGk=", media_type="image/png")) == "data:image/png;base64,aGk="
    assert side_info_json_default(object()).startswith("<object object")
