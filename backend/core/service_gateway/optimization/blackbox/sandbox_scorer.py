"""Python scorers behind the sandbox seam: one box per job, one runner call per evaluation.

User scorer code never runs on the worker. :class:`SandboxPythonScorer`
opens a sandbox lazily on the first evaluation, ships :mod:`.runner` into
it once, and turns every ``(candidate, case)`` into a ``calls/NNNNNN/``
directory the runner scores from ``input.json`` into ``output.json``. The
scorer's ``llm()`` calls leave the box for the gateway
:func:`scorer_gateway` resolves; their token usage comes back with each
result and lands in a :class:`ScorerUsage` ledger the run's cost ceiling
and billing read like any other language model.
"""

from __future__ import annotations

import json
import logging
import re
import shlex
import threading
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from gepa.image import Image

from ....config import Settings, settings
from ....exceptions import ServiceError
from ....models.common import ModelConfig
from ...language_models import usage_by_model_from_history
from . import runner
from .agent_eval import gateway_from_settings
from .harness import ENV_API_KEY
from .protocol import Candidate, SideInfo
from .sandbox import SandboxRuntime, SandboxSession, SandboxSpec, scorer_runtime_from_settings

logger = logging.getLogger(__name__)

RUNNER_FILE = "skynet_runner.py"
RUNNER_SOURCE = Path(runner.__file__).read_text(encoding="utf-8")
CALLS_DIR = "calls"
_DEFAULT_PROBE_TIMEOUT_SECONDS = 45.0
# A probe's box only has to outlive one call plus interpreter start-up.
_PROBE_LIFETIME_ALLOWANCE_SECONDS = 120.0
_STDERR_TAIL_CHARS = 2_000
_OPENROUTER_PREFIX = "openrouter/"
_OPENROUTER_URL = "https://openrouter.ai/api/v1"
_DATA_IMAGE_PREFIX = "data:image/"
_NAME_UNSAFE = re.compile(r"[^a-z0-9-]+")
_USAGE_KEYS = ("prompt_tokens", "completion_tokens", "total_tokens")
_GATEWAY_MISSING = (
    "Scorer models need a gateway the sandboxes can reach: set LITELLM_PROXY_URL and "
    "LITELLM_PROXY_API_KEY, or BLACKBOX_AGENT_GATEWAY_URL and BLACKBOX_AGENT_GATEWAY_API_KEY."
)


@dataclass(frozen=True)
class ScorerGateway:
    """Where a sandboxed scorer's ``llm()`` calls go, and how the run bills them."""

    url: str
    model: str
    api_key: str | None
    billing_model: str
    temperature: float | None = None
    max_tokens: int | None = None
    timeout_seconds: float = 120.0

    def runner_payload(self) -> dict[str, Any]:
        """Return the ``gateway`` section of a runner call — the key travels separately."""
        return {
            "url": self.url,
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "timeout_seconds": self.timeout_seconds,
        }

    def injected_headers(self) -> dict[str, dict[str, str]]:
        """Return the headers a network edge adds to the box's requests to the gateway host, keyed by host."""
        host = urlsplit(self.url).hostname
        if not host or not self.api_key:
            return {}
        return {host: {"Authorization": f"Bearer {self.api_key}"}}


def _without_provider(name: str) -> str:
    """Drop the LiteLLM provider prefix a custom endpoint never sees.

    Args:
        name: A ``provider/model`` identifier.

    Returns:
        The identifier the endpoint is sent.
    """
    return name.split("/", 1)[1] if "/" in name else name


