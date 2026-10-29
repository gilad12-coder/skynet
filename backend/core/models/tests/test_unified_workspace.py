"""Tests for UnifiedWorkspace's extra-file path rules, nested folders included."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from core.models.unified import UnifiedWorkspace, workspace_path_error

RUN = "from lib.parse import x\n\ndef run(artifact, input):\n    return x\n"
METRIC = "def score(input, output, expected=None):\n    return 1.0, {}\n"


@pytest.mark.parametrize("path", ["lib/parse.py", "lib/__init__.py", "pkg/sub/deep/mod.py", "data/notes.md"])
def test_nested_folder_paths_are_accepted(path: str) -> None:
    """Folders up to the depth limit are valid extra-file paths."""
    assert workspace_path_error(path) is None
    workspace = UnifiedWorkspace(run_code=RUN, metric_code=METRIC, files={path: "x = 1\n"})
    assert path in workspace.files


@pytest.mark.parametrize("path", ["lib/run.py\n", "a/b/c/d/e.py", "lib//parse.py", "lib/../parse.py", "run.py/x.py"])
def test_unsafe_or_too_deep_paths_are_refused(path: str) -> None:
    """Newlines, empty or parent segments, a fixed file as a folder and depth past four are refused."""
    assert workspace_path_error(path) is not None
    with pytest.raises(ValidationError):
        UnifiedWorkspace(run_code=RUN, metric_code=METRIC, files={path: ""})


def test_a_path_cannot_be_both_a_file_and_a_folder() -> None:
    """``lib`` cannot be a file while ``lib/parse.py`` makes it a folder."""
    with pytest.raises(ValidationError, match="both a file and a folder"):
        UnifiedWorkspace(run_code=RUN, metric_code=METRIC, files={"lib.py/x.py": "", "lib.py": ""})
