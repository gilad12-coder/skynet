"""Score repository versions in the trusted parent's box, where the run's secrets live.

The guest that hosts the coding agent never sees the secrets or this box: it
posts each version through the parent's evaluator capability, and the parent
lays it out on a copy of the already set-up tree, then calls the user's
``score(repo_path)`` (or ``score(repo_path, case)``) on it.

A scorer returns a score with its feedback, like any scorer, and may return
per-case results under ``cases``, a mapping of case name to
``{"score", "feedback"}``. The run's score stays the top-level number; each
case becomes a named score that every engine reflects on and keeps on its
Pareto front.
"""

from __future__ import annotations

import json
import math
import shlex
import threading
from collections.abc import Mapping
from typing import Any

from ....billing.model_dispatch import ModelHTTPResult
from . import runner, sandbox_log
from .repo_workspace import REPO_DIR, RepoWorkspace, redact
from .sandbox import SandboxSession
from .sandbox_scorer import RUNNER_SOURCE

CASES_KEY = "cases"
# The guest names no real endpoint: its requests reach only the parent relay.
REPO_SCORER_URL = "https://scoped-evaluator.invalid/score"
RUNNER_PATH = f"{REPO_DIR}/skynet_runner.py"
CALLS_DIR = f"{REPO_DIR}/calls"
# The guest waits for the version's checkout and the scorer together; copying a
# prepared tree with its installed dependencies can take a while, so its relay
# gets an allowance on top of the scorer's own timeout.
SETUP_ALLOWANCE_SECONDS = 1_800.0


class RepoScoreError(Exception):
    """A version could not be scored; the message is safe to show the agent."""


def fold_case_scores(side_info: Mapping[str, Any]) -> dict[str, Any]:
    """Turn the per-case scores a repository scorer returned into named scores.

    Each case becomes a named score, so every engine reflects on it and
    treats it as its own objective, exactly like ``scores``.

    Args:
        side_info: Everything the scorer returned besides its score.

    Returns:
        The side info with ``cases`` folded into ``scores``.

    Raises:
        RepoScoreError: When ``cases`` is not a mapping of names to a finite
            score with its feedback.
    """
    folded = dict(side_info)
    cases = folded.pop(CASES_KEY, None)
    if cases is None:
        return folded
    try:
        named = runner.named_scores(cases)
    except runner.ScorerError as exc:
        raise RepoScoreError(f"'{CASES_KEY}' must map each case name to a score and feedback. {exc}") from exc
    if not all(math.isfinite(entry["score"]) for entry in named.values()):
        raise RepoScoreError(f"'{CASES_KEY}' must map each case name to a finite score.")
    folded["scores"] = {**named, **(folded.get("scores") or {})}
    return folded


class RepoScorer:
    """Score one repository version at a time in the parent's workspace box."""

    def __init__(self, workspace: RepoWorkspace, code: str, *, timeout_seconds: float) -> None:
        """Bind the user's scorer code to a repository workspace.

        Args:
            workspace: Parent-owned box holding the pristine tree.
            code: Scorer source defining ``score(repo_path)`` or ``score(repo_path, case)``.
            timeout_seconds: Longest one scorer call may run, setup excluded.
        """
        self._workspace = workspace
        self._code = code
        self._timeout_seconds = timeout_seconds
        self._root: str | None = None
        self._calls = 0
        self._lock = threading.Lock()

    def score(self, patch: str, case: Any = None) -> dict[str, Any]:
        """Check out one version and score it.

        Args:
            patch: The version as a git patch against the starting commit.
            case: The case to score it on, when the run has cases.

        Returns:
            ``{"score": ..., **side_info}``, secrets redacted.

        Raises:
            RepoScoreError: When the version breaks the path rules or does not
                apply, or the scorer fails or returns no score.
        """
        secrets = list(self._workspace.secrets.values())
        # Checkout and scoring share one lock: the next version's checkout
        # replaces the tree this one is scored on.
        with self._lock:
            checkout = self._workspace.checkout(patch)
            if checkout.path is None:
                raise RepoScoreError(" ".join(checkout.problems))
            session = self._workspace.session()
            root = self._box_root(session)
            self._calls += 1
            call_dir = f"{root}/{CALLS_DIR}/{self._calls:06d}"
            session.write_files(
                {
                    f"{CALLS_DIR}/{self._calls:06d}/{runner.INPUT_FILE}": json.dumps(
                        {"code": self._code, "candidate": f"{root}/{checkout.path}", "case": case, "gateway": None}
                    )
                }
            )
            # A sink makes the session stream stderr live, which is where log() events travel.
            with sandbox_log.event_scope(source="scorer"):
                result = session.run(
                    f"cd {shlex.quote(checkout.path)} && python3 {shlex.quote(f'{root}/{RUNNER_PATH}')}"
                    f" {shlex.quote(call_dir)}",
                    env=self._workspace.secrets or None,
                    timeout_seconds=self._timeout_seconds,
                    on_output=sandbox_log.ignore_output,
                )
            if result.timed_out:
                raise RepoScoreError(f"The scorer exceeded its {self._timeout_seconds:g}s timeout.")
            text = session.read_file(f"{CALLS_DIR}/{self._calls:06d}/{runner.OUTPUT_FILE}")
        if text is None:
            output = redact((result.stderr or result.stdout)[-2_000:], secrets)
            raise RepoScoreError(f"The scorer did not finish (exit {result.exit_code}): {output}")
        output = json.loads(redact(text, secrets))
        if output.get("error") or output.get("score") is None:
            raise RepoScoreError(str(output.get("error") or "The scorer returned no score."))
        side_info = fold_case_scores(output.get("side_info") or {})
        return {**side_info, "score": float(output["score"])}

    def prepare(self) -> None:
        """Set the repository up and take its box offline before any version is sent.

        Raises:
            RepoSetupError: When the repository cannot be unpacked or set up.
            NetworkCutoffError: When the box's network cannot be switched off and confirmed.
        """
        with self._lock:
            self._workspace.session()

    def dispatch(self, body: Mapping[str, Any]) -> ModelHTTPResult:
        """Answer one guest scoring request through the evaluator capability.

        Args:
            body: ``{"candidate": <patch>, "case": ...}`` from the guest.

        Returns:
            200 with the score and side information, or 422 with why the
            version could not be scored, as text.

        Raises:
            ValueError: When the body is not a patch and an optional case.
        """
        candidate = body.get("candidate")
        if set(body).difference({"candidate", "case"}) or not isinstance(candidate, str):
            raise ValueError("A repository version must be sent as a patch and an optional case.")
        try:
            document = self.score(candidate, body.get("case"))
        except RepoScoreError as error:
            # Plain text: the guest's relay client quotes the body in its error.
            return ModelHTTPResult(422, "text/plain; charset=utf-8", str(error).encode())
        return ModelHTTPResult(200, "application/json", json.dumps(document).encode())

    def _box_root(self, session: SandboxSession) -> str:
        """Return the box's working directory, installing the runner on first use.

        Args:
            session: The workspace's open box.

        Returns:
            The absolute directory relative paths in the box resolve against.

        Raises:
            RepoScoreError: When the box cannot report its directory.
        """
        if self._root is None:
            located = session.run("pwd", timeout_seconds=30)
            root = located.stdout.strip()
            if not located.ok or not root.startswith("/"):
                raise RepoScoreError("The scoring box could not report its working directory.")
            session.write_files({RUNNER_PATH: RUNNER_SOURCE})
            self._root = root
        return self._root

    def close(self) -> None:
        """Destroy the workspace box."""
        self._workspace.close()
