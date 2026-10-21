"""Read a repository's ``optimize.toml`` and work out the environment its run gets.

The file travels with the repository, so anyone who can push to it wrote it.
It may only narrow what the customer approved: it can shrink the editable
paths, protect more files, propose a setup command when none was chosen, and
add instructions for the agent. It can never widen an editable path or grant
a service; asking for either fails the setup check with the reason.

Enforced: ``[paths] editable`` and ``[paths] protected`` (every version is
checked against them before it is scored or published). Not enforced:
``[instructions]``, which the agent reads as guidance only.
"""

from __future__ import annotations

import hashlib
import tarfile
import tomllib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

CONSTRAINTS_FILE = "optimize.toml"
_MAX_FILE_BYTES = 64 * 1024
_MAX_PATHS = 200
_MAX_INTENT_CHARS = 4_000
_MAX_INVARIANTS = 50
_MAX_INVARIANT_CHARS = 500
_MAX_COMMAND_CHARS = 300
_SECTIONS: dict[str, frozenset[str]] = {
    "paths": frozenset({"editable", "protected"}),
    "setup": frozenset({"command"}),
    "instructions": frozenset({"intent", "invariants"}),
}


class ConstraintsError(ValueError):
    """The repository's constraints file is invalid or asks for more than the run allows."""


@dataclass(frozen=True)
class RepoConstraints:
    """What a repository's constraints file proposes, already validated."""

    sha256: str
    editable_paths: tuple[str, ...] | None = None
    protected_paths: tuple[str, ...] = ()
    setup_command: str | None = None
    intent: str | None = None
    invariants: tuple[str, ...] = ()


@dataclass(frozen=True)
class RepoEnvironment:
    """The effective rules a repository run is held to."""

    editable_paths: tuple[str, ...]
    protected_paths: tuple[str, ...]
    setup_command: str | None
    constraints: RepoConstraints | None = None
    notes: tuple[str, ...] = ()

    def record(
        self, *, repository: str, commit: str, readonly_paths: Sequence[str], secret_names: Iterable[str]
    ) -> dict[str, Any]:
        """Describe the environment as the JSON saved with the run and shown before it starts.

        Args:
            repository: ``owner/name``.
            commit: The pinned starting commit.
            readonly_paths: Submodules and Git LFS files.
            secret_names: Names of the variables the scorer receives; never values.

        Returns:
            A JSON-ready summary of what the run can and cannot do.
        """
        file = self.constraints
        return {
            "repository": repository,
            "commit": commit,
            "constraints_file": {"path": CONSTRAINTS_FILE, "sha256": file.sha256} if file else None,
            "editable_paths": list(self.editable_paths),
            "protected_paths": list(self.protected_paths),
            "readonly_paths": list(readonly_paths),
            "secret_names": sorted(secret_names),
            "services": [],
            "instructions": {"intent": file.intent, "invariants": list(file.invariants)}
            if file and (file.intent or file.invariants)
            else None,
            "notes": list(self.notes),
        }


def _clean_path(raw: Any, key: str) -> str:
    """Normalize one repository-relative path from the file.

    Args:
        raw: The value as parsed.
        key: The setting it came from, named in errors.

    Returns:
        The ``/``-joined path without leading or trailing slashes; ``.`` for the whole tree.

    Raises:
        ConstraintsError: When the value is not a path inside the repository, or is a pattern.
    """
    if not isinstance(raw, str):
        raise ConstraintsError(f"{CONSTRAINTS_FILE}: every entry of [paths] {key} must be a text path.")
    path = raw.strip().replace("\\", "/")
    if path in (".", "./"):
        return "."
    stripped = path.strip("/")
    if path.startswith("/") or not stripped or any(part in ("", ".", "..") for part in stripped.split("/")):
        raise ConstraintsError(
            f"{CONSTRAINTS_FILE}: '{raw}' in [paths] {key} must be relative and stay inside the repository."
        )
    if stripped == ".git" or stripped.startswith(".git/"):
        raise ConstraintsError(f"{CONSTRAINTS_FILE}: [paths] {key} cannot name the .git folder.")
    # Paths are compared literally, so a pattern would match no file and
    # protect nothing while still being listed as protected.
    if any(char in stripped for char in "*?["):
        raise ConstraintsError(
            f"{CONSTRAINTS_FILE}: '{raw}' in [paths] {key} looks like a pattern. Patterns are not supported;"
            " name the files or folders."
        )
    return stripped


