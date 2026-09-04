"""Execute pinned upstream agent engines with a filesystem evaluator mailbox.

This standalone module is copied into the selected runtime. It deliberately
imports no Skynet application code and never receives held-out test examples.
"""

from __future__ import annotations

import base64
import contextlib
import io
import json
import math
import os
import signal
import subprocess
import sys
import tarfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from gepa.oa.budget import BudgetTracker
from gepa.oa.config import OptimizeAnythingConfig
from gepa.oa.engines.autoresearch import _best_aggregate_candidate
from gepa.oa.eval_server import EvalServer
from gepa.oa.registry import get_engine_cls
from gepa.oa.task import Task

_RPC_PREFIX = "SKYNET_NATIVE_RPC "
_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
_TOKEN_NAMES = ("prompt_tokens", "completion_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
_PROC_ROOT = Path("/proc")


class EvaluationStopped(BaseException):
    """Unwind infrastructure failures past upstream's ordinary bad-candidate handling."""


class BudgetStopped(EvaluationStopped):
    """Stop admission without converting an unperformed evaluation into feedback."""


class EvaluatorMailbox:
    """Send evaluation requests to the parent and await matching response files."""

    def __init__(self, nonce: str, timeout_seconds: float) -> None:
        """Create a process-scoped evaluator transport.

        Args:
            nonce: Parent-generated request framing token.
            timeout_seconds: Maximum time any evaluation can wait for a response.
        """
        self.nonce = nonce
        self.timeout_seconds = timeout_seconds
        self.error: EvaluationStopped | None = None
        self.stopped = threading.Event()
        self._write_lock = threading.Lock()

    def evaluate(self, candidate: str, example: Any = None, **kwargs: Any) -> tuple[float, dict[str, Any]]:
        """Evaluate only through the parent-owned budget and scorer.

        Args:
            candidate: Upstream text candidate.
            example: Visible training or validation case.
            **kwargs: Additional upstream evaluation context.

        Returns:
            Parent score and feedback.

        Raises:
            EvaluationStopped: When the parent rejects evaluation or does not reply.
        """
        del kwargs
        if self.stopped.is_set():
            raise EvaluationStopped("The parent evaluator has stopped this run.")
        request_id = uuid.uuid4().hex
        request = {"id": request_id, "candidate": candidate, "example": example}
        self.emit(_RPC_PREFIX, request)
        response_path = Path("rpc") / f"{request_id}.json"
        deadline = time.monotonic() + self.timeout_seconds
        while not self.stopped.is_set() and time.monotonic() < deadline:
            if response_path.exists():
                try:
                    response = json.loads(response_path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    # Both runtime filesystems can expose a new file before its
                    # contents have finished landing.
                    time.sleep(0.05)
                    continue
                if "error" in response:
                    kind = BudgetStopped if response.get("stop_reason") == "budget_reached" else EvaluationStopped
                    self.error = kind(str(response["error"]))
                    self.stopped.set()
                    raise self.error
                return float(response["score"]), dict(response.get("info") or {})
            time.sleep(0.05)
        self.error = self.error or EvaluationStopped("Native evaluator response timed out.")
        self.stopped.set()
        raise self.error

    def emit(self, prefix: str, payload: dict[str, Any]) -> None:
        """Write one framed event atomically across upstream evaluator threads.

        Args:
            prefix: Request or progress event family.
            payload: Event fields to serialize.
        """
        with self._write_lock:
            print(f"{prefix}{self.nonce} {json.dumps(payload, default=str, allow_nan=False)}", flush=True)


class ProgressEvalServer(EvalServer):
    """Forward aggregate checkpoints after upstream records them normally."""

    def __init__(self, task: Task, mailbox: EvaluatorMailbox, config: OptimizeAnythingConfig, output_dir: Path) -> None:
        """Bind the upstream evaluator and its additive progress transport.

        Args:
            task: Upstream task without held-out examples.
            mailbox: Parent evaluation and progress connection.
            config: Native engine evaluation budget and concurrency.
            output_dir: Persisted upstream evaluation artifacts.
        """
        self.mailbox = mailbox
        super().__init__(
            task,
            mailbox.evaluate,
            BudgetTracker(max_evals=config.max_evals),
            max_concurrency=config.max_concurrency,
            output_dir=output_dir,
        )

    def log_progress(
        self, val_score: float, candidate: str | None = None, reflection_cost: float = 0.0
    ) -> dict[str, Any]:
        """Forward an upstream aggregate without constructing candidate ancestry.

        Args:
            val_score: Aggregate score computed by the unchanged upstream engine.
            candidate: Candidate measured at this checkpoint.
            reflection_cost: Upstream-reported cumulative proposer dollars.

        Returns:
            The unchanged upstream checkpoint result.
        """
        result = super().log_progress(val_score, candidate, reflection_cost)
        if isinstance(candidate, str) and math.isfinite(val_score):
            self.mailbox.emit(
                "SKYNET_NATIVE_PROGRESS ",
                {
                    "candidate_id": self._register_candidate(candidate),
                    "candidate": candidate,
                    "score": val_score,
                    "total_evals": self.budget.used,
                },
            )
        return result


def _number(value: Any) -> int:
    """Return a nonnegative integral token count.

    Args:
        value: Native CLI usage value.

    Returns:
        Its count or zero when the field is absent or invalid.
    """
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _add_usage(destination: dict[str, dict[str, int]], model: str, counts: dict[str, Any], *, camel: bool) -> None:
    """Accumulate one CLI summary or one completed assistant message.

    Args:
        destination: Per-model cumulative usage.
        model: Model identifier reported by Claude Code.
        counts: Native token usage fields.
        camel: Whether fields use the CLI final-summary camelCase spelling.
    """
    mapping = (
        ("inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens")
        if camel
        else ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    )
    current = destination.setdefault(model, dict.fromkeys(_TOKEN_NAMES, 0))
    for name, native_name in zip(_TOKEN_NAMES, mapping, strict=True):
        current[name] += _number(counts.get(native_name))
    current["total_tokens"] = sum(current[name] for name in _TOKEN_NAMES)


def collect_usage(paths: list[Path], model: str) -> dict[str, dict[str, int]]:
    """Recover usage without counting mirrored session transcripts twice.

    Args:
        paths: Upstream artifact and Claude transcript directories.
        model: Configured model, used when a native record omits its model id.

    Returns:
        Per-model usage from final CLI summaries or deduplicated message ids.
    """
    totals: dict[str, dict[str, int]] = {}
    complete_sessions: set[str] = set()
    summaries: dict[str, dict[str, Any]] = {}
    messages: dict[tuple[str, str], dict[str, Any]] = {}
    for root in paths:
        if not root.exists():
            continue
        for path in root.rglob("*.json"):
            if not path.name.endswith("_stdout.json") or path.is_symlink():
                continue
            try:
                document = json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                continue
            if isinstance(document, dict) and isinstance(document.get("modelUsage"), dict):
                session = str(document.get("session_id") or path.name)
                summaries[session] = document["modelUsage"]
        for path in root.rglob("*.jsonl"):
            if path.is_symlink():
                continue
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except OSError:
                continue
            for index, line in enumerate(lines):
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(entry, dict) or entry.get("type") != "assistant":
                    continue
                message = entry.get("message")
                if not isinstance(message, dict) or not isinstance(message.get("usage"), dict):
                    continue
                session = str(entry.get("sessionId") or path.stem)
                message_id = str(message.get("id") or entry.get("uuid") or index)
                messages[(session, message_id)] = message
    for session, usage in summaries.items():
        if not usage:
            continue
        complete_sessions.add(session)
        for native_model, counts in usage.items():
            if isinstance(counts, dict):
                _add_usage(totals, str(native_model), counts, camel=True)
    for (session, _message_id), message in messages.items():
        if session not in complete_sessions:
            _add_usage(totals, str(message.get("model") or model), message["usage"], camel=False)
    return totals


def _descendants() -> list[int]:
    """Find only processes descended from this isolated runner.

    Returns:
        Child process ids, including separately grouped Claude sessions.
    """
    parents: dict[int, int] = {}
    if _PROC_ROOT.is_dir():
        for process in _PROC_ROOT.iterdir():
            if not process.name.isdigit():
                continue
            try:
                lines = (process / "status").read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeError):
                continue
            for line in lines:
                if line.startswith("PPid:") and line.split()[-1].isdigit():
                    parents[int(process.name)] = int(line.split()[-1])
                    break
    else:
        completed = subprocess.run(["ps", "-eo", "pid=,ppid="], capture_output=True, text=True, check=False)
        for line in completed.stdout.splitlines():
            columns = line.split()
            if len(columns) == 2 and all(value.isdigit() for value in columns):
                parents[int(columns[0])] = int(columns[1])
    descendants = {os.getpid()}
    while True:
        expanded = descendants | {pid for pid, parent in parents.items() if parent in descendants}
        if expanded == descendants:
            return sorted(descendants - {os.getpid()}, reverse=True)
        descendants = expanded


def _stop_children() -> None:
    """Stop native proposer processes after a parent evaluator failure."""
    for pid in _descendants():
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGKILL)


