"""Tests for the sandboxed python scorer: file contract, gateway resolution, usage billing and probes."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest
from gepa.image import Image

from core.exceptions import ServiceError
from core.models.common import ModelConfig
from core.service_gateway.language_models import lm_call_count, total_tokens_from_history, usage_by_model_from_history

from .. import sandbox_scorer as sandbox_scorer_mod
from ..harness import GatewayConfig
from ..sandbox import CommandResult, LocalSubprocessRuntime
from ..sandbox_scorer import (
    CALLS_DIR,
    RUNNER_FILE,
    RUNNER_SOURCE,
    SandboxPythonScorer,
    ScorerGateway,
    ScorerProbeResult,
    ScorerUsage,
    probe_scorer,
    revive_images,
    scorer_gateway,
)
from .mocks import VOWEL_SCORER_CODE, FakeGateway, FakeSandboxRuntime, FakeSandboxSession

Responder = Callable[[dict[str, Any]], "CommandResult | dict[str, Any]"]

_GATEWAY = ScorerGateway(
    url="http://gw.example/v1", model="judge", api_key="k", billing_model="fake/judge", timeout_seconds=9.0
)
_OK = {"score": 0.5, "side_info": {}, "error": None, "usage": []}
_LLM_SCORER = "def score(candidate, case=None):\n    return float(llm(candidate, case['input']))\n"


class _RunnerSession(FakeSandboxSession):
    """Fake box that understands the runner's file contract and answers from a callback."""

    def __init__(self, respond: Responder) -> None:
        """Remember the responder.

        Args:
            respond: Turns the call payload into an output document or a raw command result.
        """
        super().__init__()
        self._respond = respond
        self.envs: list[dict[str, str] | None] = []
        self.timeouts: list[float | None] = []
        self.payloads: list[dict[str, Any]] = []

    def run(
        self, command: str, *, env: dict[str, str] | None = None, timeout_seconds: float | None = None
    ) -> CommandResult:
        """Execute a runner invocation against the callback.

        Args:
            command: ``python3 skynet_runner.py <call_dir>``.
            env: Per-call environment.
            timeout_seconds: Per-call timeout.

        Returns:
            The command result (success unless the callback returned one).
        """
        self.commands.append(command)
        self.envs.append(dict(env) if env is not None else None)
        self.timeouts.append(timeout_seconds)
        call_dir = command.split()[-1]
        payload = json.loads(self.files[f"{call_dir}/input.json"])
        self.payloads.append(payload)
        answer = self._respond(payload)
        if isinstance(answer, CommandResult):
            return answer
        self.files[f"{call_dir}/output.json"] = json.dumps(answer)
        return CommandResult(exit_code=0)


def _runtime(respond: Responder, *, injects_headers: bool = False) -> FakeSandboxRuntime:
    """Runtime whose boxes answer through ``respond``.

    Args:
        respond: The responder.
        injects_headers: Whether the runtime claims a header-injecting network edge.

    Returns:
        A fake runtime.
    """
    return FakeSandboxRuntime(lambda: _RunnerSession(respond), injects_headers=injects_headers)


def _usage(*pairs: tuple[int, int]) -> list[dict[str, int]]:
    """Build runner usage entries.

    Args:
        *pairs: ``(prompt_tokens, completion_tokens)`` per llm call.

    Returns:
        Usage entries as the runner reports them.
    """
    return [{"prompt_tokens": p, "completion_tokens": c, "total_tokens": p + c} for p, c in pairs]


