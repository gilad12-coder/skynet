"""Tests for fetching a repository at one commit and packing its tree."""

from __future__ import annotations

import base64
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest

from ..github_repo import GITHUB_HOST, RepoFetchError, fetch_snapshot, git_auth_env, patched_repo_zip

_GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]


def _git(cwd: Path, *arguments: str) -> str:
    """Run git in a fixture repository.

    Args:
        cwd: Repository root.
        *arguments: Arguments after ``git``.

    Returns:
        Standard output, stripped.
    """
    return subprocess.run([*_GIT, *arguments], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def _repository(root: Path, files: dict[str, str]) -> tuple[Path, str]:
    """Create a committed repository that serves any commit by id.

    Args:
        root: Folder to create.
        files: Relative path to text.

    Returns:
        The repository and its head commit.
    """
    root.mkdir(parents=True)
    _git(root, "init", "--quiet")
    _git(root, "config", "uploadpack.allowAnySHA1InWant", "true")
    for name, text in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text)
    _git(root, "add", "--all")
    _git(root, "commit", "--quiet", "-m", "init")
    return root, _git(root, "rev-parse", "HEAD")


def test_fetch_packs_the_pinned_tree_with_submodules_and_marks_them_read_only(tmp_path: Path) -> None:
    """Fetch the exact commit, include submodule files, strip git metadata, and list the submodule."""
    library, _ = _repository(tmp_path / "library", {"lib.py": "LIB = 1\n"})
    app, first = _repository(tmp_path / "app", {"src/app.py": "x = 1\n"})
    _git(app, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", f"file://{library}", "vendor/lib")
    _git(app, "commit", "--quiet", "-m", "submodule")
    pinned = _git(app, "rev-parse", "HEAD")
    (app / "src/app.py").write_text("x = 2\n")
    _git(app, "commit", "--quiet", "-am", "later")

    snapshot = fetch_snapshot("acme/app", pinned, None, tmp_path / "work", remote=f"file://{app}")

    assert snapshot.commit == pinned != first
    assert snapshot.readonly_paths == ("vendor/lib",)
    with tarfile.open(snapshot.archive) as packed:
        names = set(packed.getnames())
        assert packed.extractfile("src/app.py").read() == b"x = 1\n"
    assert "vendor/lib/lib.py" in names
    assert not any(".git" in Path(name).parts for name in names)
    assert not (tmp_path / "work" / "checkout").exists()


def test_fetch_failure_explains_without_leaking_the_token(tmp_path: Path) -> None:
    """Report a clone failure in plain words and never echo the credential."""
    with pytest.raises(RepoFetchError) as raised:
        fetch_snapshot("acme/app", "0" * 40, "ghp_supersecret", tmp_path / "work", remote=f"file://{tmp_path}/none")

    assert "ghp_supersecret" not in str(raised.value)


def test_auth_is_a_scoped_header_in_the_environment() -> None:
    """Send the token only to GitHub, through config the process list never shows."""
    environment = git_auth_env("ghp_supersecret")

    assert environment["GIT_CONFIG_KEY_0"] == f"http.{GITHUB_HOST}/.extraheader"
    header = environment["GIT_CONFIG_VALUE_0"].split(" ")[-1]
    assert base64.b64decode(header).decode() == "x-access-token:ghp_supersecret"
    assert environment["GIT_TERMINAL_PROMPT"] == "0"
    assert "GIT_CONFIG_COUNT" not in git_auth_env(None)


def test_patched_zip_holds_the_whole_tree_with_the_patch_applied(tmp_path: Path) -> None:
    """Apply the version's patch to the pinned commit and zip every file under the repository's name."""
    app, pinned = _repository(tmp_path / "app", {"src/app.py": "x = 1\n", "README.md": "hi\n"})
    patch = "--- a/src/app.py\n+++ b/src/app.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n"

    archive = patched_repo_zip("acme/app", pinned, patch, None, tmp_path / "work", remote=f"file://{app}")

    with zipfile.ZipFile(archive) as packed:
        assert sorted(packed.namelist()) == ["app/README.md", "app/src/app.py"]
        assert packed.read("app/src/app.py") == b"x = 2\n"
    assert not (tmp_path / "work" / "checkout").exists()


def test_patched_zip_refuses_a_patch_that_does_not_apply(tmp_path: Path) -> None:
    """Raise rather than zip a tree the version never produced."""
    app, pinned = _repository(tmp_path / "app", {"src/app.py": "x = 1\n"})
    patch = "--- a/src/app.py\n+++ b/src/app.py\n@@ -1 +1 @@\n-y = 9\n+x = 2\n"

    with pytest.raises(RepoFetchError):
        patched_repo_zip("acme/app", pinned, patch, None, tmp_path / "work", remote=f"file://{app}")
