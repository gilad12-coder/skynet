"""Tests for reading a repository's optimize.toml and the environment its run gets."""

from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from ..repo_constraints import (
    CONSTRAINTS_FILE,
    ConstraintsError,
    effective_environment,
    instructions_brief,
    parse_constraints,
    read_constraints,
)

_CFCA = b"""
version = 1

[paths]
editable = ["bot/geocode"]
protected = ["bot/geocode/eval", "data/labels.csv"]

[setup]
command = "pip install -r requirements.txt"

[instructions]
intent = "Return the coordinates of the place the sender most likely means."
invariants = ["Keep the reply format unchanged."]
"""


def _archive(tmp_path: Path, files: dict[str, bytes], *, link: str | None = None) -> Path:
    """Pack files the way the parent ships a fetched tree.

    Args:
        tmp_path: Scratch folder.
        files: Root-relative path to bytes.
        link: When set, a symbolic link named ``optimize.toml`` pointing here.

    Returns:
        The archive.
    """
    archive = tmp_path / "tree.tgz"
    with tarfile.open(archive, "w:gz") as packed:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            packed.addfile(info, io.BytesIO(data))
        if link is not None:
            info = tarfile.TarInfo(CONSTRAINTS_FILE)
            info.type, info.linkname = tarfile.SYMTYPE, link
            packed.addfile(info)
    return archive


def test_a_repository_without_the_file_keeps_the_approved_settings(tmp_path: Path) -> None:
    """No file means the approved paths and setup stand, and the file name itself is still protected."""
    assert read_constraints(_archive(tmp_path, {"src/app.py": b"x = 1\n"})) is None

    environment = effective_environment(None, approved_editable=["src"], approved_setup=None)

    assert environment.editable_paths == ("src",)
    assert environment.protected_paths == (CONSTRAINTS_FILE,)
    assert environment.setup_command is None


def test_the_file_narrows_paths_protects_files_and_proposes_setup(tmp_path: Path) -> None:
    """A valid file narrows the editable paths, adds protected ones, and fills in the missing setup."""
    constraints = read_constraints(_archive(tmp_path, {CONSTRAINTS_FILE: _CFCA, "bot/app.py": b""}))
    assert constraints is not None

    environment = effective_environment(constraints, approved_editable=["bot"], approved_setup=None)

    assert environment.editable_paths == ("bot/geocode",)
    assert environment.protected_paths == (CONSTRAINTS_FILE, "bot/geocode/eval", "data/labels.csv")
    assert environment.setup_command == "pip install -r requirements.txt"
    record = environment.record(
        repository="cfca/bot", commit="a" * 40, readonly_paths=["vendor"], secret_names={"GEO_KEY": "v"}
    )
    assert record["constraints_file"] == {"path": CONSTRAINTS_FILE, "sha256": constraints.sha256}
    assert record["secret_names"] == ["GEO_KEY"]
    assert record["services"] == []
    brief = instructions_brief(environment)
    assert "`data/labels.csv`" in brief
    assert "not enforced" in brief
    assert "Keep the reply format unchanged." in brief


def test_the_approved_setup_command_wins_and_says_so() -> None:
    """A run's own setup command is kept, with a note that the file's proposal was not used."""
    constraints = parse_constraints(_CFCA)

    environment = effective_environment(constraints, approved_editable=["."], approved_setup="uv sync")

    assert environment.setup_command == "uv sync"
    assert environment.notes == (f"The run's own setup command replaces the one in {CONSTRAINTS_FILE}.",)


def test_the_file_cannot_widen_the_approved_editable_paths() -> None:
    """Asking to edit outside the approved paths fails with the path and the way to fix it."""
    constraints = parse_constraints(b'[paths]\neditable = ["bot", "eval"]\n')

    with pytest.raises(ConstraintsError, match="'eval' editable, which is outside the approved editable paths"):
        effective_environment(constraints, approved_editable=["bot"], approved_setup=None)


@pytest.mark.parametrize(
    ("raw", "approved"),
    [
        (b'[paths]\neditable = ["bot/geocode"]\nprotected = ["bot"]\n', ["bot"]),
        (b'[paths]\nprotected = ["bot"]\n', ["bot/geocode"]),
        (b'[paths]\neditable = ["optimize.toml"]\n', ["."]),
    ],
)
def test_a_file_that_protects_every_editable_path_fails_the_setup_check(raw: bytes, approved: list[str]) -> None:
    """A run where every edit would be refused as protected fails before it spends its budget."""
    constraints = parse_constraints(raw)

    with pytest.raises(ConstraintsError, match="protects every editable path"):
        effective_environment(constraints, approved_editable=approved, approved_setup=None)


def test_a_file_that_protects_part_of_an_editable_path_still_runs() -> None:
    """Protecting a file inside an editable folder leaves the rest of the folder editable."""
    constraints = parse_constraints(b'[paths]\nprotected = ["bot/labels.csv"]\n')

    environment = effective_environment(constraints, approved_editable=["bot"], approved_setup=None)

    assert environment.editable_paths == ("bot",)


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        (b'[services]\ngeocoder = ["search"]\n', "cannot grant services"),
        (b"[network]\nallow = true\n", r"\[network\] is not a supported section"),
        (b"[paths]\nwritable = []\n", r"\[paths\] writable is not a supported setting"),
        (b'[paths]\nprotected = ["."]\n', "cannot protect the whole repository"),
        (b"[paths]\neditable = []\n", r"\[paths\] editable is empty"),
        (b'[paths]\neditable = ["../outside"]\n', "must be relative and stay inside"),
        (b'[paths]\nprotected = [".git/hooks"]\n', "cannot name the .git folder"),
        (b"version = 2\n", "version 2 is not supported"),
        (b"[paths\n", "is not valid TOML"),
        (b"paths = 1\n", r"must be a \[paths\] table"),
        (b'[setup]\ncommand = ""\n', r"\[setup\] command must be text"),
    ],
)
def test_unsupported_or_malformed_settings_fail_with_a_reason(raw: bytes, message: str) -> None:
    """Every rule the runtime cannot honor is refused rather than dropped."""
    with pytest.raises(ConstraintsError, match=message):
        parse_constraints(raw)


def test_a_linked_constraints_file_is_refused(tmp_path: Path) -> None:
    """A symbolic link could point the rules anywhere, so only a regular file counts."""
    with pytest.raises(ConstraintsError, match="must be a regular file"):
        read_constraints(_archive(tmp_path, {"real.toml": b""}, link="real.toml"))


def test_an_oversized_file_is_refused() -> None:
    """The file is read into memory and into the agent's brief, so its size is capped."""
    with pytest.raises(ConstraintsError, match="larger than 64 KiB"):
        parse_constraints(b"#" * (64 * 1024 + 1))
