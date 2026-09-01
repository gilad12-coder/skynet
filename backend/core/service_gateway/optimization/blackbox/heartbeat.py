"""A once-a-minute log line while a long sandbox step runs, so a slow step is not mistaken for a hung one."""

from __future__ import annotations

import contextlib
import logging
import threading
import time
from collections.abc import Iterator

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 60.0


def duration(seconds: float) -> str:
    """Render a duration the way a person reads it.

    Args:
        seconds: The duration.

    Returns:
        Whole seconds under a minute, else minutes with one decimal.
    """
    return f"{seconds:.0f}s" if seconds < 60 else f"{seconds / 60:.1f}m"


@contextlib.contextmanager
def heartbeat(log: logging.Logger, label: str, step: str, allowance: float) -> Iterator[None]:
    """Log, once per :data:`HEARTBEAT_SECONDS`, that ``step`` is still running.

    Args:
        log: The logger the lines go to, so they carry the caller's name.
        label: Prefix of the run's log lines.
        step: What is running.
        allowance: The step's timeout, in seconds.
    """
    done = threading.Event()
    started = time.perf_counter()

    def beat() -> None:
        """Log until the step ends."""
        while not done.wait(HEARTBEAT_SECONDS):
            elapsed = time.perf_counter() - started
            log.info(
                "%s: %s still running after %s (allowance %s)", label, step, duration(elapsed), duration(allowance)
            )

    thread = threading.Thread(target=beat, name=f"heartbeat-{step}", daemon=True)
    thread.start()
    try:
        yield
    finally:
        done.set()
        thread.join()
