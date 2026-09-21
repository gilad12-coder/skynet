"""Handlers for aggregated analytics across the caller's optimizations.

All three tools aggregate over :func:`_common.accessible_jobs` (owned runs, plus
all runs for an admin), applying the same optional ``optimizer`` / ``model`` /
``status`` / ``username`` filters before summarizing.
"""

from __future__ import annotations

from typing import Any

from bench.handlers._common import accessible_jobs
from bench.world import World, tool


def _filtered(w: World, args: dict[str, Any]) -> list[dict[str, Any]]:
    """Return accessible jobs narrowed by the analytics filter arguments."""
    jobs = accessible_jobs(w, include_shared=False)
    if args.get("optimizer"):
        jobs = [j for j in jobs if j.get("optimizer_name") == args["optimizer"]]
    if args.get("model"):
        jobs = [j for j in jobs if _primary_model(j) == args["model"]]
    if args.get("status"):
        jobs = [j for j in jobs if j["status"] == args["status"]]
    if args.get("username"):
        jobs = [j for j in jobs if j.get("username", "").lower() == args["username"].lower()]
    return jobs


def _primary_model(job: dict[str, Any]) -> str | None:
    """Return the model a job is primarily attributed to for model-scoped stats."""
    if job.get("model_name"):
        return job["model_name"]
    gen = job.get("generation_models") or []
    if gen and isinstance(gen[0], dict):
        return gen[0].get("name")
    return None


def _improvements(jobs: list[dict[str, Any]]) -> list[float]:
    """Return the metric improvements of jobs that recorded one."""
    return [j["metric_improvement"] for j in jobs if j.get("metric_improvement") is not None]


def _avg(values: list[float]) -> float | None:
    """Return the rounded mean of ``values``, or None when empty."""
    return round(sum(values) / len(values), 6) if values else None


@tool("get_analytics_summary_analytics_summary_get")
def get_analytics_summary(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Return aggregated KPIs across the caller's optimizations."""
    jobs = _filtered(w, args)
    successful = [j for j in jobs if j["status"] == "success"]
    improvements = _improvements(successful)
    runtime = sum(j.get("elapsed_seconds") or 0.0 for j in jobs)
    by_status: dict[str, int] = {}
    for job in jobs:
        by_status[job["status"]] = by_status.get(job["status"], 0) + 1
    return {
        "total_optimizations": len(jobs),
        "successful": len(successful),
        "failed": by_status.get("failed", 0),
        "by_status": by_status,
        "avg_improvement": _avg(improvements),
        "best_improvement": max(improvements) if improvements else None,
        "total_runtime_seconds": round(runtime, 3),
    }


@tool("get_model_stats_analytics_models_get")
def get_model_stats(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Return per-model aggregated statistics."""
    jobs = _filtered(w, args)
    buckets: dict[str, list[dict[str, Any]]] = {}
    for job in jobs:
        model = _primary_model(job)
        if model:
            buckets.setdefault(model, []).append(job)
    stats = [
        {
            "model": model,
            "count": len(group),
            "successful": sum(1 for j in group if j["status"] == "success"),
            "avg_improvement": _avg(_improvements([j for j in group if j["status"] == "success"])),
        }
        for model, group in sorted(buckets.items())
    ]
    return {"models": stats}


@tool("get_optimizer_stats_analytics_optimizers_get")
def get_optimizer_stats(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Return per-optimizer aggregated statistics."""
    jobs = _filtered(w, args)
    buckets: dict[str, list[dict[str, Any]]] = {}
    for job in jobs:
        buckets.setdefault(job.get("optimizer_name") or "unknown", []).append(job)
    stats = [
        {
            "optimizer": optimizer,
            "count": len(group),
            "successful": sum(1 for j in group if j["status"] == "success"),
            "avg_improvement": _avg(_improvements([j for j in group if j["status"] == "success"])),
        }
        for optimizer, group in sorted(buckets.items())
    ]
    return {"optimizers": stats}
