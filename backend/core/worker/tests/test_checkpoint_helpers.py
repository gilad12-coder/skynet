"""Tests for the worker's GEPA checkpoint persist/restore helpers.

Exercises ``_checkpoints_enabled``, ``_prepare_gepa_dir`` (restore-on-resume) and
``_persist_gepa_checkpoint`` (mtime-gated save) directly — the durable half of
resume, for both a single run and a grid of per-pair runs — without spinning up
the optimization subprocess.
"""

from __future__ import annotations

import json
import pickle
import queue
import shutil
from types import SimpleNamespace
from typing import cast

from gepa.core.state import GEPAState, ValsetEvaluation

from core.constants import OPTIMIZATION_TYPE_GRID_SEARCH, OPTIMIZATION_TYPE_RUN, PROGRESS_CANDIDATE
from core.service_gateway.optimization.trajectory import GEPA_STATE_FILENAME, GRID_PAIR_RESULT_FILENAME
from core.storage import JobStore
from core.worker.checkpoint_compat import checkpoint_incumbent, checkpoint_manifest
from core.worker.constants import EVENT_PROGRESS
from core.worker.engine import BackgroundWorker

_PAYLOAD = {"optimizer_name": "GEPA", "dataset": [{"input": "a"}]}


def _state(iteration: int) -> bytes:
    """Serialize a real GEPA state with the requested completed iteration.

    Args:
        iteration: Upstream loop counter to retain across restoration.

    Returns:
        Exact pickle format used by upstream's state serializer.
    """
    state = GEPAState({"predict": "seed"}, ValsetEvaluation({0: "answer"}, {0: 0.5}))
    state.i = iteration
    state.total_num_evals = 10
    state.num_full_ds_evals = 1
    return pickle.dumps(state.__dict__)


class _CheckpointStore:
    """In-memory stand-in exposing the checkpoint/pair-result surface the helpers use."""

    def __init__(self) -> None:
        """Start with no saved checkpoints or pair results."""
        self.checkpoints: dict[int, tuple[bytes, int]] = {}
        self.manifests: dict[int, dict | None] = {}
        self.pair_results: dict[int, dict] = {}

    def get_job(self, optimization_id: str) -> dict:
        """Return the immutable execution payload used to validate recovery."""
        return {"payload": _PAYLOAD, "code_version": None}

    def save_gepa_checkpoint(
        self,
        optimization_id: str,
        data: bytes,
        iteration: int,
        pair_index: int = -1,
        *,
        manifest=None,
        expected_generation=None,
    ) -> None:
        """Record one run/pair's checkpoint bytes and iteration."""
        self.checkpoints[pair_index] = (data, iteration)
        self.manifests[pair_index] = manifest

    def get_gepa_checkpoint(self, optimization_id: str, pair_index: int = -1):
        """Return one run/pair's checkpoint record, or ``None``."""
        row = self.checkpoints.get(pair_index)
        if row is None:
            return None
        return SimpleNamespace(
            pair_index=pair_index,
            data=row[0],
            iteration=row[1],
            stored_bytes=len(row[0]),
            manifest=self.manifests.get(pair_index) or checkpoint_manifest(row[0], _PAYLOAD, None),
        )

    def list_gepa_checkpoints(self, optimization_id: str):
        """Return every stored checkpoint record."""
        return [self.get_gepa_checkpoint(optimization_id, idx) for idx in self.checkpoints]

    def delete_gepa_checkpoint(self, optimization_id: str, pair_index: int = -1) -> None:
        """Drop one run/pair's checkpoint."""
        self.checkpoints.pop(pair_index, None)

    def save_grid_pair_result(
        self, optimization_id: str, pair_index: int, result: dict, *, expected_generation=None
    ) -> None:
        """Record one finished grid pair's result."""
        self.pair_results[pair_index] = result


def _worker(store: object) -> BackgroundWorker:
    """Build a worker bound to ``store`` (never started)."""
    return BackgroundWorker(job_store=cast(JobStore, store))


def test_checkpoints_enabled_for_runs_and_grids_on_capable_store() -> None:
    """Enabled for single runs AND grids on a capable store; off for an incapable one."""
    worker = _worker(_CheckpointStore())
    assert worker._checkpoints_enabled(OPTIMIZATION_TYPE_RUN) is True
    assert worker._checkpoints_enabled(OPTIMIZATION_TYPE_GRID_SEARCH) is True
    assert _worker(object())._checkpoints_enabled(OPTIMIZATION_TYPE_RUN) is False


