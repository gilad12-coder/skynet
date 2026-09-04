"""Recover only selections published by the pinned GEPA state serializer."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from gepa.core.result import GEPAResult
from gepa.core.state import GEPAState


def completed_gepa_result(run_dir: str | None, *, seed: int | None = None) -> GEPAResult[Any, Any] | None:
    """Read an evaluated incumbent through the upstream result-construction API.

    Args:
        run_dir: Private GEPA directory with an atomically published state file.
        seed: Original optimizer seed, retained as result provenance.

    Returns:
        The upstream-selected result, or no result before the first complete snapshot.

    Raises:
        ValueError: When a snapshot cannot prove a finite aggregate selection.
    """
    if run_dir is None or not (Path(run_dir) / "gepa_state.bin").exists():
        return None
    state = GEPAState.load(run_dir)
    result = GEPAResult.from_state(state, run_dir=run_dir, seed=seed)
    if not result.candidates or not math.isfinite(float(result.val_aggregate_scores[result.best_idx])):
        raise ValueError("The GEPA checkpoint does not contain an evaluated aggregate incumbent.")
    return result
