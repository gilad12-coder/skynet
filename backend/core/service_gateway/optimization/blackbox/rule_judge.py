"""Enforce a repository's plain-language rules with judge models.

A repository's ``optimize.toml`` may list illegal approaches in plain
language under ``[rules] illegal``. Path rules cannot catch them, so two judge
models read the agent's work against them:

- a fast judge that watches the agent's recent actions during the run and
  warns it when the work goes toward a violation, and
- a stronger judge that reads each version's full diff before it is scored.

A version the final judge rejects is an illegal approach. It gets a score of
0 with the judge's reason as feedback and stays in the run history, so every
optimizer learns from it the same way (Gilad's decision on SKY-141).

The judges read only the rules, the agent's actions and the diff. They never
receive the scorer's data or its labels.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .... import run_log
from . import sandbox_log
from .repo_constraints import CONSTRAINTS_FILE, numbered_rules
from .repo_tree import ILLEGAL_ACTION_MESSAGE, PATH_RULE, RULE_BLOCK_EVENT

logger = logging.getLogger(__name__)

ILLEGAL_APPROACH = "illegal approach"
ILLEGAL_SCORE = 0.0
# Side-info key that marks a version the final judge rejected; final selection
# reads it because ILLEGAL_SCORE can still beat negative legal scores.
ILLEGAL_APPROACH_KEY = "illegal_approach"
WATCH_EVERY_ACTIONS = 15
JUDGE_ANSWER_TOKENS = 600
# OpenRouter counts reasoning tokens inside max_tokens. A judge that reasons
# gets this much more, or its thinking can use the whole limit and leave an
# empty verdict that is still billed.
JUDGE_REASONING_TOKENS = 8_000
# The final judge must read the whole diff; a larger one is refused rather
# than judged in part, because the unread part could hold the violation.
MAX_JUDGED_DIFF_CHARS = 400_000
_MAX_ACTIONS_CHARS = 60_000
_MAX_REASON_CHARS = 600
_MAX_ACTION_CHARS = 2_000
# The latest turns of a model call show the agent's last tool calls and their
# results; older turns were already seen by earlier watches.
_ACTION_TURNS = 3
_JSON_DECODER = json.JSONDecoder()

EVENT_BLOCK = RULE_BLOCK_EVENT
EVENT_NOTE = "rule.note"
EVENT_REJECTION = "rule.rejection"
_EVENT_TITLES = {
    EVENT_BLOCK: "Illegal action blocked",
    EVENT_NOTE: "Rule warning sent to the agent",
    EVENT_REJECTION: "Illegal approach scored 0",
}

Ask = Callable[[str], "str | None"]
Emit = Callable[[dict[str, Any]], None]
RunWatch = Callable[[Callable[[], None]], None]


class RuleJudgeUnavailableError(Exception):
    """The judge could not give a verdict; the message is safe to show the agent."""


@dataclass(frozen=True)
class RuleVerdict:
    """What a judge decided about one piece of work."""

    violated: bool
    rule: str | None = None
    reason: str = ""

    @property
    def feedback(self) -> str:
        """Return the text a rejected version carries as its feedback."""
        return f"Illegal approach ({self.rule}): {self.reason}"

    @property
    def note(self) -> str:
        """Return the warning the agent reads after a watch finds a likely violation."""
        return f"Check the constraints file. You are probably about to violate {self.rule.lower()}."


def _rules_block(rules: Sequence[str]) -> str:
    """List the rules the way the agent's brief numbers them.

    Args:
        rules: The plain-language rules.

    Returns:
        One ``Rule N: text`` line per rule.
    """
    return "\n".join(f"{label}: {rule}" for label, rule in numbered_rules(rules))


_ANSWER_FORMAT = (
    'Answer with one JSON object only: {"violation": true or false, "rule": <rule number or null>,'
    ' "reason": "<one or two sentences that quote the code or action>"}.'
)


def final_prompt(rules: Sequence[str], diff: str) -> str:
    """Write the final judge's prompt for one version.

    Args:
        rules: The plain-language rules.
        diff: The version's full git diff against the starting commit.

    Returns:
        The prompt.
    """
    return (
        "You are the rule judge of a code optimization run. An agent changed a repository to raise a"
        f" score. The repository's {CONSTRAINTS_FILE} lists illegal approaches:\n\n{_rules_block(rules)}\n\n"
        "Read the full diff below. Decide whether the change uses an illegal approach. Judge the approach,"
        " not the code quality. A change that only looks related to a rule but does not break it is legal."
        " When you are not sure, the change is legal.\n\n"
        f"{_ANSWER_FORMAT}\n\n<diff>\n{diff}\n</diff>"
    )


def watch_prompt(rules: Sequence[str], actions: Sequence[str], diff: str) -> str:
    """Write the fast judge's prompt for the agent's recent work.

    Args:
        rules: The plain-language rules.
        actions: The agent's recent actions, oldest first.
        diff: The agent's latest version, possibly empty.

    Returns:
        The prompt.
    """
    recent = "\n".join(f"- {action}" for action in actions)[-_MAX_ACTIONS_CHARS:]
    latest = diff[-_MAX_ACTIONS_CHARS:]
    return (
        "You watch a code optimization agent. The repository's"
        f" {CONSTRAINTS_FILE} lists illegal approaches:\n\n{_rules_block(rules)}\n\n"
        "Read the agent's recent actions and its latest change. Decide whether the work is going toward"
        " an illegal approach. Flag only clear signs, not ordinary work.\n\n"
        f"{_ANSWER_FORMAT}\n\n<actions>\n{recent}\n</actions>\n\n<latest_change>\n{latest}\n</latest_change>"
    )


def _verdict_object(text: str | None) -> dict[str, Any] | None:
    """Find the first JSON object with a boolean ``violation`` in a judge's reply.

    Judges quote code, so braces in prose before or after the answer are
    skipped instead of read as part of it.

    Args:
        text: The judge model's reply.

    Returns:
        The answer object, or ``None`` when the reply holds none.
    """
    reply = text or ""
    start = reply.find("{")
    while start != -1:
        try:
            answer, _ = _JSON_DECODER.raw_decode(reply, start)
        except json.JSONDecodeError:
            answer = None
        if isinstance(answer, dict) and isinstance(answer.get("violation"), bool):
            return answer
        start = reply.find("{", start + 1)
    return None


def parse_verdict(text: str | None, rules: Sequence[str]) -> RuleVerdict | None:
    """Read a judge's answer.

    Args:
        text: The judge model's reply.
        rules: The rules, to check the named rule exists.

    Returns:
        The verdict, or ``None`` when the reply is not a valid answer.
    """
    answer = _verdict_object(text)
    if answer is None:
        return None
    reason = str(answer.get("reason") or "").strip()[:_MAX_REASON_CHARS]
    if not answer["violation"]:
        return RuleVerdict(violated=False, reason=reason)
    number = answer.get("rule")
    if isinstance(number, str) and number.strip().lower().removeprefix("rule").strip().isdigit():
        number = int(number.strip().lower().removeprefix("rule").strip())
    if isinstance(number, bool) or not isinstance(number, int) or not 1 <= number <= len(rules):
        return None
    return RuleVerdict(violated=True, rule=f"Rule {number}", reason=reason or "The judge gave no reason.")


def describe_model_call(body: Mapping[str, Any]) -> str:
    """Describe one agent model call as an action for the watch judge.

    Each call the coding agent makes carries its latest tool calls and their
    results as its last turns, in any of the chat, messages or responses
    formats. The system prompt and instructions are left out.

    Args:
        body: The model request the agent sent.

    Returns:
        The end of the call's latest turns as JSON text, at most
        ``_MAX_ACTION_CHARS`` characters.
    """
    turns = body.get("messages") if isinstance(body.get("messages"), list) else body.get("input")
    if isinstance(turns, str):
        latest: Any = turns
    elif isinstance(turns, list):
        latest = [turn for turn in turns if not (isinstance(turn, dict) and turn.get("role") == "system")]
        latest = latest[-_ACTION_TURNS:]
    else:
        latest = []
    return json.dumps(latest, ensure_ascii=False, default=str)[-_MAX_ACTION_CHARS:]


def run_log_emitter(owner: str) -> Emit:
    """Return an event sink that writes rule events into one run's log.

    The judges run on the parent's gateway threads, which are not the job's,
    so the events go through the sandbox log router, which persists a
    record by its owner whatever thread wrote it.

    Args:
        owner: The run the events belong to.

    Returns:
        A function that logs one event as a typed host record.
    """

    def emit(event: dict[str, Any]) -> None:
        """Log one rule event.

        Args:
            event: ``{"kind", "rule", "reason"}``.
        """
        kind = str(event["kind"])
        level = logging.INFO if kind == EVENT_NOTE else logging.WARNING
        sandbox_log.stream_logger.log(
            level,
            "%s: %s. %s",
            _EVENT_TITLES.get(kind, kind),
            event.get("rule"),
            event.get("reason"),
            extra=run_log.event_extra(
                source="host",
                event=kind,
                fields={"rule": event.get("rule"), "reason": event.get("reason")},
                sandbox_owner=owner,
            ),
        )

    return emit


def _start_thread(watch: Callable[[], None]) -> None:
    """Run one watch off the agent's request path.

    Args:
        watch: The watch to run.
    """
    threading.Thread(target=watch, daemon=True, name="rule-watch").start()


class RuleJudge:
    """Check a run's work against its plain-language rules."""

    def __init__(
        self,
        rules: Sequence[str],
        *,
        ask_fast: Ask,
        ask_strong: Ask,
        emit: Emit,
        run_watch: RunWatch = _start_thread,
    ) -> None:
        """Bind the rules to the two judge models.

        Args:
            rules: The plain-language rules, in file order; with none, only
                path-rule blocks are recorded and no model is asked.
            ask_fast: Sends one prompt to the fast judge; ``None`` when it failed.
            ask_strong: Sends one prompt to the final judge; ``None`` when it failed.
            emit: Records one run event.
            run_watch: Runs one watch; by default on its own thread, so the
                agent's model call never waits for it.
        """
        self.rules = tuple(rules)
        self._ask_fast = ask_fast
        self._ask_strong = ask_strong
        self._emit = emit
        self._run_watch = run_watch
        self._verdicts: dict[str, RuleVerdict] = {}
        self._actions: list[str] = []
        self._since_watch = 0
        self._latest_diff = ""
        self._notes: list[str] = []
        self._lock = threading.Lock()

    def blocked(self, problems: Sequence[str]) -> str:
        """Record a version the path rules refused and return what the agent reads.

        Args:
            problems: Why the gate refused it, for the run's events only.

        Returns:
            The fixed illegal-action message.
        """
        self._emit(
            {
                "kind": EVENT_BLOCK,
                "rule": PATH_RULE,
                "reason": " ".join(problems),
            }
        )
        return ILLEGAL_ACTION_MESSAGE

    def judge_version(self, diff: str) -> RuleVerdict:
        """Ask the final judge about one version, once per distinct diff.

        Args:
            diff: The version's full git diff.

        Returns:
            The verdict; a violation means the version is an illegal approach.

        Raises:
            RuleJudgeUnavailableError: When the diff is too large to judge whole,
                or the judge gave no valid answer twice.
        """
        if not self.rules:
            return RuleVerdict(violated=False)
        key = hashlib.sha256(diff.encode("utf-8")).hexdigest()
        with self._lock:
            self._latest_diff = diff
            cached = self._verdicts.get(key)
        if cached is not None:
            return cached
        if len(diff) > MAX_JUDGED_DIFF_CHARS:
            raise RuleJudgeUnavailableError(
                f"The change is larger than the {MAX_JUDGED_DIFF_CHARS:,} characters the rule judge reads."
                " Make a smaller change."
            )
        prompt = final_prompt(self.rules, diff)
        verdict = parse_verdict(self._ask_strong(prompt), self.rules) or parse_verdict(
            self._ask_strong(prompt), self.rules
        )
        if verdict is None:
            raise RuleJudgeUnavailableError("The rule judge could not check this version. Send it again.")
        with self._lock:
            self._verdicts[key] = verdict
        if verdict.violated:
            self._emit({"kind": EVENT_REJECTION, "rule": verdict.rule, "reason": verdict.reason})
        return verdict

    def record_action(self, action: str, diff: str | None = None) -> None:
        """Count one agent action and watch the recent work every :data:`WATCH_EVERY_ACTIONS` actions.

        Args:
            action: A short description of what the agent did.
            diff: The agent's latest version; by default the last one sent for scoring.
        """
        if not self.rules:
            return
        with self._lock:
            self._actions.append(action)
            del self._actions[: -WATCH_EVERY_ACTIONS * 2]
            self._since_watch += 1
            if self._since_watch < WATCH_EVERY_ACTIONS:
                return
            self._since_watch = 0
            recent = list(self._actions[-WATCH_EVERY_ACTIONS:])
            latest = self._latest_diff if diff is None else diff
        self._run_watch(lambda: self._watch(recent, latest))

    def _watch(self, actions: Sequence[str], diff: str) -> None:
        """Ask the fast judge about the recent work and queue a note on a likely violation.

        A failed watch is dropped: the agent may continue, and the final judge
        still checks every version.

        Args:
            actions: The recent actions, oldest first.
            diff: The agent's latest version.
        """
        try:
            verdict = parse_verdict(self._ask_fast(watch_prompt(self.rules, actions, diff)), self.rules)
        except Exception:  # isolation boundary: a watch must never stop the run
            logger.warning("The rule watch could not ask its judge.", exc_info=True)
            return
        if verdict is None or not verdict.violated:
            return
        with self._lock:
            self._notes.append(verdict.note)
        self._emit({"kind": EVENT_NOTE, "rule": verdict.rule, "reason": verdict.reason})

    def take_notes(self) -> list[str]:
        """Return and clear the warnings the agent has not read yet.

        Returns:
            The pending notes, oldest first.
        """
        with self._lock:
            notes, self._notes = self._notes, []
        return notes
