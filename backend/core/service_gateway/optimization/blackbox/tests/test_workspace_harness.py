"""The in-sandbox workspace harness: run code, then the metric, under the one contract every optimizer runs."""

from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from .. import runner, workspace_harness
from ..workspace_harness import (
    Workspace,
    encode_stream,
    parse_replies,
    serve,
)

RUN_CODE = "def run(artifact, input):\n    return artifact + ':' + input['q']\n"
BLACKBOX_METRIC = (
    "def score(input, output, expected=None):\n"
    "    return float(output.endswith(expected or '')), {'feedback': 'compared'}\n"
)


@pytest.fixture(autouse=True)
def _restore_helper_module(monkeypatch: pytest.MonkeyPatch) -> None:
    """Undo the harness's ``import skynet`` binding after each test."""
    monkeypatch.setitem(sys.modules, runner.HELPER_MODULE_NAME, None)


def _workspace(metric_code: str, *, run_code: str = RUN_CODE, **extra: Any) -> Workspace:
    """Load a workspace with no model gateways."""
    return Workspace(
        {
            "run_code": run_code,
            "metric_code": metric_code,
            "files": extra.get("files", {}),
            "artifact_kind": extra.get("artifact_kind", "prompt"),
            "input_fields": extra.get("input_fields", ["q"]),
            "gateways": {"task": None, "metric": None},
        }
    )


def _case(q: str = "x", expected: Any = None) -> dict[str, Any]:
    """Build one call message's case."""
    return {"input": {"q": q}, "expected": expected}


def test_blackbox_metric_passes_with_score_and_side_info() -> None:
    """``score(input, output, expected)`` returning ``(float, dict)`` is normalized."""
    reply = _workspace(BLACKBOX_METRIC).handle({"candidate": "p", "case": _case("x", "x")})

    assert reply["score"] == 1.0
    assert reply["side_info"]["feedback"] == "compared"
    assert reply["output_preview"] == "p:x"
    assert "error" not in reply


def test_blackbox_metric_without_expected_is_called_with_two_arguments() -> None:
    """``expected`` is passed only when the function declares it."""
    metric = "def score(input, output):\n    return 0.5, {'feedback': ''}\n"

    reply = _workspace(metric).handle({"candidate": "p", "case": _case()})

    assert reply["score"] == 0.5


def test_blackbox_metric_returning_a_bare_float_is_a_shape_error() -> None:
    """A blackbox score must return ``(float, dict)``; a float alone fails the shape."""
    reply = _workspace("def score(input, output):\n    return 1.0\n").handle({"candidate": "p", "case": _case()})

    assert reply["stage"] == "shape"
    assert "score" not in reply


@pytest.mark.parametrize(
    "returned", ["1.0", "(0.5, 'no dict')", "(0.5, {'scores': {}})", "{'score': 1, 'feedback': ''}"]
)
def test_any_other_return_value_is_a_shape_error(returned: str) -> None:
    """Only ``(score, side_info)`` with a feedback string is accepted, whatever the artifact kind.

    Args:
        returned: The expression ``score`` returns.
    """
    metric = f"def score(input, output, expected=None):\n    return {returned}\n"

    reply = _workspace(metric).handle({"candidate": "p", "case": _case()})

    assert reply["stage"] == "shape"


def test_retired_dspy_metric_is_not_called() -> None:
    """A ``metric(gold, pred, ...)`` written for the retired DSPy shape fails at the metric stage."""
    metric = "def metric(gold, pred, trace=None):\n    return 1.0\n"

    reply = _workspace(metric).handle({"candidate": "p", "case": _case()})

    assert reply["stage"] == "metric"
    assert "score" in reply["error"]


# The same run code and metric the DSPy engine compiles (unified/tests/test_dspy_engine.py):
# run returns the module's instruction, so no model is needed to see the candidate applied.
DSPY_RUN_CODE = (
    "import dspy\n"
    "program = dspy.Predict('q -> answer')\n"
    "def run(artifact, input):\n"
    "    return dspy.Prediction(answer=program.signature.instructions + ':' + input['q'])\n"
)
DSPY_SCORE = (
    "def score(input, output, expected=None):\n"
    "    ok = output.answer == expected['answer']\n"
    "    return float(ok), {'feedback': output.answer}\n"
)


