"""Classify subprocess failures without inferring retryability from error text."""

from __future__ import annotations

from typing import Any

from ..billing.runtime import UsagePendingError
from ..exceptions import DETERMINISTIC_FAILURE, INFRASTRUCTURE_INTERRUPTION, InfrastructureInterruptionError
from .constants import EVENT_ERROR


def failure_event(error: BaseException, *, traceback_text: str = "") -> dict[str, Any]:
    """Serialize a child failure with a trusted retry classification.

    Args:
        error: Exception caught at the child or sandbox-supervisor boundary.
        traceback_text: Optional formatted traceback retained for job logs.

    Returns:
        An ``EVENT_ERROR`` frame with a stable failure kind and exception type.
    """
    temporary = isinstance(error, InfrastructureInterruptionError | UsagePendingError)
    return {
        "type": EVENT_ERROR,
        "error": str(error),
        "traceback": traceback_text,
        "error_type": type(error).__name__,
        "failure_kind": INFRASTRUCTURE_INTERRUPTION if temporary else DETERMINISTIC_FAILURE,
    }
