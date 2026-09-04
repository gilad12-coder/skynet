"""Routes for code formatting and pre-submit validation. [INTERNAL]

Two POST endpoints used by the submit wizard to lint/format user-authored
DSPy signature and metric code before a job is enqueued. All endpoints
are hidden from the public Scalar reference (none are in
``_SCALAR_PUBLIC_PATHS``) — devs hitting ``/run`` directly should validate
locally with ruff/mypy rather than depending on this surface.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from ...models import ValidateCodeRequest, ValidateCodeResponse
from ..response_limits import AGENT_MAX_ERROR, truncate_text
from ..static_code_validation import StaticCodeError, inspect_metric, inspect_signature


def _bounded_error(message: str) -> str:
    """Truncate an exception / traceback string to a context-safe length.

    Args:
        message: The raw error message or traceback.

    Returns:
        The truncated message, never longer than :data:`AGENT_MAX_ERROR`.
    """
    return truncate_text(message, AGENT_MAX_ERROR) or message


class FormatCodeRequest(BaseModel):
    """Request body for ``POST /format-code`` — a raw Python snippet to reformat."""

    code: str


class FormatCodeResponse(BaseModel):
    """Response body for ``POST /format-code``: reformatted code plus diff / error flags."""

    code: str
    changed: bool
    error: str | None = None


def create_code_validation_router() -> APIRouter:
    """Build the code-validation router.

    Returns:
        A configured :class:`APIRouter` exposing ``/format-code`` and ``/validate-code``.
    """
    router = APIRouter()

    @router.post(
        "/format-code",
        response_model=FormatCodeResponse,
        summary="Format user-authored Python code with ruff",
    )
    def format_code(payload: FormatCodeRequest) -> FormatCodeResponse:
        """Run ``ruff format`` on the supplied snippet.

        Never raises 5xx — any formatting error is returned in the ``error`` field.

        Args:
            payload: Request body containing the raw Python snippet.

        Returns:
            A :class:`FormatCodeResponse` with the (possibly reformatted) code,
            a ``changed`` flag, and any error message.
        """
        # ``delete=False`` keeps the file readable after the writer closes so
        # ruff can pick it up via path. ``try/finally`` guarantees cleanup on
        # every exit path — non-zero ruff exit, timeout, missing binary, etc.
        # — so a long-lived API process can't leak /tmp space.
        tmp_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
                f.write(payload.code)
                f.flush()
                tmp_path = f.name
            result = subprocess.run(
                ["ruff", "format", tmp_path],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            if result.returncode != 0:
                return FormatCodeResponse(code=payload.code, changed=False, error=result.stderr.strip())
            formatted = Path(tmp_path).read_text()
            return FormatCodeResponse(code=formatted, changed=formatted != payload.code)
        except FileNotFoundError:
            return FormatCodeResponse(code=payload.code, changed=False, error="ruff is not installed on the server")
        except subprocess.TimeoutExpired:
            return FormatCodeResponse(code=payload.code, changed=False, error="Formatting timed out")
        except (OSError, subprocess.SubprocessError) as exc:
            return FormatCodeResponse(code=payload.code, changed=False, error=str(exc))
        finally:
            if tmp_path is not None:
                Path(tmp_path).unlink(missing_ok=True)

    @router.post(
        "/validate-code",
        response_model=ValidateCodeResponse,
        summary="Static authoring validation for signature and metric code",
        tags=["agent"],
    )
    def validate_code(payload: ValidateCodeRequest) -> ValidateCodeResponse:
        """Inspect DSPy signature and metric syntax without executing authored code.

        Runtime behavior is checked by protected setup when the user continues.
        Legacy sample rows are ignored here so held-out data cannot reach a metric.

        Args:
            payload: Validation request containing signature/metric code,
                column mapping, and optimizer name.

        Returns:
            A :class:`ValidateCodeResponse` with ``valid``, signature fields,
            and the populated ``errors`` and ``warnings`` lists.
        """
        errors: list[str] = []
        warnings: list[str] = []
        sig_fields: dict[str, list[str]] | None = None

        if not payload.signature_code and not payload.metric_code:
            errors.append("Provide signature_code and/or metric_code to validate.")

        if payload.signature_code:
            try:
                intro = inspect_signature(payload.signature_code)
                if intro is None:
                    warnings.append(
                        "Signature fields depend on runtime construction. "
                        "Continue checks the signature and column mapping in protected setup."
                    )
                else:
                    sig_fields = {
                        "inputs": intro.input_fields,
                        "outputs": intro.output_fields,
                    }
            except StaticCodeError as exc:
                errors.append(_bounded_error(str(exc)))

            if sig_fields:
                missing_inputs = set(sig_fields["inputs"]) - set(payload.column_mapping.inputs.keys())
                missing_outputs = set(sig_fields["outputs"]) - set(payload.column_mapping.outputs.keys())
                if missing_inputs:
                    errors.append(
                        f"Signature input fields not mapped to columns: {sorted(missing_inputs)}. "
                        f"Mapped input columns: {sorted(payload.column_mapping.inputs.keys())}"
                    )
                if missing_outputs:
                    errors.append(
                        f"Signature output fields not mapped to columns: {sorted(missing_outputs)}. "
                        f"Mapped output columns: {sorted(payload.column_mapping.outputs.keys())}"
                    )
                extra_inputs = set(payload.column_mapping.inputs.keys()) - set(sig_fields["inputs"])
                extra_outputs = set(payload.column_mapping.outputs.keys()) - set(sig_fields["outputs"])
                if extra_inputs:
                    warnings.append(f"Input columns not in Signature (will be ignored): {sorted(extra_inputs)}")
                if extra_outputs:
                    warnings.append(f"Output columns not in Signature (will be ignored): {sorted(extra_outputs)}")

        is_react = (payload.module_name or "").lower() == "react"
        if payload.metric_code:
            try:
                metric_info = inspect_metric(payload.metric_code)
            except StaticCodeError as exc:
                errors.append(_bounded_error(str(exc)))
            else:
                param_names = metric_info.param_names
                if is_react and len(param_names) < 2 and not metric_info.accepts_varargs:
                    errors.append(
                        f"A ReAct metric must accept (example, rollout). "
                        f"Found {len(param_names)}: ({', '.join(param_names)})."
                    )
                elif (
                    not is_react
                    and payload.optimizer_name == "gepa"
                    and len(param_names) < 5
                    and not metric_info.accepts_varargs
                ):
                    errors.append(
                        f"GEPA metric must accept 5 arguments: (gold, pred, trace, pred_name, pred_trace). "
                        f"Found {len(param_names)}: ({', '.join(param_names)}). "
                        f"See https://dspy.ai/api/optimizers/GEPA for details."
                    )

        if payload.sample_row is not None:
            warnings.append(
                "Sample rows are not executed during authoring validation. Continue runs protected setup checks."
            )

        return ValidateCodeResponse(
            valid=len(errors) == 0,
            signature_fields=sig_fields,
            errors=errors,
            warnings=warnings,
        )

    return router
