"""Tests for laying out repository versions in the parent-owned scorer box."""

from __future__ import annotations

import base64
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

from ..repo_tree import unpack_tree, version_patch
from ..repo_workspace import WORK_DIR, RepoWorkspace, redact
from ..sandbox import LocalSubprocessRuntime, SandboxSpec


def _archive(root: Path, files: dict[str, str]) -> Path:
    """Pack ``files`` the way the parent ships a fetched tree.

    Args:
        root: Scratch folder.
        files: Relative path to text.

    Returns:
        The archive.
    """
    source = root / "source"
    for name, text in files.items():
        (source / name).parent.mkdir(parents=True, exist_ok=True)
        (source / name).write_text(text)
    archive = root / "tree.tgz"
    subprocess.run(["tar", "-czf", str(archive), "-C", str(source), "."], check=True)
    return archive


def _patch(root: Path, archive: Path, edits: dict[str, str]) -> str:
    """Write ``edits`` into a copy of the tree and return them as a version.

    Args:
        root: Scratch folder.
        archive: Packed tree.
        edits: Relative path to new text.

    Returns:
        The version's patch.
    """
    root.mkdir(parents=True, exist_ok=True)
    chunk = root / "chunk"
    chunk.write_text(base64.b64encode(archive.read_bytes()).decode())
    checkout = unpack_tree([chunk], root / "agent")
    for name, text in edits.items():
        (checkout / name).parent.mkdir(parents=True, exist_ok=True)
        (checkout / name).write_text(text)
    return version_patch(checkout)


@pytest.fixture
def workspace(tmp_path: Path) -> Iterator[tuple[RepoWorkspace, Path, Path]]:
    """Open a workspace over a small tree with a setup command that reads a secret.

    Args:
        tmp_path: Scratch folder.

    Yields:
        The workspace, the archive and the scratch folder.
    """
    archive = _archive(tmp_path, {"src/app.py": "x = 1\n", "tests/test_app.py": "t\n"})
    space = RepoWorkspace(
        runtime=LocalSubprocessRuntime(),
        spec=SandboxSpec(lifetime_seconds=60),
        archive=archive,
        editable_paths=["src"],
        readonly_paths=[],
        setup_command='echo "token=$API_KEY"; cat src/app.py > built.txt; touch stray.txt',
        secrets={"API_KEY": "very-secret-value"},
    )
    yield space, archive, tmp_path
    space.close()


def test_each_version_is_set_up_on_a_fresh_copy_with_secrets_redacted(
    workspace: tuple[RepoWorkspace, Path, Path],
) -> None:
    """Apply the patch, run setup with the secret, hide it from logs, and start every version clean."""
    space, archive, root = workspace
    streamed: list[str] = []

    first = space.checkout(
        _patch(root / "one", archive, {"src/app.py": "x = 2\n"}),
        on_output=lambda stream, piece: streamed.append(piece),
    )

    assert first.path == WORK_DIR
    assert first.problems == ()
    built = space.session().read_file(f"{WORK_DIR}/built.txt")
    assert built == "x = 2\n"
    assert "token=[secret]" in "".join(streamed)
    assert "very-secret-value" not in first.setup_log + "".join(streamed)
    assert "token=[secret]" in first.setup_log

    second = space.checkout("")

    assert second.path == WORK_DIR
    assert space.session().read_file(f"{WORK_DIR}/built.txt") == "x = 1\n"


def test_versions_outside_the_editable_paths_never_reach_the_box(
    workspace: tuple[RepoWorkspace, Path, Path],
) -> None:
    """Refuse a version that edits the tests before anything runs."""
    space, archive, root = workspace

    result = space.checkout(_patch(root / "one", archive, {"tests/test_app.py": "rigged\n"}))

    assert result.path is None
    assert result.problems == ("'tests/test_app.py' is outside the editable paths.",)


def test_failed_setup_and_broken_patches_are_reported(tmp_path: Path) -> None:
    """Explain a setup that exits non-zero and a patch that does not apply."""
    archive = _archive(tmp_path, {"src/app.py": "x = 1\n"})
    space = RepoWorkspace(
        runtime=LocalSubprocessRuntime(),
        spec=SandboxSpec(lifetime_seconds=60),
        archive=archive,
        editable_paths=["."],
        readonly_paths=[],
        setup_command="echo boom; exit 3",
        secrets={},
    )
    try:
        failed = space.checkout("")
        broken = space.checkout(
            "diff --git a/src/app.py b/src/app.py\n--- a/src/app.py\n+++ b/src/app.py\n@@ -1 +1 @@\n-y\n+z\n"
        )
    finally:
        space.close()

    assert failed.problems == ("The setup command failed (exit 3).",)
    assert "boom" in failed.setup_log
    assert broken.problems[0].startswith("The change does not apply cleanly")


def test_redact_hides_long_values_only() -> None:
    """Mask real secrets while leaving short values that would scramble ordinary output."""
    assert redact("key=abcdefgh on=1", ["abcdefgh", "1"]) == "key=[secret] on=1"