def test_sandbox_scorer_installs_the_runner_once_and_runs_one_call_per_directory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The runner ships on first use, every call gets its own directory, and the gateway key travels only via env."""
    # Pin the ceiling: a developer's .env may raise it above the 2700 default.
    monkeypatch.setattr(sandbox_scorer_mod.settings, "vercel_sandbox_max_lifetime_seconds", 2_700)
    runtime = _runtime(lambda payload: {**_OK, "score": len(payload["candidate"]), "usage": _usage((3, 1))})
    scorer = SandboxPythonScorer(
        "def score(c): return 1", runtime=runtime, gateway=_GATEWAY, timeout_seconds=7.5, job_id="job-1"
    )

    assert scorer("abc") == (3.0, {})
    assert scorer("hello", {"input": "x"}) == (5.0, {})
    scorer.close()

    [spec] = runtime.specs
    assert spec.name == "skynet-scorer-job-1"
    assert spec.tags == {"skynet_job": "job-1"}
    assert spec.lifetime_seconds == 2_700
    assert spec.inject_headers == {}
    [box] = runtime.sessions
    assert box.files[RUNNER_FILE] == RUNNER_SOURCE
    assert box.commands == [f"python3 {RUNNER_FILE} {CALLS_DIR}/000001", f"python3 {RUNNER_FILE} {CALLS_DIR}/000002"]
    assert box.envs == [{"SKYNET_API_KEY": "k"}, {"SKYNET_API_KEY": "k"}]
    assert box.timeouts == [7.5, 7.5]
    assert box.payloads[1]["candidate"] == "hello"
    assert box.payloads[1]["case"] == {"input": "x"}
    assert box.payloads[1]["code"] == "def score(c): return 1"
    assert box.payloads[1]["gateway"] == {
        "url": "http://gw.example/v1",
        "model": "judge",
        "temperature": None,
        "max_tokens": None,
        "timeout_seconds": 9.0,
    }
    assert "api_key" not in box.payloads[1]["gateway"]
    assert box.closed is True
    assert scorer.usage is not None
    assert usage_by_model_from_history(scorer.usage) == {"fake/judge": (6, 2)}
    assert lm_call_count(scorer.usage) == 2
    assert total_tokens_from_history(scorer.usage) == 8


def test_sandbox_scorer_without_a_model_sends_no_gateway_and_bills_nothing() -> None:
    """No model chosen: the payload has no gateway, the env carries no key, and there is no usage ledger."""
    runtime = _runtime(lambda payload: _OK)
    scorer = SandboxPythonScorer("def score(c): return 0.5", runtime=runtime, gateway=None, timeout_seconds=5)

    assert scorer("x") == (0.5, {})

    [box] = runtime.sessions
    assert box.payloads[0]["gateway"] is None
    assert box.envs == [None]
    assert runtime.specs[0].name is None
    assert runtime.specs[0].tags == {}
    assert scorer.usage is None


def test_sandbox_scorer_reports_scorer_errors_and_still_bills_the_tokens() -> None:
    """``run()`` returns the error as data; ``__call__`` raises it; tokens spent before the failure are billed."""
    runtime = _runtime(
        lambda payload: {"score": None, "side_info": {}, "error": "ValueError: bad candidate", "usage": _usage((4, 4))}
    )
    scorer = SandboxPythonScorer(
        "def score(c): raise ValueError('bad candidate')", runtime=runtime, gateway=_GATEWAY, timeout_seconds=5
    )

    probe = scorer.run("x")
    assert probe == ScorerProbeResult(
        score=None, side_info={}, error="ValueError: bad candidate", usage_by_model={"fake/judge": (4, 4)}
    )
    with pytest.raises(ServiceError, match="ValueError: bad candidate"):
        scorer("x")

    assert usage_by_model_from_history(scorer.usage) == {"fake/judge": (8, 8)}


def test_sandbox_scorer_revives_images_for_the_optimizer_but_not_for_probes() -> None:
    """Data-URL side info becomes ``Image`` objects on the engine path and stays a plain string in ``run()``."""
    data_url = "data:image/png;base64,aGk="
    runtime = _runtime(lambda payload: {**_OK, "side_info": {"render": data_url, "note": "n"}})
    scorer = SandboxPythonScorer("def score(c): return 0.5", runtime=runtime, gateway=None, timeout_seconds=5)

    score, side_info = scorer("x")
    probe = scorer.run("x")

    assert score == 0.5
    assert isinstance(side_info["render"], Image)
    assert side_info["render"].url == data_url
    assert side_info["note"] == "n"
    assert probe.side_info == {"render": data_url, "note": "n"}


def test_sandbox_scorer_turns_a_timed_out_call_into_a_scorer_error() -> None:
    """The box's timeout is reported as the scorer's timeout, in the user's units."""
    runtime = _runtime(lambda payload: CommandResult(exit_code=137, timed_out=True))
    scorer = SandboxPythonScorer("def score(c): return 1", runtime=runtime, gateway=None, timeout_seconds=2.5)

    assert scorer.run("x").error == "scorer exceeded the 2.5s timeout"
    with pytest.raises(ServiceError, match=r"scorer exceeded the 2\.5s timeout"):
        scorer("x")