def test_single_run_persist_is_mtime_gated_and_prepare_restores() -> None:
    """Single run: persist saves on change only; a later prepare seeds state back."""
    store = _CheckpointStore()
    worker = _worker(store)

    base = worker._prepare_gepa_dir("w1", is_grid=False)
    try:
        assert base.exists()
        assert not (base / GEPA_STATE_FILENAME).exists()

        (base / GEPA_STATE_FILENAME).write_bytes(_state(1))
        tracker: dict = {"payload": _PAYLOAD}
        worker._persist_gepa_checkpoint("w1", base, tracker, is_grid=False)
        assert store.checkpoints[-1] == (_state(1), 1)

        before = store.checkpoints[-1]
        worker._persist_gepa_checkpoint("w1", base, tracker, is_grid=False)
        assert store.checkpoints[-1] is before  # unchanged mtime → no re-save
    finally:
        shutil.rmtree(base, ignore_errors=True)

    base2 = worker._prepare_gepa_dir("w1", is_grid=False)
    try:
        assert (base2 / GEPA_STATE_FILENAME).read_bytes() == _state(1)
    finally:
        shutil.rmtree(base2, ignore_errors=True)


def test_checkpoint_persists_best_json_safe_evaluated_incumbent() -> None:
    """Bind the best fully scored candidate event to the generation-fenced state manifest."""
    store = _CheckpointStore()
    worker = _worker(store)
    events: queue.Queue = queue.Queue()
    tracker: dict = {"payload": _PAYLOAD}
    for candidate_id, score, prompt in [
        ("0", 0.5, "seed"),
        ("1", 0.75, "better"),
        ("2", 0.6, "worse"),
    ]:
        events.put(
            {
                "type": EVENT_PROGRESS,
                "event": PROGRESS_CANDIDATE,
                "metrics": {
                    "candidate_id": candidate_id,
                    "score": score,
                    "prompt": {"predict": prompt},
                    "per_example": [{"id": "0", "score": score}],
                    "discovered_at_evals": int(candidate_id) + 1,
                    "iteration": int(candidate_id),
                },
            }
        )
    worker._drain_subprocess_events("incumbent", events, checkpoint_tracker=tracker)

    base = worker._prepare_gepa_dir("incumbent", is_grid=False)
    try:
        (base / GEPA_STATE_FILENAME).write_bytes(_state(2))
        worker._persist_gepa_checkpoint("incumbent", base, tracker, is_grid=False)
    finally:
        shutil.rmtree(base, ignore_errors=True)

    incumbent = checkpoint_incumbent(store.manifests[-1])
    assert incumbent is not None
    assert incumbent["candidate"] == {"predict": "better"}
    assert incumbent["selection_score"] == 0.75
    assert incumbent["candidate_origin"] == "optimized"


def test_grid_persist_stores_finished_pairs_and_checkpoints_in_flight() -> None:
    """Grid: a pair's result.json is stored (and its checkpoint dropped); others persist state."""
    store = _CheckpointStore()
    worker = _worker(store)

    base = worker._prepare_gepa_dir("g1", is_grid=True)
    try:
        # Pair 0 finished → result.json; pair 1 still in-flight → gepa_state.bin.
        (base / "pair_0").mkdir()
        (base / "pair_0" / GRID_PAIR_RESULT_FILENAME).write_text(
            json.dumps({"pair_index": 0, "optimized_test_metric": 0.8})
        )
        (base / "pair_0" / GEPA_STATE_FILENAME).write_bytes(_state(1))
        (base / "pair_1").mkdir()
        (base / "pair_1" / GEPA_STATE_FILENAME).write_bytes(_state(1))

        tracker: dict = {"payload": _PAYLOAD}
        worker._persist_gepa_checkpoint("g1", base, tracker, is_grid=True)

        # Keep state until the owning job commits its final outcome.
        assert store.pair_results[0]["optimized_test_metric"] == 0.8
        assert store.checkpoints[0] == (_state(1), 1)
        # In-flight pair 1: checkpoint persisted under its index.
        assert store.checkpoints[1] == (_state(1), 1)
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_grid_prepare_restores_in_flight_pair_checkpoints() -> None:
    """Grid resume: saved pair checkpoints are written back under their pair dirs."""
    store = _CheckpointStore()
    store.checkpoints = {0: (_state(3), 3), 2: (_state(5), 5)}
    worker = _worker(store)

    base = worker._prepare_gepa_dir("g2", is_grid=True)
    try:
        assert (base / "pair_0" / GEPA_STATE_FILENAME).read_bytes() == _state(3)
        assert (base / "pair_2" / GEPA_STATE_FILENAME).read_bytes() == _state(5)
        assert not (base / "pair_1").exists()  # pair 1 had no checkpoint (e.g. already finished)
    finally:
        shutil.rmtree(base, ignore_errors=True)
