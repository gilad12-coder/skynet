"""Tests for the plain-language rule judges."""

from __future__ import annotations

import json
import logging
import threading
from typing import Any

import pytest

from core import run_log

from ..rule_judge import (
    EVENT_BLOCK,
    EVENT_NOTE,
    EVENT_REJECTION,
    ILLEGAL_ACTION_MESSAGE,
    MAX_JUDGED_DIFF_CHARS,
    WATCH_EVERY_ACTIONS,
    RuleJudge,
    RuleJudgeUnavailableError,
    describe_model_call,
    final_prompt,
    parse_verdict,
    run_log_emitter,
    watch_prompt,
)

_RULES = ("Do not hardcode answers for dataset cases.", "Do not call an outside geocoding service.")


class _Judge:
    """Answer judge prompts with fixed replies and remember every prompt."""

    def __init__(self, *replies: str | None) -> None:
        """Queue the replies, the last one repeating.

        Args:
            replies: Model replies in order.
        """
        self.replies = list(replies)
        self.prompts: list[str] = []

    def __call__(self, prompt: str) -> str | None:
        """Return the next reply.

        Args:
            prompt: The judge prompt.

        Returns:
            The queued reply.
        """
        self.prompts.append(prompt)
        return self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]


def _answer(violation: bool, rule: Any = None, reason: str = "") -> str:
    """Write a judge reply.

    Args:
        violation: Whether a rule is broken.
        rule: The rule number.
        reason: The judge's reason.

    Returns:
        The reply text.
    """
    return json.dumps({"violation": violation, "rule": rule, "reason": reason})


def _judge(fast: _Judge | None = None, strong: _Judge | None = None) -> tuple[RuleJudge, list[dict[str, Any]]]:
    """Build a judge whose events are collected.

    Args:
        fast: The fast judge stub.
        strong: The final judge stub.

    Returns:
        The judge and its event list.
    """
    events: list[dict[str, Any]] = []
    judge = RuleJudge(
        _RULES,
        ask_fast=fast or _Judge(_answer(False)),
        ask_strong=strong or _Judge(_answer(False)),
        emit=events.append,
        run_watch=lambda watch: watch(),
    )
    return judge, events


def test_a_blocked_version_gets_the_fixed_message_and_an_event_with_the_reason() -> None:
    """The agent reads only the fixed text; the run's events keep the path and the rule."""
    judge, events = _judge()

    message = judge.blocked(["'data/labels.csv' is protected by the repository's optimize.toml ([paths] protected)."])

    assert message == (
        "Illegal action. Read the constraints file. You cannot do this action. Do not repeat it,"
        " because it wastes time."
    )
    assert message == ILLEGAL_ACTION_MESSAGE
    assert events == [
        {
            "kind": EVENT_BLOCK,
            "rule": "optimize.toml [paths]",
            "reason": "'data/labels.csv' is protected by the repository's optimize.toml ([paths] protected).",
        }
    ]


def test_the_final_judge_rejects_a_violating_diff_once_and_records_the_rule() -> None:
    """A violating diff becomes an illegal approach with the reason, judged once however often it is scored."""
    strong = _Judge(_answer(True, 1, "It maps each dataset sentence to its expected coordinates."))
    judge, events = _judge(strong=strong)

    first = judge.judge_version("diff --git a/bot.py b/bot.py\n+ANSWERS = {'Meet at the pier': (1, 2)}\n")
    second = judge.judge_version("diff --git a/bot.py b/bot.py\n+ANSWERS = {'Meet at the pier': (1, 2)}\n")

    assert first.violated
    assert first is second
    assert first.rule == "Rule 1"
    assert first.feedback == "Illegal approach (Rule 1): It maps each dataset sentence to its expected coordinates."
    assert len(strong.prompts) == 1
    assert "Rule 1: Do not hardcode answers for dataset cases." in strong.prompts[0]
    assert "ANSWERS" in strong.prompts[0]
    assert events == [
        {
            "kind": EVENT_REJECTION,
            "rule": "Rule 1",
            "reason": "It maps each dataset sentence to its expected coordinates.",
        }
    ]