def test_sandbox_scorer_reports_a_runner_crash_with_the_tail_of_stderr() -> None:
    """No ``output.json`` means the runner itself died: the exit code and the end of stderr are surfaced."""
    stderr = "x" * 5_000 + "\nTraceback: boom"
    runtime = _runtime(lambda payload: CommandResult(exit_code=3, stderr=stderr))
    scorer = SandboxPythonScorer("def score(c): return 1", runtime=runtime, gateway=None, timeout_seconds=5)

    with pytest.raises(ServiceError, match=r"(?s)scorer sandbox failed \(exit 3\): .*Traceback: boom$") as excinfo:
        scorer("x")

    assert len(str(excinfo.value)) <= len("scorer sandbox failed (exit 3): ") + 2_000


def test_sandbox_scorer_reopens_the_box_once_when_it_dies() -> None:
    """A dead box (a raw exception from the session) is discarded and the call retried in a fresh one."""
    attempts: list[int] = []

    def respond(payload: dict[str, Any]) -> dict[str, Any]:
        """Fail the first call outright, then answer normally."""
        attempts.append(1)
        if len(attempts) == 1:
            raise OSError("box went away")
        return _OK

    runtime = _runtime(respond)
    scorer = SandboxPythonScorer("def score(c): return 1", runtime=runtime, gateway=None, timeout_seconds=5)

    assert scorer("x") == (0.5, {})
    assert scorer("y") == (0.5, {})

    first, second = runtime.sessions
    assert first.closed is True
    assert second.closed is False
    assert second.commands == [f"python3 {RUNNER_FILE} {CALLS_DIR}/000002", f"python3 {RUNNER_FILE} {CALLS_DIR}/000003"]
    assert RUNNER_FILE in second.files


def test_sandbox_scorer_gives_up_after_one_reopen() -> None:
    """A box that dies twice in a row surfaces the underlying error."""

    def respond(payload: dict[str, Any]) -> dict[str, Any]:
        """Always fail."""
        raise OSError("still dead")

    scorer = SandboxPythonScorer("def score(c): return 1", runtime=_runtime(respond), gateway=None, timeout_seconds=5)

    with pytest.raises(OSError, match="still dead"):
        scorer("x")


def test_sandbox_scorer_close_is_safe_before_and_after_use() -> None:
    """Closing an unopened or already-closed scorer does nothing."""
    runtime = _runtime(lambda payload: _OK)
    scorer = SandboxPythonScorer("def score(c): return 1", runtime=runtime, gateway=None, timeout_seconds=5)

    scorer.close()
    scorer("x")
    scorer.close()
    scorer.close()

    assert runtime.sessions[0].closed is True
    assert len(runtime.sessions) == 1


