"""The Mac app's BYOK vault key, kept in a file in the local state directory.

A hosted deployment gets ``BYOK_VAULT_KEY`` from its environment. The Mac app
has no operator to set it, so without this file the vault stays read-only and
the user cannot save a provider key. The file has the same protection as the
desktop shell's other local secrets: it is readable only by the user.

Only standard-library and ``cryptography`` imports, because ``core.config``
loads this module while it builds the settings.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from cryptography.fernet import Fernet

VAULT_KEY_FILE = "byok_vault.key"


def load_or_create_vault_key(state_dir: str | os.PathLike[str]) -> str:
    """Read the vault key from the state directory, creating it on first use.

    The API and the worker start at the same time and must use one key, so the
    file is created with ``O_EXCL``: the process that loses the race reads the
    winner's key.

    Args:
        state_dir: The local-mode state directory.

    Returns:
        The urlsafe-base64 Fernet key.

    Raises:
        ValueError: When the file exists but does not hold a valid Fernet key.
            A new key would make every saved provider key unreadable, so the
            app must not replace it.
    """
    directory = Path(state_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / VAULT_KEY_FILE
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return _read_key(path)
    key = Fernet.generate_key()
    with os.fdopen(fd, "wb") as handle:
        handle.write(key)
        handle.flush()
        os.fsync(handle.fileno())
    return key.decode("ascii")


def _read_key(path: Path) -> str:
    """Read and check an existing vault key file.

    A process that lost the creation race can see the file before the winner
    wrote the key, so an empty file is read again for a short time.

    Args:
        path: The key file.

    Returns:
        The stored Fernet key.

    Raises:
        ValueError: When the file does not hold a valid Fernet key.
    """
    for _ in range(50):
        key = path.read_text(encoding="ascii").strip()
        if key:
            break
        time.sleep(0.02)
    try:
        Fernet(key.encode("ascii"))
    except ValueError as exc:
        raise ValueError(f"{path} does not hold a valid BYOK vault key") from exc
    return key
