"""Fixtures shared by the black-box tests."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from core.service_gateway.optimization.blackbox.sandbox import LocalSubprocessRuntime, sandbox_runtime_context


@pytest.fixture(autouse=True)
def local_scorer_runtime(request: pytest.FixtureRequest) -> Iterator[None]:
    """Bind the local adapter except while its settings resolver is under test.

    Args:
        request: Current test metadata used to exempt the resolver test module.

    Yields:
        Control while the deterministic sandbox override is active.
    """
    if request.path.name in {"test_sandbox.py", "test_sandbox_local.py"} or request.node.name == (
        "test_runtime_context_overrides_settings_and_restores_nested_bindings"
    ):
        yield
        return
    with sandbox_runtime_context(LocalSubprocessRuntime()):
        yield
