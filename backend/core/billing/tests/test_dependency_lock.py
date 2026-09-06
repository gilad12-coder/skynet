"""Verify that saved dependency artifacts cannot be changed or reused with different code."""

from __future__ import annotations

import hashlib

import pytest

from .. import dependency_lock


def test_lock_binds_artifacts_source_and_image(monkeypatch: pytest.MonkeyPatch) -> None:
    """Authenticate a lock and reject source, image, and artifact modifications.

    Args:
        monkeypatch: Fixture configuring an isolated signing secret.
    """
    monkeypatch.setattr(dependency_lock.settings, "backend_auth_secret", "fixture-secret")
    code = "import example"
    lock = dependency_lock.sign_dependency_lock(
        {
            "code_sha256": hashlib.sha256(code.encode()).hexdigest(),
            "requirements": [],
            "inferred": ["example"],
            "imports": ["example"],
            "python": "3.12.11",
            "image": "runtime@sha256:" + "a" * 64,
            "registry_url": "https://pypi.org/simple",
            "artifacts": [
                {
                    "name": "example",
                    "version": "1.0",
                    "filename": "example-1.0-py3-none-any.whl",
                    "url": "https://files.example/example.whl",
                    "sha256": "b" * 64,
                }
            ],
        }
    )
    assert dependency_lock.verify_dependency_lock(lock, image=lock["image"], code=code).artifacts[0].version == "1.0"
    for image, source in [("different-image", code), (lock["image"], code + "\n")]:
        with pytest.raises(ValueError, match="changed"):
            dependency_lock.verify_dependency_lock(lock, image=image, code=source)
    modified = {**lock, "artifacts": [{**lock["artifacts"][0], "url": "https://other.example/wheel.whl"}]}
    with pytest.raises(ValueError, match="invalid"):
        dependency_lock.verify_dependency_lock(modified, image=lock["image"], code=code)