def test_a_legal_diff_passes_without_an_event() -> None:
    """A legal version is scored normally and leaves no rule event."""
    judge, events = _judge(strong=_Judge(_answer(False, None, "Normalizes whitespace.")))

    assert not judge.judge_version("diff --git a/bot.py b/bot.py\n+text = text.strip()\n").violated
    assert events == []


def test_the_final_judge_retries_once_then_refuses_to_guess() -> None:
    """An unreadable answer is asked again; two failures leave the version unscored, never scored 0."""
    recovered = _Judge("not json", _answer(False))
    judge, _ = _judge(strong=recovered)
    assert not judge.judge_version("diff").violated
    assert len(recovered.prompts) == 2

    judge, events = _judge(strong=_Judge(None))
    with pytest.raises(RuleJudgeUnavailableError, match="could not check this version"):
        judge.judge_version("diff")
    assert events == []


def test_a_diff_too_large_to_read_whole_is_refused() -> None:
    """The unread part of a diff could hold the violation, so it is not judged in part."""
    strong = _Judge(_answer(False))
    judge, _ = _judge(strong=strong)

    with pytest.raises(RuleJudgeUnavailableError, match="larger than"):
        judge.judge_version("+" * (MAX_JUDGED_DIFF_CHARS + 1))
    assert strong.prompts == []


def test_the_fast_judge_watches_every_fifteen_actions_and_leaves_one_note() -> None:
    """The watch runs on the 15th action and its warning names the rule for the agent."""
    fast = _Judge(_answer(True, 2, "The agent is reading the docs of a hosted geocoding API."))
    judge, events = _judge(fast=fast)

    for index in range(WATCH_EVERY_ACTIONS - 1):
        judge.record_action(f"read file {index}")
    assert fast.prompts == []
    judge.record_action("curl https://geocode.example/api", diff="+import requests\n")

    assert len(fast.prompts) == 1
    assert "curl https://geocode.example/api" in fast.prompts[0]
    assert "+import requests" in fast.prompts[0]
    assert judge.take_notes() == ["Check the constraints file. You are probably about to violate rule 2."]
    assert judge.take_notes() == []
    assert events == [
        {"kind": EVENT_NOTE, "rule": "Rule 2", "reason": "The agent is reading the docs of a hosted geocoding API."}
    ]
    for index in range(WATCH_EVERY_ACTIONS):
        judge.record_action(f"edit {index}")
    assert len(fast.prompts) == 2


def test_a_quiet_watch_leaves_no_note() -> None:
    """Ordinary work produces no warning and no event."""
    judge, events = _judge(fast=_Judge(_answer(False)))

    for index in range(WATCH_EVERY_ACTIONS):
        judge.record_action(f"edit {index}")

    assert judge.take_notes() == []
    assert events == []


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        ('{"violation": false, "rule": null, "reason": "fine"}', (False, None)),
        ('Here: {"violation": true, "rule": 2, "reason": "calls an API"} done', (True, "Rule 2")),
        ('{"violation": true, "rule": "Rule 1", "reason": "table"}', (True, "Rule 1")),
        ('{"violation": true, "rule": 3, "reason": "no such rule"}', None),
        ('{"violation": true, "rule": true, "reason": "bool"}', None),
        ('{"violation": "yes", "rule": 1}', None),
        ('Rule {1} applies. `CACHE = {}` {"violation": true, "rule": 1, "reason": "x"}', (True, "Rule 1")),
        ('{"violation": false, "rule": null, "reason": "ok"} See `fn s() { k }` and {}.', (False, None)),
        ('{"violation": true, "rule": 2, "reason": "a"} {"violation": false, "reason": "b"}', (True, "Rule 2")),
        ('{"note": 1} {"violation": false, "reason": "b"}', (False, None)),
        ("{not json}", None),
        ("no verdict", None),
        (None, None),
    ],
)
def test_judge_answers_are_read_strictly(reply: str | None, expected: tuple[bool, str | None] | None) -> None:
    """Only a well-formed answer naming a real rule counts as a verdict."""
    verdict = parse_verdict(reply, _RULES)

    assert (None if verdict is None else (verdict.violated, verdict.rule)) == expected


