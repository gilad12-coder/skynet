"""Run a local coding CLI without the user's own instructions, memory or MCP servers.

A CLI that reads the user's personal setup (global ``AGENTS.md`` or
``CLAUDE.md``, rules, hooks, skills, MCP servers) sends it with every prompt.
That skews model answers and can start MCP OAuth refreshes. :func:`isolated_cli`
gives each call an environment and flags that keep that setup out, but keep
the subscription login:

* ``codex``: a temporary ``HOME`` and ``CODEX_HOME`` that hold only a copy of
  ``auth.json``, plus ``--ignore-user-config --ignore-rules --ephemeral``, no
  ``AGENTS.md`` project docs and no skill list.
* ``claude``: the real config directory (its macOS Keychain login does not work
  from another one), with flags that load no settings, MCP servers or slash
  commands. Never ``--bare``: it ignores the subscription login.

Any other CLI is refused. Droid was removed (SKY-144): it has no flag that skips
the user's hooks, MCP servers, config or rules, and it always keeps one tool on.

A CLI can refresh its login during a call. When the copy changed and the real
file did not change meanwhile, the copy goes back under a file lock, so the
refreshed login survives and a newer login from another call is never lost.

Usage::

    with isolated_cli("codex") as isolation:
        argv = [binary, "exec", *isolation.args, ...]
        subprocess.run(argv, env=isolation.env, ...)
"""

from __future__ import annotations

import contextlib
import fcntl
import os
import shutil
import tempfile
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path

from .cli_catalog import CliProvider
from .cli_probe import cli_child_env

CLAUDE_ARGS = (
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--no-session-persistence",
)
"""``claude`` flags: no user, project or local settings (so no hooks or ``CLAUDE.md``), no MCP servers."""

CODEX_ARGS = (
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "-c",
    "mcp_servers={}",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "skills.include_instructions=false",
)
"""``codex exec`` flags: no ``config.toml``, rules, session files, MCP servers, ``AGENTS.md`` or skill list."""

CODEX_AUTH_FILE = "auth.json"
_LOCK_SUFFIX = ".skynet.lock"


@dataclass(frozen=True)
class CliIsolation:
    """The environment and extra flags for one isolated CLI call."""

    env: dict[str, str]
    args: tuple[str, ...]


@dataclass(frozen=True)
class _Credential:
    """A login file copied into a temporary home, and its bytes at copy time."""

    real: Path
    copy: Path
    original: bytes


def _user_home(env: Mapping[str, str]) -> Path:
    """Return the user's real home directory.

    Args:
        env: The environment the CLI would otherwise get.

    Returns:
        ``HOME`` from ``env``, or the process's home directory.
    """
    return Path(env["HOME"]) if env.get("HOME") else Path.home()


@contextlib.contextmanager
def _locked(real: Path) -> Iterator[None]:
    """Hold an exclusive lock that serializes copies of one login file.

    Args:
        real: The real login file.

    Yields:
        Nothing; the lock is held until the block ends.
    """
    lock_path = real.with_name(real.name + _LOCK_SUFFIX)
    with lock_path.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _copy_in(real: Path, copy: Path) -> _Credential | None:
    """Copy a login file into a temporary home, readable only by the user.

    Args:
        real: The real login file.
        copy: Where the copy goes.

    Returns:
        The copy record, or ``None`` when the real file does not exist.
    """
    if not real.is_file():
        return None
    with _locked(real):
        original = real.read_bytes()
    copy.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(copy, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(original)
    return _Credential(real=real, copy=copy, original=original)


def _copy_back(credential: _Credential) -> None:
    """Put a refreshed login back, unless another call changed the real file.

    Args:
        credential: The copy made by :func:`_copy_in`.
    """
    try:
        current = credential.copy.read_bytes()
    except OSError:
        return
    if current == credential.original:
        return
    with _locked(credential.real):
        try:
            if credential.real.read_bytes() != credential.original:
                return
        except OSError:
            return
        # Write next to the real file and rename, so a reader never sees half a login.
        descriptor, name = tempfile.mkstemp(dir=credential.real.parent, prefix=f".{credential.real.name}.")
        staged = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(current)
            staged.chmod(0o600)
            staged.replace(credential.real)
        except BaseException:
            staged.unlink(missing_ok=True)
            raise


def _codex(root: Path, env: dict[str, str]) -> list[_Credential]:
    """Point codex at a temporary ``HOME`` and ``CODEX_HOME`` with a login copy.

    Args:
        root: The call's temporary directory.
        env: The environment to change in place.

    Returns:
        The login copies to put back after the call.
    """
    real_codex_home = Path(env["CODEX_HOME"]) if env.get("CODEX_HOME") else _user_home(env) / ".codex"
    home = root / "home"
    codex_home = root / "codex"
    home.mkdir()
    codex_home.mkdir()
    env["HOME"] = str(home)
    env["CODEX_HOME"] = str(codex_home)
    credential = _copy_in(real_codex_home / CODEX_AUTH_FILE, codex_home / CODEX_AUTH_FILE)
    return [credential] if credential is not None else []


@contextlib.contextmanager
def isolated_cli(cli: CliProvider, *, base_env: Mapping[str, str] | None = None) -> Iterator[CliIsolation]:
    """Give one CLI call an environment and flags without the user's personal setup.

    Args:
        cli: The CLI that runs inside the block.
        base_env: The environment to start from; ``os.environ`` by default.

    Yields:
        The allow-listed environment and the flags to add to the
        CLI's command. Temporary homes exist until the block ends.

    Raises:
        ValueError: If ``cli`` is not ``claude`` or ``codex``.
    """
    if cli not in ("claude", "codex"):
        raise ValueError(f"No isolated setup for CLI {cli!r}; only claude and codex are supported")
    source = os.environ if base_env is None else base_env
    env = cli_child_env(source)
    if cli == "claude":
        yield CliIsolation(env=env, args=CLAUDE_ARGS)
        return
    root = Path(tempfile.mkdtemp(prefix=f"skynet-{cli}-home-"))
    credentials: list[_Credential] = []
    try:
        credentials = _codex(root, env)
        yield CliIsolation(env=env, args=CODEX_ARGS)
    finally:
        for credential in credentials:
            _copy_back(credential)
        shutil.rmtree(root, ignore_errors=True)
