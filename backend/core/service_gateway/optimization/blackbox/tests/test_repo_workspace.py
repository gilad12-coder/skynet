"""Tests for laying out repository versions in the parent-owned scorer box."""

from __future__ import annotations

import base64
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from core.exceptions import ServiceError

from ..repo_tree import unpack_tree, version_patch
from ..repo_workspace import _PROBE_OK, WORK_DIR, NetworkCutoffError, RepoSetupError, RepoWorkspace, redact
from ..sandbox import CommandResult, LocalSubprocessRuntime, SandboxSpec


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


class _Box:
    """Run commands on the host, but track the network state a real box would have."""

    def __init__(self, inner: Any, *, online: bool, cutoff: str) -> None:
        """Wrap a local session.

        Args:
            inner: The real local session commands run in.
            online: Whether the box opened with network access.
            cutoff: ``"ok"``, ``"refused"`` (the switch raises) or ``"leaky"``
                (the switch returns but hosts stay reachable).
        """
        self._inner = inner
        self.online = online
        self._cutoff = cutoff
        self.commands: list[tuple[str, bool, dict[str, str] | None]] = []
        self.closed = False

    def write_files(self, files: dict[str, str]) -> None:
        """Write into the wrapped box."""
        self._inner.write_files(files)

    def read_file(self, path: str) -> str | None:
        """Read from the wrapped box."""
        return self._inner.read_file(path)

    def run(self, command: str, **options: Any) -> CommandResult:
        """Record the command with the network state it ran under, answering the reachability probe."""
        self.commands.append((command, self.online, options.get("env")))
        if "/dev/tcp/" in command:
            return CommandResult(exit_code=1) if self.online else CommandResult(exit_code=0, stdout=_PROBE_OK)
        return self._inner.run(command, **options)

    def disable_network(self) -> None:
        """Switch the network off, or fail the way the configured provider would."""
        if self._cutoff == "refused":
            raise ServiceError("provider refused the policy change")
        if self._cutoff == "ok":
            self.online = False

    def close(self) -> None:
        """Close the wrapped box."""
        self.closed = True
        self._inner.close()


class _Runtime:
    """Open recording boxes over the local runtime."""

    def __init__(self, cutoff: str = "ok") -> None:
        """Choose how the network switch behaves.

        Args:
            cutoff: Passed to every box opened.
        """
        self._local = LocalSubprocessRuntime()
        self._cutoff = cutoff
        self.boxes: list[_Box] = []

    def open(self, spec: SandboxSpec) -> _Box:
        """Open one recording box."""
        box = _Box(self._local.open(spec), online=not spec.network_disabled, cutoff=self._cutoff)
        self.boxes.append(box)
        return box


_ONLINE = SandboxSpec(lifetime_seconds=60, allowed_hosts=("pypi.org",))


def _space(archive: Path, runtime: Any, *, setup: str | None, spec: SandboxSpec = _ONLINE) -> RepoWorkspace:
    """Build a workspace over ``archive`` with one secret.

    Args:
        archive: Packed tree.
        runtime: Where its box opens.
        setup: The setup command.
        spec: The box's network profile.

    Returns:
        The workspace.
    """
    return RepoWorkspace(
        runtime=runtime,
        spec=spec,
        archive=archive,
        editable_paths=["src"],
        readonly_paths=[],
        setup_command=setup,
        secrets={"API_KEY": "very-secret-value"},
    )


@pytest.fixture
def workspace(tmp_path: Path) -> Iterator[tuple[RepoWorkspace, _Runtime, Path, Path]]:
    """Open a workspace whose setup builds a file and leaves a stray one.

    Args:
        tmp_path: Scratch folder.

    Yields:
        The workspace, its runtime, the archive and the scratch folder.
    """
    archive = _archive(tmp_path, {"src/app.py": "x = 1\n", "tests/test_app.py": "t\n"})
    runtime = _Runtime()
    space = _space(archive, runtime, setup='echo "key=${API_KEY:-unset}"; cat src/app.py > built.txt')
    yield space, runtime, archive, tmp_path
    space.close()


def test_setup_runs_once_online_without_secrets_and_versions_run_offline(
    workspace: tuple[RepoWorkspace, _Runtime, Path, Path],
) -> None:
    """Prepare the starting commit once with network, then lay every version out on a copy with it off."""
    space, runtime, archive, root = workspace

    first = space.checkout(_patch(root / "one", archive, {"src/app.py": "x = 2\n"}))
    space.session().run(f"touch {WORK_DIR}/stray.txt")
    second = space.checkout("")

    assert first.path == second.path == WORK_DIR
    box = runtime.boxes[0]
    assert len(runtime.boxes) == 1
    setups = [entry for entry in box.commands if "built.txt" in entry[0]]
    assert len(setups) == 1
    assert setups[0][1] is True
    assert setups[0][2] is None
    assert "key=unset" in space.setup_log
    version_runs = [entry for entry in box.commands if "version.patch" in entry[0] or "stray" in entry[0]]
    assert len(version_runs) == 3
    assert all(online is False for _, online, _ in version_runs)
    assert space.session().read_file(f"{WORK_DIR}/built.txt") == "x = 1\n"
    assert space.session().read_file(f"{WORK_DIR}/stray.txt") is None