def _paths(section: Mapping[str, Any], key: str) -> tuple[str, ...] | None:
    """Read one list of paths from ``[paths]``.

    Args:
        section: The parsed ``[paths]`` table.
        key: ``editable`` or ``protected``.

    Returns:
        The distinct cleaned paths, or ``None`` when the key is absent.

    Raises:
        ConstraintsError: When the value is not a list of paths.
    """
    if key not in section:
        return None
    values = section[key]
    if not isinstance(values, list) or len(values) > _MAX_PATHS:
        raise ConstraintsError(f"{CONSTRAINTS_FILE}: [paths] {key} must be a list of at most {_MAX_PATHS} paths.")
    return tuple(dict.fromkeys(_clean_path(value, key) for value in values))


def _text(value: Any, setting: str, limit: int) -> str:
    """Read one bounded text setting.

    Args:
        value: The value as parsed.
        setting: The setting's name, used in errors.
        limit: Most characters allowed.

    Returns:
        The stripped text.

    Raises:
        ConstraintsError: When the value is not text, is blank, or is too long.
    """
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ConstraintsError(f"{CONSTRAINTS_FILE}: {setting} must be text of 1 to {limit} characters.")
    return value.strip()


def parse_constraints(raw: bytes) -> RepoConstraints:
    """Validate the bytes of a constraints file.

    Unknown sections and keys fail rather than being ignored, so a rule the
    runtime cannot enforce is never silently dropped.

    Args:
        raw: The file's contents.

    Returns:
        The validated proposal.

    Raises:
        ConstraintsError: When the file is too large, not TOML, or holds an
            unknown, malformed, or unsupported setting.
    """
    if len(raw) > _MAX_FILE_BYTES:
        raise ConstraintsError(f"{CONSTRAINTS_FILE} is larger than {_MAX_FILE_BYTES // 1024} KiB.")
    try:
        document = tomllib.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ConstraintsError(f"{CONSTRAINTS_FILE} is not valid TOML: {error}") from error
    version = document.pop("version", 1)
    if version != 1:
        raise ConstraintsError(f"{CONSTRAINTS_FILE}: version {version!r} is not supported; use version = 1.")
    if "services" in document:
        raise ConstraintsError(
            f"{CONSTRAINTS_FILE} asks for service access in [services]. A repository file cannot grant"
            " services, and repository runs cannot reach outside services yet. Remove the section to run."
        )
    for name, section in document.items():
        if name not in _SECTIONS:
            raise ConstraintsError(f"{CONSTRAINTS_FILE}: [{name}] is not a supported section.")
        if not isinstance(section, dict):
            raise ConstraintsError(f"{CONSTRAINTS_FILE}: {name} must be a [{name}] table.")
        unknown = sorted(set(section) - _SECTIONS[name])
        if unknown:
            raise ConstraintsError(f"{CONSTRAINTS_FILE}: [{name}] {unknown[0]} is not a supported setting.")
    paths = document.get("paths", {})
    setup = document.get("setup", {})
    instructions = document.get("instructions", {})
    protected = _paths(paths, "protected") or ()
    if "." in protected:
        raise ConstraintsError(f"{CONSTRAINTS_FILE}: [paths] protected cannot protect the whole repository.")
    editable = _paths(paths, "editable")
    if editable == ():
        raise ConstraintsError(
            f"{CONSTRAINTS_FILE}: [paths] editable is empty, so no version could change anything."
            " List at least one path, or remove the setting to keep the approved ones."
        )
    invariants = instructions.get("invariants", [])
    if not isinstance(invariants, list) or len(invariants) > _MAX_INVARIANTS:
        raise ConstraintsError(
            f"{CONSTRAINTS_FILE}: [instructions] invariants must be a list of at most {_MAX_INVARIANTS} items."
        )
    return RepoConstraints(
        sha256=hashlib.sha256(raw).hexdigest(),
        editable_paths=editable,
        protected_paths=protected,
        setup_command=_text(setup["command"], "[setup] command", _MAX_COMMAND_CHARS) if "command" in setup else None,
        intent=_text(instructions["intent"], "[instructions] intent", _MAX_INTENT_CHARS)
        if "intent" in instructions
        else None,
        invariants=tuple(_text(item, "[instructions] invariants", _MAX_INVARIANT_CHARS) for item in invariants),
    )


