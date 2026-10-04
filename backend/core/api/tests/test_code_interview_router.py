"""Tests for the Signature & Metric interview SSE endpoint.

Mounts the code-agent router with the engine's stream monkeypatched, so the
wire contract (event framing, argument forwarding, sample-row cap, error
translation) is covered without an LLM. The ``interview_brief`` pass-through
on the seed endpoint is covered the same way against ``run_code_agent``.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from .. import model_catalog, model_router
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError
from ..routers import code_agent as code_agent_router
from ..routers.code_agent import create_code_agent_router

_ALICE = AuthenticatedUser(username="alice", role="user", groups=())

_INTERVIEW_BODY = {
    "dataset_columns": ["text", "label"],
    "column_roles": {"text": "input", "label": "output"},
    "column_kinds": {"text": "text"},
    "sample_rows": [{"text": f"row {i}", "label": "x"} for i in range(7)],
    "turns": [{"role": "assistant", "content": "Q1?"}, {"role": "user", "content": "A1"}],
    "job_model": "openai/gpt-4o-mini",
    "locale": "en",
}


def _client() -> TestClient:
    """Mount the code-agent router authed as Alice."""
    app = FastAPI()
    app.include_router(create_code_agent_router())
    app.dependency_overrides[get_authenticated_user] = lambda: _ALICE

    @app.exception_handler(DomainError)
    async def _domain_error_handler(_request, exc: DomainError) -> JSONResponse:
        """Mirror the app-level envelope so tests can assert on ``code``."""
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "code": exc.code, "params": exc.params},
        )

    return TestClient(app)


def test_interview_streams_events_and_forwards_args(monkeypatch) -> None:
    """The route relays engine events as SSE and forwards the request fields."""
    seen: dict[str, Any] = {}

    async def fake_stream(**kwargs: Any) -> Any:
        """Record the forwarded kwargs and yield a two-event stream."""
        seen.update(kwargs)
        yield {"event": "message_patch", "data": {"chunk": "שאלה"}}
        yield {
            "event": "interview_done",
            "data": {"message": "שאלה", "options": [], "brief": [], "done": False, "model": "m"},
        }

    monkeypatch.setattr(code_agent_router, "interview_turn_stream", fake_stream)
    monkeypatch.setattr(
        model_catalog,
        "get_catalog_cached",
        lambda: SimpleNamespace(models=[SimpleNamespace(value="openai/gpt-test", is_default=False)]),
    )
    resp = _client().post(
        "/optimizations/code-interview",
        json={**_INTERVIEW_BODY, "model": "openai/gpt-test", "reasoning_effort": "high"},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert "event: message_patch" in resp.text
    assert "event: interview_done" in resp.text
    assert "שאלה" in resp.text

    assert seen["dataset_columns"] == ["text", "label"]
    assert seen["job_model"] == "openai/gpt-4o-mini"
    assert seen["locale"] == "en"
    assert seen["turns"] == _INTERVIEW_BODY["turns"]
    assert len(seen["sample_rows"]) == 5
    assert seen["model"] == "openai/gpt-test"
    assert seen["reasoning_effort"] == "high"


def test_interview_without_model_runs_catalog_default(monkeypatch) -> None:
    """An absent model and the retired 'auto:intelligent' both run the catalog default."""
    seen: list[dict[str, Any]] = []

    async def fake_stream(**kwargs: Any) -> Any:
        """Record the forwarded kwargs and finish immediately."""
        seen.append(kwargs)
        yield {
            "event": "interview_done",
            "data": {"message": "q", "options": [], "brief": [], "done": False, "model": "m"},
        }

    monkeypatch.setattr(code_agent_router, "interview_turn_stream", fake_stream)
    monkeypatch.setattr(
        model_router,
        "get_catalog_cached",
        lambda: SimpleNamespace(
            models=[
                SimpleNamespace(
                    value="openrouter/anthropic/claude-sonnet-5",
                    is_default=True,
                    reasoning_efforts=None,
                    reasoning_default_enabled=None,
                )
            ]
        ),
    )
    client = _client()
    assert client.post("/optimizations/code-interview", json=_INTERVIEW_BODY).status_code == 200
    assert (
        client.post(
            "/optimizations/code-interview",
            json={**_INTERVIEW_BODY, "model": "auto:intelligent"},
        ).status_code
        == 200
    )
    assert [k["model"] for k in seen] == ["openrouter/anthropic/claude-sonnet-5"] * 2


def test_interview_rejects_unknown_model(monkeypatch) -> None:
    """A non-catalog interview model is refused before any LLM spend."""
    monkeypatch.setattr(
        model_catalog,
        "get_catalog_cached",
        lambda: SimpleNamespace(models=[SimpleNamespace(value="openai/gpt-test", is_default=False)]),
    )
    resp = _client().post("/optimizations/code-interview", json={**_INTERVIEW_BODY, "model": "openai/not-a-model"})
    assert resp.status_code == 422
    assert resp.json()["code"] == "models.unknown_model"


def test_interview_translates_engine_failure_to_error_event(monkeypatch) -> None:
    """An engine exception becomes a terminal error event, not a broken stream."""

    async def failing_stream(**_: Any) -> Any:
        """Blow up before yielding anything."""
        raise RuntimeError("provider down")
        yield  # pragma: no cover - marks this as a generator

    monkeypatch.setattr(code_agent_router, "interview_turn_stream", failing_stream)
    # The model-less request auto-routes, which consults the catalog — keep
    # the test hermetic instead of probing live providers.
    monkeypatch.setattr(
        model_router,
        "get_catalog_cached",
        lambda: SimpleNamespace(models=[SimpleNamespace(value="openai/gpt-test", is_default=False)]),
    )
    resp = _client().post("/optimizations/code-interview", json=_INTERVIEW_BODY)
    assert resp.status_code == 200
    assert "event: error" in resp.text
    assert "submit.code.interview.llm_failed" in resp.text


def test_seed_endpoint_forwards_interview_brief(monkeypatch) -> None:
    """The confirmed brief rides the ai-generate-code request into the engine."""
    seen: dict[str, Any] = {}

    def fake_run(**kwargs: Any) -> Any:
        """Record kwargs and return an immediately-done stream."""
        seen.update(kwargs)

        async def gen() -> Any:
            yield {"event": "done", "data": {"signature_code": "", "metric_code": ""}}

        return gen()

    monkeypatch.setattr(code_agent_router, "run_code_agent", fake_run)
    body = {
        "dataset_columns": ["text", "label"],
        "column_roles": {"text": "input", "label": "output"},
        "sample_rows": [],
        "user_message": "",
        "interview_brief": ["Outputs must be lowercase.", "Penalize hedging."],
    }
    resp = _client().post("/optimizations/ai-generate-code", json=body)
    assert resp.status_code == 200
    assert seen["interview_brief"] == ["Outputs must be lowercase.", "Penalize hedging."]


_SEED_BODY = {
    "dataset_columns": ["text", "label"],
    "column_roles": {"text": "input", "label": "output"},
    "sample_rows": [],
    "user_message": "",
}


def _fake_run(seen: dict[str, Any]):
    """Build a ``run_code_agent`` stub that records kwargs and finishes at once."""

    def fake_run(**kwargs: Any) -> Any:
        """Record kwargs and return an immediately-done stream."""
        seen.update(kwargs)

        async def gen() -> Any:
            yield {"event": "done", "data": {"signature_code": "", "metric_code": ""}}

        return gen()

    return fake_run


def test_seed_endpoint_forwards_model_and_effort(monkeypatch) -> None:
    """An explicit catalog model + effort ride ai-generate-code into the engine."""
    seen: dict[str, Any] = {}
    monkeypatch.setattr(code_agent_router, "run_code_agent", _fake_run(seen))
    monkeypatch.setattr(
        model_catalog,
        "get_catalog_cached",
        lambda: SimpleNamespace(models=[SimpleNamespace(value="openai/gpt-test", is_default=False)]),
    )
    resp = _client().post(
        "/optimizations/ai-generate-code",
        json={**_SEED_BODY, "model": "openai/gpt-test", "reasoning_effort": "high"},
    )
    assert resp.status_code == 200
    assert seen["model"] == "openai/gpt-test"
    assert seen["reasoning_effort"] == "high"


def test_seed_endpoint_without_model_runs_catalog_default(monkeypatch) -> None:
    """An absent model and the retired 'auto:intelligent' both run the catalog default."""
    seen: list[dict[str, Any]] = []

    def fake_run(**kwargs: Any) -> Any:
        """Record kwargs and return an immediately-done stream."""
        seen.append(kwargs)

        async def gen() -> Any:
            yield {"event": "done", "data": {"signature_code": "", "metric_code": ""}}

        return gen()

    monkeypatch.setattr(code_agent_router, "run_code_agent", fake_run)
    monkeypatch.setattr(
        model_router,
        "get_catalog_cached",
        lambda: SimpleNamespace(
            models=[
                SimpleNamespace(
                    value="openrouter/anthropic/claude-sonnet-5",
                    is_default=True,
                    reasoning_efforts=None,
                    reasoning_default_enabled=None,
                )
            ]
        ),
    )
    client = _client()
    assert client.post("/optimizations/ai-generate-code", json=_SEED_BODY).status_code == 200
    assert (
        client.post(
            "/optimizations/ai-generate-code",
            json={**_SEED_BODY, "model": "auto:intelligent"},
        ).status_code
        == 200
    )
    assert [k["model"] for k in seen] == ["openrouter/anthropic/claude-sonnet-5"] * 2


def test_seed_endpoint_rejects_unknown_model(monkeypatch) -> None:
    """A non-catalog code-author model is refused before any LLM spend."""
    monkeypatch.setattr(
        model_catalog,
        "get_catalog_cached",
        lambda: SimpleNamespace(models=[SimpleNamespace(value="openai/gpt-test", is_default=False)]),
    )
    resp = _client().post("/optimizations/ai-generate-code", json={**_SEED_BODY, "model": "openai/not-a-model"})
    assert resp.status_code == 422
    assert resp.json()["code"] == "models.unknown_model"


_BLACKBOX_CONTEXT = {
    "recipe": "prompt",
    "objective": "Replies that resolve the ticket.",
    "target_kind": "text",
    "scorer_has_model": True,
}


def test_interview_forwards_blackbox_context_without_columns(monkeypatch) -> None:
    """A black-box interview may omit the dataset; its context reaches the engine as a dict."""
    seen: dict[str, Any] = {}

    async def fake_stream(**kwargs: Any) -> Any:
        """Record the forwarded kwargs and finish immediately."""
        seen.update(kwargs)
        yield {"event": "interview_done", "data": {"done": True}}

    monkeypatch.setattr(code_agent_router, "interview_turn_stream", fake_stream)
    resp = _client().post(
        "/optimizations/code-interview",
        json={
            "dataset_columns": [],
            "column_roles": {},
            "sample_rows": [{"ticket": "hi"}],
            "turns": [],
            "job_model": "",
            "blackbox": _BLACKBOX_CONTEXT,
        },
    )
    assert resp.status_code == 200
    assert seen["dataset_columns"] == []
    assert seen["blackbox"] == {
        **_BLACKBOX_CONTEXT,
        "background": "",
        "repository": "",
        "branch": "",
        "editable_paths": [],
        "focus": "goal",
    }


def test_interview_without_columns_or_blackbox_is_rejected() -> None:
    """The DSPy contract stays strict: no dataset and no black-box context is a 422."""
    resp = _client().post(
        "/optimizations/code-interview",
        json={"dataset_columns": [], "column_roles": {}, "sample_rows": [], "turns": [], "job_model": ""},
    )
    assert resp.status_code == 422


def test_seed_endpoint_forwards_blackbox_context(monkeypatch) -> None:
    """The seed endpoint passes the black-box context through and ``None`` without it."""
    seen: dict[str, Any] = {}
    monkeypatch.setattr(code_agent_router, "run_code_agent", _fake_run(seen))
    client = _client()
    assert client.post("/optimizations/ai-generate-code", json=_SEED_BODY).status_code == 200
    assert seen["blackbox"] is None

    resp = client.post(
        "/optimizations/ai-generate-code",
        json={**_SEED_BODY, "dataset_columns": [], "column_roles": {}, "blackbox": _BLACKBOX_CONTEXT},
    )
    assert resp.status_code == 200
    assert seen["dataset_columns"] == []
    assert seen["blackbox"] == {
        **_BLACKBOX_CONTEXT,
        "background": "",
        "repository": "",
        "branch": "",
        "editable_paths": [],
        "focus": "goal",
    }


def test_seed_endpoint_without_columns_or_blackbox_is_rejected() -> None:
    """An empty dataset without a black-box context is still a validation error."""
    resp = _client().post(
        "/optimizations/ai-generate-code",
        json={**_SEED_BODY, "dataset_columns": [], "column_roles": {}},
    )
    assert resp.status_code == 422


def _record_gates(monkeypatch, calls: dict[str, Any]) -> None:
    """Record the balance gate, the wizard quota and the store each turn is metered against."""
    monkeypatch.setattr(code_agent_router, "enforce_llm_balance", lambda *_a: calls.setdefault("balance", True))
    monkeypatch.setattr(code_agent_router, "consume_wizard_agent_turn", lambda *_a: calls.setdefault("quota", True))

    async def fake_metering(source: Any, *, job_store: Any, **_kwargs: Any) -> Any:
        """Note the billed store and pass the events through."""
        calls["billed_store"] = job_store
        async for event in source:
            yield event

    monkeypatch.setattr(code_agent_router, "stream_with_llm_metering", fake_metering)


def test_blackbox_agent_turn_uses_the_quota_not_credits(monkeypatch) -> None:
    """The wizard agent counts against the daily cap and streams unbilled."""
    calls: dict[str, Any] = {}
    _record_gates(monkeypatch, calls)
    monkeypatch.setattr(code_agent_router, "run_code_agent", _fake_run({}))
    resp = _client().post(
        "/optimizations/ai-generate-code",
        json={**_SEED_BODY, "user_message": "hi", "blackbox": _BLACKBOX_CONTEXT},
    )
    assert resp.status_code == 200
    assert calls == {"quota": True, "billed_store": None}


def test_dspy_agent_turn_still_charges(monkeypatch) -> None:
    """Every other authoring turn keeps the balance gate and is metered."""
    calls: dict[str, Any] = {}
    _record_gates(monkeypatch, calls)
    monkeypatch.setattr(code_agent_router, "run_code_agent", _fake_run({}))
    resp = _client().post("/optimizations/ai-generate-code", json={**_SEED_BODY, "user_message": "hi"})
    assert resp.status_code == 200
    assert "quota" not in calls
    assert calls["balance"] is True


def test_blackbox_interview_uses_the_quota_not_credits(monkeypatch) -> None:
    """The wizard's interview turns are free as well."""
    calls: dict[str, Any] = {}
    _record_gates(monkeypatch, calls)

    async def fake_stream(**_kwargs: Any) -> Any:
        """Finish at once."""
        yield {"event": "interview_done", "data": {"done": True}}

    monkeypatch.setattr(code_agent_router, "interview_turn_stream", fake_stream)
    resp = _client().post(
        "/optimizations/code-interview",
        json={
            "dataset_columns": [],
            "column_roles": {},
            "sample_rows": [],
            "turns": [],
            "job_model": "",
            "blackbox": _BLACKBOX_CONTEXT,
        },
    )
    assert resp.status_code == 200
    assert calls == {"quota": True, "billed_store": None}


