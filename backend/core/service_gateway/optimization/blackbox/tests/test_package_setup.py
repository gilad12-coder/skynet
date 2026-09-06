"""Exercise real pip resolution and hash-locked installation against a fixture registry."""

from __future__ import annotations

import base64
import hashlib
import io
import os
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any

import pytest

from .. import package_setup


def test_resolve_and_install_exact_wheel(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Resolve and import the same wheel through pip without an external registry.

    Args:
        tmp_path: Isolated guest-like workspace.
        monkeypatch: Fixture replacing only the parent transport.
    """
    archive = io.BytesIO()
    name = "skynet_package_fixture"
    with zipfile.ZipFile(archive, "w") as wheel:
        wheel.writestr(f"{name}/__init__.py", "VALUE = 42\n")
        wheel.writestr(f"{name}-1.2.dist-info/METADATA", f"Metadata-Version: 2.1\nName: {name}\nVersion: 1.2\n")
        wheel.writestr(f"{name}-1.2.dist-info/WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        wheel.writestr(f"{name}-1.2.dist-info/RECORD", "")
    data = archive.getvalue()
    digest = hashlib.sha256(data).hexdigest()
    artifact = {
        "filename": f"{name}-1.2-py3-none-any.whl",
        "sha256": digest,
        "url": f"https://registry.example/{name}.whl",
        "requires_python": ">=3.11",
    }

    def request(route: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
        """Emulate the scoped parent registry protocol.

        Args:
            route: Opaque test capability.
            body: Requested package operation.

        Returns:
            Fixture index metadata or exact wheel bytes.
        """
        if body["action"] == "index":
            assert body["project"].replace("-", "_") == name
            return {"artifacts": [artifact]}
        assert body["sha256"] == digest
        return {"data": base64.b64encode(data[body["offset"] :]).decode(), "size": len(data)}

    monkeypatch.setattr(package_setup, "_request", request)
    code = f"import {name}\ndef score(candidate): return {name}.VALUE"
    lock = package_setup.resolve(code, [], {}, tmp_path)
    assert lock["artifacts"][0]["version"] == "1.2"
    assert lock["artifacts"][0]["sha256"] == digest
    assert lock["artifacts"][0]["url"] == artifact["url"]
    package_setup.install(lock, {}, tmp_path)
    result = subprocess.run(
        [sys.executable, "-c", f"import {name}; print({name}.VALUE)"],
        env={**os.environ, "PYTHONPATH": str(tmp_path / "site")},
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == "42"
    assert "--hash=sha256:" + digest in (tmp_path / "locked.txt").read_text()


def test_inference_ignores_strings_stdlib_and_injected_helpers() -> None:
    """Infer executable imports while leaving image-provided libraries untouched."""
    requirements, imports = package_setup.infer_requirements(
        'import json\nfrom skynet import llm\ntext="import absent"', []
    )
    assert requirements == []
    assert imports == ["json", "skynet"]
    with pytest.raises(ValueError, match="direct URLs"):
        package_setup.infer_requirements("import json", ["package @ https://elsewhere.invalid/pkg.whl"])


def test_resolution_preserves_budget_stop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Stop resolution with the parent's budget signal instead of a missing-package error.

    Args:
        tmp_path: Isolated resolution workspace.
        monkeypatch: Fixture injecting a denied parent operation.
    """

    def request(route: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
        """Reject the registry operation at the budget boundary.

        Args:
            route: Package-only capability.
            body: Attempted registry operation.

        Raises:
            PackageSetupStoppedError: The owning budget is exhausted.
        """
        raise package_setup.PackageSetupStoppedError("budget_reached", "No remaining budget")

    monkeypatch.setattr(package_setup, "_request", request)
    with pytest.raises(package_setup.PackageSetupStoppedError, match="No remaining budget"):
        package_setup.resolve("import skynet_absent_fixture", [], {}, tmp_path)
