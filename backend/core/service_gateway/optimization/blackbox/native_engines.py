"""Latest-upstream Meta-Harness and AutoResearch loops behind the gepa.oa ``Engine`` contract.

This standalone module is copied into the selected runtime beside
``native_runner.py``. The upstream repositories are research scripts locked to
their own domains (memory systems for text classification; nanochat training
runs), so they cannot be imported as libraries. This module mirrors their loop
structure, state files and proposer prompts one-to-one, swapping only the
domain-specific evaluation for the gepa.oa ``EvalServer`` the run scores with.
The prompts are derived at run time from the verbatim upstream files under
``upstream_prompts/`` through exact-snippet substitutions, so a pin bump that
changes the upstream wording fails loudly instead of drifting silently.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from gepa.oa.budget import BudgetExhausted
from gepa.oa.config import OptimizeAnythingConfig
from gepa.oa.engine import Result
from gepa.oa.eval_server import EvalServer
from gepa.oa.task import Task, seed_as_text

META_HARNESS_REVISION = "0cbc31e97c9e6d24232d1dc754827c02e1ec415c"
AUTORESEARCH_REVISION = "228791fb499afffb54b46200aca536f79142f117"
PROMPTS_DIR = Path(__file__).with_name("upstream_prompts")
ASSET_CHECKSUMS = {
    "meta_harness/SKILL.md": "fce9a51d2e95d8a2d59c60b91106adc0309232a8d6b2fe0fa0785395dcb78d1c",
    "autoresearch/program.md": "86cf987a5c381e46eefe0d0a82765223fd766d8d7acdc2afacfbbce15ecacece",
}
BUDGET_EXHAUSTED_MARKER = "BUDGET_EXHAUSTED"
# Upstream meta_harness.py: PROPOSER_ALLOWED_TOOLS.
META_HARNESS_TOOLS = "Read,Glob,Grep,Agent,Write,Edit,Bash"
_SAFE_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}$")
_SESSION_POLL_SECONDS = 0.2

# The evaluator stands in for ``uv run train.py``: one call scores the whole
# visible pool so every logged aggregate is comparable, and HTTP 429 surfaces
# the upstream-style BUDGET_EXHAUSTED marker the brief tells the agent to obey.
# The JSON body is built with the runtime's own interpreter because the
# sandbox image is not guaranteed to ship jq.
EVAL_SCRIPT = """\
#!/usr/bin/env bash
# Usage: ./eval.sh <candidate_file>
set -euo pipefail
CANDIDATE_FILE="$1"
SERVER_URL="{server_url}"
PYTHON="{python}"
BODY=$(CANDIDATE_FILE="$CANDIDATE_FILE" "$PYTHON" -c 'import json, os; print(json.dumps({{"candidate": open(os.environ["CANDIDATE_FILE"], encoding="utf-8").read()}}))')
RESPONSE=$(curl -s -w "\\n%{{http_code}}" -X POST "$SERVER_URL/{route}" \\
    -H "Content-Type: application/json" -d "$BODY")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
echo "$BODY"
if [ "$HTTP_CODE" = "429" ]; then echo "{marker}" >&2; exit 1; fi
if [ "$HTTP_CODE" != "200" ]; then echo "evaluator returned HTTP $HTTP_CODE" >&2; exit 1; fi
"""


def load_asset(relative: str) -> str:
    """Read a vendored upstream prompt and verify it is the pinned revision's text.

    Args:
        relative: Path under ``upstream_prompts/``.

    Returns:
        The verbatim upstream file.

    Raises:
        RuntimeError: When the file is missing or differs from the pinned checksum.
    """
    path = PROMPTS_DIR / relative
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"Missing pinned upstream prompt {relative}: {exc}") from exc
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if digest != ASSET_CHECKSUMS[relative]:
        raise RuntimeError(f"Pinned upstream prompt {relative} drifted (sha256 {digest}).")
    return text


def adapt(text: str, edits: list[tuple[str, ...]]) -> str:
    """Apply exact-snippet substitutions, each of which must match exactly once.

    Args:
        text: Verbatim upstream text.
        edits: ``(old, new)`` replacements, or ``(start, end, new)`` spans replaced
            from the start marker through the end marker inclusive.

    Returns:
        The adapted text.

    Raises:
        RuntimeError: When a snippet is absent or ambiguous, which means the
            upstream wording changed under the pin.
    """
    for edit in edits:
        if len(edit) == 2:
            old, new = edit
            if text.count(old) != 1:
                raise RuntimeError(f"Upstream prompt snippet matched {text.count(old)} times: {old[:60]!r}")
            text = text.replace(old, new)
            continue
        start, end, new = edit
        if text.count(start) != 1 or text.count(end) != 1:
            raise RuntimeError(f"Upstream prompt span is not unique: {start[:60]!r} .. {end[:60]!r}")
        head = text.index(start)
        tail = text.index(end) + len(end)
        if tail <= head:
            raise RuntimeError(f"Upstream prompt span is inverted: {start[:60]!r} .. {end[:60]!r}")
        text = text[:head] + new + text[tail:]
    return text


def _plural(count: int, noun: str) -> str:
    """Render ``count`` with ``noun`` pluralized by an ``s``.

    Args:
        count: Number of items.
        noun: Singular noun.

    Returns:
        A phrase such as ``3 candidates`` or ``1 candidate``.
    """
    return f"{count} {noun}{'' if count == 1 else 's'}"


def visible_example_ids(server: EvalServer) -> list[str]:
    """List the training and validation example ids the server exposes.

    Args:
        server: Evaluation server for the current task.

    Returns:
        Example ids in split order; empty for single-candidate tasks.
    """
    return [eid for split in ("train", "val") for eid, _ in server.iter_split(split)]


def best_aggregate_candidate(server: EvalServer) -> tuple[str, float] | None:
    """Return the best candidate among the server's logged aggregate checkpoints.

    Dataset ``EvalServer.best_score`` is the best per-example score, not a
    candidate-level aggregate; ``/evaluate_examples`` and the engines log the
    aggregates with candidate ids instead.

    Args:
        server: Evaluation server whose ``progress_log`` holds the checkpoints.

    Returns:
        ``(candidate, score)`` for the highest logged aggregate, or ``None``.
    """
    by_id = {cid: candidate for candidate, cid in server._candidate_registry.items()}
    best: tuple[str, float] | None = None
    for entry in server.progress_log:
        candidate = by_id.get(entry.get("candidate_id"))
        score = entry.get("val_score")
        if candidate is None or not isinstance(score, int | float):
            continue
        if best is None or score > best[1]:
            best = (candidate, float(score))
    return best


@dataclass
class ProposerOutcome:
    """One ``claude --print`` invocation's parsed result."""

    session_id: str
    cost_usd: float
    is_error: bool
    text: str
    budget_exhausted: bool
    killed: bool


