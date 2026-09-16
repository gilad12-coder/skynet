"""Verify AutoSaddler delegates search to the pinned upstream loop in the managed sandbox."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from core.exceptions import ServiceError

from .. import autosaddler as autosaddler_mod
from ..autosaddler import AutoSaddlerEngine
from ..protocol import EvalServer, Result, Task
from .mocks import make_ctx, vowel_scorer


@pytest.mark.parametrize("seed", ["seed", {"system": "seed", "user": "ask"}])
def test_autosaddler_forwards_text_and_named_parts_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seed: str | dict[str, str]
) -> None:
    """Preserve the task, including a parts candidate, and the upstream winner."""
    task = Task(seed_candidate=seed, objective="improve", train_set=[{"id": "a"}], val_set=[{"id": "b"}])
    server = EvalServer(vowel_scorer, max_evals=10)
    incumbent = Result(best_candidate=seed, best_score=0.4, total_evals=5)
    native_run = MagicMock(return_value=incumbent)
    monkeypatch.setattr(autosaddler_mod, "run_native_engine", native_run)
    ctx = make_ctx(str(tmp_path), native_options=SimpleNamespace(runtime="vercel"))

    result = AutoSaddlerEngine().run(task, server, ctx)

    native_run.assert_called_once_with("autosaddler", task, server, ctx)
    assert result is incumbent


def test_autosaddler_requires_a_native_runtime(tmp_path: Path) -> None:
    """Reject missing native execution instead of falling back to an in-process loop."""
    lm = MagicMock()
    with pytest.raises(ServiceError, match="managed Vercel sandbox"):
        AutoSaddlerEngine().run(
            Task(seed_candidate="seed", train_set=[{"id": "a"}, {"id": "b"}]),
            EvalServer(vowel_scorer, max_evals=5),
            make_ctx(str(tmp_path), lm),
        )
    lm.assert_not_called()


def test_autosaddler_propagates_native_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Surface native execution failures without a different algorithm or fresh retry."""
    native_run = MagicMock(side_effect=ServiceError("upstream proposer unavailable"))
    monkeypatch.setattr(autosaddler_mod, "run_native_engine", native_run)
    with pytest.raises(ServiceError, match="upstream proposer unavailable"):
        AutoSaddlerEngine().run(
            Task(seed_candidate="seed", train_set=[{"id": "a"}, {"id": "b"}]),
            EvalServer(vowel_scorer, max_evals=5),
            make_ctx(str(tmp_path)),
        )
    assert native_run.call_count == 1