def test_dspy_program_runs_through_run_with_the_candidate_applied() -> None:
    """A DSPy program uses the same run(artifact, input) and score(...) as every other kind."""
    workspace = _workspace(DSPY_SCORE, run_code=DSPY_RUN_CODE, artifact_kind="dspy_program")

    reply = workspace.handle({"candidate": {"self": "tuned"}, "case": _case("x", {"answer": "tuned:x"})})

    assert "error" not in reply, reply
    assert reply["score"] == 1.0
    assert reply["side_info"]["feedback"] == "tuned:x"


def test_dspy_program_without_a_module_level_module_fails_at_the_run_stage() -> None:
    """The harness must find the module run calls; without one the run stage says how to fix it."""
    run_code = "import dspy\ndef run(artifact, input):\n    return dspy.Predict('q -> a')(**input)\n"

    reply = _workspace(DSPY_SCORE, run_code=run_code, artifact_kind="dspy_program").handle(
        {"candidate": {"self": "x"}, "case": _case()}
    )

    assert reply["stage"] == "run"
    assert "dspy.Module" in reply["error"]


def test_retired_build_program_fails_at_the_run_stage() -> None:
    """Run code written for the retired ``build_program()`` entry point has no ``run``."""
    run_code = "import dspy\ndef build_program():\n    return dspy.Predict('q -> a')\n"

    reply = _workspace(DSPY_SCORE, run_code=run_code, artifact_kind="dspy_program").handle(
        {"candidate": {"self": "x"}, "case": _case()}
    )

    assert reply["stage"] == "run"
    assert "run()" in reply["error"]


def test_missing_run_fails_at_the_run_stage() -> None:
    """Run code without ``run`` reports a ``run``-stage NameError."""
    reply = _workspace(BLACKBOX_METRIC, run_code="x = 1\n").handle({"candidate": "p", "case": _case()})

    assert reply["stage"] == "run"
    assert reply["error"].startswith("NameError: ")


def test_user_error_carries_only_user_frames() -> None:
    """``error`` is ``Type: message``; ``detail`` names user-code frames, not the harness."""
    run_code = "def helper(x):\n    return x['missing']\n\ndef run(artifact, input):\n    return helper(input)\n"

    reply = _workspace(BLACKBOX_METRIC, run_code=run_code).handle({"candidate": "p", "case": _case()})

    assert reply["error"] == "KeyError: 'missing'"
    assert "<run_code>" in reply["detail"]
    assert "workspace_harness" not in reply["detail"]
    assert len(reply["detail"]) <= workspace_harness.DETAIL_MAX_CHARS


CODE_RUN = (
    "def run(artifact, input):\n    namespace = {}\n    exec(artifact, namespace)\n    return namespace['run'](input)\n"
)
SECRET_METRIC = (
    "SECRET = 'metric-source-marker'\n"
    "def score(input, output, expected=None):\n"
    "    return float(output == expected), {'feedback': SECRET}\n"
)


def test_candidate_cannot_read_the_metric_source() -> None:
    """A code candidate that dumps the metric's linecache entry gets nothing from it."""
    candidate = (
        "import linecache\n"
        "def run(input):\n"
        "    raise RuntimeError(''.join(linecache.getlines('<metric_code>')) or 'empty')\n"
    )
    workspace = _workspace(SECRET_METRIC, run_code=CODE_RUN, artifact_kind="code")

    reply = workspace.handle({"candidate": candidate, "case": _case("x", "gold")})

    assert reply["stage"] == "run"
    assert "metric-source-marker" not in reply["error"]
    assert "metric-source-marker" not in reply["detail"]
    assert reply["error"] == "RuntimeError: empty"


def test_candidate_cannot_read_the_expected_value() -> None:
    """A code candidate walking the stack for ``expected`` cannot reach the gold label."""
    candidate = (
        "import sys\n"
        "def run(input):\n"
        "    frame = sys._getframe(0)\n"
        "    while frame is not None:\n"
        "        if 'expected' in frame.f_locals:\n"
        "            return frame.f_locals['expected']\n"
        "        frame = frame.f_back\n"
        "    return 'not found'\n"
    )
    workspace = _workspace(SECRET_METRIC, run_code=CODE_RUN, artifact_kind="code")

    reply = workspace.handle({"candidate": candidate, "case": _case("x", "gold")})

    assert reply["score"] == 0.0


