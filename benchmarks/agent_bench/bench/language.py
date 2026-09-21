"""Report how often each harness answers in the wrong language.

The brief tells the agent to reply in the user's language, and several checks
read the answer in English, so a correct answer in the wrong language fails.
This report separates those failures from substantive ones.
"""

from __future__ import annotations

import argparse
import re
from collections import Counter, defaultdict
from pathlib import Path

from bench.report import load, table
from bench.task import load_tasks

HEBREW = re.compile(r"[֐-׿]")
LATIN = re.compile(r"[A-Za-z]")


def is_hebrew(text: str) -> bool:
    """Return whether ``text`` is written in Hebrew.

    Args:
        text: A prompt or an answer.

    Returns:
        True when Hebrew is at least 30% of the letters, so quoted code, ids
        and run names inside a Hebrew answer do not mask it.
    """
    hebrew = len(HEBREW.findall(text))
    return hebrew > 0.3 * (hebrew + len(LATIN.findall(text)))


def main() -> None:
    """Print the language report for the run directory given on the command line."""
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    tasks = load_tasks()
    stats: dict[str, Counter[str]] = defaultdict(Counter)
    for record in load(args.run_dir / "results.jsonl"):
        if "infra_error" in record or not record["answer"].strip():
            continue
        mine = stats[record["harness"]]
        prompt_hebrew = is_hebrew(tasks[record["task"]].prompt)
        wrong = is_hebrew(record["answer"]) != prompt_hebrew
        mine["hebrew prompts" if prompt_hebrew else "english prompts"] += 1
        if wrong:
            mine["hebrew wrong" if prompt_hebrew else "english wrong"] += 1
        if not record["passed"]:
            mine["failed in the wrong language" if wrong else "failed on substance"] += 1
    rows = [
        [
            harness,
            f"{mine['english wrong']}/{mine['english prompts']}",
            f"{mine['hebrew wrong']}/{mine['hebrew prompts']}",
            mine["failed in the wrong language"],
            mine["failed on substance"],
        ]
        for harness, mine in sorted(stats.items(), key=lambda kv: kv[1]["english wrong"])
    ]
    print("## Reply language\n")
    print(table(
        ["harness", "English prompts answered in Hebrew", "Hebrew prompts answered in English",
         "failures in the wrong language", "failures on substance"], rows,
    ))  # fmt: skip


if __name__ == "__main__":
    main()