def test_blackbox_daily_limit_is_a_429(monkeypatch) -> None:
    """At the cap the turn is refused before any agent work starts."""

    def at_cap(*_args: Any) -> None:
        """Refuse like the quota does at the cap."""
        raise DomainError("wizard_agent.daily_limit_reached", status=429, limit=50)

    monkeypatch.setattr(code_agent_router, "consume_wizard_agent_turn", at_cap)
    resp = _client().post(
        "/optimizations/ai-generate-code",
        json={**_SEED_BODY, "user_message": "hi", "blackbox": _BLACKBOX_CONTEXT},
    )
    assert resp.status_code == 429
    assert resp.json()["code"] == "wizard_agent.daily_limit_reached"


class _FakeBrowser:
    """A repository the kickoff measures as fitting or not, recording its key-file read."""

    def __init__(self, fits: bool) -> None:
        """Hold the measured verdict.

        Args:
            fits: What ``opening_fits`` answers.
        """
        self.repository = "acme/app"
        self.fits = fits
        self.preloaded = False

    def opening_fits(self) -> bool:
        """Answer the preset verdict."""
        return self.fits

    def preload_key_files(self) -> None:
        """Record the key-file read."""
        self.preloaded = True


def test_kickoff_within_budget_sends_the_hidden_opening_and_reads_key_files(monkeypatch) -> None:
    """A fitting repository gets the server's opening message, its key files and a quota turn."""
    seen: dict[str, Any] = {}
    calls: dict[str, Any] = {}
    browser = _FakeBrowser(fits=True)
    _record_gates(monkeypatch, calls)
    monkeypatch.setattr(code_agent_router, "run_code_agent", _fake_run(seen))
    monkeypatch.setattr(code_agent_router, "open_repo_browser", lambda *_args: browser)
    resp = _client().post(
        "/optimizations/ai-generate-code",
        json={**_SEED_BODY, "kickoff": True, "blackbox": _BLACKBOX_CONTEXT},
    )
    assert resp.status_code == 200
    assert seen["user_message"] == code_agent_router.KICKOFF_MESSAGE
    assert browser.preloaded is True
    assert calls["quota"] is True