PROBE_CANDIDATE = """
import gc, linecache, os, sys

def run(input):
    seen = [repr(linecache.cache), repr(dict(os.environ)), repr(sys.argv)]
    seen.append(repr({k: v for k, v in vars(sys.modules['__main__']).items() if k != '__builtins__'}))
    for obj in gc.get_objects():
        if isinstance(obj, dict):
            seen.extend([v for v in list(obj.values()) if isinstance(v, str)])
        elif isinstance(obj, (list, tuple)):
            seen.extend([v for v in list(obj) if isinstance(v, str)])
    for pid in ('self', str(os.getppid())):
        for name in ('environ', 'cmdline'):
            try:
                with open('/proc/%s/%s' % (pid, name), 'rb') as handle:
                    seen.append(handle.read().decode('utf-8', 'replace'))
            except OSError:
                pass
    with open(input['q'], 'w', errors='replace') as out:
        out.write('\\n'.join(seen))
    return 'probed'
"""


def test_candidate_probes_reach_neither_metric_source_nor_expected(tmp_path: Path) -> None:
    """Candidate code harvesting linecache, globals, gc, env and ``/proc`` finds no metric source or gold label."""
    metric_marker, gold_marker = "METRIC_SOURCE_MARKER_93", "GOLD_LABEL_MARKER_77"
    metric = f"# {metric_marker}\nKEY = '{metric_marker}'\n" + BLACKBOX_METRIC
    harness_dir = Path(workspace_harness.__file__).parent
    for target, source in (("skynet_workspace_harness.py", "workspace_harness.py"), ("skynet_runner.py", "runner.py")):
        (tmp_path / target).write_text((harness_dir / source).read_text(encoding="utf-8"), encoding="utf-8")
    dump = tmp_path / "dump.txt"
    init = {
        "run_code": CODE_RUN,
        "metric_code": metric,
        "artifact_kind": "code",
        "gateways": {},
    }
    call = {"candidate": PROBE_CANDIDATE, "case": {"input": {"q": str(dump)}, "expected": gold_marker}}
    env = {"PATH": "/usr/bin:/bin", **encode_stream([init, call])}

    result = subprocess.run(
        [sys.executable, "skynet_workspace_harness.py", "--env"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    reply = parse_replies(result.stdout)[-1]
    assert reply["output_preview"] == "probed", result.stderr
    assert reply["score"] == 0.0
    harvested = dump.read_text(encoding="utf-8")
    assert "probed" in harvested
    assert metric_marker not in harvested
    assert gold_marker not in harvested


def test_run_error_is_one_capped_line() -> None:
    """A run-stage error keeps only the first line of the message, capped."""
    run_code = "def run(artifact, input):\n    raise ValueError('first\\n' + 'y' * 5000)\n"

    reply = _workspace(BLACKBOX_METRIC, run_code=run_code).handle({"candidate": "p", "case": _case()})

    assert reply["error"] == "ValueError: first"
    big = _workspace(BLACKBOX_METRIC, run_code="def run(a, i):\n    raise ValueError('z' * 5000)\n")
    assert len(big.handle({"candidate": "p", "case": _case()})["error"]) <= workspace_harness.RUN_ERROR_MAX_CHARS


def test_load_error_is_reported_for_every_call() -> None:
    """A metric that fails to import reports a ``metric``-stage error."""
    workspace = _workspace("raise RuntimeError('boom')\n")

    reply = workspace.handle({"candidate": "p", "case": _case()})

    assert reply["stage"] == "metric"
    assert reply["error"] == "RuntimeError: boom"


def test_serve_answers_init_then_each_call() -> None:
    """The JSON-lines protocol answers ``ready`` and then one reply per call."""
    init = {"run_code": RUN_CODE, "metric_code": BLACKBOX_METRIC, "gateways": {}}
    lines = [json.dumps(init), json.dumps({"candidate": "a", "case": _case("y", "y")}), ""]
    out = io.StringIO()

    serve(lines, out)

    ready, call = parse_replies(out.getvalue())
    assert ready == {"ready": True}
    assert call["score"] == 1.0


def test_env_stream_round_trips_and_the_code_never_touches_disk(tmp_path: Path) -> None:
    """``--env`` reads the code from the environment; the working directory holds only the harness."""
    secret = "SECRET_METRIC_MARKER_51"
    metric = f"# {secret}\n" + BLACKBOX_METRIC
    harness_dir = Path(workspace_harness.__file__).parent
    (tmp_path / "skynet_workspace_harness.py").write_text(
        (harness_dir / "workspace_harness.py").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (tmp_path / "skynet_runner.py").write_text(
        (harness_dir / "runner.py").read_text(encoding="utf-8"), encoding="utf-8"
    )
    init = {"run_code": RUN_CODE, "metric_code": metric, "gateways": {}}
    env = {"PATH": "/usr/bin:/bin", **encode_stream([init, {"candidate": "a", "case": _case("y", "y")}])}

    result = subprocess.run(
        [sys.executable, "skynet_workspace_harness.py", "--env"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    replies = parse_replies(result.stdout)
    assert replies[-1]["score"] == 1.0, result.stderr
    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert secret not in path.read_text(encoding="utf-8", errors="ignore")


HELPER_RUN = "from helpers import shout\n\ndef run(artifact, input):\n    return shout(artifact + ':' + input['q'])\n"


def test_run_code_imports_an_extra_workspace_file() -> None:
    """An extra file sits on the run child's path, so ``run.py`` can import it."""
    metric = "def score(input, output, expected=None):\n    return 1.0, {'feedback': output}\n"
    files = {"helpers.py": "def shout(text):\n    return text.upper()\n"}

    reply = _workspace(metric, run_code=HELPER_RUN, files=files).handle({"candidate": "p", "case": _case("x")})

    assert reply["side_info"]["feedback"] == "P:X"


def test_run_code_imports_an_extra_file_from_a_package_folder() -> None:
    """Nested paths become folders, importable as namespace packages."""
    run_code = "from lib.text import shout\n\ndef run(artifact, input):\n    return shout(input['q'])\n"
    metric = "def score(input, output, expected=None):\n    return 1.0, {'feedback': output}\n"

    reply = _workspace(metric, run_code=run_code, files={"lib/text.py": "def shout(t):\n    return t + '!'\n"}).handle(
        {"candidate": "p", "case": _case("hi")}
    )

    assert reply["side_info"]["feedback"] == "hi!"


def test_metric_cannot_import_candidate_files() -> None:
    """The extra files exist only in the run child: the metric cannot import them."""
    metric = (
        "def score(input, output, expected=None):\n"
        "    try:\n"
        "        import helpers\n"
        "        return 1.0, {'feedback': 'leaked'}\n"
        "    except ImportError:\n"
        "        return 0.0, {'feedback': 'isolated'}\n"
    )
    files = {"helpers.py": "def shout(text):\n    return text.upper()\n"}

    reply = _workspace(metric, run_code=HELPER_RUN, files=files).handle({"candidate": "p", "case": _case()})

    assert reply["side_info"]["feedback"] == "isolated"


def test_extra_files_are_removed_after_the_run_child(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The temporary files directory is gone once the child answers."""
    monkeypatch.setattr(workspace_harness.tempfile, "tempdir", str(tmp_path))
    reply = workspace_harness.run_child(
        {
            "run_code": HELPER_RUN,
            "files": {"helpers.py": "def shout(t):\n    return t\n"},
            "candidate": "p",
            "inputs": {"q": "x"},
        }
    )

    assert reply["output"] == "p:x"
    assert list(tmp_path.iterdir()) == []


def test_helper_file_frames_carry_their_workspace_path() -> None:
    """A failure inside a helper file names it by its workspace path, not the temp dir."""
    metric = "def score(input, output, expected=None):\n    return 1.0, {'feedback': ''}\n"
    files = {"helpers.py": "def shout(text):\n    raise ValueError('boom')\n"}

    reply = _workspace(metric, run_code=HELPER_RUN, files=files).handle({"candidate": "p", "case": _case()})

    assert reply["stage"] == "run"
    assert reply["error"] == "ValueError: boom"
    assert 'File "helpers.py"' in reply["detail"]
    assert workspace_harness.FILES_DIR_PREFIX not in reply["detail"]


@pytest.mark.parametrize("path", ["../escape.py", "/abs.py", "a//b.py", "a/./b.py"])
def test_write_files_refuses_paths_that_leave_the_directory(path: str) -> None:
    """The harness re-checks every path even though the API validated it.

    Args:
        path: A path that would escape or alias the files directory.
    """
    with pytest.raises(ValueError):
        workspace_harness.write_files({path: "x = 1\n"})
