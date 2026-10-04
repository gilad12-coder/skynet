"""Infer the shell command that prepares a repository checkout for scoring.

Users never type a setup command for a repository run: the trusted parent
reads the fetched tree, asks the run's optimization model when one is
reachable, and otherwise falls back to the manifests and lockfiles it finds.
"""

from __future__ import annotations

import fnmatch
import logging
import tarfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

logger = logging.getLogger(__name__)

# A model reads these, so each is capped; listing and contents stay well under
# any context window while still showing what the repository is built with.
_MAX_LISTED_PATHS = 400
_MAX_FILE_CHARS = 4_000
_MAX_TOTAL_CHARS = 40_000
_MAX_COMMAND_CHARS = 300
_KEY_FILE_PATTERNS = (
    "README*",
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
    "pyproject.toml",
    "requirements*.txt",
    "setup.py",
    "setup.cfg",
    "package.json",
    "Makefile",
    "Cargo.toml",
    "go.mod",
    "Dockerfile",
    "tox.ini",
    "noxfile.py",
)
# Lockfiles are large and only their presence matters.
_PRESENCE_ONLY = ("uv.lock", "poetry.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "go.sum")
# First match wins: a lockfile names the tool the project already pins.
_DETECTORS = (
    (("uv.lock",), "uv sync --frozen"),
    (("poetry.lock",), "poetry install --no-interaction"),
    (("requirements.txt",), "pip install -r requirements.txt"),
    (("pyproject.toml", "setup.py"), "pip install -e ."),
    (("package-lock.json",), "npm ci"),
    (("pnpm-lock.yaml",), "pnpm install --frozen-lockfile"),
    (("yarn.lock",), "yarn install --frozen-lockfile"),
    (("Cargo.toml",), "cargo build"),
    (("go.mod",), "go build ./..."),
)
_PROMPT = """You prepare a freshly cloned repository so its code can be run and tested.
Below are the repository's file listing and its key files.
Reply with exactly one line: a single shell command, run from the repository root,
that installs its dependencies and builds it. Prefer the project's own lockfile and
tooling (as its CI does). Do not run tests, start servers or use sudo.
If nothing needs installing, reply with exactly: none

File listing:
{listing}

Key files:
{files}
"""


@dataclass(frozen=True)
class RepoOverview:
    """The parts of a repository tree that reveal how it is set up."""

    paths: tuple[str, ...]
    files: dict[str, str]


def _is_key_file(path: str) -> bool:
    """Report whether a path is one of the files worth showing the model.

    Args:
        path: Repository-relative POSIX path.

    Returns:
        Whether it matches a key-file pattern; only top-level files and CI
        workflows qualify, since ``*`` would otherwise cross folders.
    """
    folder = path.rpartition("/")[0]
    if folder not in ("", ".github/workflows"):
        return False
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in _KEY_FILE_PATTERNS)


def read_overview(archive: Path) -> RepoOverview:
    """Read the file listing and key files out of a packed snapshot.

    Args:
        archive: Packed tree from :func:`fetch_snapshot`.

    Returns:
        Every regular file's path and the capped text of each key file.
    """
    paths: list[str] = []
    files: dict[str, str] = {}
    total = 0
    with tarfile.open(archive, "r:gz") as packed:
        members = sorted((member for member in packed.getmembers() if member.isfile()), key=lambda m: m.name)
        for member in members:
            path = str(PurePosixPath(member.name))
            paths.append(path)
            if not _is_key_file(path) or total >= _MAX_TOTAL_CHARS:
                continue
            handle = packed.extractfile(member)
            if handle is None:
                continue
            text = handle.read(_MAX_FILE_CHARS * 4).decode("utf-8", errors="replace")[:_MAX_FILE_CHARS]
            files[path] = text
            total += len(text)
    return RepoOverview(paths=tuple(paths), files=files)


def detect_setup_command(paths: Iterable[str]) -> str | None:
    """Pick a setup command from the manifests and lockfiles at the repository root.

    Args:
        paths: Repository-relative file paths.

    Returns:
        The install command for the first recognized project kind, or ``None``.
    """
    present = set(paths)
    for markers, command in _DETECTORS:
        if any(marker in present for marker in markers):
            return command
    return None


def _prompt(overview: RepoOverview) -> str:
    """Write the question the model answers.

    Args:
        overview: Listing and key files of the repository.

    Returns:
        The full prompt.
    """
    listed = list(overview.paths[:_MAX_LISTED_PATHS])
    if len(overview.paths) > _MAX_LISTED_PATHS:
        listed.append(f"... and {len(overview.paths) - _MAX_LISTED_PATHS} more files")
    present = [name for name in _PRESENCE_ONLY if name in overview.paths]
    files = "\n\n".join(f"--- {path} ---\n{text}" for path, text in overview.files.items())
    if present:
        files += "\n\nLockfiles present: " + ", ".join(present)
    return _PROMPT.format(listing="\n".join(listed), files=files or "(none)")


def parse_answer(answer: str) -> tuple[bool, str | None]:
    """Read the model's one-line answer.

    Args:
        answer: Raw model reply.

    Returns:
        Whether the reply is usable, and the command it names (``None`` when
        the model said nothing needs setting up).
    """
    lines = [line.strip().strip("`").strip() for line in answer.strip().strip("`").splitlines()]
    lines = [line for line in lines if line and line.lower() not in {"bash", "sh", "shell"}]
    if len(lines) != 1:
        return False, None
    command = lines[0].removeprefix("$ ").strip()
    if command.lower().rstrip(".") == "none":
        return True, None
    if len(command) > _MAX_COMMAND_CHARS or "\x00" in command:
        return False, None
    return True, command


def infer_setup_command(archive: Path, ask: Callable[[str], str | None] | None = None) -> str | None:
    """Infer the command that prepares a checkout of the snapshot.

    Args:
        archive: Packed tree from :func:`fetch_snapshot`.
        ask: Sends a prompt to the run's model and returns its reply, or
            ``None`` when the call did not succeed; without it only the
            manifests decide.

    Returns:
        A shell command, or ``None`` when the repository needs no setup.
    """
    overview = read_overview(archive)
    fallback = detect_setup_command(overview.paths)
    if ask is None:
        return fallback
    try:
        answer = ask(_prompt(overview))
    except Exception:  # isolation boundary: the manifest fallback must still set the run up
        logger.warning("Asking the model for a repository setup command failed", exc_info=True)
        return fallback
    usable, command = parse_answer(answer or "")
    if not usable:
        logger.info("The model's setup command was unusable; using the manifest fallback")
        return fallback
    return command