def _archive_artifacts(paths: list[tuple[str, Path]]) -> None:
    """Preserve regular upstream files within a bounded artifact archive.

    Args:
        paths: Artifact prefixes and corresponding process-local directories.

    Raises:
        RuntimeError: When raw artifacts exceed the transfer limit.
    """
    buffer = io.BytesIO()
    total = 0
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for prefix, root in paths:
            if not root.exists():
                continue
            for path in sorted(root.rglob("*")):
                if not path.is_file() or path.is_symlink():
                    continue
                total += path.stat().st_size
                if total > _MAX_ARTIFACT_BYTES:
                    raise RuntimeError("Native artifacts exceed the 64 MiB transfer limit.")
                archive.add(path, arcname=str(Path(prefix) / path.relative_to(root)), recursive=False)
    Path("native_artifacts.tar.gz.b64").write_text(base64.b64encode(buffer.getvalue()).decode("ascii"))


def _json_finite(value: Any) -> Any:
    """Replace unsupported nonfinite scores while preserving upstream metadata.

    Args:
        value: Result field or nested metadata value.

    Returns:
        A JSON-safe value with nonfinite floats represented by ``None``.
    """
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(key): _json_finite(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_json_finite(item) for item in value]
    return value


def _has_evaluated_single_result(server: EvalServer, output_dir: Path, candidate: Any, score: float) -> bool:
    """Verify that one completed upstream evaluation measured the returned pair.

    Args:
        server: Completed upstream evaluation history.
        output_dir: Upstream artifacts containing full evaluated candidates.
        candidate: Candidate selected by the unchanged engine.
        score: Finite single-task score selected by that engine.

    Returns:
        Whether any completed evaluation supports both the candidate and score.
    """
    for index, entry in enumerate(server.eval_log):
        if entry.get("score") != score:
            continue
        try:
            record = json.loads((output_dir / "evals" / f"{index}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get("candidate") == candidate and record.get("score") == score:
            return True
    return False


def _budget_incumbent(engine_id: str, engine: Any, task: Task, server: EvalServer, output_dir: Path) -> dict[str, Any]:
    """Retain an incumbent published by the upstream engine before interruption.

    Args:
        engine_id: Pinned native engine.
        engine: Interrupted upstream instance.
        task: Unchanged task and visible evaluation scope.
        server: Completed evaluation evidence.
        output_dir: Full upstream evaluator artifacts.

    Returns:
        An evaluated candidate envelope, or an empty mapping when none was published.
    """
    pending = getattr(engine, "_pending_tempdir", None)
    work_dir = Path(pending.name) if pending is not None else Path(engine.run_dir)
    if engine_id == "meta_harness":
        frontier = engine._read_frontier(work_dir / "state/frontier.json")
        score = engine._best_score(work_dir / "state/frontier.json")
        filename = frontier.get("best_candidate_file")
        if not isinstance(filename, str):
            return {}
        candidate_path = (work_dir / filename).resolve()
        if not candidate_path.is_relative_to(work_dir.resolve()) or not candidate_path.is_file():
            return {}
        candidate = candidate_path.read_text(encoding="utf-8")
    elif task.has_dataset:
        selected = _best_aggregate_candidate(server)
        if selected is None:
            return {}
        candidate, score = selected
    else:
        best_file = work_dir / "best_candidate.txt"
        if not best_file.is_file():
            return {}
        candidate, score = best_file.read_text(encoding="utf-8"), server.best_score
    if not isinstance(score, int | float) or not math.isfinite(score):
        return {}
    if task.has_dataset:
        candidate_id = server._candidate_registry.get(candidate)
        supported = candidate_id is not None and any(
            entry.get("candidate_id") == candidate_id and entry.get("val_score") == score
            for entry in server.progress_log
        )
    else:
        supported = _has_evaluated_single_result(server, output_dir, candidate, score)
    if not supported:
        return {}
    return {
        "best_candidate": candidate,
        "best_score": score,
        "total_evals": server.budget.used,
        "metadata": {"selection_source": "upstream_published_incumbent"},
    }


def execute(payload: dict[str, Any]) -> dict[str, Any]:
    """Run the exact upstream engine and capture its result and histories.

    Args:
        payload: Parent configuration, task and evaluator framing token.

    Returns:
        Result envelope, or a failure envelope retaining available usage.
    """
    if payload.get("engine_id") not in ("meta_harness", "autoresearch"):
        raise ValueError("Unsupported native optimizer.")
    if payload.get("task", {}).get("test_set") is not None:
        raise ValueError("Held-out examples must not enter the native optimizer.")
    task = Task(**payload["task"])
    config_values: dict[str, Any] = {"model": payload["model"]}
    if payload["engine_id"] == "meta_harness" and payload.get("max_iterations") is not None:
        config_values["max_iterations"] = payload["max_iterations"]
    output_dir = Path("upstream-artifacts").resolve()
    config = OptimizeAnythingConfig(
        engine=payload["engine_id"],
        max_token_cost=payload["max_token_cost"],
        max_evals=payload.get("max_evals"),
        max_concurrency=payload.get("max_concurrency", 1),
        run_dir=str(Path("engine-work").resolve()),
        output_dir=output_dir,
        stop_at_score=payload.get("stop_at_score"),
        sandbox=bool(payload["sandbox"]),
        engine_config=config_values,
    )
    mailbox = EvaluatorMailbox(payload["nonce"], float(payload["timeout_seconds"]))
    server = ProgressEvalServer(task, mailbox, config, output_dir)
    engine = get_engine_cls(payload["engine_id"])(config)
    document: dict[str, Any] = {}
    finished = threading.Event()

    def optimize() -> None:
        """Run upstream on a supervised thread so evaluator failures cannot spawn retries."""
        try:
            result = engine.run(task, server)
            engine.process_result(result, output_dir)
            document.update(
                {
                    "best_candidate": result.best_candidate,
                    "best_score": result.best_score,
                    "total_evals": server.budget.used,
                    "metadata": result.metadata,
                }
            )
        except (Exception, EvaluationStopped) as exc:
            document["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            finished.set()

    server.start()
    worker = threading.Thread(target=optimize, daemon=True)
    worker.start()
    timeout = float(payload["timeout_seconds"])
    deadline = time.monotonic() + max(0.1, timeout - min(10.0, timeout * 0.1))
    try:
        while not finished.wait(0.05):
            if mailbox.stopped.is_set() or time.monotonic() >= deadline:
                document["error"] = str(mailbox.error or "Native optimizer exceeded its runtime limit.")
                mailbox.stopped.set()
                _stop_children()
                worker.join(timeout=1.0)
                break
        if mailbox.error is not None:
            document["error"] = str(mailbox.error)
    finally:
        server.stop()
    if isinstance(mailbox.error, BudgetStopped):
        document.pop("error", None)
        document.pop("best_candidate", None)
        document.pop("best_score", None)
        document["stop_reason"] = "budget_reached"
        document.update(_budget_incumbent(payload["engine_id"], engine, task, server, output_dir))
    if document.get("error"):
        document["interrupted_incumbent"] = _budget_incumbent(payload["engine_id"], engine, task, server, output_dir)
    best_score = document.get("best_score")
    if (
        not document.get("error")
        and not task.has_dataset
        and isinstance(best_score, int | float)
        and math.isfinite(best_score)
        and not _has_evaluated_single_result(server, output_dir, document.get("best_candidate"), best_score)
    ):
        document["error"] = (
            "Upstream result fidelity check failed: the selected candidate and score were not evaluated together."
        )
    paths = [("upstream", output_dir), ("work", Path(config.run_dir)), ("sessions", Path.home() / ".claude/projects")]
    pending = getattr(engine, "_pending_tempdir", None)
    if pending is not None:
        paths.append(("interrupted-work", Path(pending.name)))
    document["usage_by_model"] = collect_usage([path for _, path in paths], payload["model"])
    metadata = document.get("metadata", {})
    had_session = bool(metadata.get("session_id") or metadata.get("session_ids"))
    document["usage_complete"] = bool(document["usage_by_model"]) or (not had_session and not document.get("error"))
    try:
        _archive_artifacts(paths)
    except Exception as exc:
        document["error"] = f"Could not preserve native artifacts: {exc}"
    return _json_finite(document)


def main() -> int:
    """Run one native engine invocation from its JSON input file.

    Returns:
        Zero for a completed run, one for a persisted failure envelope.
    """
    try:
        payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        result = execute(payload)
    except Exception as exc:
        result = {"error": f"{type(exc).__name__}: {exc}", "usage_by_model": {}, "usage_complete": False}
    Path("native_result.json").write_text(json.dumps(result, default=str, allow_nan=False), encoding="utf-8")
    return 1 if result.get("error") else 0


if __name__ == "__main__":
    raise SystemExit(main())