def read_constraints(archive: Path) -> RepoConstraints | None:
    """Read the constraints file at the root of a packed snapshot.

    Args:
        archive: Packed tree from :func:`fetch_snapshot`.

    Returns:
        The validated proposal, or ``None`` when the repository has no such file.

    Raises:
        ConstraintsError: When the file is not a regular file or is invalid.
    """
    with tarfile.open(archive, "r:gz") as packed:
        member = next((m for m in packed.getmembers() if str(PurePosixPath(m.name)) == CONSTRAINTS_FILE), None)
        if member is None:
            return None
        if not member.isfile():
            raise ConstraintsError(f"{CONSTRAINTS_FILE} must be a regular file, not a link or folder.")
        if member.size > _MAX_FILE_BYTES:
            raise ConstraintsError(f"{CONSTRAINTS_FILE} is larger than {_MAX_FILE_BYTES // 1024} KiB.")
        handle = packed.extractfile(member)
        return parse_constraints(handle.read() if handle is not None else b"")


def _inside(path: str, roots: Iterable[str]) -> bool:
    """Report whether ``path`` is one of ``roots`` or lies below one.

    Args:
        path: Repository-relative path; ``.`` is the whole tree.
        roots: Repository-relative files or folders; ``.`` is the whole tree.

    Returns:
        Whether a root covers the path.
    """
    return any(root == "." or path == root or path.startswith(root.rstrip("/") + "/") for root in roots)


def effective_environment(
    constraints: RepoConstraints | None,
    *,
    approved_editable: Sequence[str],
    approved_setup: str | None,
) -> RepoEnvironment:
    """Combine the customer's approved settings with what the repository proposes.

    The constraints file itself is always protected, so no version can change
    the rules it is scored under.

    Args:
        constraints: The repository's proposal, or ``None`` when it has none.
        approved_editable: Editable paths from the submitted run.
        approved_setup: Setup command from the submitted run, if any.

    Returns:
        The rules the run is held to.

    Raises:
        ConstraintsError: When the file proposes an editable path outside the approved ones,
            or when the protected paths (always including the file itself) cover every editable path.
    """
    if constraints is None:
        editable = tuple(approved_editable)
        if all(_inside(path, (CONSTRAINTS_FILE,)) for path in editable):
            raise ConstraintsError(
                f"{CONSTRAINTS_FILE} is always protected, so the approved editable paths ({', '.join(editable)})"
                " leave nothing a version can change. Approve a path other than the constraints file."
            )
        return RepoEnvironment(
            editable_paths=editable, protected_paths=(CONSTRAINTS_FILE,), setup_command=approved_setup
        )
    editable = tuple(approved_editable)
    if constraints.editable_paths is not None:
        wider = [path for path in constraints.editable_paths if not _inside(path, approved_editable)]
        if wider:
            approved = ", ".join(approved_editable)
            raise ConstraintsError(
                f"{CONSTRAINTS_FILE} makes '{wider[0]}' editable, which is outside the approved editable"
                f" paths ({approved}). A repository file can only narrow them; widen them in the run's settings."
            )
        editable = constraints.editable_paths
    protected = tuple(dict.fromkeys((CONSTRAINTS_FILE, *constraints.protected_paths)))
    # Protected paths win over editable ones when a patch is checked, so this
    # run could only spend its budget on versions that are all refused.
    if all(_inside(path, protected) for path in editable):
        raise ConstraintsError(
            f"{CONSTRAINTS_FILE} protects every editable path ({', '.join(editable)}), so no version could"
            " change anything. Protect less, or make a path outside [paths] protected editable."
        )
    notes: list[str] = []
    setup = approved_setup
    if (approved_setup or "").strip():
        if constraints.setup_command and constraints.setup_command != approved_setup.strip():
            notes.append(f"The run's own setup command replaces the one in {CONSTRAINTS_FILE}.")
    else:
        setup = constraints.setup_command
    return RepoEnvironment(
        editable_paths=editable,
        protected_paths=protected,
        setup_command=setup,
        constraints=constraints,
        notes=tuple(notes),
    )


def instructions_brief(environment: RepoEnvironment) -> str:
    """Write the repository's rules as text the optimization agent reads.

    Args:
        environment: The effective rules.

    Returns:
        Markdown naming the protected paths and the file's instructions, marked
        as guidance where the runtime does not enforce them.
    """
    lines = [
        f"## Repository rules ({CONSTRAINTS_FILE})",
        "",
        "Protected, every change to them is rejected before scoring: "
        + ", ".join(f"`{path}`" for path in environment.protected_paths)
        + ".",
    ]
    file = environment.constraints
    if file is not None and (file.intent or file.invariants):
        lines += ["", "Guidance from the repository (not enforced; the scorer decides):"]
        if file.intent:
            lines += ["", file.intent]
        lines += [f"- {item}" for item in file.invariants]
    return "\n".join(lines)