def test_version_code_never_runs_while_the_network_is_on(
    workspace: tuple[RepoWorkspace, _Runtime, Path, Path],
) -> None:
    """Every command after setup, including the reachability check, runs only once the switch landed."""
    space, runtime, archive, root = workspace

    space.checkout(_patch(root / "one", archive, {"src/app.py": "x = 2\n"}))

    commands = runtime.boxes[0].commands
    probe = next(index for index, entry in enumerate(commands) if "/dev/tcp/" in entry[0])
    assert all(online for _, online, _ in commands[:probe])
    assert not any(online for _, online, _ in commands[probe:])
    assert all("version.patch" not in command for command, _, _ in commands[:probe])


@pytest.mark.parametrize("cutoff", ["refused", "leaky"])
def test_a_failed_network_cutoff_stops_the_workspace(tmp_path: Path, cutoff: str) -> None:
    """Close the box and refuse every version when the network cannot be switched off and confirmed."""
    archive = _archive(tmp_path, {"src/app.py": "x = 1\n"})
    runtime = _Runtime(cutoff)
    space = _space(archive, runtime, setup="true")

    with pytest.raises(NetworkCutoffError):
        space.checkout(_patch(tmp_path / "one", archive, {"src/app.py": "x = 2\n"}))
    with pytest.raises(NetworkCutoffError):
        space.checkout("")

    assert len(runtime.boxes) == 1
    assert runtime.boxes[0].closed
    assert all("version.patch" not in command for command, _, _ in runtime.boxes[0].commands)


def test_a_box_that_cannot_switch_its_network_off_is_refused(tmp_path: Path) -> None:
    """Fail closed when the runtime offers no way to take an online box offline."""
    archive = _archive(tmp_path, {"src/app.py": "x = 1\n"})
    space = _space(archive, LocalSubprocessRuntime(), setup=None)

    with pytest.raises(NetworkCutoffError, match="cannot switch"):
        space.session()


def test_an_offline_box_is_not_switched_or_probed(tmp_path: Path) -> None:
    """A box that opened offline needs no switch, so a run without setup never reaches a registry."""
    archive = _archive(tmp_path, {"src/app.py": "x = 1\n"})
    runtime = _Runtime("refused")
    space = _space(archive, runtime, setup=None, spec=SandboxSpec(lifetime_seconds=60, network_disabled=True))
    try:
        assert space.checkout("").path == WORK_DIR
    finally:
        space.close()

    assert not any(online for _, online, _ in runtime.boxes[0].commands)
    assert all("/dev/tcp/" not in command for command, _, _ in runtime.boxes[0].commands)


def test_failed_setup_and_broken_patches_are_reported(tmp_path: Path) -> None:
    """Stop on a setup that exits non-zero, and explain a patch that does not apply."""
    archive = _archive(tmp_path, {"src/app.py": "x = 1\n"})
    failing = _space(archive, _Runtime(), setup="echo boom; exit 3")
    with pytest.raises(RepoSetupError, match="exit 3") as failed:
        failing.session()
    assert "boom" in str(failed.value)

    space = _space(archive, _Runtime(), setup=None)
    try:
        broken = space.checkout(
            "diff --git a/src/app.py b/src/app.py\n--- a/src/app.py\n+++ b/src/app.py\n@@ -1 +1 @@\n-y\n+z\n"
        )
    finally:
        space.close()
    assert broken.problems[0].startswith("The change does not apply cleanly")


def test_versions_outside_the_editable_paths_never_reach_the_box(
    workspace: tuple[RepoWorkspace, _Runtime, Path, Path],
) -> None:
    """Refuse a version that edits the tests before anything runs."""
    space, runtime, archive, root = workspace

    result = space.checkout(_patch(root / "one", archive, {"tests/test_app.py": "rigged\n"}))

    assert result.path is None
    assert result.problems == ("'tests/test_app.py' is outside the editable paths.",)
    assert runtime.boxes == []


def test_redact_hides_long_values_only() -> None:
    """Mask real secrets while leaving short values that would scramble ordinary output."""
    assert redact("key=abcdefgh on=1", ["abcdefgh", "1"]) == "key=[secret] on=1"
