"""Tests for the dictation transcription route (Groq-only + guards).

Mounts the router with the auth dependency overridden and the Groq leg
monkeypatched — no network. Covers the unconfigured 503, the size-cap 413,
the happy path, the provider-failure 502, and the hourly clip cap and monthly
Groq budget against an in-memory Redis double. Eligibility (paid balance, Pro,
or BYOK) and the caller's own Groq key run against an in-memory SQLite engine.
"""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import fakeredis
import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...billing.byok_vault import ProviderKeyVault
from ...config import settings
from ...storage.models import Base, BillingCustomerModel
from .. import platform_budget
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError
from ..routers import transcription
from ..routers.transcription import create_transcription_router

_USER = AuthenticatedUser(username="alice", role="user", groups=())


def _client(job_store: Any = None) -> TestClient:
    """Mount the transcription router authed as a fixed user.

    Args:
        job_store: Store backing the eligibility check; the default has no
            engine, so there are no billing tables to gate on.

    Returns:
        A test client for the mounted router.
    """
    app = FastAPI()
    app.include_router(create_transcription_router(job_store=job_store or SimpleNamespace()))
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


class _BillingStore:
    """Job-store stand-in exposing an engine and a switchable Pro flag."""

    def __init__(self, engine: Any, *, pro: bool = False) -> None:
        """Bind the engine and the Pro answer.

        Args:
            engine: SQLAlchemy engine with the billing tables.
            pro: What ``has_pro_plan`` returns.
        """
        self.engine = engine
        self._pro = pro

    def has_pro_plan(self, username: str) -> bool:
        """Return the configured Pro flag for any user."""
        return self._pro


@pytest.fixture
def billing_engine(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """Yield an in-memory SQLite engine with billing tables and a vault key."""
    monkeypatch.setattr(settings, "byok_vault_key", SecretStr(Fernet.generate_key().decode("utf-8")))
    monkeypatch.setattr(settings, "groq_api_key", SecretStr("gsk-platform"))
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    yield engine
    Base.metadata.drop_all(engine)


def _save_key(engine: Any, provider: str, secret: str) -> None:
    """Store and verify a BYOK key for the test user without a network probe."""
    ok = SimpleNamespace(status_code=200, is_success=True)
    with patch("core.billing.byok_vault.httpx.get", return_value=ok):
        ProviderKeyVault(engine=engine).save_key(_USER.username, provider, secret)


def _seen_keys(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Stub the Groq leg and return the list of API keys it was called with."""
    keys: list[str] = []

    async def _fake_groq(_client, _audio, _filename, key) -> tuple[str, float]:
        keys.append(key)
        return "hi", 3.0

    monkeypatch.setattr(transcription, "_groq_transcribe", _fake_groq)
    return keys


def test_free_grant_only_account_is_not_eligible(monkeypatch: pytest.MonkeyPatch, billing_engine: Any) -> None:
    """No paid balance, no Pro and no BYOK key answers 402 before Groq is called."""
    keys = _seen_keys(monkeypatch)
    resp = _post_audio(_client(_BillingStore(billing_engine)))
    assert resp.status_code == 402
    assert resp.json()["code"] == "transcription.not_eligible"
    assert keys == []


def test_paid_balance_makes_account_eligible(monkeypatch: pytest.MonkeyPatch, billing_engine: Any) -> None:
    """A positive purchased balance unlocks platform-paid dictation."""
    with Session(billing_engine) as session:
        session.add(BillingCustomerModel(username=_USER.username, stripe_customer_id="cus_1", balance_cents=5))
        session.commit()
    keys = _seen_keys(monkeypatch)
    assert _post_audio(_client(_BillingStore(billing_engine))).status_code == 200
    assert keys == ["gsk-platform"]


def test_pro_plan_makes_account_eligible(monkeypatch: pytest.MonkeyPatch, billing_engine: Any) -> None:
    """An active Pro plan unlocks platform-paid dictation with no balance."""
    keys = _seen_keys(monkeypatch)
    assert _post_audio(_client(_BillingStore(billing_engine, pro=True))).status_code == 200
    assert keys == ["gsk-platform"]


def test_any_verified_byok_key_makes_account_eligible(monkeypatch: pytest.MonkeyPatch, billing_engine: Any) -> None:
    """A verified non-Groq BYOK key unlocks dictation on the platform key."""
    _save_key(billing_engine, "openai", "sk-own-openai")
    keys = _seen_keys(monkeypatch)
    assert _post_audio(_client(_BillingStore(billing_engine))).status_code == 200
    assert keys == ["gsk-platform"]


def test_own_groq_key_is_used_and_skips_platform_budget(
    monkeypatch: pytest.MonkeyPatch, billing_engine: Any, redis_double: fakeredis.FakeStrictRedis
) -> None:
    """A verified Groq BYOK key transcribes on that key, even with the platform budget spent."""
    _save_key(billing_engine, "groq", "gsk-own")
    monkeypatch.setattr(settings, "groq_api_key", None)
    monkeypatch.setattr(settings, "groq_monthly_budget_usd", 0.000001)
    keys = _seen_keys(monkeypatch)
    client = _client(_BillingStore(billing_engine))
    assert [_post_audio(client).status_code for _ in range(2)] == [200, 200]
    assert keys == ["gsk-own", "gsk-own"]
    assert not list(redis_double.scan_iter("skynet:platform-budget:groq*"))
