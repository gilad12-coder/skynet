"""Speech-to-text for composer dictation. [INTERNAL]

``POST /transcribe`` — accept one recorded clip (multipart ``audio`` plus an
optional ``language`` hint from the UI locale) and return its transcript.

Groq's LPU-served Whisper large-v3-turbo is the platform's sole dictation
provider: a clip returns in hundreds of milliseconds, and running one leg
keeps the failure surface honest — no key configured answers a typed 503 the
composer turns into a transient failure notice, a provider error answers 502.
The ``language`` field is accepted for wire compatibility but never
forwarded: Whisper treats the param as a directive, and the UI locale isn't
necessarily the spoken language.

Dictation is paid from the platform's Groq key, not from user credits, so it
is open only to accounts with skin in the game: a positive purchased credit
balance, an active Skynet Pro plan, or a verified BYOK key (the one-time free
grant alone does not qualify, or throwaway sign-ups could farm it). A caller
with a verified Groq BYOK key is transcribed on that key instead. Two limits
still bound every caller: a per-account hourly clip cap, and a platform-wide
monthly dollar budget counted from each platform-paid clip's billed duration.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ...billing.byok_vault import STATUS_VERIFIED, ProviderKeyVault
from ...config import settings
from ...storage.models import BillingCustomerModel
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError
from ..platform_budget import budget_open, record_spend
from ..rate_limit import RateLimiter, shared_redis_client

logger = logging.getLogger("skynet.api.transcription")

_GROQ_BASE = "https://api.groq.com/openai/v1"
_GROQ_MODEL = "whisper-large-v3-turbo"
# whisper's documented upload cap; dictation takes are far below it.
_MAX_AUDIO_MB = 25
_MAX_AUDIO_BYTES = _MAX_AUDIO_MB * 1024 * 1024
_HTTP_TIMEOUT_S = 120.0
# Groq's published whisper-large-v3-turbo rate, and its per-request billing floor.
_GROQ_DOLLARS_PER_AUDIO_HOUR = 0.04
_GROQ_MIN_BILLED_SECONDS = 10.0
_BUDGET_SERVICE = "groq"
_BYOK_PROVIDER = "groq"


def _groq_clip_cost(duration_seconds: float) -> float:
    """Return what Groq bills for one clip of ``duration_seconds``.

    Args:
        duration_seconds: Audio duration Groq reported for the clip.

    Returns:
        The cost in dollars.
    """
    return max(duration_seconds, _GROQ_MIN_BILLED_SECONDS) / 3600 * _GROQ_DOLLARS_PER_AUDIO_HOUR


class TranscriptionResponse(BaseModel):
    """Response body for ``POST /transcribe``: transcript plus provider used."""

    text: str
    provider: str


async def _groq_transcribe(
    client: httpx.AsyncClient, audio: bytes, filename: str, api_key: str
) -> tuple[str, float]:
    """Transcribe one clip via Whisper large-v3-turbo on Groq.

    Args:
        client: Shared HTTP client.
        audio: Raw audio bytes.
        filename: Client filename, used for container detection.
        api_key: Groq bearer token.

    Returns:
        The transcript text and the clip duration in seconds (0 when Groq
        omits it, which bills the per-request minimum).

    Raises:
        RuntimeError: On a non-OK provider response.
    """
    res = await client.post(
        f"{_GROQ_BASE}/audio/transcriptions",
        headers={"Authorization": f"Bearer {api_key}"},
        files={"file": (filename, audio)},
        data={"model": _GROQ_MODEL, "response_format": "verbose_json"},
    )
    if res.status_code >= 400:
        raise RuntimeError(f"groq transcribe: {res.status_code}")
    body = res.json()
    return str(body.get("text") or ""), float(body.get("duration") or 0.0)


def _own_groq_key(engine: Any, username: str) -> str | None:
    """Return the caller's verified Groq BYOK secret, or None.

    Args:
        engine: SQLAlchemy engine backing the vault, or ``None``.
        username: The caller.

    Returns:
        The decrypted key when the caller has a verified Groq connection that
        the vault can decrypt; otherwise None, which routes to the platform key.
    """
    if engine is None:
        return None
    vault = ProviderKeyVault(engine=engine)
    try:
        if not vault.has_verified_connection(username, _BYOK_PROVIDER):
            return None
        connection = vault.resolve_connection(username, _BYOK_PROVIDER, verified_only=True)
    except DomainError as err:
        logger.warning("groq byok key unusable for %s: %s", username, err.code)
        return None
    return connection.secret if connection is not None else None


def _eligible_for_platform_dictation(job_store: Any, username: str) -> bool:
    """Return whether the caller may dictate on the platform's Groq key.

    Args:
        job_store: Store exposing ``engine`` and, with a database, ``has_pro_plan``.
        username: The caller.

    Returns:
        True for a positive purchased balance, an active Pro plan, or any
        verified BYOK key.
    """
    engine = getattr(job_store, "engine", None)
    if engine is None:
        # No billing tables to consult (in-memory dev store): nothing to gate on.
        return True
    with Session(engine) as session:
        customer = session.get(BillingCustomerModel, username)
        if customer is not None and int(customer.credit_balance) > 0:
            return True
    has_pro_plan = getattr(job_store, "has_pro_plan", None)
    if callable(has_pro_plan) and has_pro_plan(username):
        return True
    keys = ProviderKeyVault(engine=engine).list_keys(username).keys
    return any(key.status == STATUS_VERIFIED for key in keys)


def create_transcription_router(job_store: Any) -> APIRouter:
    """Build the dictation transcription router.

    Args:
        job_store: Store whose engine backs the billing and BYOK tables used
            for the eligibility check.

    Returns:
        A configured :class:`APIRouter` exposing ``POST /transcribe``.
    """
    router = APIRouter()

    @router.post(
        "/transcribe",
        response_model=TranscriptionResponse,
        summary="Transcribe one recorded audio clip to text",
    )
    async def transcribe(
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
        audio: Annotated[UploadFile, File()],
        language: Annotated[str | None, Form()] = None,
    ) -> TranscriptionResponse:
        """Run the clip through Groq Whisper and return the transcript.

        Args:
            user: Authenticated caller (dictation is login-gated like the
                composers that host it); keys the hourly clip cap.
            audio: The recorded clip (webm/opus everywhere, AAC-in-MP4 on
                Safari).
            language: Optional BCP-47 tag from the UI locale; accepted but
                unused — Whisper auto-detects the spoken language.

        Returns:
            The transcript and which provider produced it.

        Raises:
            DomainError: 413 when the clip exceeds the size cap, 402 when the
                caller is not eligible for platform-paid dictation, 429 when
                the caller is over the hourly clip cap, 503 when no Groq key is
                configured or the monthly budget is spent, 502 when the
                provider call failed.
        """
        del language
        data = await audio.read()
        if len(data) > _MAX_AUDIO_BYTES:
            raise DomainError("transcription.too_large", status=413, max_mb=_MAX_AUDIO_MB)
        own_key = _own_groq_key(getattr(job_store, "engine", None), user.username)
        if own_key is None:
            if not settings.groq_api_key:
                raise DomainError("transcription.unconfigured", status=503)
            if not _eligible_for_platform_dictation(job_store, user.username):
                raise DomainError("transcription.not_eligible", status=402)
        RateLimiter(shared_redis_client()).enforce(
            f"transcribe:{user.username}",
            limit=settings.rate_limit_transcriptions_per_hour,
            window_seconds=3600,
        )
        budget = settings.groq_monthly_budget_usd
        if own_key is None and not budget_open(_BUDGET_SERVICE, budget):
            raise DomainError("transcription.budget_exhausted", status=503)
        filename = audio.filename or "take.webm"
        api_key = own_key or settings.groq_api_key.get_secret_value()

        async with httpx.AsyncClient(timeout=httpx.Timeout(_HTTP_TIMEOUT_S)) as client:
            try:
                text, duration = await _groq_transcribe(client, data, filename, api_key)
            except (RuntimeError, httpx.HTTPError, KeyError, ValueError) as err:
                logger.warning("transcription failed (groq): %s", err)
                raise DomainError("transcription.failed", status=502) from err
        if own_key is None:
            record_spend(_BUDGET_SERVICE, _groq_clip_cost(duration), budget)
        return TranscriptionResponse(text=text, provider="groq")

    return router