def run_proposer(
    prompt: str,
    *,
    work_dir: Path,
    log_dir: Path,
    name: str,
    model: str,
    session_id: str,
    resume: bool = False,
    effort: str | None = None,
    max_thinking_tokens: int | None = None,
    max_budget_usd: float | None = None,
    tools: str | None = None,
    append_system_prompt: str | None = None,
    should_kill: Callable[[], bool] | None = None,
) -> ProposerOutcome:
    """Run the proposer through the ``claude`` command, exactly as the upstream drivers do.

    The configured harness stands behind ``claude`` when it is not Claude Code,
    so this is the single invocation shape every proposer must answer.

    Args:
        prompt: Task prompt for this session.
        work_dir: Workspace the agent edits.
        log_dir: Where the CLI stdout, stderr and metadata land.
        name: Log file stem, such as ``iter3`` or ``session2``.
        model: Model identifier passed to the CLI.
        session_id: Session to create or, with ``resume``, to continue.
        resume: Whether to continue ``session_id`` instead of starting it.
        effort: ``--effort`` value, or ``None``.
        max_thinking_tokens: Fixed thinking budget, or ``None`` for adaptive.
        max_budget_usd: Remaining proposer spend passed as ``--max-budget-usd``.
        tools: Comma-separated tool whitelist, or ``None`` for the CLI default.
        append_system_prompt: Extra system prompt (the Meta-Harness skill).
        should_kill: Polled while the CLI runs; returning ``True`` terminates it.

    Returns:
        The parsed outcome; a CLI failure is reported, not raised.
    """
    cmd = ["claude", "--print", "--output-format", "json", "--model", model, "--dangerously-skip-permissions"]
    cmd.extend(["--resume", session_id] if resume else ["--session-id", session_id])
    if tools:
        cmd.extend(["--tools", tools, "--allowedTools", tools])
    if append_system_prompt:
        cmd.extend(["--append-system-prompt", append_system_prompt])
    if effort is not None and max_thinking_tokens is None:
        cmd.extend(["--effort", str(effort)])
    if max_budget_usd is not None:
        cmd.extend(["--max-budget-usd", f"{max(0.0, max_budget_usd):.6f}"])
    cmd.append(prompt)
    env = {**os.environ}
    # Upstream: a nested CLI must not believe it is already inside Claude Code,
    # and the proposer must authenticate through the harness, not a raw key.
    env.pop("CLAUDECODE", None)
    env.pop("ANTHROPIC_API_KEY", None)
    if max_thinking_tokens is not None:
        env["CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING"] = "1"
        env["MAX_THINKING_TOKENS"] = str(max_thinking_tokens)
    log_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    killed = False
    with (
        (log_dir / f"{name}_stdout.json").open("w", encoding="utf-8") as stdout_file,
        (log_dir / f"{name}_stderr.txt").open("w", encoding="utf-8") as stderr_file,
    ):
        process = subprocess.Popen(
            cmd, cwd=str(work_dir), env=env, stdout=stdout_file, stderr=stderr_file, text=True, start_new_session=True
        )
        while process.poll() is None:
            if should_kill is not None and should_kill():
                killed = True
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                break
            time.sleep(_SESSION_POLL_SECONDS)
    stdout = (log_dir / f"{name}_stdout.json").read_text(encoding="utf-8")
    stderr = (log_dir / f"{name}_stderr.txt").read_text(encoding="utf-8")
    document = _result_document(stdout)
    outcome = ProposerOutcome(
        session_id=str(document.get("session_id") or session_id),
        cost_usd=float(document.get("total_cost_usd") or 0.0),
        is_error=killed or process.returncode != 0 or bool(document.get("is_error")),
        text=str(document.get("result") or ""),
        budget_exhausted=BUDGET_EXHAUSTED_MARKER in stdout or BUDGET_EXHAUSTED_MARKER in stderr,
        killed=killed,
    )
    (log_dir / f"{name}_meta.json").write_text(
        json.dumps(
            {
                "session_id": outcome.session_id,
                "returncode": process.returncode,
                "cost_usd": outcome.cost_usd,
                "is_error": outcome.is_error,
                "killed": killed,
                "duration_s": round(time.monotonic() - started, 1),
            }
        ),
        encoding="utf-8",
    )
    return outcome


def _result_document(stdout: str) -> dict[str, Any]:
    """Find the ``claude --output-format json`` result object in captured stdout.

    Args:
        stdout: Captured CLI output.

    Returns:
        The result object, or an empty mapping when none parses.
    """
    for raw in (stdout.strip(), *reversed(stdout.strip().splitlines())):
        try:
            payload = json.loads(raw)
        except ValueError:
            continue
        if isinstance(payload, dict) and ("result" in payload or "session_id" in payload):
            return payload
    return {}


def _remaining_cost(max_token_cost: float | None, spent: float) -> float | None:
    """Return the proposer spend still allowed, or ``None`` when uncapped.

    Args:
        max_token_cost: Configured proposer cap in USD.
        spent: Summed CLI-reported cost so far.

    Returns:
        Remaining USD, never negative, or ``None``.
    """
    return None if max_token_cost is None else max(0.0, float(max_token_cost) - spent)


def _reached(stop_at_score: float | None, score: float | None) -> bool:
    """Tell whether ``score`` satisfies the configured early-stop threshold.

    Args:
        stop_at_score: Threshold from the run config, or ``None``.
        score: Best score so far, or ``None``.

    Returns:
        ``True`` only when both are set and the threshold is met.
    """
    return stop_at_score is not None and score is not None and score >= stop_at_score


def task_brief(task: Task, example_ids: list[str]) -> str:
    """Describe the task the way the upstream repositories' READMEs describe theirs.

    Args:
        task: Task being optimized.
        example_ids: Visible example ids, empty for single-candidate tasks.

    Returns:
        Markdown with the objective, background and evaluation scope.
    """
    lines = [f"# {task.name}", ""]
    if task.objective:
        lines += ["## Objective", "", str(task.objective).strip(), ""]
    if task.background:
        lines += ["## Background", "", str(task.background).strip(), ""]
    lines += ["## Evaluation", ""]
    if example_ids:
        lines += [
            f"The evaluator scores a candidate on {_plural(len(example_ids), 'visible example')} and reports the "
            "average score (higher is better) together with per-example scores and feedback.",
            "",
            "Example ids: " + ", ".join(f"`{eid}`" for eid in example_ids),
            "",
            "Held-out test cases exist and are never exposed; do not overfit the visible ones.",
        ]
    else:
        lines += ["The evaluator scores the candidate as a whole and reports a single score (higher is better)."]
    return "\n".join(lines) + "\n"


