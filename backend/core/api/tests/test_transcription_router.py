"""Tests for the dictation transcription route (Groq-only + guards).

Mounts the router with the auth dependency overridden and the Groq leg
monkeypatched — no network. Covers the unconfigured 503, the size-cap 413,
the happy path, the provider-failure 502, and the hourly clip cap and monthly
Groq budget against an in-memory Redis double.
"""

from __future__ import annotations

import fakeredis
import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from pydantic import SecretStr

from ...config import settings
from .. import platform_budget
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError
from ..routers import transcription
from ..routers.transcription import create_transcription_router

_USER = AuthenticatedUser(username="alice", role="user", groups=())


def _client() -> TestClient:
    """Mount the transcription router authed as a fixed user."""
    app = FastAPI()
    app.include_router(create_transcription_router())
    app.dependency_overrides[get_authenticated_user] = lambda: _USER

    @app.exception_handler(DomainError)
    async def _domain_error_handler(_request, exc: DomainError) -> JSONResponse:
        """Mirror the app-level envelope so tests can assert on ``code``."""
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "code": exc.code, "params": exc.params},
        )

    return TestClient(app)


def _post_audio(client: TestClient, payload: bytes = b"RIFFxxxx") -> httpx.Response:
    """POST a small multipart clip to /transcribe."""
    return client.post(
        "/transcribe",
        files={"audio": ("take.webm", payload, "audio/webm")},
        data={"language": "he-IL"},
    )


def test_unconfigured_returns_typed_503(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without a Groq key, the route answers an honest 503."""
    monkeypatch.setattr(settings, "groq_api_key", None)
    resp = _post_audio(_client())
    assert resp.status_code == 503
    assert resp.json()["code"] == "transcription.unconfigured"


def test_oversized_clip_rejected_413(monkeypatch: pytest.MonkeyPatch) -> None:
    """A clip over the cap is rejected before the provider is contacted."""
    monkeypatch.setattr(settings, "groq_api_key", SecretStr("gsk-test"))
    monkeypatch.setattr(transcription, "_MAX_AUDIO_BYTES", 4)
    resp = _post_audio(_client(), payload=b"12345")
    assert resp.status_code == 413
    assert resp.json()["code"] == "transcription.too_large"


def test_groq_leg_returns_transcript(monkeypatch: pytest.MonkeyPatch) -> None:
    """With a Groq key set, the leg serves the transcript."""
    monkeypatch.setattr(settings, "groq_api_key", SecretStr("gsk-test"))

    seen: dict[str, str] = {}

    async def _fake_groq(_client, _audio, _filename, key) -> tuple[str, float]:
        seen["key"] = key
        return "מהיר מאוד", 3.0

    monkeypatch.setattr(transcription, "_groq_transcribe", _fake_groq)
    resp = _post_audio(_client())
    assert resp.status_code == 200
    assert resp.json() == {"text": "מהיר מאוד", "provider": "groq"}
    assert seen == {"key": "gsk-test"}


def test_provider_failure_returns_502(monkeypatch: pytest.MonkeyPatch) -> None:
    """A failing Groq call answers a typed 502."""
    monkeypatch.setattr(settings, "groq_api_key", SecretStr("gsk-test"))

    async def _boom(_client, _audio, _filename, _key) -> tuple[str, float]:
        raise RuntimeError("groq transcribe: 500")

    monkeypatch.setattr(transcription, "_groq_transcribe", _boom)
    resp = _post_audio(_client())
    assert resp.status_code == 502
    assert resp.json()["code"] == "transcription.failed"


@pytest.fixture
def redis_double(monkeypatch: pytest.MonkeyPatch) -> fakeredis.FakeStrictRedis:
    """Point the clip cap and the Groq budget at one in-memory Redis."""
    client = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr(transcription, "shared_redis_client", lambda: client)
    monkeypatch.setattr(platform_budget, "shared_redis_client", lambda: client)
    monkeypatch.setattr(settings, "groq_api_key", SecretStr("gsk-test"))
    return client


def _count_groq_calls(monkeypatch: pytest.MonkeyPatch, duration: float = 3.0) -> list[int]:
    """Stub the Groq leg and return a list that grows by one per call."""
    calls: list[int] = []

    async def _fake_groq(_client, _audio, _filename, _key) -> tuple[str, float]:
        calls.append(1)
        return "hi", duration

    monkeypatch.setattr(transcription, "_groq_transcribe", _fake_groq)
    return calls


def test_clip_cost_bills_the_ten_second_floor() -> None:
    """Short clips bill Groq's 10 s minimum; longer ones bill their length."""
    assert transcription._groq_clip_cost(3.0) == pytest.approx(10 / 3600 * 0.04)
    assert transcription._groq_clip_cost(0.0) == pytest.approx(10 / 3600 * 0.04)
    assert transcription._groq_clip_cost(90.0) == pytest.approx(90 / 3600 * 0.04)


def test_spent_budget_refuses_without_calling_groq(
    monkeypatch: pytest.MonkeyPatch, redis_double: fakeredis.FakeStrictRedis
) -> None:
    """Once the month's Groq budget is spent, dictation answers a typed 503."""
    monkeypatch.setattr(settings, "groq_monthly_budget_usd", 0.001)
    calls = _count_groq_calls(monkeypatch, duration=120.0)
    client = _client()
    assert _post_audio(client).status_code == 200
    resp = _post_audio(client)
    assert resp.status_code == 503
    assert resp.json()["code"] == "transcription.budget_exhausted"
    assert len(calls) == 1


def test_hourly_clip_cap_answers_429(monkeypatch: pytest.MonkeyPatch, redis_double: fakeredis.FakeStrictRedis) -> None:
    """A caller over the hourly clip cap is refused before Groq is called."""
    monkeypatch.setattr(settings, "rate_limit_transcriptions_per_hour", 2)
    calls = _count_groq_calls(monkeypatch)
    client = _client()
    assert [_post_audio(client).status_code for _ in range(3)] == [200, 200, 429]
    assert len(calls) == 2
