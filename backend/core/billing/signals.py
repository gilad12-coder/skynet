"""Carry normal platform budget stops past optimizer error-handling loops."""

from __future__ import annotations

import threading
from typing import Any


class BudgetReached(BaseException):
    """Stop protected work without teaching an optimizer a fabricated failure score."""

    def __init__(self, message: str = "The remaining budget cannot cover the next operation.") -> None:
        """Retain a normal stop and optional independently completed result.

        Args:
            message: Explanation supplied by the authoritative admission boundary.
        """
        super().__init__(message)
        self.result: Any = None
        self.evidence: dict[str, Any] = {}


class BudgetStopLatch:
    """Share one durable-in-process stop decision across concurrent optimizer lanes."""

    def __init__(self) -> None:
        """Start with no confirmed budget stop."""
        self._lock = threading.Lock()
        self._stop: BudgetReached | None = None

    def trip(self, message: str = "The remaining budget cannot cover the next operation.") -> BudgetReached:
        """Latch the first confirmed exhaustion decision.

        Args:
            message: Admission failure after outstanding work has been reconciled.

        Returns:
            A fresh control signal retaining the first exhaustion explanation.
        """
        with self._lock:
            if self._stop is None:
                self._stop = BudgetReached(message)
            return BudgetReached(str(self._stop))

    def check(self) -> None:
        """Prevent further protected work once exhaustion has been confirmed.

        Raises:
            BudgetReached: When the shared run has stopped for budget.
        """
        with self._lock:
            stop = self._stop
        if stop is not None:
            raise BudgetReached(str(stop))

    @property
    def stopped(self) -> bool:
        """Return whether admission has confirmed exhaustion."""
        with self._lock:
            return self._stop is not None