class AutoResearchEngine:
    """karpathy/autoresearch at the pinned revision, driven against the evaluation server.

    The original has no driver: the agent reads ``program.md`` and runs the
    experiment loop itself on a git branch, editing one file and scoring it with
    one command. This engine lays out that repository shape, hands the agent the
    adapted brief, and re-launches the session (Ralph) while budget remains.
    """

    name = "autoresearch"

    def __init__(self, config: OptimizeAnythingConfig) -> None:
        """Pop the engine knobs from the shared config.

        Args:
            config: Cross-engine run configuration.
        """
        engine_config = dict(config.engine_config)
        self.model = str(engine_config.pop("model"))
        self.ralph = bool(engine_config.pop("ralph", False))
        no_eval = engine_config.pop("max_no_eval_seconds", None)
        self.max_no_eval_seconds = None if no_eval is None else float(no_eval)
        self.effort = engine_config.pop("effort", None)
        thinking = engine_config.pop("max_thinking_tokens", None)
        self.max_thinking_tokens = None if thinking is None else int(thinking)
        self.max_token_cost = config.max_token_cost
        self.stop_at_score = config.stop_at_score
        self.run_dir = Path(config.run_dir or "autoresearch-run").resolve()
        self.work_dir = self.run_dir / "autoresearch"
        self.session_ids: list[str] = []
        self.sessions = 0
        self.cost_usd = 0.0
        self.tag = time.strftime("%b%d").lower()

    def run(self, task: Task, server: EvalServer) -> Result:
        """Lay out the repository, run the agent's experiment loop, and report the server-verified best.

        Args:
            task: Task with a text seed candidate.
            server: Evaluation server the agent's ``eval.sh`` calls.

        Returns:
            The best candidate the server actually scored.

        Raises:
            RuntimeError: When the agent finished without scoring any candidate.
        """
        self._layout(task, server)
        session_id = str(uuid.uuid4())
        while True:
            remaining = _remaining_cost(self.max_token_cost, self.cost_usd)
            if remaining is not None and remaining <= 0 and self.sessions:
                break
            evals_before = server.budget.used
            outcome = self._session(server, session_id, resume=self.sessions > 0, max_budget_usd=remaining)
            self.sessions += 1
            self.cost_usd += outcome.cost_usd
            if outcome.session_id not in self.session_ids:
                self.session_ids.append(outcome.session_id)
            if not self.ralph or self._loop_done(server, outcome, evals_before):
                break
        return self._result(task, server)

    def incumbent(self, server: EvalServer) -> tuple[str, float] | None:
        """Return the best server-verified candidate so far.

        Args:
            server: Evaluation server with the run's evidence.

        Returns:
            ``(candidate, score)`` or ``None`` before any evaluation.
        """
        if server.task.has_dataset:
            return best_aggregate_candidate(server)
        if server.best_candidate is None or server.best_score is None:
            return None
        return str(server.best_candidate), float(server.best_score)

    def process_result(self, result: Result, output_dir: str | Path) -> None:
        """Write the final candidate and run metadata beside the evaluator artifacts.

        Args:
            result: Result returned by ``run``.
            output_dir: Evaluator output directory.
        """
        target = Path(output_dir) / self.name
        target.mkdir(parents=True, exist_ok=True)
        (target / "best_candidate.txt").write_text(result.best_candidate, encoding="utf-8")
        (target / "metadata.json").write_text(json.dumps(result.metadata, indent=2, default=str), encoding="utf-8")

    def _layout(self, task: Task, server: EvalServer) -> None:
        """Create the git repository the brief describes.

        Args:
            task: Task providing the seed and description.
            server: Evaluation server whose URL ``eval.sh`` targets.

        Raises:
            RuntimeError: When git is unavailable, since the loop is branch-based.
        """
        if shutil.which("git") is None:
            raise RuntimeError("AutoResearch needs git in the runtime: its experiment loop advances a branch.")
        if self.work_dir.exists():
            shutil.rmtree(self.work_dir)
        self.work_dir.mkdir(parents=True)
        example_ids = visible_example_ids(server)
        route = "evaluate_examples" if example_ids else "evaluate"
        (self.work_dir / "README.md").write_text(task_brief(task, example_ids), encoding="utf-8")
        (self.work_dir / "candidate.txt").write_text(seed_as_text(task.seed_candidate), encoding="utf-8")
        eval_script = self.work_dir / "eval.sh"
        eval_script.write_text(
            EVAL_SCRIPT.format(
                server_url=server.url, route=route, marker=BUDGET_EXHAUSTED_MARKER, python=sys.executable
            ),
            encoding="utf-8",
        )
        eval_script.chmod(0o755)
        (self.work_dir / "program.md").write_text(self._program(server, example_ids), encoding="utf-8")
        (self.work_dir / ".gitignore").write_text("results.tsv\nrun.log\n", encoding="utf-8")
        (self.work_dir / "results.tsv").write_text("commit\tscore\tstatus\tdescription\n", encoding="utf-8")
        git_env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "autoresearch",
            "GIT_AUTHOR_EMAIL": "autoresearch@localhost",
            "GIT_COMMITTER_NAME": "autoresearch",
            "GIT_COMMITTER_EMAIL": "autoresearch@localhost",
        }
        for args in (
            ["init", "-q", "-b", "master"],
            ["add", "-A"],
            ["commit", "-q", "-m", "initial candidate"],
            ["checkout", "-q", "-b", f"autoresearch/{self.tag}"],
        ):
            subprocess.run(["git", *args], cwd=self.work_dir, env=git_env, check=True, capture_output=True)

    def _program(self, server: EvalServer, example_ids: list[str]) -> str:
        """Derive the sandbox brief from the pinned upstream ``program.md``.

        Args:
            server: Evaluation server, for the budget figures.
            example_ids: Visible example ids, empty for single-candidate tasks.

        Returns:
            The adapted brief.
        """
        budget = server.budget.remaining
        budget_note = (
            "as many evaluator calls as the run allows" if budget is None else f"{budget} evaluator calls in total"
        )
        if self.max_token_cost is not None:
            budget_note += f" and ${float(self.max_token_cost):.2f} of your own model spend"
        pool = (
            f" It scores the candidate on all {_plural(len(example_ids), 'visible example')} and reports the "
            "average `score` plus per-example scores and feedback."
            if example_ids
            else " It reports a single `score` plus any evaluator feedback."
        )
        edits: list[tuple[str, ...]] = [
            ("To set up a new experiment, work with the user to:", "To set up a new experiment:"),
            (
                "1. **Agree on a run tag**",
                "Once you get confirmation, kick off the experimentation.",
                f"1. **Run tag**: this run's tag is `{self.tag}`; the branch `autoresearch/{self.tag}` has already "
                "been created and checked out for you — this is a fresh run.\n"
                "2. **Stay on the branch**: never switch branches or touch `master`.\n"
                "3. **Read the in-scope files**: The repo is small. Read these files for full context:\n"
                "   - `README.md` — the task: what the candidate is for and how it is judged.\n"
                "   - `eval.sh` — the fixed evaluator. Do not modify.\n"
                "   - `candidate.txt` — the file you modify. It holds the candidate text being optimized.\n"
                "4. **Verify the evaluator answers**: `./eval.sh candidate.txt` must print a JSON body with a "
                "`score` field.\n"
                "5. **results.tsv is initialized**: it already holds just the header row. The baseline will be "
                "recorded after the first run.\n"
                "6. **Go**: there is no human in this session to confirm with.\n\n"
                "Kick off the experimentation immediately.",
            ),
            (
                "Each experiment runs on a single GPU. The training script runs for a **fixed time budget of 5 "
                "minutes** (wall clock training time, excluding startup/compilation). You launch it simply as: "
                "`uv run train.py`.",
                "Each experiment scores the current `candidate.txt` with the fixed evaluator. You launch it simply "
                f"as: `./eval.sh candidate.txt`.{pool}",
            ),
            (
                "- Modify `train.py` — this is the only file you edit. Everything is fair game: model architecture, "
                "optimizer, hyperparameters, training loop, batch size, model size, etc.",
                "- Modify `candidate.txt` — this is the only file you edit. Everything in it is fair game: "
                "structure, wording, logic, length, etc.",
            ),
            (
                "- Modify `prepare.py`. It is read-only.",
                "The `evaluate_bpb` function in `prepare.py` is the ground truth metric.",
                "- Modify `eval.sh` or `README.md`. They are read-only.\n"
                "- Install packages or reach the network. The only outside call you make is `./eval.sh`.\n"
                "- Modify the evaluation harness. The `score` that `./eval.sh` returns is the ground truth metric.",
            ),
            (
                "**The goal is simple: get the lowest val_bpb.**",
                "The only constraint is that the code runs without crashing and finishes within the time budget.",
                "**The goal is simple: get the highest score.** Everything is fair game as long as the candidate "
                "stays valid for the task in `README.md`. The only constraint is that the evaluator returns a "
                "score for it.",
            ),
            (
                "**VRAM** is a soft constraint. Some increase is acceptable for meaningful val_bpb gains, but it "
                "should not blow up dramatically.",
                "**Length** is a soft constraint. Some growth is acceptable for meaningful score gains, but the "
                "candidate should not blow up dramatically.",
            ),
            (
                "A 0.001 val_bpb improvement that adds 20 lines of hacky code? Probably not worth it. A 0.001 "
                "val_bpb improvement from deleting code? Definitely keep.",
                "A tiny score improvement that adds 20 lines of convoluted text? Probably not worth it. A tiny "
                "score improvement from deleting text? Definitely keep.",
            ),
            (
                "so you will run the training script as is.",
                "so you will run the evaluator on `candidate.txt` as is.",
            ),
            (
                "Once the script finishes it prints a summary like this:",
                'grep "^val_bpb:" run.log\n```',
                "Once the evaluator finishes it prints a JSON body like this:\n\n```\n"
                '{"score": 0.6875, ...}\n```\n\n'
                "The body also carries the evaluator's `feedback` when it has any — read it, it says why the "
                "candidate scored the way it did. You can extract the key metric from the log file:\n\n```\n"
                "grep -o '\"score\": *[-0-9.e]*' run.log\n```",
            ),
            (
                "The TSV has a header row and 5 columns:",
                "d4e5f6g\t0.000000\t0.0\tcrash\tdouble model width (OOM)\n```",
                "The TSV has a header row and 4 columns:\n\n```\ncommit\tscore\tstatus\tdescription\n```\n\n"
                "1. git commit hash (short, 7 chars)\n"
                "2. score achieved (e.g. 0.687500) — use 0.000000 for crashes\n"
                "3. status: `keep`, `discard`, or `crash`\n"
                "4. short text description of what this experiment tried\n\n"
                "Example:\n\n```\ncommit\tscore\tstatus\tdescription\n"
                "a1b2c3d\t0.625000\tkeep\tbaseline\n"
                "b2c3d4e\t0.687500\tkeep\tstate the output format up front\n"
                "c3d4e5f\t0.610000\tdiscard\tdrop the worked example\n"
                "d4e5f6g\t0.000000\tcrash\tempty candidate (evaluator rejected it)\n```",
            ),
            (
                "The experiment runs on a dedicated branch (e.g. `autoresearch/mar5` or `autoresearch/mar5-gpu0`).",
                f"The experiment runs on the dedicated branch `autoresearch/{self.tag}`.",
            ),
            (
                "2. Tune `train.py` with an experimental idea by directly hacking the code.",
                "2. Tune `candidate.txt` with an experimental idea by directly editing it.",
            ),
            (
                "4. Run the experiment: `uv run train.py > run.log 2>&1`",
                "4. Run the experiment: `./eval.sh candidate.txt > run.log 2>&1`",
            ),
            (
                '5. Read out the results: `grep "^val_bpb:\\|^peak_vram_mb:" run.log`',
                "5. Read out the results: `grep -o '\"score\": *[-0-9.e]*' run.log`",
            ),
            (
                "Run `tail -n 50 run.log` to read the Python stack trace and attempt a fix.",
                "Run `tail -n 50 run.log` to read the evaluator's error and attempt a fix. If the log says "
                f"`{BUDGET_EXHAUSTED_MARKER}`, the evaluation budget is spent: stop the loop and finish.",
            ),
            (
                '8. If val_bpb improved (lower), you "advance" the branch, keeping the git commit',
                '8. If the score improved (higher), you "advance" the branch, keeping the git commit',
            ),
            (
                "9. If val_bpb is equal or worse, you git reset back to where you started",
                "9. If the score is equal or worse, you git reset back to where you started",
            ),
            (
                "**Timeout**: Each experiment should take ~5 minutes total (+ a few seconds for startup and eval "
                "overhead). If a run exceeds 10 minutes, kill it and treat it as a failure (discard and revert).",
                "**Timeout**: Each experiment takes as long as the evaluator needs. If a run exceeds 10 minutes, "
                "kill it and treat it as a failure (discard and revert).",
            ),
            (
                "If a run crashes (OOM, or a bug, or etc.)",
                "If a run crashes (the evaluator rejects the candidate, etc.)",
            ),
            (
                "The human might be asleep, or gone from a computer and expects you to continue working "
                "*indefinitely* until you are manually stopped.",
                "There is no human in this session; you are expected to continue working until the evaluation "
                "budget runs out.",
            ),
            (
                "The loop runs until the human interrupts you, period.",
                "The loop runs until the evaluation budget is exhausted or the run is interrupted, period.",
            ),
            (
                "As an example use case, a user might leave you running while they sleep.",
                "all completed by you while they slept!",
                f"The budget for this run is {budget_note}. Spend it on new experiments, not on re-scoring the "
                "same candidate: every `./eval.sh` call counts.",
            ),
        ]
        return adapt(load_asset("autoresearch/program.md"), edits)

    def _session(
        self, server: EvalServer, session_id: str, *, resume: bool, max_budget_usd: float | None
    ) -> ProposerOutcome:
        """Run one agent session with the no-evaluation watchdog.

        Args:
            server: Evaluation server whose usage counter proves progress.
            session_id: Session to start or resume.
            resume: Whether this is a Ralph continuation.
            max_budget_usd: Remaining proposer spend.

        Returns:
            The session outcome.
        """
        last_used = server.budget.used
        last_progress = time.monotonic()

        def stalled() -> bool:
            """Tell whether the agent has gone ``max_no_eval_seconds`` without evaluating."""
            nonlocal last_used, last_progress
            if server.budget.used != last_used:
                last_used = server.budget.used
                last_progress = time.monotonic()
            return self.max_no_eval_seconds is not None and time.monotonic() - last_progress >= self.max_no_eval_seconds

        prompt = (
            "Read `program.md` in this directory and follow it exactly: it is your complete brief for this "
            "autonomous research run. Setup is already done; start the experiment loop now."
        )
        if resume:
            prompt = (
                "Continue the experiment loop from `program.md`. The branch, `results.tsv` and your earlier "
                "commits are still here; pick up where you left off and keep experimenting."
            )
        return run_proposer(
            prompt,
            work_dir=self.work_dir,
            log_dir=self.run_dir / "sessions",
            name=f"session{self.sessions + 1}",
            model=self.model,
            session_id=session_id,
            resume=resume,
            effort=self.effort,
            max_thinking_tokens=self.max_thinking_tokens,
            max_budget_usd=max_budget_usd,
            should_kill=stalled,
        )

    def _loop_done(self, server: EvalServer, outcome: ProposerOutcome, evals_before: int) -> bool:
        """Decide whether Ralph should relaunch the session.

        Args:
            server: Evaluation server with the budget state.
            outcome: The session that just ended.
            evals_before: Evaluations used before that session started.

        Returns:
            ``True`` when budget, threshold or a wedged agent ends the loop.
        """
        best = self.incumbent(server)
        remaining = server.budget.remaining
        return (
            outcome.budget_exhausted
            or (remaining is not None and remaining <= 0)
            or _reached(self.stop_at_score, None if best is None else best[1])
            or server.budget.used == evals_before
        )

    def _result(self, task: Task, server: EvalServer) -> Result:
        """Build the result from server evidence only.

        Args:
            task: Task being optimized.
            server: Evaluation server with the run's evidence.

        Returns:
            The verified best candidate.

        Raises:
            RuntimeError: When nothing was ever scored.
        """
        best = self.incumbent(server)
        if best is None:
            raise RuntimeError("The AutoResearch agent finished without scoring any candidate through eval.sh.")
        candidate, score = best
        return Result(
            best_candidate=candidate,
            best_score=score,
            total_evals=server.budget.used,
            eval_log=list(server.eval_log),
            metadata={
                "engine": self.name,
                "upstream_revision": AUTORESEARCH_REVISION,
                "session_ids": list(self.session_ids),
                "sessions": self.sessions,
                "proposer_cost_usd": round(self.cost_usd, 6),
                "branch": f"autoresearch/{self.tag}",
                "work_dir": str(self.work_dir),
                "seed_len": len(seed_as_text(task.seed_candidate)),
            },
        )


