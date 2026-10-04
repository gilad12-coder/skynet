"""Tests for staging a repository target's tree and secrets in the trusted parent."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from core.billing.protected_credentials import has_exposed_execution_credentials
from core.connectors.github_repo import RepoSnapshot
from core.worker import repo_staging


def _payload(commit: str | None) -> dict[str, Any]:
    """Build a repository payload whose secret is still a vault reference.

    Args:
        commit: Pinned commit, or ``None`` to follow the branch.

    Returns:
        The payload.
    """
    secret = {"name": "API_KEY", "credential_ref": "ref-1", "credential_revision": 1}
    repo = {
        "repository": "acme/app",
        "branch": "main",
        "commit": commit,
        "editable_paths": ["src"],
        "secrets": [secret],
    }
    return {"target": {"kind": "repo", "repo": repo}}


@pytest.mark.parametrize("commit", [None, "b" * 40])
def test_staging_pins_the_commit_and_keeps_secrets_in_the_parent(
    commit: str | None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Follow the branch only when no commit is pinned, and hand the guest secret names but never values."""
    fetched: list[tuple[str, str, str]] = []

    def fetch(repository: str, pinned: str, token: str, workdir: Path) -> RepoSnapshot:
        """Pretend to clone and record what was asked for."""
        fetched.append((repository, pinned, token))
        archive = workdir / "tree.tgz"
        archive.write_bytes(b"tree")
        return RepoSnapshot(commit=pinned, archive=archive, readonly_paths=("vendor/lib",), size_bytes=4)

    monkeypatch.setattr(repo_staging, "resolve_repo_secrets", lambda payload, **_: {"API_KEY": "secret-value"})
    monkeypatch.setattr(repo_staging, "github_token", lambda engine, username: "gh-token")
    monkeypatch.setattr(repo_staging, "resolve_commit", lambda token, repository, branch: "a" * 40)
    monkeypatch.setattr(repo_staging, "fetch_snapshot", fetch)
    original = _payload(commit)

    staged_payload, staged = repo_staging.stage_repository(original, username="alice", binding_id="b", engine=None)

    expected = commit or "a" * 40
    assert fetched == [("acme/app", expected, "gh-token")]
    assert staged_payload["target"]["repo"]["commit"] == expected
    assert staged_payload["target"]["repo"]["secrets"] == []
    assert staged_payload["_repo_snapshot"]["secret_names"] == ["API_KEY"]
    assert staged_payload["_repo_snapshot"]["readonly_paths"] == ["vendor/lib"]
    assert "secret-value" not in repr(staged_payload)
    assert not has_exposed_execution_credentials(staged_payload)
    assert staged.secrets == {"API_KEY": "secret-value"}
    assert original["target"]["repo"]["secrets"][0]["credential_ref"] == "ref-1"
    staged.cleanup()
    assert not staged.workdir.exists()


def test_failed_fetch_leaves_nothing_on_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove the scratch folder when the clone fails."""
    workdirs: list[Path] = []

    def fetch(repository: str, pinned: str, token: str, workdir: Path) -> RepoSnapshot:
        """Fail like a refused clone."""
        workdirs.append(workdir)
        raise RuntimeError("refused")

    monkeypatch.setattr(repo_staging, "resolve_repo_secrets", lambda payload, **_: {})
    monkeypatch.setattr(repo_staging, "github_token", lambda engine, username: "gh-token")
    monkeypatch.setattr(repo_staging, "fetch_snapshot", fetch)

    with pytest.raises(RuntimeError):
        repo_staging.stage_repository(_payload("c" * 40), username="alice", binding_id="b", engine=None)

    assert workdirs
    assert not workdirs[0].exists()


def test_only_repository_targets_are_staged() -> None:
    """Leave text and agent targets alone."""
    assert repo_staging.is_repo_payload(_payload(None))
    assert not repo_staging.is_repo_payload({"target": {"kind": "agent"}})
    assert not repo_staging.is_repo_payload({})


class _Gateway:
    """Record the evaluator a repository run binds."""

    def __init__(self) -> None:
        """Start with no evaluator."""
        self.evaluator: Any = None

    def bind_evaluator(self, evaluator: Any) -> dict[str, str]:
        """Keep the evaluator and hand back a fake route.

        Args:
            evaluator: The parent's repository scorer.

        Returns:
            A fake route.
        """
        self.evaluator = evaluator
        return {"url": "http://127.0.0.1:1/v1", "token": "evaluator-token"}


def test_binding_hands_the_guest_a_route_and_closes_the_box(tmp_path: Path) -> None:
    """The guest receives only the evaluator route; the parent owns the scorer and closes it."""
    archive = tmp_path / "tree.tgz"
    archive.write_bytes(b"tree")
    staged = repo_staging.StagedRepository(
        snapshot=RepoSnapshot(commit="a" * 40, archive=archive, readonly_paths=(), size_bytes=4),
        secrets={"API_KEY": "secret-value"},
        workdir=tmp_path,
    )
    payload = {
        **_payload("a" * 40),
        "scorer": {"kind": "python", "metric_code": "def score(p):\n    return 1\n", "timeout_seconds": 60},
        "_budget_gateway_descriptor": {
            "url": "http://127.0.0.1:1/v1",
            "control_token": "control-token",
            "image": "img",
            "lifetime_seconds": 600,
        },
    }
    gateway = _Gateway()

    repo_staging.bind_repo_scorer(payload, staged, gateway, owner_id="job-1")

    assert payload["_skynet_evaluator_route"] == {"url": "http://127.0.0.1:1/v1", "token": "evaluator-token"}
    assert staged.scorers == [gateway.evaluator]
    assert "secret-value" not in repr(payload)
    staged.close_scorers()
    assert staged.scorers == []
