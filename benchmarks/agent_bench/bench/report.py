"""Summarise a run directory as Markdown tables.

Usage::

    python -m bench.report results/main > results/main/REPORT.md
"""

from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def load(path: Path) -> list[dict[str, Any]]:
    """Return the JSON-lines records of ``path``, or an empty list if it is missing."""
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def table(headers: list[str], rows: list[list[Any]]) -> str:
    """Render a Markdown table."""
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    lines += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(lines)


def pct(values: list[bool]) -> str:
    """Format the share of true values as a percentage."""
    return f"{100 * sum(values) / len(values):.0f}%" if values else "-"


def pass_matrix(records: list[dict[str, Any]], harnesses: list[str], key: str) -> str:
    """Render pass rate per harness, broken down by the record field ``key``."""
    groups = sorted({r[key] for r in records})
    rows = []
    for harness in harnesses:
        mine = [r for r in records if r["harness"] == harness]
        rows.append([harness] + [pct([r["passed"] for r in mine if r[key] == g]) for g in groups])
    return table(["harness", *groups], rows)


def main() -> None:
    """Print the report for the run directory given on the command line."""
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    everything = load(args.run_dir / "results.jsonl")
    records = [r for r in everything if "infra_error" not in r]
    # A rerun retries infrastructure errors, so only the ones never replaced still count.
    graded = {(r["harness"], r["task"], r["trial"]) for r in records}
    infra = [r for r in everything if "infra_error" in r and (r["harness"], r["task"], r["trial"]) not in graded]
    billed: dict[str, float] = defaultdict(float)
    for batch in load(args.run_dir / "batches.jsonl"):
        billed[batch["harness"]] += batch.get("billed_usd") or 0.0

    by_harness: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        by_harness[record["harness"]].append(record)
    harnesses = sorted(by_harness, key=lambda h: -statistics.mean(r["passed"] for r in by_harness[h]))

    rows = []
    for harness in harnesses:
        mine = by_harness[harness]
        tokens_in = statistics.mean(r["fresh_input_tokens"] + r["cached_input_tokens"] for r in mine)
        rows.append([
            harness, len(mine), pct([r["passed"] for r in mine]),
            f"{statistics.mean(r['score'] for r in mine):.2f}",
            f"{statistics.median(r['seconds'] for r in mine):.0f}s",
            f"{statistics.mean(r['tool_calls'] for r in mine):.1f}",
            f"{tokens_in / 1000:.0f}k", f"{statistics.mean(r['output_tokens'] for r in mine):.0f}",
            f"${1000 * statistics.mean(r['cost_usd'] for r in mine):.2f}",
            f"${1000 * billed[harness] / len(mine):.2f}" if billed.get(harness) else "-",
            sum(1 for r in mine if r["error"]),
        ])  # fmt: skip
    print("## Overall\n")
    print(table(
        ["harness", "attempts", "pass", "mean score", "median time", "tool calls", "input tok", "output tok",
         "list cost / 1k tasks", "billed / 1k tasks", "harness errors"], rows,
    ))  # fmt: skip
    print("\n## Pass rate by category\n")
    print(pass_matrix(records, harnesses, "category"))
    print("\n## Pass rate by difficulty\n")
    print(pass_matrix(records, harnesses, "difficulty"))

    print("\n## Per task (passes / attempts)\n")
    task_ids = sorted({r["task"] for r in records})
    rows = []
    for task_id in task_ids:
        row = [task_id]
        for harness in harnesses:
            mine = [r for r in by_harness[harness] if r["task"] == task_id]
            row.append(f"{sum(r['passed'] for r in mine)}/{len(mine)}" if mine else "-")
        rows.append(row)
    print(table(["task", *harnesses], rows))

    print("\n## Most-failed checks per harness\n")
    for harness in harnesses:
        failed = Counter(
            f"{r['task']}:{name}" for r in by_harness[harness] for name, ok in r["checks"].items() if not ok
        )
        print(f"- **{harness}**: " + (", ".join(f"{k} ×{v}" for k, v in failed.most_common(8)) or "none"))
    if infra:
        print(f"\n{len(infra)} attempt(s) hit benchmark infrastructure errors and are excluded above.")


if __name__ == "__main__":
    main()