class MetaHarnessEngine:
    """stanford-iris-lab/meta-harness ``run_evolve`` at the pinned revision, driven against the evaluation server.

    Phase 0 benchmarks the seed; every iteration then shows the frontier, asks the
    proposer for a fixed number of candidates through the upstream skill, validates
    and benchmarks each one on every visible example, recomputes the frontier and
    appends the upstream ``evolution_summary.jsonl`` rows.
    """

    name = "meta_harness"

    def __init__(self, config: OptimizeAnythingConfig) -> None:
        """Pop the engine knobs from the shared config.

        Args:
            config: Cross-engine run configuration.
        """
        engine_config = dict(config.engine_config)
        self.model = str(engine_config.pop("model"))
        # Upstream CLI default: ``--iterations 20``.
        self.max_iterations = int(engine_config.pop("max_iterations", 20))
        self.candidates_per_iter = max(1, int(engine_config.pop("max_candidates_per_iter", 3)))
        self.effort = engine_config.pop("effort", None)
        thinking = engine_config.pop("max_thinking_tokens", None)
        self.max_thinking_tokens = None if thinking is None else int(thinking)
        self.max_token_cost = config.max_token_cost
        self.stop_at_score = config.stop_at_score
        self.run_dir = Path(config.run_dir or "meta-harness-run").resolve()
        self.work_dir = self.run_dir / "meta_harness"
        self.logs_dir = self.work_dir / "logs" / "run"
        self.session_ids: list[str] = []
        self.cost_usd = 0.0
        self.example_ids: list[str] = []
        self.results: dict[str, dict[str, Any]] = {}

    def run(self, task: Task, server: EvalServer) -> Result:
        """Run the baseline and the evolution iterations.

        Args:
            task: Task with a text seed candidate.
            server: Evaluation server that benchmarks candidates.

        Returns:
            The frontier's best candidate, verified by the server.
        """
        self.example_ids = visible_example_ids(server)
        self._layout(task)
        iterations = 0
        stop_reason = "max_iterations"
        try:
            self._benchmark(server, "seed", seed_as_text(task.seed_candidate))
            self._write_frontier()
            for iteration in range(1, self.max_iterations + 1):
                best = self._best()
                if _reached(self.stop_at_score, None if best is None else best[1]):
                    stop_reason = "stop_at_score"
                    break
                remaining = _remaining_cost(self.max_token_cost, self.cost_usd)
                if remaining is not None and remaining <= 0:
                    stop_reason = "proposer_budget"
                    break
                if server.budget.remaining is not None and server.budget.remaining < max(1, len(self.example_ids)):
                    stop_reason = "eval_budget"
                    break
                iterations = iteration
                self._iteration(server, iteration, remaining)
        except BudgetExhausted:
            stop_reason = "eval_budget"
        return self._result(server, iterations, stop_reason)

    def incumbent(self, server: EvalServer) -> tuple[str, float] | None:
        """Return the frontier's best candidate text and score.

        Args:
            server: Unused; the frontier is the engine's own verified record.

        Returns:
            ``(candidate, score)`` or ``None`` before the baseline finished.
        """
        del server
        return self._best()

    def process_result(self, result: Result, output_dir: str | Path) -> None:
        """Write the final candidate and run metadata beside the evaluator artifacts.

        Args:
            result: Result returned by ``run``.
            output_dir: Evaluator output directory.
        """
        target = Path(output_dir) / self.name
        target.mkdir(parents=True, exist_ok=True)
        (target / "best_candidate.txt").write_text(result.best_candidate, encoding="utf-8")
        (target / "metadata.json").write_text(json.dumps(result.metadata, indent=2, default=str), encoding="utf-8")

    def _layout(self, task: Task) -> None:
        """Create the upstream workspace: ``agents/``, the run logs and the skill.

        Args:
            task: Task providing the seed and description.
        """
        if self.work_dir.exists():
            shutil.rmtree(self.work_dir)
        for sub in ("agents", "logs/run/reports", "logs/run/claude_sessions", "logs/run/results"):
            (self.work_dir / sub).mkdir(parents=True)
        (self.work_dir / "agents" / "seed.txt").write_text(seed_as_text(task.seed_candidate), encoding="utf-8")
        (self.work_dir / "task.md").write_text(task_brief(task, self.example_ids), encoding="utf-8")
        skill_dir = self.work_dir / ".claude" / "skills" / "meta-harness"
        skill_dir.mkdir(parents=True)
        skill_dir.joinpath("SKILL.md").write_text(self.skill(), encoding="utf-8")
        (self.logs_dir / "evolution_summary.jsonl").write_text("", encoding="utf-8")

    def skill(self) -> str:
        """Derive the sandbox skill from the pinned upstream ``SKILL.md``.

        Returns:
            The adapted skill text.
        """
        n = self.candidates_per_iter
        names = ", ".join(f"<name{i}>" for i in range(1, n + 1))
        edits: list[tuple[str, ...]] = [
            (
                "description: Run one iteration of memory system evolution. Called by meta_harness.py or "
                "interactively via /meta-harness.",
                "description: Run one iteration of candidate evolution. Called by the Meta-Harness driver.",
            ),
            ("# Meta-Harness (Memory System Evolution)", "# Meta-Harness (Candidate Evolution)"),
            ("Run ONE iteration of memory system evolution.", "Run ONE iteration of candidate evolution."),
            (
                "You analyze results + prediction traces, prototype changes, and implement new systems. The outer "
                "loop (`meta_harness.py`) handles benchmarking separately.",
                "You analyze results + evaluation traces, prototype changes, and write new candidates. The outer "
                "loop (the Meta-Harness driver) handles benchmarking separately.",
            ),
            (
                "- You MUST implement 3 new memory systems every iteration.",
                f"- You MUST write {_plural(n, 'new candidate')} every iteration.",
            ),
            (
                "- Design exactly 3 candidates per iteration: mix of exploitation and exploration.",
                f"- Design exactly {_plural(n, 'candidate')} per iteration: "
                + ("mix of exploitation and exploration." if n > 1 else "exploitation or exploration."),
            ),
            (
                "The most common failure mode is creating systems that are just parameter variants of existing "
                "ones. Check `evolution_summary.jsonl` for what's been tried — parameter sweeps (pool sizes, "
                "retrieval counts, context budgets, similarity metrics) almost always regress or tie.",
                "The most common failure mode is creating candidates that are just cosmetic variants of existing "
                "ones. Check `evolution_summary.jsonl` for what's been tried — cosmetic sweeps (synonyms, "
                "reordering, small number tweaks) almost always regress or tie.",
            ),
            (
                "- A new retrieval algorithm",
                "- A new memory structure (e.g. separate fast/slow pools, hierarchical organization, compressed "
                "representations)",
                "- A new structure (e.g. organize around the task's decision points instead of a linear list)\n"
                "- A new strategy (e.g. an explicit procedure, worked examples, self-checks, a different framing)\n"
                "- A new failure defense (e.g. address the error classes the traces show, not the ones you assume)\n"
                "- A new representation (e.g. compressed rules instead of prose, or the reverse)",
            ),
            (
                "**Bad candidates just tune numbers.** If the logic in `predict()` and `learn_from_batch()` is "
                "identical to the base except for constants, it's a parameter variant.",
                "**Bad candidates just tweak wording.** If the candidate is identical to the base except for a few "
                "constants or synonyms, it's a cosmetic variant.",
            ),
            (
                "**Combining systems is valid.** Take the retrieval strategy from system A and the memory format "
                "from system B,",
                "**Combining candidates is valid.** Take the structure from candidate A and the strategy from "
                "candidate B,",
            ),
            (
                "Exploitation axes: A=Prompt template, B=Memory content, C=Selection algorithm, D=Memory sizing, "
                "E=Learning trigger, F=LLM usage in learning.",
                "Exploitation axes: A=Structure, B=Content, C=Strategy, D=Length, E=Framing, F=Failure handling.",
            ),
            (
                "- **No dataset-specific hints.** Do not hardcode knowledge about specific datasets. Memory systems "
                "must be general-purpose.\n- **Never mention dataset names** in system code, prompts, or comments.",
                "- **No example-specific hints.** Do not hardcode answers to specific evaluation examples. "
                "Candidates must generalize to unseen cases.\n- **Never copy example ids or expected outputs** "
                "into a candidate.",
            ),
            ("which datasets improved/regressed and why", "which examples improved/regressed and why"),
            (
                "   - `frontier_val.json` — current best per dataset (val accuracy)\n"
                "   - `config.yaml` for current datasets and baselines\n"
                "   - recent `logs/<dataset>/<agent>/<model>/log.jsonl` traces if they exist",
                "   - `frontier_val.json` — current best per example (score)\n"
                "   - `task.md` for the objective, background and the evaluation examples\n"
                "   - recent `results/<candidate>/val.json` traces if they exist",
            ),
            (
                "2. Formulate 3 hypotheses",
                f"2. Formulate {_plural(n, 'hypothesis').replace('hypothesiss', 'hypotheses')}",
            ),
            (
                "1. Write a test script in `/tmp/` that exercises the core retrieval/learning logic in isolation.\n"
                "2. Pull real examples from `logs/<dataset>/<memory>/<model>/log.jsonl` to test against.",
                "1. Draft the change in a scratch file under `/tmp/` and reason it through against concrete cases.\n"
                "2. Pull real cases and evaluator feedback from `results/<candidate>/val.json` to test against.",
            ),
            ("4. Delete scripts when done.", "4. Delete scratch files when done."),
            ("For each of the 3 candidates:", f"For each of the {_plural(n, 'candidate')}:"),
            (
                "1. Copy a top-performing base system to `agents/<name>.py`, then make targeted modifications. This "
                "copy-then-edit approach ensures correct imports and proven patterns.",
                "1. Copy a top-performing base candidate to `agents/<name>.txt`, then make targeted modifications. "
                "This copy-then-edit approach keeps proven patterns.",
            ),
            (
                "After implementing, re-read the file and check: does this system introduce a genuinely NEW "
                "mechanism, or is it just a parameter variant? If the logic in `predict()` and "
                "`learn_from_batch()` is identical to the base except for numbers, REWRITE with a truly novel "
                "mechanism.\n"
                "4. Validate: `uv run python -c \"from text_classification.agents.<name> import *; print('OK')\"`\n\n"
                "Do not edit `config.yaml` just to register candidates. The benchmark auto-discovers files in "
                "`agents/`.",
                "After writing, re-read the file and check: does this candidate introduce a genuinely NEW "
                "mechanism, or is it just a cosmetic variant? If it is identical to the base except for a few "
                "words or numbers, REWRITE with a truly novel mechanism.\n"
                "4. Validate: `test -s agents/<name>.txt && echo OK` — the file must exist and be non-empty; its "
                "whole content is what gets evaluated.\n\n"
                "Do not edit `task.md`. The benchmark reads exactly the files listed in `pending_eval.json`.",
            ),
            ('"file": "agents/<name>.py",', '"file": "agents/<name>.txt",'),
            ("Output: `CANDIDATES: <name1>, <name2>, <name3>`", f"Output: `CANDIDATES: {names}`"),
            (
                "## MemorySystem Interface",
                "- Test results: `results/<dataset>/<memory>/<model>/test.json` (separate dir, never exposed during "
                "evolution)",
                "## Candidate Format\n\n"
                "- Each candidate is a plain text file under `agents/`; its whole content is submitted to the "
                "evaluator.\n"
                "- `task.md` says what the candidate is for and how it is judged.\n"
                "- `agents/seed.txt` is the starting candidate the run began from.\n\n"
                "## Directory Structure\n\n"
                "- Val results: `results/<candidate>/val.json` (`avg_val` plus per-example `scores` and evaluator "
                "`infos`)\n"
                "- Frontier: `frontier_val.json` (`_pareto` ranks candidates by average score)\n"
                "- Test results are held out and never exposed during evolution",
            ),
            (
                '{"iteration": 1, "system": "example_system", "avg_val": 45.0, "axis": "exploitation", '
                '"hypothesis": "...", "delta": +2.1, "outcome": "45.0% (+2.1)", "components": ["tag1", "tag2", '
                '"tag3"]}',
                '{"iteration": 1, "system": "example_candidate", "avg_val": 0.45, "axis": "exploitation", '
                '"hypothesis": "...", "delta": 0.021, "outcome": "0.4500 (+0.0210)", "components": ["tag1", '
                '"tag2", "tag3"]}',
            ),
            (
                "Treat `evolution_summary.jsonl`, `frontier_val.json`, and recent training traces as the only "
                "shipped history sources in this trimmed repo.",
                "Treat `evolution_summary.jsonl`, `frontier_val.json`, and `results/<candidate>/val.json` as the "
                "only history sources in this workspace.",
            ),
        ]
        return adapt(load_asset("meta_harness/SKILL.md"), edits)

    def _task_prompt(self, iteration: int) -> str:
        """Render the per-iteration prompt with upstream's wording and this run's paths.

        Args:
            iteration: One-based iteration number.

        Returns:
            The prompt text.
        """
        logs = self.logs_dir.relative_to(self.work_dir)
        count = len(self.example_ids) or 1
        return (
            f"Run iteration {iteration} of the evolution loop. There are {_plural(count, 'evaluation example')}.\n\n"
            "## Run directories\n"
            f"All logs and results for this run are under `{logs}/`.\n"
            f"- `{logs / 'evolution_summary.jsonl'}` — past results\n"
            f"- `{logs / 'frontier_val.json'}` — frontier\n"
            f"- `{logs / 'reports'}/` — post-eval reports\n"
            f"- `{logs / 'results'}/<candidate>/val.json` — per-example scores and evaluator feedback\n"
            f"- Write pending_eval.json to: `{logs / 'pending_eval.json'}`\n\n"
            "Follow the meta-harness skill in `.claude/skills/meta-harness/SKILL.md`."
        )

    def _iteration(self, server: EvalServer, iteration: int, remaining_cost: float | None) -> None:
        """Run one propose-validate-benchmark iteration.

        Args:
            server: Evaluation server that benchmarks candidates.
            iteration: One-based iteration number.
            remaining_cost: Proposer spend still allowed, or ``None``.
        """
        best = self._best()
        print(
            f"[iter {iteration}] frontier: {best[1]:.4f}" if best else f"[iter {iteration}] frontier: none", flush=True
        )
        pending = self.logs_dir / "pending_eval.json"
        pending.unlink(missing_ok=True)
        started = time.monotonic()
        outcome = run_proposer(
            self._task_prompt(iteration),
            work_dir=self.work_dir,
            log_dir=self.logs_dir / "claude_sessions",
            name=f"iter{iteration}",
            model=self.model,
            session_id=str(uuid.uuid4()),
            effort=self.effort,
            max_thinking_tokens=self.max_thinking_tokens,
            max_budget_usd=remaining_cost,
            tools=META_HARNESS_TOOLS,
            append_system_prompt=self.skill(),
        )
        propose_seconds = time.monotonic() - started
        self.cost_usd += outcome.cost_usd
        self.session_ids.append(outcome.session_id)
        candidates = self._read_pending(pending)
        if not candidates:
            print(f"[iter {iteration}] no candidates produced", flush=True)
            return
        previous_best = best[1] if best else None
        rows: list[dict[str, Any]] = []
        bench_started = time.monotonic()
        for spec in candidates:
            name = str(spec.get("name") or "")
            failure = self._validate(spec)
            row: dict[str, Any] = {
                "iteration": iteration,
                "system": name,
                "axis": spec.get("axis"),
                "hypothesis": spec.get("hypothesis"),
            }
            if failure:
                row.update({"avg_val": None, "delta": None, "outcome": f"failed: {failure}"})
                rows.append(row)
                continue
            text = (self.work_dir / str(spec["file"])).read_text(encoding="utf-8")
            avg = self._benchmark(server, name, text)
            delta = None if previous_best is None else round(avg - previous_best, 4)
            row.update(
                {
                    "avg_val": avg,
                    "delta": delta,
                    "outcome": f"{avg:.4f}" + ("" if delta is None else f" ({delta:+.4f})"),
                }
            )
            if "components" in spec:
                row["components"] = spec["components"]
            rows.append(row)
        rows[0]["timing_s"] = {
            "propose": round(propose_seconds, 1),
            "bench": round(time.monotonic() - bench_started, 1),
            "wall": round(time.monotonic() - started, 1),
        }
        with (self.logs_dir / "evolution_summary.jsonl").open("a", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row) + "\n")
        self._write_frontier()
        new_best = self._best()
        if new_best and (previous_best is None or new_best[1] > previous_best):
            print(f"[iter {iteration}] NEW BEST: {new_best[1]:.4f}", flush=True)
        else:
            print(f"[iter {iteration}] no improvement", flush=True)

    def _read_pending(self, pending: Path) -> list[dict[str, Any]]:
        """Read the proposer's ``pending_eval.json`` candidate list.

        Args:
            pending: Path the prompt told the proposer to write.

        Returns:
            At most ``candidates_per_iter`` candidate specs; empty when absent or malformed.
        """
        try:
            document = json.loads(pending.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        candidates = document.get("candidates") if isinstance(document, dict) else None
        if not isinstance(candidates, list):
            return []
        return [spec for spec in candidates if isinstance(spec, dict)][: self.candidates_per_iter]

    def _validate(self, spec: dict[str, Any]) -> str | None:
        """Check a candidate spec the way upstream import-checks a new system.

        Args:
            spec: One ``pending_eval.json`` candidate entry.

        Returns:
            A failure reason, or ``None`` when the candidate can be benchmarked.
        """
        name = spec.get("name")
        if not isinstance(name, str) or not _SAFE_NAME.match(name):
            return "invalid candidate name"
        if name in self.results:
            return "duplicate candidate name"
        file = spec.get("file")
        if not isinstance(file, str):
            return "missing file"
        path = (self.work_dir / file).resolve()
        agents = (self.work_dir / "agents").resolve()
        if not path.is_relative_to(agents) or not path.is_file():
            return "candidate file must exist under agents/"
        if not path.read_text(encoding="utf-8").strip():
            return "candidate file is empty"
        return None

    def _benchmark(self, server: EvalServer, name: str, candidate: str) -> float:
        """Score one candidate on every visible example and record the trace.

        Args:
            server: Evaluation server.
            name: Candidate name used for the results directory.
            candidate: Candidate text.

        Returns:
            The average score.
        """
        ids = self.example_ids or None
        avg, info = server.evaluate_examples(candidate, example_ids=ids)
        avg = float(avg)
        server.log_progress(avg, candidate=candidate)
        record = {"system": name, "avg_val": avg, "scores": info.get("scores", {}), "infos": info.get("infos", {})}
        self.results[name] = {"avg_val": avg, "scores": dict(record["scores"]), "candidate": candidate}
        target = self.logs_dir / "results" / name
        target.mkdir(parents=True, exist_ok=True)
        (target / "val.json").write_text(json.dumps(record, indent=2, default=str), encoding="utf-8")
        return avg

    def _write_frontier(self) -> None:
        """Write ``frontier_val.json``: per-example leaders plus the ``_pareto`` ranking."""
        ranked = sorted(self.results.items(), key=lambda item: -item[1]["avg_val"])
        frontier: dict[str, Any] = {
            "_pareto": [{"system": name, "val_accuracy": entry["avg_val"]} for name, entry in ranked]
        }
        for eid in self.example_ids or ["_single"]:
            leader = max(
                ((name, entry["scores"].get(eid)) for name, entry in ranked if entry["scores"].get(eid) is not None),
                key=lambda item: item[1],
                default=None,
            )
            if leader is not None:
                frontier[eid] = {"system": leader[0], "val_accuracy": leader[1]}
        (self.logs_dir / "frontier_val.json").write_text(json.dumps(frontier, indent=2), encoding="utf-8")

    def _best(self) -> tuple[str, float] | None:
        """Return the frontier leader's candidate text and average score.

        Returns:
            ``(candidate, score)`` or ``None`` when nothing has been benchmarked.
        """
        if not self.results:
            return None
        name = max(self.results, key=lambda key: self.results[key]["avg_val"])
        return self.results[name]["candidate"], float(self.results[name]["avg_val"])

    def _result(self, server: EvalServer, iterations: int, stop_reason: str) -> Result:
        """Build the result from the frontier.

        Args:
            server: Evaluation server with the run's evidence.
            iterations: Iterations that ran.
            stop_reason: Why the loop ended.

        Returns:
            The frontier's best candidate.

        Raises:
            RuntimeError: When even the baseline could not be scored.
        """
        best = self._best()
        if best is None:
            raise RuntimeError("Meta-Harness could not benchmark the seed candidate.")
        candidate, score = best
        return Result(
            best_candidate=candidate,
            best_score=score,
            total_evals=server.budget.used,
            eval_log=list(server.eval_log),
            metadata={
                "engine": self.name,
                "upstream_revision": META_HARNESS_REVISION,
                "session_ids": list(self.session_ids),
                "iterations": iterations,
                "stop_reason": stop_reason,
                "proposer_cost_usd": round(self.cost_usd, 6),
                "candidates_evaluated": len(self.results),
                "work_dir": str(self.work_dir),
            },
        )


ENGINES: dict[str, type] = {AutoResearchEngine.name: AutoResearchEngine, MetaHarnessEngine.name: MetaHarnessEngine}


def check_assets() -> dict[str, str]:
    """Verify both vendored prompts adapt cleanly at the pinned revisions.

    Returns:
        Engine names mapped to their pinned upstream revisions.
    """
    probe = OptimizeAnythingConfig(engine="meta_harness", engine_config={"model": "probe"})
    MetaHarnessEngine(probe).skill()
    adapt(load_asset("autoresearch/program.md"), [])
    return {"meta_harness": META_HARNESS_REVISION, "autoresearch": AUTORESEARCH_REVISION}