def test_kickoff_over_budget_posts_the_fixed_opening_without_the_model(monkeypatch) -> None:
    """An oversized repository streams the fixed opening: no model call, no quota turn."""
    seen: dict[str, Any] = {}
    calls: dict[str, Any] = {}
    browser = _FakeBrowser(fits=False)
    _record_gates(monkeypatch, calls)
    monkeypatch.setattr(code_agent_router, "run_code_agent", _fake_run(seen))
    monkeypatch.setattr(code_agent_router, "open_repo_browser", lambda *_args: browser)
    resp = _client().post(
        "/optimizations/ai-generate-code",
        json={**_SEED_BODY, "kickoff": True, "blackbox": _BLACKBOX_CONTEXT},
    )
    assert resp.status_code == 200
    assert "event: kickoff_oversized" in resp.text
    assert '"subject": "repo"' in resp.text
    assert "acme/app" in resp.text
    assert seen == {}
    assert calls == {}
    assert browser.preloaded is False


def test_interview_opening_over_budget_posts_the_fixed_opening(monkeypatch) -> None:
    """An opening interview turn over a huge sample never reaches the model or the quota."""
    calls: dict[str, Any] = {}
    _record_gates(monkeypatch, calls)

    async def must_not_run(**_kwargs: Any) -> Any:
        """Fail the test if the engine is reached."""
        raise AssertionError("the model must not run")
        yield {}

    monkeypatch.setattr(code_agent_router, "interview_turn_stream", must_not_run)
    huge = [{"text": "x" * 20_000, "label": "y"} for _ in range(5)]
    resp = _client().post(
        "/optimizations/code-interview",
        json={**_INTERVIEW_BODY, "turns": [], "sample_rows": huge, "blackbox": _BLACKBOX_CONTEXT},
    )
    assert resp.status_code == 200
    assert "event: kickoff_oversized" in resp.text
    assert '"subject": "data"' in resp.text
    assert calls == {}


def test_interview_later_turns_skip_the_size_gate(monkeypatch) -> None:
    """Once the conversation started, a large sample no longer blocks the model."""
    _record_gates(monkeypatch, {})

    async def fake_stream(**_kwargs: Any) -> Any:
        """Finish at once."""
        yield {"event": "interview_done", "data": {"done": False}}

    monkeypatch.setattr(code_agent_router, "interview_turn_stream", fake_stream)
    huge = [{"text": "x" * 20_000, "label": "y"} for _ in range(5)]
    resp = _client().post("/optimizations/code-interview", json={**_INTERVIEW_BODY, "sample_rows": huge})
    assert resp.status_code == 200
    assert "event: interview_done" in resp.text


def test_kickoff_is_ignored_outside_blackbox(monkeypatch) -> None:
    """Without a black-box context the flag does nothing; the turn stays a seed."""
    seen: dict[str, Any] = {}
    _record_gates(monkeypatch, {})
    monkeypatch.setattr(code_agent_router, "run_code_agent", _fake_run(seen))
    resp = _client().post("/optimizations/ai-generate-code", json={**_SEED_BODY, "kickoff": True})
    assert resp.status_code == 200
    assert seen["user_message"] == ""