def scorer_gateway(config: ModelConfig, settings: Settings) -> ScorerGateway:
    """Resolve the gateway for the model chosen in the Scorer step.

    BYOK configs carry the user's key (the run-path bridge stamps it onto
    ``extra``) and go straight to their provider: the configured ``base_url``,
    else OpenRouter for ``openrouter/`` models. Managed configs go through the
    gateway sandboxes are pointed at — the agent gateway, else the LiteLLM
    proxy — which resolves OpenRouter models without their prefix.

    Args:
        config: The scorer's model configuration.
        settings: The backend settings.

    Returns:
        The gateway the runner posts chat completions to.

    Raises:
        ServiceError: When no reachable gateway can be resolved.
    """
    name = config.name
    common: dict[str, Any] = {
        "billing_model": name,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "timeout_seconds": settings.lm_request_timeout_seconds,
    }
    own_key = config.extra.get("api_key")
    if isinstance(own_key, str) and own_key:
        base_url = config.base_url or config.extra.get("api_base")
        if base_url:
            return ScorerGateway(
                url=str(base_url).rstrip("/"), model=_without_provider(name), api_key=own_key, **common
            )
        if name.startswith(_OPENROUTER_PREFIX):
            return ScorerGateway(url=_OPENROUTER_URL, model=name[len(_OPENROUTER_PREFIX) :], api_key=own_key, **common)
        raise ServiceError(
            f"Sandboxed scorers reach a BYOK model through OpenRouter or a base_url; '{name}' has neither."
        )
    gateway = gateway_from_settings(settings)
    if gateway is None:
        raise ServiceError(_GATEWAY_MISSING)
    return ScorerGateway(
        url=gateway.url, model=name.removeprefix(_OPENROUTER_PREFIX), api_key=gateway.api_key, **common
    )


class ScorerUsage:
    """Token ledger for one scorer's ``llm()`` calls, shaped like a ``dspy.LM`` for the usage helpers.

    ``model`` and ``history`` are all that ``usage_by_model_from_history``,
    ``lm_call_count`` and the cost ceiling read off a language model.
    """

    def __init__(self, model: str) -> None:
        """Start an empty ledger.

        Args:
            model: The model the pricing table bills these calls as.
        """
        self.model = model
        self.history: list[dict[str, Any]] = []

    def record(self, entries: Iterable[Mapping[str, Any]]) -> None:
        """Append one history entry per ``llm()`` call the runner reported.

        Args:
            entries: Usage dicts with ``prompt_tokens`` / ``completion_tokens`` / ``total_tokens``.
        """
        for entry in entries:
            self.history.append({"usage": {key: int(entry.get(key) or 0) for key in _USAGE_KEYS}})

    def by_model(self) -> dict[str, tuple[int, int]]:
        """Return ``model → (input_tokens, output_tokens)`` for everything recorded."""
        return dict(usage_by_model_from_history(self) or {})


@dataclass(frozen=True)
class ScorerProbeResult:
    """Outcome of scoring one candidate with python scorer code in a sandbox.

    ``error`` is set when the scorer itself raised or returned an unusable
    value; ``score`` and ``side_info`` are then empty. ``usage_by_model``
    is what the scorer's ``llm()`` calls consumed, for billing.
    """

    score: float | None
    side_info: dict[str, Any]
    error: str | None
    usage_by_model: dict[str, tuple[int, int]] = field(default_factory=dict)


def revive_images(side_info: Mapping[str, Any]) -> SideInfo:
    """Turn the data URLs the runner serialized images into back into ``Image`` values.

    Args:
        side_info: JSON-plain side information from a runner call.

    Returns:
        The same mapping with image strings wrapped for the reflection model.
    """
    return {
        key: Image(url=value) if isinstance(value, str) and value.startswith(_DATA_IMAGE_PREFIX) else value
        for key, value in side_info.items()
    }


def _tail(text: str) -> str:
    """Return the end of a command's output, enough to show why it died.

    Args:
        text: Captured stdout or stderr.

    Returns:
        The last ``_STDERR_TAIL_CHARS`` characters, stripped.
    """
    return text[-_STDERR_TAIL_CHARS:].strip()