def test_judge_prompts_hold_only_the_rules_the_actions_and_the_diff() -> None:
    """The prompts carry no scorer code, dataset or labels; only what the judge must read."""
    final = final_prompt(_RULES, "DIFF-BODY")
    watch = watch_prompt(_RULES, ["ACTION-ONE"], "LATEST-DIFF")

    assert "Rule 2: Do not call an outside geocoding service." in final
    assert "DIFF-BODY" in final
    assert "ACTION-ONE" in watch
    assert "LATEST-DIFF" in watch


def test_without_plain_language_rules_no_version_is_judged() -> None:
    """A constraints file with only path rules spends nothing on the final judge."""
    strong = _Judge(_answer(True, 1, "never asked"))
    judge = RuleJudge((), ask_fast=strong, ask_strong=strong, emit=lambda _event: None)

    assert not judge.judge_version("diff --git a/x b/x\n+x\n").violated
    for index in range(WATCH_EVERY_ACTIONS):
        judge.record_action(f"edit {index}")
    assert strong.prompts == []


def test_the_watch_reads_the_latest_version_sent_for_scoring() -> None:
    """Without a diff of its own, the watch reads the last version the final judge saw."""
    fast = _Judge(_answer(False))
    judge, _ = _judge(fast=fast)
    judge.judge_version("diff --git a/bot.py b/bot.py\n+LATEST = 1\n")

    for index in range(WATCH_EVERY_ACTIONS):
        judge.record_action(f"edit {index}")

    assert "+LATEST = 1" in fast.prompts[0]


def test_the_watch_runs_off_the_agent_path_and_a_failure_is_dropped() -> None:
    """By default the watch runs on its own thread, and a failed call leaves no note."""
    called = threading.Event()

    def broken(_prompt: str) -> str | None:
        """Fail like a refused model call.

        Args:
            _prompt: The judge prompt.

        Raises:
            RuntimeError: Always.
        """
        called.set()
        raise RuntimeError("budget reached")

    judge = RuleJudge(_RULES, ask_fast=broken, ask_strong=broken, emit=lambda _event: None)
    for index in range(WATCH_EVERY_ACTIONS):
        judge.record_action(f"edit {index}")

    assert called.wait(5)
    assert judge.take_notes() == []


@pytest.mark.parametrize(
    ("body", "expected", "absent"),
    [
        (
            {"messages": [{"role": "system", "content": "SYSTEM"}, {"role": "user", "content": "run tests"}]},
            "run tests",
            "SYSTEM",
        ),
        (
            {"system": "SYSTEM", "messages": [{"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}]},
            "tool_result",
            "SYSTEM",
        ),
        (
            {"instructions": "SYSTEM", "input": [{"type": "function_call", "name": "shell", "arguments": "ls"}]},
            "shell",
            "SYSTEM",
        ),
    ],
)
def test_a_model_call_is_described_by_its_latest_turns(body: dict[str, Any], expected: str, absent: str) -> None:
    """Each agent model call becomes one action: its latest turns, never its system prompt."""
    action = describe_model_call(body)

    assert expected in action
    assert absent not in action


def test_a_long_model_call_is_cut_to_its_end() -> None:
    """Only the end of a long turn is kept, so a watch prompt stays small."""
    action = describe_model_call({"messages": [{"role": "user", "content": "A" * 50_000 + "TAIL"}]})

    assert "TAIL" in action
    assert len(action) <= 2_000


def test_rule_events_reach_the_run_log(caplog: pytest.LogCaptureFixture) -> None:
    """Each event is a typed host record owned by the run, so the run log and its readers see it."""
    stream = logging.getLogger("core.service_gateway.optimization.blackbox.sandbox_log.stream")
    stream.addHandler(caplog.handler)
    try:
        run_log_emitter("run-1")({"kind": EVENT_REJECTION, "rule": "Rule 1", "reason": "A lookup table."})
    finally:
        stream.removeHandler(caplog.handler)

    (record,) = caplog.records
    assert record.sandbox_owner == "run-1"
    assert run_log.entry_fields(record)["event"] == EVENT_REJECTION
    assert run_log.entry_fields(record)["source"] == "host"
    assert "Rule 1" in record.getMessage()
    assert "A lookup table." in record.getMessage()
