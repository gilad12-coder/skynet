"""Validate isolated DSPy setup without invoking an optimizer or held-out test set."""

from __future__ import annotations

import inspect
import math
from collections.abc import Callable
from typing import Any

import dspy
from dspy.streaming import StreamListener, StreamResponse

from ..config import settings
from ..models.common import ColumnMapping, ModelConfig
from ..models.submissions import ToolSource
from ..models.workflow import WorkflowSpec
from ..registry import ServiceRegistry
from ..service_gateway import DspyService
from ..service_gateway.language_models import build_language_model, usage_by_model_from_history
from ..service_gateway.optimization.data import (
    extract_signature_fields,
    image_input_field_names,
    load_metric_from_code,
    load_signature_from_code,
    rows_to_examples,
)
from ..service_gateway.optimization.retrying_react import RetryingReActV2
from ..service_gateway.optimization.training_ground.run_react import resolve_react_tools
from ..service_gateway.optimization.validators import require_mapping_matches_signature
from ..service_gateway.optimization.workflow import (
    WorkflowNodeExecutionError,
    build_workflow_program,
    capture_node_traces,
    validate_workflow,
)


def _workflow_result(
    traces: list[dict[str, Any]], model: str, outputs: dict[str, Any] | None, error: Exception | None = None
) -> dict[str, Any]:
    """Serialize actual workflow port values and failure traces for the canvas.

    Args:
        traces: Node records captured during the actual sample prediction.
        model: Configured task model used for the prediction.
        outputs: Actual output anchor values, or None when prediction failed.
        error: Actual node or metric failure, when present.

    Returns:
        A response-safe WorkflowDryRunResponse-shaped dictionary.
    """

    def values(raw: dict[str, Any]) -> dict[str, Any]:
        """Bound authored objects before sending their representations to the canvas."""
        return {
            name: value
            if value is None or isinstance(value, bool | int) or (isinstance(value, float) and math.isfinite(value))
            else str(value)[:2000]
            for name, value in raw.items()
        }

    return {
        "outputs": values(outputs) if outputs is not None else None,
        "node_traces": [
            {
                **trace,
                "inputs": values(trace.get("inputs") or {}),
                "outputs": values(trace["outputs"]) if trace.get("outputs") is not None else None,
            }
            for trace in traces
        ],
        "model_used": model,
        "error": str(error) if error else None,
        "failed_node_id": error.node_id if isinstance(error, WorkflowNodeExecutionError) else None,
    }


def run_workflow_preview(
    payload: dict[str, Any], on_token: Callable[[dict[str, str]], None] | None = None
) -> dict[str, Any]:
    """Execute explicit debug inputs once inside the existing protected guest.

    Args:
        payload: Authored workflow, explicit input values, and scoped model route.
        on_token: Optional receiver for actual output chunks from a streaming call.

    Returns:
        Actual output ports, node traces, errors, and observed model usage.
    """
    workflow = WorkflowSpec.model_validate(payload["workflow"])
    model = ModelConfig.model_validate(payload["model_config"])
    traces: list[dict[str, Any]] = []
    language_model = None
    prediction = None
    error = None
    try:
        validate_workflow(workflow)
        names = workflow.input_field_names()
        missing = [name for name in names if name not in payload["inputs"]]
        if missing:
            raise ValueError(f"Missing workflow inputs: {missing}.")
        inputs = {name: payload["inputs"][name] for name in names}
        program, _hashes = build_workflow_program(
            workflow,
            tool_source=ToolSource.model_validate(payload["tool_source"]) if payload.get("tool_source") else None,
            dataset=None,
        )
        language_model = build_language_model(model, disable_cache=True)
        stream = None
        if on_token is not None:
            try:
                stream = dspy.streamify(
                    program,
                    stream_listeners=[
                        StreamListener(signature_field_name=name) for name in workflow.output_field_names()
                    ],
                    async_streaming=False,
                )
            except Exception:
                # Listener discovery can fail before any execution; replaying after dispatch would spend twice.
                stream = None
        with capture_node_traces() as traces, dspy.context(lm=language_model):
            if stream is None:
                prediction = program(**inputs)
            else:
                for item in stream(**inputs):
                    if isinstance(item, StreamResponse):
                        on_token({"field": item.signature_field_name, "chunk": item.chunk})
                    elif isinstance(item, dspy.Prediction):
                        prediction = item
                if prediction is None:
                    raise RuntimeError("The workflow stream did not return a final prediction.")
    except Exception as caught:
        error = caught
        nested = [caught]
        while nested:
            item = nested.pop()
            if isinstance(item, WorkflowNodeExecutionError):
                error = item
                break
            nested.extend(getattr(item, "exceptions", ()))
            if item.__cause__ is not None:
                nested.append(item.__cause__)
    result = _workflow_result(
        traces,
        model.normalized_identifier(),
        {name: getattr(prediction, name, None) for name in workflow.output_field_names()}
        if prediction is not None
        else None,
        error,
    )
    result["usage_by_model"] = [
        {"model": name, "input_tokens": counts[0], "output_tokens": counts[1]}
        for name, counts in (usage_by_model_from_history(language_model) or {}).items()
    ]
    return result


