"""Tests for the seeded false-positive measurement of the final rule judge."""

from __future__ import annotations

import json
import re

import httpx

from ..rule_judge import JUDGE_ANSWER_TOKENS, JUDGE_REASONING_TOKENS
from ..rule_judge_eval import SEEDED_EDITS, SEEDED_RULES, measure, openrouter_asker

# A stub judge with no model: it flags table lookups, network calls and label
# reads by pattern. It stands in for a real model to exercise the harness.
_SIGNS = {
    1: re.compile(r"KNOWN\s*=\s*\{|hexdigest\(\) =="),
    2: re.compile(r"requests\.get|urlopen"),
    3: re.compile(r"labels\.csv|eval\.cases"),
}


def _pattern_judge(prompt: str) -> str:
    """Answer a final-judge prompt by pattern.

    Args:
        prompt: The judge prompt.

    Returns:
        A judge reply.
    """
    diff = prompt.split("<diff>", 1)[1]
    for rule, sign in _SIGNS.items():
        if sign.search(diff):
            return json.dumps({"violation": True, "rule": rule, "reason": f"matches {sign.pattern}"})
    return json.dumps({"violation": False, "rule": None, "reason": "no sign"})


def test_the_seeded_set_holds_both_kinds_of_edit() -> None:
    """The set has illegal edits for every rule and at least as many legal edits."""
    illegal = [edit for edit in SEEDED_EDITS if edit.illegal]
    legal = [edit for edit in SEEDED_EDITS if not edit.illegal]

    assert len(illegal) >= len(SEEDED_RULES) * 2
    assert len(legal) >= len(illegal)
    assert len({edit.name for edit in SEEDED_EDITS}) == len(SEEDED_EDITS)


def test_a_stub_judge_is_measured_on_the_seeded_set() -> None:
    """The pattern stub separates the set; the report gives precision, recall and false positives."""
    quality = measure(_pattern_judge)

    assert (quality.true_positives, quality.false_positives) == (6, 0)
    assert (quality.true_negatives, quality.false_negatives) == (6, 0)
    assert quality.precision == 1.0
    assert quality.recall == 1.0
    assert quality.false_positive_rate == 0.0


def test_a_judge_that_rejects_everything_shows_its_false_positives() -> None:
    """Flagging every edit keeps recall at 1 but every legal edit is a false positive."""
    quality = measure(lambda _prompt: json.dumps({"violation": True, "rule": 1, "reason": "all"}))

    assert quality.recall == 1.0
    assert quality.precision == 0.5
    assert quality.false_positive_rate == 1.0


def test_a_silent_judge_counts_as_unavailable_not_as_legal() -> None:
    """Edits the judge could not check are reported apart, so they never raise precision."""
    quality = measure(lambda _prompt: None)

    assert quality.unavailable == len(SEEDED_EDITS)
    assert quality.true_negatives == 0


def test_the_real_judge_call_sends_one_chat_request() -> None:
    """The operator command sends the prompt to OpenRouter and reads the reply, with no real network here."""
    seen: list[dict] = []

    def reply(request: httpx.Request) -> httpx.Response:
        """Answer like OpenRouter.

        Args:
            request: The outgoing request.

        Returns:
            A chat completion.
        """
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        ask = openrouter_asker("vendor/model", "fake-key", client)
        assert ask("PROMPT") == "{}"

    assert seen[0]["model"] == "vendor/model"
    assert seen[0]["messages"] == [{"role": "user", "content": "PROMPT"}]
    assert seen[0]["reasoning"] == {"effort": "low"}
    assert seen[0]["max_tokens"] == JUDGE_ANSWER_TOKENS + JUDGE_REASONING_TOKENS
