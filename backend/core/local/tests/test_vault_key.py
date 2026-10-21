"""Tests for the Mac app's BYOK vault key file and the settings that load it."""

from __future__ import annotations

import stat
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr

from ...config import Settings
from ..vault_key import VAULT_KEY_FILE, load_or_create_vault_key


def test_creates_a_private_key_once_and_reads_it_back(tmp_path: Path) -> None:
    """Create a valid key readable only by the user, then return the same key on every later call.

    Args:
        tmp_path: Holds the state directory.
    """
    state = tmp_path / "state"
    key = load_or_create_vault_key(state)
    Fernet(key.encode("ascii"))
    path = state / VAULT_KEY_FILE
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert load_or_create_vault_key(state) == key
    assert path.read_text(encoding="ascii") == key


def test_concurrent_starts_share_one_key(tmp_path: Path) -> None:
    """Give the API and the worker the same key when they start at the same time.

    Args:
        tmp_path: The state directory.
    """
    with ThreadPoolExecutor(max_workers=8) as pool:
        keys = set(pool.map(lambda _: load_or_create_vault_key(tmp_path), range(16)))
    assert len(keys) == 1


def test_refuses_to_replace_a_damaged_key(tmp_path: Path) -> None:
    """Raise on a damaged key file, because a new key would make every saved provider key unreadable.

    Args:
        tmp_path: The state directory.
    """
    (tmp_path / VAULT_KEY_FILE).write_text("not-a-fernet-key", encoding="ascii")
    with pytest.raises(ValueError, match="does not hold a valid BYOK vault key"):
        load_or_create_vault_key(tmp_path)
    assert (tmp_path / VAULT_KEY_FILE).read_text(encoding="ascii") == "not-a-fernet-key"


def test_recovers_from_an_empty_key_file(tmp_path: Path) -> None:
    """Replace an empty key file left by a crash, so the app starts, and keep the new key after that.

    Args:
        tmp_path: The state directory.
    """
    path = tmp_path / VAULT_KEY_FILE
    path.write_bytes(b"")
    key = load_or_create_vault_key(tmp_path)
    Fernet(key.encode("ascii"))
    assert path.read_text(encoding="ascii") == key
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert load_or_create_vault_key(tmp_path) == key
    assert sorted(p.name for p in tmp_path.iterdir()) == [VAULT_KEY_FILE, f"{VAULT_KEY_FILE}.lock"]


def test_concurrent_starts_after_a_crash_share_one_key(tmp_path: Path) -> None:
    """Give every concurrent start the same new key when an empty key file is in the way.

    Args:
        tmp_path: The state directory.
    """
    (tmp_path / VAULT_KEY_FILE).write_bytes(b"\n")
    with ThreadPoolExecutor(max_workers=8) as pool:
        keys = set(pool.map(lambda _: load_or_create_vault_key(tmp_path), range(16)))
    assert len(keys) == 1
    assert (tmp_path / VAULT_KEY_FILE).read_text(encoding="ascii") == keys.pop()


def test_concurrent_processes_share_one_key(tmp_path: Path) -> None:
    """Give separate processes, as the API and the worker are, the same key.

    Args:
        tmp_path: The state directory.
    """
    with ProcessPoolExecutor(max_workers=4) as pool:
        keys = set(pool.map(load_or_create_vault_key, [str(tmp_path)] * 8))
    assert len(keys) == 1


def test_local_settings_load_the_key_and_hosted_settings_do_not(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fill the vault key only in local mode, and let an explicit key win.

    Args:
        tmp_path: Holds the state directories.
        monkeypatch: Clears a vault key from the environment.
    """
    monkeypatch.delenv("BYOK_VAULT_KEY", raising=False)
    local_dir = tmp_path / "local"
    local = Settings(_env_file=None, APP_LOCAL_MODE=True, APP_LOCAL_STATE_DIR=str(local_dir), API_HOST="127.0.0.1")
    assert local.byok_vault_key is not None
    assert local.byok_vault_key.get_secret_value() == (local_dir / VAULT_KEY_FILE).read_text(encoding="ascii")

    hosted_dir = tmp_path / "hosted"
    hosted = Settings(_env_file=None, APP_LOCAL_STATE_DIR=str(hosted_dir))
    assert hosted.byok_vault_key is None
    assert not hosted_dir.exists()

    explicit = Fernet.generate_key().decode("ascii")
    pinned_dir = tmp_path / "pinned"
    pinned = Settings(
        _env_file=None,
        APP_LOCAL_MODE=True,
        APP_LOCAL_STATE_DIR=str(pinned_dir),
        API_HOST="127.0.0.1",
        BYOK_VAULT_KEY=explicit,
    )
    assert pinned.byok_vault_key == SecretStr(explicit)
    assert not (pinned_dir / VAULT_KEY_FILE).exists()