def run_dspy_preflight(
    payload: dict[str, Any], descriptor: dict[str, Any], on_token: Callable[[dict[str, str]], None] | None = None
) -> dict[str, Any]:
    """Check code and optionally perform one actual sample prediction and metric call.

    Args:
        payload: Canonical setup with parent-selected non-held-out sample data.
        descriptor: Scope selected by the parent, either evaluation or execution.
        on_token: Optional streaming receiver for explicit workflow previews.

    Returns:
        Explicit completed and deferred checks without optimizer state.
    """
    if descriptor.get("kind") == "workflow_preview":
        result = run_workflow_preview(payload, on_token if descriptor.get("stream") else None)
        return {
            "checks": [{"key": "workflow", "status": "failed" if result["error"] else "succeeded"}],
            "workflow_result": result,
        }
    scope = descriptor.get("scope")
    if scope not in {"evaluation", "execution"}:
        raise ValueError("Unsupported DSPy setup-check scope.")
    rows = payload.get("dataset", [])
    if not rows:
        raise ValueError("A non-held-out setup sample is required.")
    mapping = ColumnMapping.model_validate(payload["column_mapping"])
    metric = load_metric_from_code(payload["metric_code"])
    module_name = str(payload["module_name"])
    signature = None
    if module_name.lower() == "workflow":
        workflow = WorkflowSpec.model_validate(payload["workflow"])
        inputs, outputs = workflow.input_field_names(), workflow.output_field_names()
        program, _hashes = build_workflow_program(
            workflow,
            tool_source=ToolSource.model_validate(payload["tool_source"]) if payload.get("tool_source") else None,
            dataset=rows,
        )
    else:
        signature = load_signature_from_code(payload["signature_code"])
        inputs, outputs = extract_signature_fields(signature)
        if module_name.lower() == "react":
            tools, _hashes = resolve_react_tools(
                ToolSource.model_validate(payload["tool_source"]), signature, settings, dataset=rows
            )
            program = RetryingReActV2(
                signature, tools, max_iters=int(payload.get("module_kwargs", {}).get("max_iters", 5))
            )
        else:
            factory, automatic_signature = DspyService(ServiceRegistry())._get_module_factory(module_name)
            kwargs = dict(payload.get("module_kwargs", {}))
            if automatic_signature or "signature" not in kwargs:
                kwargs["signature"] = signature
            program = factory(**kwargs)
    require_mapping_matches_signature(mapping, inputs, outputs)
    examples = rows_to_examples(
        rows, mapping, image_input_fields=image_input_field_names(signature) if signature else frozenset()
    )
    checks = [
        {"key": "program", "status": "succeeded"},
        {"key": "metric", "status": "succeeded"},
        {"key": "sample_mapping", "status": "succeeded"},
    ]
    if scope == "evaluation":
        return {"scope": scope, "checks": [*checks, {"key": "sample_prediction", "status": "pending"}]}
    configs = payload.get("generation_models") or [payload.get("model_config")]
    scores = []
    workflow_results = []
    for index, config in enumerate(configs):
        if not isinstance(config, dict):
            raise TypeError("Select the task model before running the paid setup check.")
        language_model = build_language_model(ModelConfig.model_validate(config), disable_cache=True)
        example = examples[0]
        prediction = None
        with capture_node_traces() as traces:
            try:
                with dspy.context(lm=language_model):
                    prediction = program(**example.inputs())
                    parameters = inspect.signature(metric).parameters
                    positional = [
                        item
                        for item in parameters.values()
                        if item.kind in {item.POSITIONAL_ONLY, item.POSITIONAL_OR_KEYWORD}
                    ]
                    score = metric(example, prediction, *([None] * max(0, len(positional) - 2)))
            except Exception as error:
                if module_name.lower() != "workflow":
                    raise
                failed = _workflow_result(
                    traces,
                    config["name"],
                    {name: getattr(prediction, name, None) for name in outputs} if prediction is not None else None,
                    error,
                )
                return {
                    "scope": scope,
                    "checks": [
                        *checks,
                        {
                            "key": f"sample_prediction:{index}" if prediction is None else f"sample_metric:{index}",
                            "status": "failed",
                            "message": str(error),
                            "field": "workflow" if prediction is None else "metric_code",
                        },
                    ],
                    "workflow_result": failed,
                    "workflow_results": [*workflow_results, failed],
                    "sample_scores": scores,
                }
        if module_name.lower() == "workflow":
            workflow_results.append(
                _workflow_result(traces, config["name"], {name: getattr(prediction, name, None) for name in outputs})
            )
        scalar = score.get("score") if isinstance(score, dict) else getattr(score, "score", score)
        if not isinstance(scalar, int | float) or not math.isfinite(scalar):
            raise ValueError("The metric must return a finite score for the setup sample.")
        scores.append({"model": config["name"], "score": float(scalar)})
        checks.extend(
            [
                {"key": f"sample_prediction:{index}", "status": "succeeded"},
                {"key": f"sample_metric:{index}", "status": "succeeded"},
            ]
        )
    result = {"scope": scope, "checks": checks, "sample_scores": scores}
    if len(scores) == 1:
        result["sample_score"] = scores[0]["score"]
    if workflow_results:
        result["workflow_result"] = workflow_results[0]
        result["workflow_results"] = workflow_results
    return result
