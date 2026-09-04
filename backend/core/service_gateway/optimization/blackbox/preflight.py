"""Verify Anything inputs from inside the selected outer execution sandbox."""

from __future__ import annotations

import ast
import time
from typing import Any

from ....billing.model_gateway import ROUTE_KEY
from ....billing.runtime import UsagePendingError
from ....config import settings
from ....exceptions import ServiceError
from ....models import BlackboxRunRequest
from ....models.blackbox import BlackboxScorer, BlackboxTarget
from ....models.common import SplitFractions
from ..data import split_examples
from .harness import GatewayConfig
from .native_runtime import NativeOptions, check_native_runtime
from .sandbox import SandboxRuntime, sandbox_runtime_context
from .sandbox_scorer import SandboxPythonScorer, scorer_gateway
from .scorer import build_scorer
from .service import _agent_scorer, validate_blackbox_payload


def _check(key: str, status: str, message: str | None = None, field: str | None = None) -> dict[str, Any]:
    """Build one scoped readiness result."""
    return {
        "key": key,
        "status": status,
        **({"message": message} if message else {}),
        **({"field": field} if field else {}),
    }


def _sample(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Choose one visible training or validation case.

    Args:
        payload: Canonical scorer inputs and split configuration.

    Returns:
        One non-held-out case, or None for a task without cases.
    """
    cases = payload.get("cases") or []
    if not cases:
        return None
    splits = split_examples(
        cases,
        SplitFractions.model_validate(payload.get("split_fractions") or {}),
        shuffle=payload.get("shuffle", True),
        seed=payload.get("seed") or 0,
    )
    eligible = splits.train or splits.val
    if not eligible:
        raise ValueError("Setup needs at least one training or validation case; held-out data is never used.")
    return eligible[0]


def _needs_model(code: str) -> bool:
    """Detect direct scorer model helper use before an inherited model is chosen."""
    tree = ast.parse(code)
    return any(isinstance(node, ast.Name) and node.id == "llm" for node in ast.walk(tree))


def verify_anything_in_sandbox(
    payload: dict[str, Any], *, scope: str, identity: str, runtime: SandboxRuntime
) -> dict[str, Any]:
    """Verify evaluator, target, and optimizer dependencies in one outer sandbox.

    Args:
        payload: Protected Anything request containing opaque parent capabilities.
        scope: Evaluation or complete execution readiness.
        identity: Stable preflight evidence identity.
        runtime: Contained command runtime bound to the selected outer sandbox.

    Returns:
        Real readiness checks and, when a seed exists, its actual scorer preview.
    """
    scorer = BlackboxScorer.model_validate(payload.get("scorer") or {})
    remote = scorer.kind == "remote"
    code = str(scorer.metric_code)
    if not remote and scorer.model is None and _needs_model(code):
        return {
            "checks": [
                _check(
                    "scorer.model",
                    "pending",
                    "Choose the model on Optimization to finish this evaluator check.",
                    "scorer.model",
                )
            ]
        }
    if remote:
        route = payload.get("_skynet_evaluator_route")
        if not route:
            raise ValueError("Remote evaluation requires its protected parent relay.")
        scorer_instance = build_scorer(scorer, job_id=identity, protected_route=route)
    else:
        scorer_instance = SandboxPythonScorer(
            code,
            runtime=runtime,
            gateway=scorer_gateway(scorer.model, settings) if scorer.model else None,
            timeout_seconds=scorer.timeout_seconds,
            lifetime_seconds=scorer.timeout_seconds + 60,
            install_command=scorer.install_command,
            job_id=identity,
        )
    checks: list[dict[str, Any]] = []
    result: dict[str, Any] = {"checks": checks}
    started = time.perf_counter()
    with sandbox_runtime_context(runtime):
        try:
            candidate = payload.get("seed_candidate")
            if candidate is None:
                if not remote:
                    scorer_instance.check_ready()
                else:
                    result["evaluator_readiness"] = {
                        "endpoint": "validated_and_pinned",
                        "candidate_evaluation": "awaiting_first_generated_candidate",
                        "external_service_fees": "excluded_from_skynet_total",
                    }
                checks.append(
                    _check(
                        "scorer.readiness",
                        "succeeded",
                        "Endpoint validated; its response will be checked with the first generated candidate."
                        if remote
                        else "Evaluator loads; scoring waits for the first generated candidate.",
                    )
                )
                if scope == "execution":
                    target = BlackboxTarget.model_validate(payload.get("target") or {})
                    if target.kind == "agent":
                        agent = _agent_scorer(
                            scorer_instance,
                            target,
                            job_id=identity,
                            progress_callback=None,
                            agent_run_sink=None,
                            target_route=payload.get("_skynet_target_route"),
                        )
                        result["agent_readiness"] = agent.check_ready()
                        checks.append(
                            _check(
                                "target.readiness",
                                "succeeded",
                                "Harness readiness verified; candidate execution waits for the first generated candidate.",
                                "target",
                            )
                        )
            else:
                target = BlackboxTarget.model_validate(payload.get("target") or {})
                if target.kind == "agent":
                    evaluate = _agent_scorer(
                        scorer_instance,
                        target,
                        job_id=identity,
                        progress_callback=None,
                        agent_run_sink=None,
                        target_route=payload.get("_skynet_target_route"),
                    )
                    score, side_info = evaluate(candidate, _sample(payload))
                    preview = {"ok": True, "score": score, "side_info": side_info}
                elif remote:
                    try:
                        score, side_info = scorer_instance(candidate, _sample(payload))
                        preview = {"ok": True, "score": score, "side_info": side_info}
                    except ServiceError as error:
                        preview = {"ok": False, "score": None, "side_info": {}, "error": str(error)}
                else:
                    probe = scorer_instance.run(candidate, _sample(payload))
                    preview = {
                        "ok": probe.error is None,
                        "score": probe.score,
                        "side_info": probe.side_info,
                        "error": probe.error,
                    }
                checks.append(
                    _check("scorer", "succeeded" if preview["ok"] else "failed", preview.get("error"), "scorer")
                )
                result["scorer_result"] = {
                    **preview,
                    "elapsed_ms": (time.perf_counter() - started) * 1000,
                }
            if scope == "execution":
                public = {key: value for key, value in payload.items() if not key.startswith("_")}
                typed = BlackboxRunRequest.model_validate(public)
                validate_blackbox_payload(typed, verify_scorer=False)
                native = typed.strategy.mode != "single" or typed.strategy.engine in {"meta_harness", "autoresearch"}
                if native:
                    route = typed.reflection_model_settings.extra[ROUTE_KEY]
                    check_native_runtime(
                        NativeOptions(
                            runtime=typed.proposer_runtime,
                            model=route["model"],
                            gateway=GatewayConfig(url=route["url"], api_key=route["token"]),
                            max_token_cost=0,
                            budget_route=route,
                            sandbox_runtime=runtime,
                        )
                    )
                checks.append(_check("optimizer", "succeeded"))
        finally:
            try:
                scorer_instance.close()
            except UsagePendingError:
                checks.append(_check("usage", "pending", "Sandbox usage is awaiting confirmation."))
    return result
