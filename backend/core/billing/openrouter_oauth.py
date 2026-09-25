"""OpenRouter's PKCE sign-in flow, which mints a BYOK key without a pasted secret.

OpenRouter needs no registered OAuth app: the browser visits ``/auth`` with a
callback URL and an S256 challenge, comes back with a ``code``, and the code
plus verifier buy a user-controlled API key. That key is then saved through the
ordinary BYOK vault path, exactly as if the user had pasted it.

OpenRouter has no ``state`` parameter, so the encrypted state (initiating user
and PKCE verifier, Fernet under the vault key with a TTL) rides inside the
callback URL's own query string instead.
"""

from __future__ import annotations

import base64
import json
import secrets
from hashlib import sha256
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken

from ..api.errors import DomainError
from ..config import settings

PROVIDER = "openrouter"
AUTHORIZE_URL = "https://openrouter.ai/auth"
KEYS_URL = "https://openrouter.ai/api/v1/auth/keys"
STATE_TTL_SECONDS = 600
API_TIMEOUT = httpx.Timeout(30.0)


def oauth_available() -> bool:
    """Report whether "Continue with OpenRouter" can be offered.

    Returns:
        ``True`` when the vault key is configured, since both the state and the
        minted key are encrypted under it.
    """
    return settings.byok_vault_key is not None


def _cipher() -> Fernet:
    """Return the Fernet cipher built from the BYOK vault key.

    Returns:
        The cipher that seals the OAuth state.

    Raises:
        DomainError: 503 when no vault key is configured.
    """
    if settings.byok_vault_key is None:
        raise DomainError("billing.byok_not_configured", status=503)
    return Fernet(settings.byok_vault_key.get_secret_value().encode("utf-8"))


def build_authorize_url(username: str, callback_url: str) -> str:
    """Start the PKCE flow for ``username``.

    Args:
        username: The app user connecting their OpenRouter account.
        callback_url: This backend's callback route, before the state is added.

    Returns:
        The OpenRouter URL to send the browser to.

    Raises:
        DomainError: 503 when the vault is not configured.
    """
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    state = _cipher().encrypt(json.dumps({"u": username, "v": verifier}).encode("utf-8")).decode("ascii")
    separator = "&" if "?" in callback_url else "?"
    callback = f"{callback_url}{separator}{urlencode({'state': state})}"
    query = urlencode({"callback_url": callback, "code_challenge": challenge, "code_challenge_method": "S256"})
    return f"{AUTHORIZE_URL}?{query}"


def parse_state(state: str) -> dict[str, str]:
    """Decrypt and validate the state carried back on the callback URL.

    Args:
        state: The opaque state parameter.

    Returns:
        The ``{"u": username, "v": verifier}`` payload.

    Raises:
        DomainError: 400 when the state is forged, tampered with or older than
            :data:`STATE_TTL_SECONDS`; 503 when the vault is not configured.
    """
    try:
        payload = json.loads(_cipher().decrypt(state.encode("ascii"), ttl=STATE_TTL_SECONDS))
    except (InvalidToken, ValueError, UnicodeEncodeError) as exc:
        raise DomainError("billing.openrouter_oauth_state_invalid", status=400) from exc
    if not isinstance(payload, dict) or not all(isinstance(payload.get(k), str) for k in ("u", "v")):
        raise DomainError("billing.openrouter_oauth_state_invalid", status=400)
    return payload


def exchange_code(code: str, verifier: str) -> str:
    """Trade the callback's code for a user-controlled OpenRouter API key.

    Args:
        code: The ``code`` OpenRouter appended to the callback URL.
        verifier: The PKCE verifier minted in :func:`build_authorize_url`.

    Returns:
        The plaintext API key.

    Raises:
        DomainError: 502 when OpenRouter is unreachable; 400 when it refuses
            the code or answers without a key.
    """
    try:
        response = httpx.post(
            KEYS_URL,
            json={"code": code, "code_verifier": verifier, "code_challenge_method": "S256"},
            timeout=API_TIMEOUT,
        )
    except httpx.HTTPError as exc:
        raise DomainError("billing.openrouter_unreachable", status=502) from exc
    if response.status_code >= 400:
        raise DomainError("billing.openrouter_oauth_failed", status=400)
    try:
        body: Any = response.json()
    except ValueError as exc:
        raise DomainError("billing.openrouter_oauth_failed", status=400) from exc
    key = body.get("key") if isinstance(body, dict) else None
    if not isinstance(key, str) or not key.strip():
        raise DomainError("billing.openrouter_oauth_failed", status=400)
    return key.strip()
