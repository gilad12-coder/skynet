"""Use a scoped parent evaluator relay without receiving the external endpoint credential."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

import httpx

from ....billing.model_gateway import raise_gateway_stop
from ....exceptions import ServiceError


class RemoteEvaluatorClient:
    """Keep the original evaluator request/response protocol behind one opaque capability."""

    def __init__(self, route: Mapping[str, str], *, timeout_seconds: float) -> None:
        """Bind the parent-created relay while requiring its loopback-only transport.

        Args:
            route: Opaque parent evaluator URL and token.
            timeout_seconds: Original evaluator timeout plus the relay response margin.
        """
        self._route = dict(route)
        origin = urlsplit(route["url"])
        if (
            origin.scheme != "http"
            or origin.hostname not in {"127.0.0.1", "localhost", "::1"}
            or origin.username
            or origin.password
            or origin.path.rstrip("/") != "/v1"
            or origin.query
            or origin.fragment
            or not route.get("token")
        ):
            raise ServiceError("Remote evaluation requires its scoped parent relay.")
        self._timeout = timeout_seconds + 30

    def __call__(self, candidate: Any, case: Any = None) -> Any:
        """Return actual evaluator JSON or preserve a typed stop and HTTP failure.

        Args:
            candidate: Actual candidate selected by the optimizer or user preview.
            case: Original case supplied to the endpoint.

        Returns:
            Original JSON value for the existing score normalizer.
        """
        base = os.environ.get("SKYNET_BUDGET_RELAY_URL", self._route["url"]).rstrip("/")
        try:
            with httpx.Client(timeout=self._timeout, trust_env=False, follow_redirects=False) as client:
                response = client.post(
                    base + "/_evaluator",
                    headers={"Authorization": f"Bearer {self._route['token']}"},
                    json={"candidate": candidate, "case": case},
                )
            if not response.is_success:
                raise_gateway_stop(self._route)
                detail = response.text[:1500]
                raise ServiceError(f"remote scorer request failed (HTTP {response.status_code}): {detail}")
            return response.json()
        except httpx.HTTPError as error:
            raise ServiceError("The remote evaluator relay could not complete its request.") from error
        except ValueError as error:
            raise ServiceError("remote scorer returned a non-JSON body.") from error