def _sandbox_name(job_id: str | None) -> str | None:
    """Return a sandbox name that carries the job id in a form Vercel accepts.

    Args:
        job_id: The job the scorer belongs to, if any.

    Returns:
        The name, or ``None`` for anonymous boxes.
    """
    if not job_id:
        return None
    return _NAME_UNSAFE.sub("-", f"skynet-scorer-{job_id}".lower()).strip("-")[:60]


class SandboxPythonScorer:
    """A python scorer that runs inside a sandbox: one box per job, one runner call per evaluation.

    Calls are serialized; the engines' concurrency applies to agent targets,
    which open their own boxes. ``usage`` is the ledger the run bills, or
    ``None`` when the scorer has no model.
    """

    def __init__(
        self,
        code: str,
        *,
        runtime: SandboxRuntime,
        gateway: ScorerGateway | None,
        timeout_seconds: float,
        lifetime_seconds: float | None = None,
        job_id: str | None = None,
    ) -> None:
        """Bind scorer code to a runtime without opening anything yet.

        Args:
            code: User-authored scorer source.
            runtime: Where the box is opened.
            gateway: Where the scorer's ``llm()`` calls go; ``None`` when no model was chosen.
            timeout_seconds: Longest a single call may run.
            lifetime_seconds: Requested box lifetime; the configured ceiling when unset, and never above it.
            job_id: Names and tags the box after the job, when known.
        """
        self._code = code
        self._runtime = runtime
        self._gateway = gateway
        self._timeout_seconds = timeout_seconds
        ceiling = settings.vercel_sandbox_max_lifetime_seconds
        # The network edge adds the key to the gateway calls when the runtime has one, so the
        # box never holds it; otherwise it rides in the runner's environment, one call at a time.
        injected = gateway.injected_headers() if gateway is not None and runtime.injects_headers else {}
        self._env_key = gateway.api_key if gateway is not None and not injected else None
        self._spec = SandboxSpec(
            lifetime_seconds=ceiling if lifetime_seconds is None else min(lifetime_seconds, ceiling),
            name=_sandbox_name(job_id),
            tags={"skynet_job": job_id} if job_id else {},
            inject_headers=injected,
        )
        self._session: SandboxSession | None = None
        self._calls = 0
        self._lock = threading.Lock()
        self.usage: ScorerUsage | None = ScorerUsage(gateway.billing_model) if gateway is not None else None

    def __call__(self, candidate: Candidate, case: Any = None) -> tuple[float, SideInfo]:
        """Score ``candidate`` on ``case`` for the engines.

        Args:
            candidate: The version to score.
            case: The case to score it on, if the task has cases.

        Returns:
            The score and side information, images revived for the reflection model.

        Raises:
            ServiceError: When the scorer raised, timed out, returned no usable
                value, or the box could not run it.
        """
        probe = self.run(candidate, case)
        if probe.error is not None or probe.score is None:
            raise ServiceError(probe.error or "scorer returned no score.")
        return probe.score, revive_images(probe.side_info)

    def run(self, candidate: Candidate, case: Any = None) -> ScorerProbeResult:
        """Score ``candidate`` on ``case`` and report the scorer's own failure as data.

        Args:
            candidate: The version to score.
            case: The case to score it on, if any.

        Returns:
            Score and JSON-plain side information, or the scorer's error, plus
            what its ``llm()`` calls consumed.

        Raises:
            ServiceError: When the box could not run the scorer at all.
        """
        payload = {
            "code": self._code,
            "candidate": candidate,
            "case": case,
            "gateway": self._gateway.runner_payload() if self._gateway is not None else None,
        }
        with self._lock:
            try:
                result = self._invoke(payload)
            except ServiceError:
                raise
            except Exception:
                # The box died under us (lifetime reached, host recycled): one fresh box, one more try.
                logger.warning("scorer sandbox failed; reopening", exc_info=True)
                self._discard()
                result = self._invoke(payload)
        entries = list(result.get("usage") or [])
        if self.usage is not None:
            self.usage.record(entries)
        call_usage = ScorerUsage(self._gateway.billing_model) if self._gateway is not None else None
        if call_usage is not None:
            call_usage.record(entries)
        raw_score = result.get("score")
        return ScorerProbeResult(
            score=float(raw_score) if raw_score is not None else None,
            side_info=dict(result.get("side_info") or {}),
            error=result.get("error"),
            usage_by_model=call_usage.by_model() if call_usage is not None else {},
        )

    def close(self) -> None:
        """Destroy the box, if one is open. Never raises."""
        with self._lock:
            self._discard()

    def _invoke(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Run one runner call in the open (or newly opened) box.

        Args:
            payload: The runner's ``input.json`` content.

        Returns:
            The runner's ``output.json`` content, or a timeout error in its shape.

        Raises:
            ServiceError: When the runner produced no output.
        """
        session = self._open()
        self._calls += 1
        call_dir = f"{CALLS_DIR}/{self._calls:06d}"
        session.write_files(
            {f"{call_dir}/{runner.INPUT_FILE}": json.dumps(payload, default=runner.side_info_json_default)}
        )
        result = session.run(
            f"python3 {RUNNER_FILE} {shlex.quote(call_dir)}",
            env={ENV_API_KEY: self._env_key} if self._env_key else None,
            timeout_seconds=self._timeout_seconds,
        )
        if result.timed_out:
            return {
                "score": None,
                "side_info": {},
                "error": f"scorer exceeded the {self._timeout_seconds:g}s timeout",
                "usage": [],
            }
        text = session.read_file(f"{call_dir}/{runner.OUTPUT_FILE}")
        if text is None:
            raise ServiceError(
                f"scorer sandbox failed (exit {result.exit_code}): {_tail(result.stderr or result.stdout)}"
            )
        return json.loads(text)

    def _open(self) -> SandboxSession:
        """Return the job's box, opening it and installing the runner on first use."""
        if self._session is None:
            session = self._runtime.open(self._spec)
            try:
                session.write_files({RUNNER_FILE: RUNNER_SOURCE})
            except BaseException:
                session.close()
                raise
            self._session = session
        return self._session

    def _discard(self) -> None:
        """Close the box, if any, so the next call opens a fresh one."""
        if self._session is not None:
            self._session.close()
            self._session = None


def probe_scorer(
    *,
    scorer_code: str,
    candidate: Any,
    case: Any = None,
    scorer_model: dict[str, Any] | None = None,
    timeout_seconds: float = _DEFAULT_PROBE_TIMEOUT_SECONDS,
    runtime: SandboxRuntime | None = None,
) -> ScorerProbeResult:
    """Score one candidate with python scorer code in a throwaway sandbox.

    A scorer that raised on the candidate is reported via
    ``ScorerProbeResult.error`` — not as an exception from this function.
    Only ``ServiceError`` (no gateway, box failure) escapes.

    Args:
        scorer_code: User-authored scorer source.
        candidate: The version to score.
        case: The case to score it on, if any.
        scorer_model: Serialized ``ModelConfig`` for the scorer's ``llm()``
            helper, if a model was chosen.
        timeout_seconds: Longest the call may run.
        runtime: Where the box is opened; the configured runtime when unset.

    Returns:
        The score and side information, or the scorer's error, plus what
        its ``llm()`` calls consumed.

    Raises:
        ServiceError: When the gateway cannot be resolved or the box fails.
    """
    gateway = scorer_gateway(ModelConfig.model_validate(scorer_model), settings) if scorer_model else None
    scorer = SandboxPythonScorer(
        scorer_code,
        runtime=runtime or scorer_runtime_from_settings(settings),
        gateway=gateway,
        timeout_seconds=timeout_seconds,
        lifetime_seconds=timeout_seconds + _PROBE_LIFETIME_ALLOWANCE_SECONDS,
        job_id="probe",
    )
    try:
        return scorer.run(candidate, case)
    finally:
        scorer.close()
