"""Read-only "insight" tasks: grounded questions about existing runs.

Every task in this module asks the assistant to look something up and answer
correctly without changing anything, so each carries ``no_mutations()``. The
scenarios cover a live run's progress, a status count, diagnosing a failure from
logs, comparing grid-search pairs, spotting per-example regressions, and giving
the honest "there is no such run" answer.

Oracles reach the world only through ``w.call`` and locate jobs by the names a
real user would type, mirroring what a correct agent must do.
"""

from __future__ import annotations

from bench import checks as c
from bench.task import Task
from bench.world import World


def _find_job_id(w: World, needle: str) -> str | None:
    """Return the id of the caller's job whose name contains ``needle``.

    Args:
        w: The world.
        needle: Case-insensitive substring of the run's display name.

    Returns:
        The matching ``optimization_id``, or None when nothing matches.
    """
    items = w.call("list_jobs_optimizations_get", {"limit": 50}).get("items", [])
    for item in items:
        if needle.lower() in (item.get("name") or "").lower():
            return item.get("optimization_id")
    return None


def oracle_live_status(w: World) -> str:
    """Report the live progress and best-so-far score of the running sweep."""
    jid = _find_job_id(w, "live sentiment sweep")
    summary = w.call("get_job_summary_optimizations", {"optimization_id": jid})
    metrics = summary.get("latest_metrics") or {}
    best = metrics.get("best_so_far")
    return (
        f"It's still running (about {summary.get('estimated_remaining')} left), "
        f"currently on iteration {metrics.get('iteration')} with a best score so far of {best}."
    )


def oracle_failed_count(w: World) -> str:
    """State how many of the caller's optimizations are in the failed state."""
    counts = w.call("get_optimization_counts_optimizations_counts_get", {})
    failed = counts["by_status"].get("failed", 0)
    return f"{failed} of your optimization runs have failed."


def oracle_why_failed_he(w: World) -> str:
    """Diagnose, in Hebrew, why the email-triage run failed and how to fix it."""
    jid = _find_job_id(w, "email-triage")
    w.call("get_job_logs_optimizations", {"optimization_id": jid, "level": "ERROR"})
    return (
        "הריצה נכשלה מפני שפונקציית המדד (metric) הפנתה לעמודה בשם label "
        "שאינה קיימת בדאטהסט. יש לתקן את קוד המדד כך שיתאים לעמודות הקיימות ולהריץ מחדש."
    )


def oracle_grid_margin(w: World) -> str:
    """Name the winning grid pair and its gap over the weakest finished pair."""
    jid = _find_job_id(w, "bake-off")
    grid = w.call("get_grid_search_result_optimizations", {"optimization_id": jid})
    best = grid["best_pair"]
    finished = [
        p
        for p in grid["pair_results"]
        if p.get("optimized_test_metric") is not None and not p.get("error")
    ]
    worst = min(finished, key=lambda p: p["optimized_test_metric"])
    margin = round(best["optimized_test_metric"] - worst["optimized_test_metric"], 6)
    return (
        f"The best pair was {best['generation_model']} (generation) + "
        f"{best['reflection_model']} (reflection), scoring {best['optimized_test_metric']:.2f} "
        f"on the test set. The weakest pair that finished scored "
        f"{worst['optimized_test_metric']:.2f}, so the winner beat it by {margin:.2f}. "
        "One pair (claude-haiku-4.5 + gemini-2.5-pro) failed with a rate-limit error "
        "and produced no score."
    )


def oracle_regressions(w: World) -> str:
    """Count the test examples the optimized program lost versus baseline."""
    jid = _find_job_id(w, "regression-risk")
    res = w.call("get_test_results_optimizations", {"optimization_id": jid})
    base = {r["index"]: r["score"] for r in res["baseline_test_results"]}
    opt = {r["index"]: r["score"] for r in res["optimized_test_results"]}
    regressed = sorted(i for i in base if base[i] >= 1.0 and opt.get(i, 0.0) < 1.0)
    return (
        f"Yes - {len(regressed)} test example regressed: the baseline got it right but the "
        f"optimized program got it wrong (example index {regressed[0]}). Overall the optimized "
        f"run came in below baseline ({res['optimized_test_metric']} vs {res['baseline_test_metric']})."
    )


def oracle_no_such_run(w: World) -> str:
    """Answer honestly that no run matches the name the user asked about."""
    items = w.call("list_jobs_optimizations_get", {"limit": 50}).get("items", [])
    matches = [it for it in items if "churn" in (it.get("name") or "").lower()]
    if matches:
        return f"Your churn-prediction run finished at {matches[0].get('optimized_test_metric')}."
    return (
        "I don't see any optimization named 'churn-prediction' in your account - none of your "
        "runs match that name, so there's no final accuracy to report."
    )


