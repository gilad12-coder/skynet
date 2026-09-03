"""Verify Meta-Harness delegates search to the pinned native execution path."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from core.exceptions import ServiceError

from .. import meta_harness as meta_mod
from ..meta_harness import MetaHarnessEngine
from ..protocol import EvalServer, Result, Task
from .mocks import make_ctx, vowel_scorer


@pytest.mark.parametrize("runtime", ["worker", "vercel"])
def test_meta_harness_forwards_the_selected_runtime_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runtime: str
) -> None:
    """Preserve inputs and the upstream aggregate winner for both execution runtimes."""
    task = Task(seed_candidate="seed", objective="improve code", val_set=[{"id": "a"}, {"id": "b"}])
    server = EvalServer(vowel_scorer, max_evals=10)
    server.evaluate("aeiou", {"id": "a"})
    incumbent = Result(best_candidate="completed version", best_score=0.4, total_evals=5)
    native_run = MagicMock(return_value=incumbent)
    monkeypatch.setattr(meta_mod, "run_native_engine", native_run)
    ctx = make_ctx(str(tmp_path), native_options=SimpleNamespace(runtime=runtime))

    result = MetaHarnessEngine().run(task, server, ctx)

    native_run.assert_called_once_with("meta_harness", task, server, ctx)
    assert result is incumbent
    assert result.best_candidate != server.best_candidate
    assert ctx.native_options.runtime == runtime


def test_meta_harness_requires_a_native_runtime(tmp_path: Path) -> None:
    """Reject missing native execution instead of falling back to a custom prompt loop."""
    lm = MagicMock()
    with pytest.raises(ServiceError, match="Choose a worker or Vercel runtime"):
        MetaHarnessEngine().run(
            Task(seed_candidate="seed"),
            EvalServer(vowel_scorer, max_evals=5),
            make_ctx(str(tmp_path), lm),
        )
    lm.assert_not_called()


def test_meta_harness_propagates_native_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Surface native execution failures without a different algorithm or fresh retry."""
    native_run = MagicMock(side_effect=ServiceError("upstream proposer unavailable"))
    monkeypatch.setattr(meta_mod, "run_native_engine", native_run)
    with pytest.raises(ServiceError, match="upstream proposer unavailable"):
        MetaHarnessEngine().run(
            Task(seed_candidate="seed"), EvalServer(vowel_scorer, max_evals=5), make_ctx(str(tmp_path))
        )
    assert native_run.call_count == 1
