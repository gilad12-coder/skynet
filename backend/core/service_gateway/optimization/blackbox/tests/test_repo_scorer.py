"""Tests for scoring repository versions in the parent-owned box."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest

from core.exceptions import ServiceError
from core.models.blackbox import BlackboxRunRequest
from core.models.tests.test_blackbox import _repo_request

from ..repo_scorer import RepoScoreError, RepoScorer, fold_case_scores
from ..repo_workspace import RepoWorkspace
from ..sandbox import LocalSubprocessRuntime, SandboxSpec
from ..service import run_blackbox_optimization
from .test_repo_workspace import _archive, _patch

SCORER = """
import os

def score(repo_path, case=None):
    value = int(open(os.path.join(repo_path, "src/app.py")).read().split("=")[1])
    built = open(os.path.join(repo_path, "built.txt")).read()
    return {
        "score": value / 10,
        "feedback": "value read",
        "secret": os.environ["API_KEY"],
        "built": built,
        "case": case,
        "cases": {
            "small": {"score": value / 20, "feedback": "small ok"},
            "large": {"score": value / 5, "feedback": "large ok"},
        },
    }
"""


@pytest.fixture
def scored(tmp_path: Path) -> Iterator[tuple[RepoScorer, Path, Path]]:
    """Open a scorer over a small tree whose setup builds a file.

    Args:
        tmp_path: Scratch folder.

    Yields:
        The scorer, the archive and the scratch folder.
    """
    archive = _archive(tmp_path, {"src/app.py": "x = 1\n", "README": "r\n"})
    scorer = RepoScorer(
        RepoWorkspace(
            runtime=LocalSubprocessRuntime(),
            spec=SandboxSpec(lifetime_seconds=120, network_disabled=True),
            archive=archive,
            editable_paths=["src"],
            readonly_paths=[],
            setup_command="cat src/app.py > built.txt",
            secrets={"API_KEY": "very-secret-value"},
        ),
        SCORER,
        timeout_seconds=60,
    )
    yield scorer, archive, tmp_path
    scorer.close()


def test_scores_the_baseline_and_a_version(scored: tuple[RepoScorer, Path, Path]) -> None:
    """The empty patch scores the commit; a patch scores its own checkout after setup."""
    scorer, archive, root = scored
    baseline = scorer.score("")
    assert baseline["score"] == pytest.approx(0.1)
    assert baseline["built"] == "x = 1\n"
    improved = scorer.score(_patch(root / "v1", archive, {"src/app.py": "x = 7\n"}), {"id": 3})
    assert improved["score"] == pytest.approx(0.7)
    assert improved["case"] == {"id": 3}
    assert "cases" not in improved
    assert improved["scores"] == {
        "small": {"score": pytest.approx(0.35), "feedback": "small ok"},
        "large": {"score": pytest.approx(1.4), "feedback": "large ok"},
    }


def test_secrets_reach_the_scorer_but_are_redacted(scored: tuple[RepoScorer, Path, Path]) -> None:
    """A scorer that echoes a secret never hands its value back."""
    scorer, _, _ = scored
    assert scorer.score("")["secret"] == "[secret]"


def test_versions_outside_the_editable_paths_are_refused(scored: tuple[RepoScorer, Path, Path]) -> None:
    """A change to a file the run may not edit is reported, not scored."""
    scorer, archive, root = scored
    with pytest.raises(RepoScoreError, match="README"):
        scorer.score(_patch(root / "bad", archive, {"README": "changed\n"}))


def test_a_failing_scorer_is_reported(tmp_path: Path) -> None:
    """A scorer that raises surfaces its error as an unscorable version."""
    archive = _archive(tmp_path, {"src/app.py": "x = 1\n"})
    scorer = RepoScorer(
        RepoWorkspace(
            runtime=LocalSubprocessRuntime(),
            spec=SandboxSpec(lifetime_seconds=60, network_disabled=True),
            archive=archive,
            editable_paths=["src"],
            readonly_paths=[],
            setup_command=None,
            secrets={},
        ),
        "def score(repo_path):\n    raise RuntimeError('tests failed')\n",
        timeout_seconds=60,
    )
    try:
        with pytest.raises(RepoScoreError, match="tests failed"):
            scorer.score("")
    finally:
        scorer.close()


def test_dispatch_answers_the_guest(scored: tuple[RepoScorer, Path, Path]) -> None:
    """The evaluator capability returns the score, or 422 with the reason."""
    scorer, archive, root = scored
    ok = scorer.dispatch({"candidate": "", "case": None})
    assert ok.status == 200
    assert json.loads(ok.body)["score"] == pytest.approx(0.1)
    refused = scorer.dispatch({"candidate": _patch(root / "bad", archive, {"README": "x\n"})})
    assert refused.status == 422
    assert "README" in refused.body.decode()
    with pytest.raises(ValueError):
        scorer.dispatch({"candidate": {"a": "b"}})


@pytest.mark.parametrize(
    ("side_info", "expected"),
    [
        ({"feedback": "f"}, {"feedback": "f"}),
        (
            {"feedback": "f", "cases": {"a": {"score": 1, "feedback": "x"}, "b": (0.5, "y")}},
            {"feedback": "f", "scores": {"a": {"score": 1.0, "feedback": "x"}, "b": {"score": 0.5, "feedback": "y"}}},
        ),
    ],
)
def test_fold_case_scores(side_info: dict, expected: dict) -> None:
    """Per-case scores are optional and become named scores, each with its feedback."""
    assert fold_case_scores(side_info) == expected


@pytest.mark.parametrize(
    "cases",
    [[1, 2], {"a": "high"}, {"a": {"score": float("nan"), "feedback": "x"}}, {"a": True}, {"a": 1.0}],
)
def test_fold_case_scores_reject_bad_shapes(cases: object) -> None:
    """Per-case scores must map names to a finite score with its own feedback."""
    with pytest.raises(RepoScoreError):
        fold_case_scores({"cases": cases})


@pytest.mark.parametrize("engine", ["autoresearch", "gepa"])
def test_a_repository_run_needs_its_tree(engine: str) -> None:
    """Refuse a repository run the guest cannot carry out before any scoring starts."""
    payload = BlackboxRunRequest.model_validate(
        _repo_request(max_cost_cents=100, strategy={"mode": "single", "engine": engine})
    )
    route = {"url": "http://127.0.0.1:1/v1/_evaluator", "token": "t"}
    with pytest.raises(ServiceError, match="repository its parent fetched"):
        run_blackbox_optimization(payload, artifact_id="job", evaluator_route=route, repo_snapshot=None)
