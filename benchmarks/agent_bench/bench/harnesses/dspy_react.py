"""DSPy ReAct harness: the agent loop Skynet's generalist agent runs today.

Two variants share this module:

* ``dspy-reactv2``  the project's ``RetryingReActV2`` (``dspy.ReActV2`` with
  parse-failure resampling and serial tool calls), exactly the class the
  production agent constructs.
* ``dspy-react``    stock classic ``dspy.ReAct``.

The loop runs in a child process so a hang can be killed and so the backend's
import footprint never stays resident in the benchmark runner.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from bench.harnesses.base import Attempt

BACKEND = Path(__file__).resolve().parents[4] / "backend"
MAX_ITERS = 15


def run_dspy(variant: str, message: str, brief: str, port: int, workdir: Path, key: str, timeout: int) -> Attempt:
    """Run one DSPy ReAct attempt in a child process.

    Args:
        variant: ``"dspy-reactv2"`` or ``"dspy-react"``.
        message: The user message.
        brief: The shared system prompt.
        port: Port of the attempt's world server.
        workdir: Directory for this attempt's files.
        key: OpenRouter API key.
        timeout: Seconds before the child is killed.

    Returns:
        The parsed attempt.
    """
    (workdir / "message.txt").write_text(message)
    (workdir / "brief.txt").write_text(brief)
    out = workdir / "dspy_result.json"
    cmd = [sys.executable, "-m", "bench.harnesses.dspy_child", variant, str(port), str(workdir)]
    # The child imports the project's ReAct class from the backend package.
    env = {**os.environ, "OPENROUTER_API_KEY": key, "PYTHONPATH": str(BACKEND)}
    try:
        proc = subprocess.run(
            cmd, cwd=Path(__file__).resolve().parents[2], env=env, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=timeout, check=False,
        )  # fmt: skip
        error = "" if proc.returncode == 0 else f"exit {proc.returncode}: {proc.stderr[-300:]}"
        (workdir / "stderr.log").write_text(proc.stderr)
    except subprocess.TimeoutExpired:
        error = f"timeout after {timeout}s"
    if not out.exists():
        return Attempt(error=error or "no result file")
    data = json.loads(out.read_text())
    return Attempt(**{**data, "error": error or data.get("error", "")})
