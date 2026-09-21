"""Reusable check builders for benchmark tasks.

Every builder returns a :class:`bench.task.Check`. Checks must be deterministic
and must accept any reasonable phrasing of a correct answer: match on the facts
(ids, names, numbers), never on wording.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from bench.task import Check, Run
from bench.world import MUTATING


def _subset(want: Any, got: Any) -> bool:
    """Return True when ``want`` is contained in ``got`` (recursive for dicts)."""
    if isinstance(want, dict):
        return isinstance(got, dict) and all(k in got and _subset(v, got[k]) for k, v in want.items())
    if callable(want):
        return bool(want(got))
    if isinstance(want, str) and isinstance(got, str):
        return want.strip().lower() == got.strip().lower()
    return want == got


def dig(data: Any, path: str) -> Any:
    """Follow a dotted ``path`` through nested dicts and lists; None when absent."""
    for part in path.split("."):
        if isinstance(data, dict):
            data = data.get(part)
        elif isinstance(data, list) and part.lstrip("-").isdigit() and -len(data) <= int(part) < len(data):
            data = data[int(part)]
        else:
            return None
    return data


def called(tool: str, name: str | None = None, **args: Any) -> Check:
    """Pass when a successful call to ``tool`` contains ``args`` as a subset.

    Arg values may be callables ``value -> bool`` for fuzzy matching; strings
    compare case-insensitively.
    """
    label = name or f"called {tool}" + (f" with {sorted(args)}" if args else "")
    return Check(label, lambda r: any(_subset(args, c["args"]) for c in r.ok_calls(tool)))


def called_any(tools: list[str], name: str | None = None) -> Check:
    """Pass when at least one of ``tools`` was called successfully."""
    return Check(name or f"called one of {tools}", lambda r: any(r.ok_calls(t) for t in tools))


def not_called(*tools: str, name: str | None = None) -> Check:
    """Pass when none of ``tools`` was attempted at all (failed attempts count)."""
    return Check(name or f"did not call {list(tools)}", lambda r: not any(c["tool"] in tools for c in r.calls))


def no_mutations(name: str = "changed nothing on the server") -> Check:
    """Pass when no state-mutating tool succeeded."""
    return Check(name, lambda r: not any(c["tool"] in MUTATING for c in r.ok_calls()))


def only_mutated(*tools: str, name: str | None = None) -> Check:
    """Pass when every successful mutating call used one of ``tools``."""
    return Check(
        name or f"mutated only via {list(tools)}",
        lambda r: all(c["tool"] in tools for c in r.ok_calls() if c["tool"] in MUTATING),
    )


def state_eq(path: str, value: Any, name: str | None = None) -> Check:
    """Pass when the final state at dotted ``path`` equals ``value`` (or satisfies it if callable)."""
    return Check(name or f"state {path} == {value!r}", lambda r: _subset(value, dig(r.state, path)))


def state_unchanged(path: str, name: str | None = None) -> Check:
    """Pass when the final state at ``path`` equals the initial state there."""
    return Check(name or f"state {path} unchanged", lambda r: dig(r.state, path) == dig(r.initial, path))


def state_check(name: str, fn: Callable[[dict[str, Any]], bool]) -> Check:
    """Pass when ``fn(final_state)`` is true."""
    return Check(name, lambda r: fn(r.state))


def _norm(text: str) -> str:
    """Lower-case and drop thousands separators so ``1,200`` matches ``1200``."""
    return re.sub(r"(?<=\d),(?=\d{3})", "", text.lower())


def answer_has(*needles: str, name: str | None = None) -> Check:
    """Pass when the final answer contains every needle (case-insensitive)."""
    return Check(
        name or f"answer mentions {list(needles)}", lambda r: all(_norm(n) in _norm(r.answer) for n in needles)
    )


def answer_has_any(*needles: str, name: str | None = None) -> Check:
    """Pass when the final answer contains at least one needle."""
    return Check(
        name or f"answer mentions one of {list(needles)}", lambda r: any(_norm(n) in _norm(r.answer) for n in needles)
    )


def answer_lacks(*needles: str, name: str | None = None) -> Check:
    """Pass when the final answer contains none of the needles."""
    return Check(
        name or f"answer omits {list(needles)}", lambda r: not any(_norm(n) in _norm(r.answer) for n in needles)
    )


def answer_regex(pattern: str, name: str | None = None) -> Check:
    """Pass when ``pattern`` matches the final answer (case-insensitive, dotall)."""
    return Check(
        name or f"answer matches /{pattern}/",
        lambda r: re.search(pattern, _norm(r.answer), re.IGNORECASE | re.DOTALL) is not None,
    )


def answer_number(value: float, tol: float = 0.0, percent_ok: bool = False, name: str | None = None) -> Check:
    """Pass when some number in the answer is within ``tol`` of ``value``.

    With ``percent_ok`` a fraction like 0.874 also matches when written 87.4.
    """

    def fn(r: Run) -> bool:
        numbers = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", _norm(r.answer))]
        targets = [value, value * 100] if percent_ok else [value]
        return any(abs(n - t) <= (tol * (100 if t != value else 1)) + 1e-9 for n in numbers for t in targets)

    return Check(name or f"answer states {value}", fn)


def answer_is_hebrew(name: str = "answered in Hebrew") -> Check:
    """Pass when Hebrew letters outnumber Latin letters in the final answer."""

    def fn(r: Run) -> bool:
        hebrew = len(re.findall(r"[֐-׿]", r.answer))
        latin = len(re.findall(r"[A-Za-z]", r.answer))
        return hebrew > 0 and hebrew >= latin * 0.5

    return Check(name, fn)


def max_calls(limit: int, name: str | None = None) -> Check:
    """Pass when the agent attempted at most ``limit`` tool calls."""
    return Check(name or f"used at most {limit} tool calls", lambda r: len(r.calls) <= limit)


def custom(name: str, fn: Callable[[Run], bool]) -> Check:
    """Wrap an arbitrary predicate over the run."""
    return Check(name, fn)
