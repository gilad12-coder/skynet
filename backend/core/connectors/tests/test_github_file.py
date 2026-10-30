"""Tests for reading one repository file for the read-only code view."""

from __future__ import annotations

from typing import Any

import pytest

from ...api.errors import DomainError
from .. import github


def _serve(monkeypatch: pytest.MonkeyPatch, fetched: dict[str, Any]) -> list[tuple[Any, ...]]:
    """Make :func:`github.file_at` return ``fetched`` and record its calls.

    Args:
        monkeypatch: Pytest monkeypatch fixture.
        fetched: What the fake read returns.

    Returns:
        The argument tuples of every call.
    """
    calls: list[tuple[Any, ...]] = []

    def fake_file_at(*args: Any) -> dict[str, Any]:
        """Record the call and return the canned read.

        Args:
            *args: The positional arguments of :func:`github.file_at`.

        Returns:
            ``fetched``.
        """
        calls.append(args)
        return fetched

    monkeypatch.setattr(github, "file_at", fake_file_at)
    return calls


def _content(data: bytes) -> dict[str, Any]:
    """Build a successful read of ``data``.

    Args:
        data: The file bytes.

    Returns:
        A :func:`github.file_at` result.
    """
    return {"content": data, "size": len(data), "missing": False, "too_large": False}


def test_text_file_is_decoded(monkeypatch: pytest.MonkeyPatch) -> None:
    """A UTF-8 file comes back as text, with the cleaned path and ref passed through."""
    calls = _serve(monkeypatch, _content("print('שלום')\n".encode()))
    result = github.read_repo_file("tok", "octo/app", " abc123 ", "src/app.py/", 100)
    assert result == {
        "path": "src/app.py",
        "text": "print('שלום')\n",
        "binary": False,
        "too_large": False,
        "missing": False,
    }
    assert calls == [("tok", "octo/app", "abc123", "src/app.py", 100)]


def test_nul_byte_marks_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    """Content holding a NUL byte is binary even when it decodes."""
    _serve(monkeypatch, _content(b"PK\x00\x03"))
    result = github.read_repo_file(None, "octo/app", "", "a.zip", 100)
    assert result["binary"] is True
    assert result["text"] is None


def test_invalid_utf8_marks_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    """Bytes that are not UTF-8 are binary."""
    _serve(monkeypatch, _content(b"\xff\xfe\xfa"))
    result = github.read_repo_file(None, "octo/app", "", "logo.bin", 100)
    assert result["binary"] is True
    assert result["text"] is None


def test_too_large_file_has_no_text(monkeypatch: pytest.MonkeyPatch) -> None:
    """An oversized file is flagged and carries no text."""
    _serve(monkeypatch, {"content": None, "size": 500, "missing": False, "too_large": True})
    result = github.read_repo_file(None, "octo/app", "main", "big.csv", 100)
    assert result == {"path": "big.csv", "text": None, "binary": False, "too_large": True, "missing": False}


def test_missing_file_is_flagged(monkeypatch: pytest.MonkeyPatch) -> None:
    """A path with no regular file is reported missing."""
    _serve(monkeypatch, {"content": None, "size": None, "missing": True, "too_large": False})
    result = github.read_repo_file(None, "octo/app", "main", "gone.py", 100)
    assert result == {"path": "gone.py", "text": None, "binary": False, "too_large": False, "missing": True}


@pytest.mark.parametrize(
    "path",
    [
        "",
        "   ",
        "/etc/passwd",
        "../secret",
        "src/../../x",
        "a//b",
        "./a",
        ".git/config",
        ".GIT/HEAD",
        "C:/x",
        "a" * 1025,
    ],
)
def test_bad_paths_are_refused_before_any_read(monkeypatch: pytest.MonkeyPatch, path: str) -> None:
    """Empty, absolute, escaping, ``.git`` and overlong paths raise ``invalid_ref`` without reading."""
    calls = _serve(monkeypatch, _content(b"x"))
    with pytest.raises(DomainError) as raised:
        github.read_repo_file(None, "octo/app", "main", path, 100)
    assert raised.value.code == "connectors.invalid_ref"
    assert raised.value.status_code == 400
    assert calls == []
