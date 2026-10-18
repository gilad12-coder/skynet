"""Publish bounded, credential-free setup phases to the current request observer."""

from collections.abc import Callable
from contextvars import ContextVar

from ..service_gateway.optimization.blackbox.check_terminal import current_recorder

PREFLIGHT_PHASES = frozenset({"budget", "sandbox", "evaluator", "models", "usage"})
progress_observer: ContextVar[Callable[[str], None] | None] = ContextVar("preflight_progress", default=None)


def report_preflight_phase(phase: str) -> None:
    """Notify this request's observer of a known execution phase.

    Args:
        phase: Public phase identifier, never raw guest logs or credentials.
    """
    if phase not in PREFLIGHT_PHASES:
        return
    recorder = current_recorder()
    if recorder is not None:
        recorder.set_phase(phase)
    observer = progress_observer.get()
    if observer is not None:
        observer(phase)
