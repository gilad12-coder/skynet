"""Engine registry: the catalog the Auto strategy explores and ``single`` picks from.

The agent engines (AutoResearch, Meta-Harness) are registered so the API
and UI can name them, but stay unavailable until the sandboxed harness and
its usage tracking land (design brief decisions 2 and 5, TODO-3).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from ....exceptions import ServiceError
from ....models.blackbox import (
    BLACKBOX_ENGINE_AUTORESEARCH,
    BLACKBOX_ENGINE_BEST_OF_N,
    BLACKBOX_ENGINE_GEPA,
    BLACKBOX_ENGINE_META_HARNESS,
)
from .best_of_n import BestOfNEngine
from .gepa_engine import GepaEngine
from .protocol import Engine

_AGENT_ENGINE_REASON = "Agent engines run in a sandboxed coding harness that is not wired up yet."


@dataclass(frozen=True)
class EngineSpec:
    """Catalog entry for one engine."""

    id: str
    label: str
    description: str
    factory: Callable[[], Engine] | None = None
    unavailable_reason: str | None = None

    @property
    def available(self) -> bool:
        """Return True when the engine can run in this deployment."""
        return self.factory is not None


ENGINES: dict[str, EngineSpec] = {
    BLACKBOX_ENGINE_GEPA: EngineSpec(
        id=BLACKBOX_ENGINE_GEPA,
        label="GEPA",
        description="Reflective evolution with a Pareto front of versions.",
        factory=GepaEngine,
    ),
    BLACKBOX_ENGINE_BEST_OF_N: EngineSpec(
        id=BLACKBOX_ENGINE_BEST_OF_N,
        label="Best-of-N",
        description="Independent proposals from the reflection model; keep the best.",
        factory=BestOfNEngine,
    ),
    BLACKBOX_ENGINE_AUTORESEARCH: EngineSpec(
        id=BLACKBOX_ENGINE_AUTORESEARCH,
        label="AutoResearch",
        description="A coding agent iterates on the version in a sandbox.",
        unavailable_reason=_AGENT_ENGINE_REASON,
    ),
    BLACKBOX_ENGINE_META_HARNESS: EngineSpec(
        id=BLACKBOX_ENGINE_META_HARNESS,
        label="Meta-Harness",
        description="A coding agent rewrites the optimization harness itself.",
        unavailable_reason=_AGENT_ENGINE_REASON,
    ),
}


def available_engine_ids() -> list[str]:
    """Return the ids of engines that can run here, in catalog order."""
    return [spec.id for spec in ENGINES.values() if spec.available]


def get_engine(engine_id: str) -> Engine:
    """Instantiate the engine registered under ``engine_id``.

    Args:
        engine_id: Catalog id such as ``"gepa"``.

    Returns:
        A fresh engine instance.

    Raises:
        ServiceError: When the id is unknown or the engine is unavailable.
    """
    spec = ENGINES.get(engine_id)
    if spec is None:
        raise ServiceError(f"Unknown engine '{engine_id}'. Available engines: {', '.join(available_engine_ids())}.")
    if spec.factory is None:
        raise ServiceError(f"Engine '{engine_id}' is not available: {spec.unavailable_reason}")
    return spec.factory()
