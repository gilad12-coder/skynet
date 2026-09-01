"""Scorer adapters for black-box runs: sandboxed python code and remote HTTP endpoints.

Both adapters normalize to the engine contract ``(score, side_info)``, carry
a ``usage`` ledger the run bills (``None`` for remote scorers, whose calls
cost the run nothing) and a ``close()`` the run calls when it is done.
Python scorers run inside a sandbox — see :mod:`.sandbox_scorer`; the
helpers here are thin wrappers over :mod:`.runner`, the stdlib-only module
that executes scorer code in the box, translating its errors into the
worker's ``ServiceError``.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol

import httpx

from ....config import settings
from ....exceptions import ServiceError
from ....models.blackbox import BlackboxScorer
from . import runner
from .protocol import Candidate, SideInfo
from .sandbox import SandboxRuntime, scorer_runtime_from_settings
from .sandbox_scorer import SandboxPythonScorer, ScorerUsage, scorer_gateway


class JobScorer(Protocol):
    """What a run needs from a scorer beyond scoring: its usage ledger and a way to shut it down."""

    usage: ScorerUsage | None

    def __call__(self, candidate: Candidate, case: Any = None) -> tuple[float, SideInfo]:
        """Score ``candidate`` on ``case``.

        Args:
            candidate: The version to score.
            case: The case to score it on, if the task has cases.

        Returns:
            The score and side information.
        """
        ...

    def close(self) -> None:
        """Release whatever the scorer holds. Never raises."""
        ...


def normalize_score(raw: Any) -> tuple[float, SideInfo]:
    """Coerce a scorer's return value into ``(score, side_info)``.

    Accepted shapes: a number; ``(number, side_info)``; a mapping with a
    ``score`` key (remaining keys become side info); an object with a
    numeric ``score`` attribute.

    Args:
        raw: Whatever the scorer returned.

    Returns:
        The float score and a side-info mapping (empty when none was given).

    Raises:
        ServiceError: When the value has none of the accepted shapes.
    """
    try:
        return runner.normalize_score(raw)
    except runner.ScorerError as exc:
        raise ServiceError(str(exc)) from exc


def load_scorer_from_code(code: str, *, helpers: dict[str, Any] | None = None) -> Callable[..., Any]:
    """Execute scorer source and return the callable it defines.

    Looks for ``score`` then ``metric``, then falls back to the single
    function the code defines.

    Args:
        code: User-authored python source.
        helpers: Names bound in the scorer's namespace before it runs.

    Returns:
        The scorer callable.

    Raises:
        ServiceError: When the code fails to compile or load, or defines no
            unambiguous scorer function.
    """
    try:
        return runner.load_scorer_from_code(code, helpers=helpers)
    except runner.ScorerError as exc:
        raise ServiceError(str(exc)) from exc


class RemoteScorer:
    """Scorer that POSTs ``{"candidate", "case"}`` to a user-owned endpoint."""

    usage = None

    def __init__(self, url: str, *, secret: str | None, timeout_seconds: float) -> None:
        """Create a remote scorer.

        Args:
            url: Endpoint that returns a JSON number or ``{"score": ..., ...}``.
            secret: Shared secret sent as a bearer token, if any.
            timeout_seconds: Per-request timeout.
        """
        self._url = url
        self._secret = secret
        self._timeout_seconds = timeout_seconds

    def __call__(self, candidate: Candidate, case: Any = None) -> tuple[float, SideInfo]:
        """Score ``candidate`` on ``case`` via one HTTP request.

        Args:
            candidate: The version to score.
            case: The case to score it on, if the task has cases.

        Returns:
            The normalized score and side information.

        Raises:
            ServiceError: When the request fails, returns an error status,
                a non-JSON body, or a body without a usable score.
        """
        headers = {"Authorization": f"Bearer {self._secret}"} if self._secret else {}
        try:
            response = httpx.post(
                self._url,
                json={"candidate": candidate, "case": case},
                headers=headers,
                timeout=self._timeout_seconds,
            )
            response.raise_for_status()
            body = response.json()
        except httpx.HTTPError as exc:
            raise ServiceError(f"remote scorer request failed: {exc}") from exc
        except ValueError as exc:
            raise ServiceError("remote scorer returned a non-JSON body.") from exc
        return normalize_score(body)

    def close(self) -> None:
        """Nothing to release: each call is one stateless request."""


def build_scorer(
    spec: BlackboxScorer, *, job_id: str | None = None, runtime: SandboxRuntime | None = None
) -> JobScorer:
    """Build the engine-facing scorer for a request's scorer spec.

    Args:
        spec: The submitted scorer definition.
        job_id: Names the python scorer's sandbox after the job, when known.
        runtime: Where python scorers open their sandbox; the configured
            runtime when unset.

    Returns:
        A scorer over ``(candidate, case)`` → ``(score, side_info)``.

    Raises:
        ServiceError: When a python scorer's model has no reachable gateway
            or the required sandbox runtime is not configured.
    """
    if spec.kind == "remote":
        return RemoteScorer(str(spec.url), secret=spec.secret, timeout_seconds=spec.timeout_seconds)
    return SandboxPythonScorer(
        str(spec.metric_code),
        runtime=runtime or scorer_runtime_from_settings(settings),
        gateway=scorer_gateway(spec.model, settings) if spec.model is not None else None,
        timeout_seconds=spec.timeout_seconds,
        job_id=job_id,
        install_command=spec.install_command,
    )