def test_scorer_usage_records_entries_in_the_lm_history_shape() -> None:
    """Missing counters default to zero so the shared usage helpers can read the ledger."""
    ledger = ScorerUsage("m")

    ledger.record([{"prompt_tokens": 2}, {}])

    assert ledger.model == "m"
    assert ledger.history == [
        {"usage": {"prompt_tokens": 2, "completion_tokens": 0, "total_tokens": 0}},
        {"usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}},
    ]
    assert ledger.by_model() == {"m": (2, 0)}


def test_scorer_gateway_for_managed_models_uses_the_shared_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    """Managed models go through the LiteLLM gateway with the ``openrouter/`` prefix stripped."""
    monkeypatch.setattr(
        sandbox_scorer_mod,
        "gateway_from_settings",
        lambda settings: GatewayConfig(url="http://gw/v1", api_key="gw-key"),
    )
    config = ModelConfig(name="openrouter/openai/gpt-4o", temperature=0.3, max_tokens=50)

    gateway = scorer_gateway(config, SimpleNamespace(lm_request_timeout_seconds=33.0))

    assert gateway == ScorerGateway(
        url="http://gw/v1",
        model="openai/gpt-4o",
        api_key="gw-key",
        billing_model="openrouter/openai/gpt-4o",
        temperature=0.3,
        max_tokens=50,
        timeout_seconds=33.0,
    )
    assert gateway.runner_payload() == {
        "url": "http://gw/v1",
        "model": "openai/gpt-4o",
        "temperature": 0.3,
        "max_tokens": 50,
        "timeout_seconds": 33.0,
    }


def test_scorer_gateway_for_managed_models_needs_a_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without a reachable gateway a managed scorer model is a configuration error."""
    monkeypatch.setattr(sandbox_scorer_mod, "gateway_from_settings", lambda settings: None)

    with pytest.raises(ServiceError, match="LITELLM_PROXY_URL"):
        scorer_gateway(ModelConfig(name="openrouter/openai/gpt-4o"), SimpleNamespace(lm_request_timeout_seconds=33.0))


@pytest.mark.parametrize(
    ("config", "url", "model"),
    [
        (
            ModelConfig(name="openrouter/anthropic/claude", token_source="byok", extra={"api_key": "byok"}),
            "https://openrouter.ai/api/v1",
            "anthropic/claude",
        ),
        (
            ModelConfig(
                name="openai/gpt-4o",
                token_source="byok",
                base_url="https://proxy.example/v1/",
                extra={"api_key": "byok"},
            ),
            "https://proxy.example/v1",
            "gpt-4o",
        ),
        (
            ModelConfig(
                name="gpt-4o", token_source="byok", extra={"api_key": "byok", "api_base": "https://proxy.example/v1"}
            ),
            "https://proxy.example/v1",
            "gpt-4o",
        ),
    ],
)
def test_scorer_gateway_for_byok_models_talks_to_the_provider_directly(
    config: ModelConfig, url: str, model: str
) -> None:
    """BYOK models use the user's key against OpenRouter or their own base URL.

    Args:
        config: The BYOK model.
        url: Expected gateway URL.
        model: Expected wire model name.
    """
    gateway = scorer_gateway(config, SimpleNamespace(lm_request_timeout_seconds=12.0))

    assert (gateway.url, gateway.model, gateway.api_key, gateway.billing_model) == (url, model, "byok", config.name)
    assert gateway.timeout_seconds == 12.0


def test_scorer_gateway_for_byok_models_needs_a_reachable_endpoint() -> None:
    """A BYOK model with neither an OpenRouter prefix nor a base URL cannot be reached from a box."""
    with pytest.raises(ServiceError, match="OpenRouter or a base_url"):
        scorer_gateway(
            ModelConfig(name="gpt-4o", token_source="byok", extra={"api_key": "byok"}),
            SimpleNamespace(lm_request_timeout_seconds=1.0),
        )


def test_revive_images_only_touches_data_urls() -> None:
    """Image data URLs become ``Image`` objects; other strings and values are untouched."""
    revived = revive_images({"render": "data:image/png;base64,aGk=", "url": "https://x/y.png", "n": 1})

    assert isinstance(revived["render"], Image)
    assert revived["render"].url == "data:image/png;base64,aGk="
    assert revived["url"] == "https://x/y.png"
    assert revived["n"] == 1


def test_probe_scorer_runs_the_real_runner_through_the_local_runtime() -> None:
    """End to end on the host: the vowel scorer scores a seed and returns its side info."""
    probe = probe_scorer(scorer_code=VOWEL_SCORER_CODE, candidate="aeiou", runtime=LocalSubprocessRuntime())

    assert probe == ScorerProbeResult(score=1.0, side_info={"vowels": 5}, error=None, usage_by_model={})


@pytest.mark.parametrize(
    ("code", "error"),
    [
        ("def score(c, case=None): raise ValueError('bad candidate')", "ValueError: bad candidate"),
        ("def score(c, case=None): return 'nope'", "scorer must return"),
        ("def !!!", "scorer code has a syntax error"),
        (_LLM_SCORER, "no model was chosen in the Scorer step"),
    ],
)
def test_probe_scorer_reports_failures_as_data(code: str, error: str) -> None:
    """Probe failures come back in ``error`` rather than as exceptions.

    Args:
        code: The scorer source.
        error: Expected fragment of the error.
    """
    probe = probe_scorer(scorer_code=code, candidate="x", case={"input": "i"}, runtime=LocalSubprocessRuntime())

    assert probe.score is None
    assert error in (probe.error or "")


def test_probe_scorer_carries_large_side_info_and_images_back_from_the_box() -> None:
    """Multi-megabyte side info, image objects and odd types all survive the file round trip."""
    code = (
        "def score(candidate, case=None):\n"
        "    return 0.5, {'blob': 'x' * 3_000_000, 'render': Image(base64_data='aGk=', media_type='image/png'), 'odd': {1, 2}}\n"
    )

    probe = probe_scorer(scorer_code=code, candidate="x", runtime=LocalSubprocessRuntime())

    assert probe.error is None
    assert probe.score == 0.5
    assert len(probe.side_info["blob"]) == 3_000_000
    assert probe.side_info["render"] == "data:image/png;base64,aGk="
    assert probe.side_info["odd"] == "{1, 2}"


def test_probe_scorer_stops_a_scorer_that_outruns_its_timeout() -> None:
    """A hanging scorer is killed at the deadline and reported as a timeout."""
    started = time.monotonic()

    probe = probe_scorer(
        scorer_code="import time\ndef score(c, case=None):\n    time.sleep(30)\n    return 1\n",
        candidate="x",
        timeout_seconds=1,
        runtime=LocalSubprocessRuntime(),
    )

    assert probe.error == "scorer exceeded the 1s timeout"
    assert time.monotonic() - started < 10


def test_probe_scorer_calls_the_gateway_from_inside_the_box_and_bills_the_tokens() -> None:
    """The scorer's ``llm()`` reaches the gateway with the key from the environment and its usage is returned."""
    with FakeGateway(reply="0.75", usage=(5, 2)) as judge:
        gateway = ScorerGateway(url=judge.url, model="judge", api_key="secret-key", billing_model="fake/judge")
        runtime = LocalSubprocessRuntime()
        scorer = SandboxPythonScorer(_LLM_SCORER, runtime=runtime, gateway=gateway, timeout_seconds=30)
        try:
            probe = scorer.run("rate me", {"input": "the text"})
        finally:
            scorer.close()

    assert probe == ScorerProbeResult(score=0.75, side_info={}, error=None, usage_by_model={"fake/judge": (5, 2)})
    [request] = judge.requests
    assert request["authorization"] == "Bearer secret-key"
    assert request["body"]["model"] == "judge"
    assert request["body"]["messages"] == [
        {"role": "system", "content": "rate me"},
        {"role": "user", "content": "the text"},
    ]
    assert usage_by_model_from_history(scorer.usage) == {"fake/judge": (5, 2)}


def test_sandbox_scorer_leaves_the_key_to_the_network_edge_when_the_runtime_injects_it() -> None:
    """On a runtime with a header-injecting edge the key rides in the spec; the box's environment never sees it."""
    runtime = _runtime(lambda payload: _OK, injects_headers=True)
    scorer = SandboxPythonScorer("def score(c): return 1", runtime=runtime, gateway=_GATEWAY, timeout_seconds=5)

    scorer("abc")
    scorer.close()

    [spec] = runtime.specs
    assert spec.inject_headers == {"gw.example": {"Authorization": "Bearer k"}}
    [box] = runtime.sessions
    assert box.envs == [None]
    assert "api_key" not in box.payloads[0]["gateway"]


def test_sandbox_scorer_injects_nothing_without_a_key() -> None:
    """A keyless gateway adds no injection rule and no environment."""
    runtime = _runtime(lambda payload: _OK, injects_headers=True)
    gateway = ScorerGateway(url="http://gw.example/v1", model="m", api_key=None, billing_model="b")
    scorer = SandboxPythonScorer("def score(c): return 1", runtime=runtime, gateway=gateway, timeout_seconds=5)

    scorer("abc")
    scorer.close()

    assert runtime.specs[0].inject_headers == {}
    assert runtime.sessions[0].envs == [None]


def test_sandbox_scorer_caps_the_lifetime_at_the_configured_ceiling(monkeypatch: pytest.MonkeyPatch) -> None:
    """``VERCEL_SANDBOX_MAX_LIFETIME_SECONDS`` is the default lifetime and the cap on a requested one."""
    monkeypatch.setattr(sandbox_scorer_mod.settings, "vercel_sandbox_max_lifetime_seconds", 100.0)
    lifetimes = []
    for requested in (None, 50.0, 500.0):
        runtime = _runtime(lambda payload: _OK)
        scorer = SandboxPythonScorer(
            "def score(c): return 1", runtime=runtime, gateway=None, timeout_seconds=5, lifetime_seconds=requested
        )
        scorer("abc")
        scorer.close()
        lifetimes.append(runtime.specs[0].lifetime_seconds)

    assert lifetimes == [100.0, 50.0, 100.0]
