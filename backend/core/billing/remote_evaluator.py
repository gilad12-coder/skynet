"""Relay one selected external evaluator without exposing its destination or credential."""

from __future__ import annotations

import asyncio
import math
from collections.abc import Callable, Mapping
from typing import Any

import httpx

from .credential_safety import credential_fragments, redact_secret_bytes
from .mcp_broker import _pinned_address, _PinnedTransport
from .model_dispatch import ModelHTTPResult


class RemoteEvaluatorTransportError(RuntimeError):
    """Mark a parent-to-evaluator network failure without exposing destination details."""


class RemoteEvaluatorBroker:
    """Retain the fixed evaluator endpoint in the parent and preserve its original HTTP protocol."""

    def __init__(
        self,
        url: str,
        *,
        secret: str | None,
        timeout_seconds: float,
        check_admission: Callable[[], None],
        allow_private: bool = False,
    ) -> None:
        """Validate and pin the selected evaluator before any candidate request.

        Args:
            url: Owner-selected HTTP endpoint, including its original path and query.
            secret: Optional original bearer credential retained in the parent.
            timeout_seconds: Request timeout without retries.
            check_admission: Generation and cancellation guard for this run or setup.
            allow_private: Explicit deployment permission for private endpoints.
        """
        if not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 600:
            raise ValueError("The remote evaluator timeout must be greater than zero and at most 600 seconds.")
        self._url = url
        self._address = _pinned_address(url, allow_private, label="remote evaluator endpoint")
        self._secret = secret
        self._redactions = credential_fragments(secret, endpoint=url)
        self._timeout = timeout_seconds
        self._check_admission = check_admission

    async def _request(self, body: Mapping[str, Any]) -> ModelHTTPResult:
        """POST the actual candidate once to the fixed endpoint without redirects.

        Args:
            body: Original candidate/case protocol body.

        Returns:
            Actual HTTP status and body, including endpoint validation failures.
        """
        headers = {"Authorization": f"Bearer {self._secret}"} if self._secret else {}
        async with httpx.AsyncClient(
            transport=_PinnedTransport(self._url, self._address),
            timeout=self._timeout,
            follow_redirects=False,
            trust_env=False,
        ) as client:
            self._check_admission()
            response = await client.post(self._url, json=dict(body), headers=headers)
            return ModelHTTPResult(
                response.status_code,
                response.headers.get("Content-Type", "application/json"),
                redact_secret_bytes(response.content, self._redactions),
            )

    def dispatch(self, body: Mapping[str, Any]) -> ModelHTTPResult:
        """Forward one allowed evaluator request without inventing a Skynet charge.

        Args:
            body: JSON object containing only candidate and optional case.

        Returns:
            Actual endpoint response; external service fees remain outside Skynet Total.
        """
        candidate = body.get("candidate")
        if set(body).difference({"candidate", "case"}) or not (
            isinstance(candidate, str)
            or (
                isinstance(candidate, dict)
                and candidate
                and all(isinstance(key, str) and isinstance(value, str) for key, value in candidate.items())
            )
        ):
            raise ValueError("The evaluator relay requires an actual text candidate and optional case.")
        self._check_admission()
        try:
            return asyncio.run(self._request({"candidate": candidate, "case": body.get("case")}))
        except httpx.HTTPError as error:
            raise RemoteEvaluatorTransportError(
                "The selected remote evaluator could not complete its request."
            ) from error
