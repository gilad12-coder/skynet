"""The unified workspace contract: does the code fit the optimizer the user chose?

The resolved optimizer fixes the metric's shape (:func:`metric_shape_for`).
The static check reads the source in a subprocess, never executing it in
the API process: the run code must define ``run(artifact, input)`` (or
``build_program()`` for a DSPy program), the metric entrypoint's arity must
fit the shape, and a metric that calls ``llm`` needs a metric model.
The sandboxed check then runs the starting version through the code and the
metric on a few training/validation cases (never test) and reports the
user's exact error, user-code frames only, when anything does not fit.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from ....i18n import t
from ....models.unified import (
    ContractCheckItem,
    ContractCheckResponse,
    ContractSample,
    MetricShape,
    UnifiedRunRequest,
    metric_shape_for,
    resolve_optimizer,
)
from ...safe_exec import FunctionShape, WorkspaceCodeIntrospection, introspect_workspace_code
from ..blackbox.harness import GatewayConfig
from ..blackbox.sandbox import SandboxRuntime
from ..blackbox.workspace_harness import DETAIL_MAX_CHARS
from ..blackbox.workspace_scorer import WorkspaceProbe, build_workspace_scorer
from .split import contract_samples, split_cases, split_seed

PREVIEW_CHARS = 500
# Positional slots each shape's caller fills, and at least how many the metric must accept.
_METRIC_SLOTS: dict[str, tuple[str, int, int]] = {
    "dspy_feedback": ("metric", 5, 5),
    "dspy_scalar": ("metric", 3, 3),
    # ``expected`` is optional: the harness passes it only when the function accepts it.
    "blackbox_side_info": ("score", 2, 2),
}
_SIGNATURE_KEYS: dict[str, str] = {
    "dspy_feedback": "contract.metric_signature.dspy_feedback",
    "dspy_scalar": "contract.metric_signature.dspy_scalar",
    "blackbox_side_info": "contract.metric_signature.blackbox",
}
_SHAPE_KEYS: dict[str, str] = {
    "dspy_feedback": "contract.shape.dspy_feedback",
    "dspy_scalar": "contract.shape.dspy_scalar",
    "blackbox_side_info": "contract.shape.blackbox",
}


def contract_fingerprint(payload: UnifiedRunRequest) -> str:
    """Hash everything a contract check's verdict depends on.

    Args:
        payload: The unified run.

    Returns:
        The sha256 hex digest of the canonical JSON of the artifact, the data
        (inline cases or the staged dataset id), data mode, input and expected
        fields, split and shuffle, resolved optimizer, both pieces of code, the
        task and metric models' names and the metric timeout.
    """
    data = payload.data
    task_model = payload.models.task_model
    metric_model = payload.models.metric_model
    # The sampled check draws its cases through the split, so different data
    # or a different split can flip the verdict even with identical code.
    cases = None if data.cases is None else [case.model_dump(mode="json") for case in data.cases]
    body = {
        "artifact": payload.task.artifact.model_dump(mode="json"),
        "data_mode": data.mode,
        "cases": cases,
        "staged_dataset_id": data.staged_dataset_id if data.cases is None else None,
        "input_fields": list(data.input_fields),
        "expected_field": data.expected_field,
        "split": data.split.model_dump(mode="json"),
        "shuffle": data.shuffle,
        "optimizer_resolved": resolve_optimizer(payload.optimizer.choice, payload.task.artifact.kind),
        "run_code": payload.workspace.run_code,
        "metric_code": payload.workspace.metric_code,
        "task_model": task_model.name if task_model is not None else None,
        "metric_model": metric_model.name if metric_model is not None else None,
        "metric_timeout_seconds": payload.workspace.metric_timeout_seconds,
    }
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _item(
    key: str,
    passed: bool,
    message_key: str,
    *,
    detail: str | None = None,
    sample_index: int | None = None,
    **params: Any,
) -> ContractCheckItem:
    """Build one check item, its message localized.

    Args:
        key: The contract check key.
        passed: Whether the check passed.
        message_key: i18n key of the failure message.
        detail: Exact error text for a failure.
        sample_index: The sample the item is about, if any.
        **params: Placeholders for the failure message.

    Returns:
        The item; a passing item carries the shared passed message.
    """
    return ContractCheckItem(
        key=key,  # type: ignore[arg-type]
        status="passed" if passed else "failed",
        message=t("contract.passed") if passed else t(message_key, **params),
        sample_index=sample_index,
        detail=None if passed or detail is None else detail[-DETAIL_MAX_CHARS:],
    )


def _fits(shape: FunctionShape | None, slots: int, at_least: int) -> bool:
    """Return whether a function can be called with ``slots`` positional arguments.

    Args:
        shape: The function's declared arity; unknown arity always fits.
        slots: Positional arguments its caller passes at most.
        at_least: Positional parameters it must accept.

    Returns:
        True when the declared signature fits the call.
    """
    if shape is None:
        return False
    if shape.capacity is None or shape.required is None:
        return True
    return shape.capacity >= at_least and shape.required <= slots


def _run_item(kind: str, code: WorkspaceCodeIntrospection) -> ContractCheckItem:
    """Check the run code defines the entrypoint its artifact kind needs.

    Args:
        kind: The artifact kind.
        code: The run code's introspection.

    Returns:
        The ``workspace.run_signature`` item.
    """
    if kind == "dspy_program":
        ok = code.syntax_error is None and _fits(code.functions.get("build_program"), 0, 0)
        return _item("workspace.run_signature", ok, "contract.build_program_missing", detail=code.syntax_error)
    ok = code.syntax_error is None and _fits(code.functions.get("run"), 2, 2)
    return _item("workspace.run_signature", ok, "contract.run_missing", detail=code.syntax_error)


def _metric_items(
    payload: UnifiedRunRequest, shape: MetricShape, code: WorkspaceCodeIntrospection
) -> list[ContractCheckItem]:
    """Check the metric entrypoint fits the shape and has a model if it calls one.

    Args:
        payload: The unified run.
        shape: The resolved optimizer's metric shape.
        code: The metric code's introspection.

    Returns:
        The ``metric.signature`` and ``metric.model`` items.
    """
    name, slots, at_least = _METRIC_SLOTS[shape]
    function = code.functions.get(name)
    if code.syntax_error is not None:
        signature = _item("metric.signature", False, "contract.metric_missing", detail=code.syntax_error)
    elif function is None:
        signature = _item(
            "metric.signature", False, "contract.metric_missing", detail=f"NameError: {name} is not defined"
        )
    else:
        signature = _item("metric.signature", _fits(function, slots, at_least), _SIGNATURE_KEYS[shape])
    model = _item(
        "metric.model",
        not code.uses_llm or payload.models.metric_model is not None,
        "contract.metric_model_missing",
    )
    return [signature, model]


def _static_items(payload: UnifiedRunRequest) -> tuple[list[ContractCheckItem], bool]:
    """Run every source-level check.

    Args:
        payload: The unified run.

    Returns:
        The run signature, metric signature and metric model items, and
        whether the metric code calls ``llm``.
    """
    shape = metric_shape_for(payload.optimizer.choice, payload.task.artifact.kind)
    run_code = introspect_workspace_code(payload.workspace.run_code)
    metric_code = introspect_workspace_code(payload.workspace.metric_code)
    items = [_run_item(payload.task.artifact.kind, run_code), *_metric_items(payload, shape, metric_code)]
    return items, metric_code.uses_llm


def _response(
    payload: UnifiedRunRequest,
    checks: list[ContractCheckItem],
    samples: list[ContractSample],
    *,
    uses_llm: bool,
) -> ContractCheckResponse:
    """Assemble a contract check response.

    Args:
        payload: The unified run.
        checks: Every check item.
        samples: The scored samples, if any.
        uses_llm: Whether the metric code calls ``llm``.

    Returns:
        The response; ``ok`` only when every item passed.
    """
    return ContractCheckResponse(
        ok=bool(checks) and all(check.status == "passed" for check in checks),
        optimizer_resolved=resolve_optimizer(payload.optimizer.choice, payload.task.artifact.kind),
        metric_shape=metric_shape_for(payload.optimizer.choice, payload.task.artifact.kind),
        uses_llm=uses_llm,
        checks=checks,
        samples=samples,
        fingerprint=contract_fingerprint(payload),
    )


def validate_unified_payload(payload: UnifiedRunRequest) -> None:
    """Reject a unified run whose code cannot fit its optimizer, without running it.

    Args:
        payload: The unified run.

    Raises:
        ValueError: With the first failing check's localized message.
    """
    checks, _ = _static_items(payload)
    for check in checks:
        if check.status == "failed":
            raise ValueError(check.message)


def static_contract_check(payload: UnifiedRunRequest) -> ContractCheckResponse:
    """Check the code's signatures and metric model without a sandbox.

    Args:
        payload: The unified run.

    Returns:
        The static items, with no samples.
    """
    checks, uses_llm = _static_items(payload)
    return _response(payload, checks, [], uses_llm=uses_llm)


def _preview(value: Any) -> str:
    """Render a value for a sample preview.

    Args:
        value: Plain data.

    Returns:
        Compact JSON, capped in length.
    """
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text[:PREVIEW_CHARS]


def _sample_items(index: int, shape: MetricShape, probe: WorkspaceProbe) -> list[ContractCheckItem]:
    """Turn one sample's outcome into its run and metric items.

    Args:
        index: The sample's position, from 0.
        shape: The metric shape it was held to.
        probe: The sample's outcome.

    Returns:
        The ``workspace.run`` and ``metric.shape`` items.
    """
    number = index + 1
    detail = probe.detail or probe.error
    if probe.stage == "run":
        return [
            _item(
                "workspace.run",
                False,
                "contract.run_error",
                detail=detail,
                sample_index=index,
                index=number,
                error=probe.error,
            ),
            ContractCheckItem(key="metric.shape", status="skipped", message=t(_SHAPE_KEYS[shape]), sample_index=index),
        ]
    run = _item("workspace.run", True, "contract.run_error", sample_index=index)
    if probe.stage == "shape":
        return [run, _item("metric.shape", False, _SHAPE_KEYS[shape], detail=detail, sample_index=index)]
    if probe.error is not None or probe.score is None:
        return [
            run,
            _item(
                "metric.shape",
                False,
                "contract.metric_error",
                detail=detail,
                sample_index=index,
                index=number,
                error=probe.error or "ValueError: no score",
            ),
        ]
    return [run, _item("metric.shape", True, _SHAPE_KEYS[shape], sample_index=index)]


def run_contract_check(
    payload: UnifiedRunRequest,
    sample_count: int,
    *,
    gateway: GatewayConfig | None,
    protected: bool,
    runtime: SandboxRuntime | None = None,
    job_id: str | None = None,
    lifetime_seconds: float | None = None,
    dependency_route: dict[str, str] | None = None,
) -> ContractCheckResponse:
    """Run the starting version through the code and metric on a few samples, in the sandbox.

    The samples come from train then validation, never test. The static
    checks run first; when they fail, nothing is executed.

    Args:
        payload: The unified run; its cases must be inline.
        sample_count: How many samples to score.
        gateway: The model gateway for managed models, if any.
        protected: Whether this runs under the protected profile.
        runtime: Where the box opens; the configured scorer runtime when unset.
        job_id: Names the box, when known.
        lifetime_seconds: Requested box lifetime; the configured ceiling when unset.
        dependency_route: The protected package relay pinned dependencies install through.

    Returns:
        Every check item and the scored samples; ``ok`` only when all passed.

    Raises:
        ValueError: When the cases are not inline.
        ServiceError: When the sandbox could not run the harness at all.
    """
    checks, uses_llm = _static_items(payload)
    if any(check.status == "failed" for check in checks):
        return _response(payload, checks, [], uses_llm=uses_llm)
    if payload.data.cases is None:
        raise ValueError("The contract check needs the cases inline.")
    splits = split_cases(
        list(payload.data.cases),
        payload.data.mode,
        payload.data.split,
        shuffle=payload.data.shuffle,
        seed=split_seed(payload),
    )
    shape = metric_shape_for(payload.optimizer.choice, payload.task.artifact.kind)
    scorer = build_workspace_scorer(
        payload,
        gateway,
        protected=protected,
        runtime=runtime,
        job_id=job_id,
        lifetime_seconds=lifetime_seconds,
        dependency_route=dependency_route,
    )
    samples: list[ContractSample] = []
    try:
        for index, case in enumerate(contract_samples(splits, sample_count)):
            probe = scorer.run(payload.task.artifact.starting_version, case)
            checks.extend(_sample_items(index, shape, probe))
            feedback = probe.side_info.get("feedback")
            samples.append(
                ContractSample(
                    index=index,
                    input_preview=_preview(case.input),
                    output_preview=probe.output_preview,
                    score=probe.score,
                    feedback_preview=feedback[:PREVIEW_CHARS] if isinstance(feedback, str) and feedback else None,
                    duration_ms=probe.duration_ms,
                )
            )
    finally:
        scorer.close()
    return _response(payload, checks, samples, uses_llm=uses_llm)