TASKS: list[Task] = [
    Task(
        id="insight-live-status",
        category="insight",
        difficulty="easy",
        prompt="How's my 'live sentiment sweep' run doing right now, and what's the best score it's reached so far?",
        checks=[
            c.no_mutations(),
            c.answer_number(0.71, percent_ok=True, name="states best-so-far 0.71"),
            c.answer_has_any(
                "running", "in progress", "still", "under way", "underway", "progress",
                name="says it is still running",
            ),
        ],
        oracle=oracle_live_status,
        skills=["single-run status", "live metrics"],
        notes="Must report best_so_far (0.71) and that the run is still running, not a final metric; a wrong agent claims it finished or reads another sentiment run.",
    ),
    Task(
        id="insight-failed-count",
        category="insight",
        difficulty="easy",
        prompt="How many of my optimization runs have failed?",
        checks=[
            c.no_mutations(),
            c.answer_number(3, name="states 3 failed"),
            c.answer_regex(
                r"\b3\b[^.,;:|\n]{0,60}fail|fail[a-z]*[^.,;|\n]{0,60}\b3\b",
                name="ties the count 3 to 'failed'",
            ),
        ],
        oracle=oracle_failed_count,
        skills=["status counts", "aggregation"],
        notes="Failed = 3 (two runs + one blackbox scorer crash). A wrong agent that skips the blackbox failure answers 2; the regex stays inside one clause, so it rejects '3 pending, 2 failed' yet accepts '3 of your 16 runs have failed'.",
    ),
    Task(
        id="insight-why-failed-he",
        category="insight",
        difficulty="medium",
        prompt="למה הריצה email-triage nightly נכשלה, ומה צריך לתקן כדי להריץ אותה שוב?",
        checks=[
            c.no_mutations(),
            c.answer_is_hebrew(),
            c.answer_has("label", name="names the missing 'label' column"),
            c.answer_has_any("מדד", "metric", "קוד", "code", name="points at the metric code"),
        ],
        oracle=oracle_why_failed_he,
        skills=["failure diagnosis", "log reading", "hebrew"],
        notes="Failure is a metric referencing a 'label' column absent from the dataset. A wrong agent reads the qa-bot 429 run instead (no 'label'/metric mention) or answers in English.",
    ),
    Task(
        id="insight-grid-margin",
        category="insight",
        difficulty="hard",
        prompt="In my 'model bake-off' grid search, which model pair scored best on the test set, and by how much did it beat the weakest pair that actually finished?",
        checks=[
            c.no_mutations(),
            c.answer_number(0.80, percent_ok=True, name="states the winning score 0.80"),
            c.answer_number(0.58, percent_ok=True, name="states the weakest finished score 0.58"),
            c.answer_has_any("haiku", "claude-haiku", name="names the winning generation model"),
        ],
        oracle=oracle_grid_margin,
        skills=["grid-search comparison", "reasoning over numbers"],
        notes="Six pairs, one failed with no score; the weakest FINISHED pair is 0.58, best is 0.80. The trap is treating the failed pair as the worst; requiring 0.58 forces excluding it.",
    ),
    Task(
        id="insight-regressions",
        category="insight",
        difficulty="hard",
        prompt="On my 'regression-risk run', did the optimized program get any test examples wrong that the baseline got right? If so, how many?",
        checks=[
            c.no_mutations(),
            c.answer_regex(r"\bone\b|\b1\b|\bsingle\b", name="says exactly one example regressed"),
            c.answer_has_any(
                "regress", "worse", "wrong", "incorrect", "lower", "dropped", "degrad", "lost",
                name="affirms a regression happened",
            ),
        ],
        oracle=oracle_regressions,
        skills=["per-example results", "counting regressions"],
        notes="Exactly one test example (index 6) went from correct to wrong. A headline-only agent reports the 0.66 vs 0.70 drop but never counts per-example; an agent that answers 'none' or a larger count fails.",
    ),
    Task(
        id="insight-no-such-run",
        category="insight",
        difficulty="medium",
        prompt="What final accuracy did my 'churn-prediction' run end up with?",
        checks=[
            c.no_mutations(),
            c.answer_has_any(
                "couldn't find", "could not find", "cannot find", "can't find", "no run",
                "no optimization", "no such", "don't see", "do not see", "doesn't exist",
                "does not exist", "not found", "no match", "no job", "i don't", "no records",
                name="says no such run exists",
            ),
            c.answer_has("churn", name="echoes the queried name"),
        ],
        oracle=oracle_no_such_run,
        skills=["honest no-data", "resisting fabrication"],
        notes="No run is named churn-prediction. The honest answer says so; a wrong agent fabricates an accuracy for a run that does not exist.",
    ),
]
