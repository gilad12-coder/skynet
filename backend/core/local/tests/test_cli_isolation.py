"""Tests for the isolated environments that keep a user's own CLI setup out of model calls."""

from __future__ import annotations

import fcntl
import os
import stat
import threading
from pathlib import Path

import pytest

from core.local import cli_isolation
from core.local.cli_isolation import isolated_cli
from core.local.cli_probe import STRIPPED_ENV_KEYS


def _user_home(tmp_path: Path) -> Path:
    """Return a fake user home with a codex login and personal instructions."""
    home = tmp_path / "user"
    (home / ".codex").mkdir(parents=True)
    (home / ".codex" / "auth.json").write_text("old-login", encoding="utf-8")
    (home / ".codex" / "AGENTS.md").write_text("personal instructions", encoding="utf-8")
    return home


def test_keys_are_stripped_and_the_temporary_homes_are_removed(tmp_path: Path) -> None:
    """Drop provider keys, copy only the login, and remove the temporary homes after the call."""
    home = _user_home(tmp_path)
    base = {"HOME": str(home), "PATH": "/usr/bin", **dict.fromkeys(STRIPPED_ENV_KEYS, "secret")}
    with isolated_cli("codex", base_env=base) as isolation:
        codex_home = Path(isolation.env["CODEX_HOME"])
        assert not set(STRIPPED_ENV_KEYS) & set(isolation.env)
        assert isolation.env["PATH"] == "/usr/bin"
        assert Path(isolation.env["HOME"]) != home
        assert sorted(path.name for path in codex_home.iterdir()) == ["auth.json"]
        assert stat.S_IMODE((codex_home / "auth.json").stat().st_mode) == 0o600
        assert {"--ignore-user-config", "--ignore-rules", "--ephemeral"} <= set(isolation.args)
    assert not codex_home.exists()


def test_codex_reads_the_login_from_codex_home(tmp_path: Path) -> None:
    """Copy the login from ``CODEX_HOME`` when it is set."""
    custom = tmp_path / "custom-codex"
    custom.mkdir()
    (custom / "auth.json").write_text("custom-login", encoding="utf-8")
    base = {"HOME": str(tmp_path / "user"), "CODEX_HOME": str(custom)}
    with isolated_cli("codex", base_env=base) as isolation:
        assert (Path(isolation.env["CODEX_HOME"]) / "auth.json").read_text(encoding="utf-8") == "custom-login"


def test_an_unchanged_login_is_not_written_back(tmp_path: Path) -> None:
    """Leave the real login file alone when the CLI did not refresh it."""
    home = _user_home(tmp_path)
    real = home / ".codex" / "auth.json"
    before = real.stat().st_ino
    with isolated_cli("codex", base_env={"HOME": str(home)}):
        pass
    assert real.stat().st_ino == before


def test_a_refreshed_login_goes_back(tmp_path: Path) -> None:
    """Write a refreshed login back to the real file, readable only by the user."""
    home = _user_home(tmp_path)
    with isolated_cli("codex", base_env={"HOME": str(home)}) as isolation:
        (Path(isolation.env["CODEX_HOME"]) / "auth.json").write_text("new-login", encoding="utf-8")
    real = home / ".codex" / "auth.json"
    assert real.read_text(encoding="utf-8") == "new-login"
    assert stat.S_IMODE(real.stat().st_mode) == 0o600


def test_a_newer_real_login_is_kept(tmp_path: Path) -> None:
    """Keep the real login when another call changed it during this call."""
    home = _user_home(tmp_path)
    real = home / ".codex" / "auth.json"
    with isolated_cli("codex", base_env={"HOME": str(home)}) as isolation:
        (Path(isolation.env["CODEX_HOME"]) / "auth.json").write_text("stale-refresh", encoding="utf-8")
        real.write_text("newer-login", encoding="utf-8")
    assert real.read_text(encoding="utf-8") == "newer-login"


def test_the_write_back_waits_for_the_lock(tmp_path: Path) -> None:
    """Hold the login lock, and check that the write-back waits until it is free."""
    home = _user_home(tmp_path)
    real = home / ".codex" / "auth.json"
    lock = (home / ".codex" / "auth.json.skynet.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX)
    finished = threading.Event()

    def call() -> None:
        """Refresh the login inside an isolated call."""
        with isolated_cli("codex", base_env={"HOME": str(home)}) as isolation:
            (Path(isolation.env["CODEX_HOME"]) / "auth.json").write_text("new-login", encoding="utf-8")
        finished.set()

    # The copy-in also takes the lock, so the call starts only after the first release.
    worker = threading.Thread(target=call)
    worker.start()
    try:
        assert not finished.wait(0.3)
        assert real.read_text(encoding="utf-8") == "old-login"
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()
    worker.join(timeout=5)
    assert finished.is_set()
    assert real.read_text(encoding="utf-8") == "new-login"


def test_codex_without_a_login_gets_empty_homes(tmp_path: Path) -> None:
    """Start codex with empty temporary homes when the user has no codex login."""
    with isolated_cli("codex", base_env={"HOME": str(tmp_path / "nobody")}) as isolation:
        assert list(Path(isolation.env["CODEX_HOME"]).iterdir()) == []


def test_droid_gets_a_private_home_with_its_login(tmp_path: Path) -> None:
    """Copy droid's login into a temporary HOME that links the real Keychain folder."""
    home = tmp_path / "user"
    (home / ".factory").mkdir(parents=True)
    (home / ".factory" / "auth.v2.loginkeychain").write_bytes(b"sealed")
    (home / ".factory" / "AGENTS.md").write_text("personal instructions", encoding="utf-8")
    (home / "Library").mkdir()
    with isolated_cli("droid", base_env={"HOME": str(home)}) as isolation:
        private = Path(isolation.env["HOME"])
        assert private != home
        assert sorted(path.name for path in (private / ".factory").iterdir()) == ["auth.v2.loginkeychain"]
        assert (private / "Library").is_symlink()
        assert isolation.args == cli_isolation.DROID_ARGS
    assert not private.exists()
    assert (home / "Library").is_dir()


def test_droid_without_a_login_file_keeps_the_real_home(tmp_path: Path) -> None:
    """Keep the real HOME when droid has no login file to copy, so its login still works."""
    home = tmp_path / "user"
    home.mkdir()
    with isolated_cli("droid", base_env={"HOME": str(home)}) as isolation:
        assert isolation.env["HOME"] == str(home)


@pytest.mark.parametrize("flag", ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"])
def test_claude_keeps_its_home_and_gets_the_isolation_flags(tmp_path: Path, flag: str) -> None:
    """Keep claude's real HOME and config folder, and pass flags that load no user setup."""
    base = {"HOME": str(tmp_path), "ANTHROPIC_API_KEY": "secret"}
    with isolated_cli("claude", base_env=base) as isolation:
        assert isolation.env == {"HOME": str(tmp_path)}
        assert flag in isolation.args
        assert "--bare" not in isolation.args
        assert isolation.args[isolation.args.index("--setting-sources") + 1] == ""


def test_the_default_environment_is_this_process(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Start from ``os.environ`` when no base environment is given."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("SKYNET_ISOLATION_MARK", "1")
    with isolated_cli("claude") as isolation:
        assert isolation.env["SKYNET_ISOLATION_MARK"] == "1"
        assert isolation.env["HOME"] == os.environ["HOME"]
