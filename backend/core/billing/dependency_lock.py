"""Authenticate dependency locks before accepting their artifact fetch capabilities."""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

from ..config import settings
from ..models.scorer_dependencies import ScorerDependencyLock


def _signature(document: dict[str, Any]) -> str:
    """Bind exact artifact URLs, hashes, and runtime identity to the server secret.

    Args:
        document: Canonical dependency lock without its signature.

    Returns:
        HMAC used only by the trusted parent.
    """
    secret = settings.backend_auth_secret
    if not secret:
        raise ValueError("Dependency locks require the backend authentication secret.")
    key = secret.get_secret_value() if hasattr(secret, "get_secret_value") else str(secret)
    body = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(key.encode(), b"skynet-scorer-dependencies-v1:" + body, hashlib.sha256).hexdigest()


def sign_dependency_lock(document: dict[str, Any]) -> dict[str, Any]:
    """Sign a successfully resolved sandbox package set.

    Args:
        document: Complete dependency resolution and selected image/source.

    Returns:
        Schema-normalized lock with a parent-authenticated signature.
    """
    lock = ScorerDependencyLock.model_validate({**document, "signature": "0" * 64})
    body = lock.model_dump(mode="json", exclude={"signature"})
    return {**body, "signature": _signature(body)}


def verify_dependency_lock(document: dict[str, Any], *, image: str, code: str) -> ScorerDependencyLock:
    """Reject modified or stale locks before permitting package downloads.

    Args:
        document: User-supplied saved lock.
        image: Parent-selected immutable runtime image.
        code: Exact scorer source being tested or submitted.

    Returns:
        Authenticated lock matching this code and runtime.
    """
    lock = ScorerDependencyLock.model_validate(document)
    body = lock.model_dump(mode="json", exclude={"signature"})
    if not hmac.compare_digest(lock.signature, _signature(body)):
        raise ValueError("The dependency lock is invalid; resolve packages again.")
    if lock.image != image or lock.code_sha256 != hashlib.sha256(code.encode()).hexdigest():
        raise ValueError("The scorer or sandbox image changed; resolve packages again.")
    return lock
