"""The Mac app's BYOK vault key, kept in a file in the local state directory.

A hosted deployment gets ``BYOK_VAULT_KEY`` from its environment. The Mac app
has no operator to set it, so without this file the vault stays read-only and
the user cannot save a provider key. The file has the same protection as the
desktop shell's other local secrets: it is readable only by the user.

Only standard-library and ``cryptography`` imports, because ``core.config``
loads this module while it builds the settings.
"""

from __future__ import annotations

import fcntl
import os
import tempfile
from pathlib import Path

from cryptography.fernet import Fernet

VAULT_KEY_FILE = "byok_vault.key"
_LOCK_FILE = f"{VAULT_KEY_FILE}.lock"


def load_or_create_vault_key(state_dir: str | os.PathLike[str]) -> str:
    """Read the vault key from the state directory, creating it on first use.

    The API and the worker start at the same time and must use one key, so
    creation runs under an exclusive file lock. The key is written to a
    private temp file first and then linked into place, so the key file is
    never seen half written. An empty key file, left by a crash of an older
    build between creating and writing it, protects no saved secret and is
    replaced.

    Args:
        state_dir: The local-mode state directory.

    Returns:
        The urlsafe-base64 Fernet key.

    Raises:
        ValueError: When the file holds data that is not a valid Fernet key.
            A new key would make every saved provider key unreadable, so the
            app must not replace it.
    """
    directory = Path(state_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / VAULT_KEY_FILE
    lock_fd = os.open(directory / _LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        existing = _read_key(path)
        if existing is not None:
            return existing
        key = Fernet.generate_key()
        _install_key(path, key, replace_empty=path.exists())
        return key.decode("ascii")
    finally:
        os.close(lock_fd)


def _install_key(path: Path, key: bytes, *, replace_empty: bool) -> None:
    """Write a new key to a private temp file and move it into place.

    ``mkstemp`` creates the temp file readable only by the user, so the key
    file is private from the moment it appears.

    Args:
        path: The key file.
        key: The new Fernet key.
        replace_empty: Whether an empty key file is in the way. Only then is
            the file replaced; otherwise ``os.link`` refuses to overwrite.
    """
    fd, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{VAULT_KEY_FILE}.")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(key)
            handle.flush()
            os.fsync(handle.fileno())
        if replace_empty:
            Path(temp_name).replace(path)
        else:
            os.link(temp_name, path)
    finally:
        Path(temp_name).unlink(missing_ok=True)


def _read_key(path: Path) -> str | None:
    """Read and check an existing vault key file.

    Args:
        path: The key file.

    Returns:
        The stored Fernet key, or ``None`` when the file is missing or empty.

    Raises:
        ValueError: When the file holds data that is not a valid Fernet key.
    """
    try:
        key = path.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        return None
    if not key:
        return None
    try:
        Fernet(key.encode("ascii"))
    except ValueError as exc:
        raise ValueError(f"{path} does not hold a valid BYOK vault key") from exc
    return key
