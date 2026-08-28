"""Shared fakes for the black-box tests: a deterministic scorer and reflection LM."""

from __future__ import annotations

from typing import Any

from ..protocol import Candidate, EngineContext, EvalServer, Result, SideInfo, Task

VOWELS = "aeiou"

# Scorer source in the shape users submit; the in-process twin below keeps
# the engine tests free of the sandbox.
VOWEL_SCORER_CODE = """
def score(candidate, case=None):
    text = candidate if isinstance(candidate, str) else " ".join(candidate.values())
    vowels = sum(ch in "aeiou" for ch in text)
    return vowels / max(1, len(text)), {"vowels": vowels}
"""


def vowel_scorer(candidate: Candidate, case: Any = None) -> tuple[float, SideInfo]:
    """Score a candidate by its vowel density, ignoring the case.

    Args:
        candidate: Text or named parts.
        case: Ignored.

    Returns:
        Vowel density in ``[0, 1]`` and the raw vowel count.
    """
    text = candidate if isinstance(candidate, str) else " ".join(candidate.values())
    vowels = sum(ch in VOWELS for ch in text)
    return vowels / max(1, len(text)), {"vowels": vowels}


class FakeReflectionLM:
    """Stands in for ``dspy.LM``: every call proposes a vowel-denser text.

    Records ``history`` entries with a ``usage`` block so the service's
    token accounting has something to read.
    """

    def __init__(self, model: str = "fake/model", *, improving: bool = True) -> None:
        """Create the fake.

        Args:
            model: Model id reported to the usage helpers.
            improving: When False every proposal is vowel-free, so nothing
                ever beats a seed that has a vowel.
        """
        self.model = model
        self.improving = improving
        self.history: list[dict[str, Any]] = []
        self.prompts: list[str] = []

    def __call__(self, prompt: str, *args: Any, **kwargs: Any) -> list[str]:
        """Return one fenced completion, as the engines expect.

        Args:
            prompt: The engine's reflection prompt.
            *args: Ignored.
            **kwargs: Ignored.

        Returns:
            A single-element completion list.
        """
        self.prompts.append(prompt)
        self.history.append({"prompt": prompt, "usage": {"prompt_tokens": 10, "completion_tokens": 5}})
        text = ("aeiou " * len(self.history)).strip() if self.improving else "xyz"
        return [f"```\n{text}\n```"]


def make_ctx(run_dir: str, lm: FakeReflectionLM | None = None, **overrides: Any) -> EngineContext:
    """Build an ``EngineContext`` over a fake LM.

    Args:
        run_dir: Workspace for engine state.
        lm: The reflection LM fake; a fresh improving one when unset.
        **overrides: Extra ``EngineContext`` fields.

    Returns:
        The context.
    """
    lm = lm or FakeReflectionLM()
    return EngineContext(reflection_lm=lambda prompt: str(lm(prompt)[0]), run_dir=run_dir, **overrides)


class ScriptedEngine:
    """Engine that scores a fixed list of candidates, then returns the best or raises.

    Args:
        name: Catalog id to report.
        candidates: Versions to score through the server, in order.
        error: Exception to raise after scoring, if any.
    """

    def __init__(self, name: str, candidates: list[str], *, error: BaseException | None = None) -> None:
        """Create the engine."""
        self.name = name
        self._candidates = candidates
        self._error = error
        self.calls: list[Task] = []

    def run(self, task: Task, server: EvalServer, ctx: EngineContext) -> Result:
        """Score the scripted candidates and hand back the server's best.

        Args:
            task: Recorded on ``calls`` so tests can inspect the seed.
            server: Budgeted scorer for this lane.
            ctx: Ignored.

        Returns:
            The best candidate the server saw.

        Raises:
            BaseException: The configured ``error``, after scoring.
        """
        self.calls.append(task)
        for candidate in self._candidates:
            server.evaluate(candidate, None)
        if self._error is not None:
            raise self._error
        best = server.best_candidate
        assert best is not None
        return Result(best_candidate=best, best_score=server.best_score, total_evals=server.used)
