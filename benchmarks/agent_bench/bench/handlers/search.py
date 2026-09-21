"""Handler for the public dashboard search over the community optimization gallery.

Only public jobs in ``search_corpus`` are searchable; private runs are never
returned. Scoring is deterministic lexical overlap between the query terms and
each job's text fields, with name and task matches weighted highest.
"""

from __future__ import annotations

from typing import Any

from bench.world import World, tool

_FIELD_WEIGHTS = (("name", 3.0), ("task_name", 2.0), ("summary_text", 1.0), ("description", 1.0), ("module_name", 1.0), ("optimizer_name", 1.0), ("winning_model", 1.0))


@tool("public_search_dashboard_search_post")
def public_search(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Search the public gallery of shared optimizations.

    Args:
        w: The world.
        args: Optional ``query`` plus ``models``, ``optimizers``,
            ``optimization_types``, ``tasks``, ``modules``, ``date_from``,
            ``date_to``, ``owner_username``, ``shared_with_username`` filters and
            ``sort`` (``relevance``/``recent``/``gain``), ``page``, ``size``.

    Returns:
        ``{"items", "total", "page", "size"}`` with a projected, gain-annotated
        view of each matching public job.
    """
    query = (args.get("query") or "").strip().lower()
    terms = query.split()
    scored = []
    for job in w.s["search_corpus"]:
        if job.get("is_private"):
            continue
        if not _passes_filters(job, args):
            continue
        score = _relevance(job, terms) if terms else 0.0
        if terms and score <= 0:
            continue
        scored.append((score, job))

    sort = args.get("sort") or ("relevance" if terms else "recent")
    scored.sort(key=lambda pair: _sort_key(sort, pair[0], pair[1]), reverse=True)

    total = len(scored)
    size = min(max(int(args.get("size", 20)), 1), 100)
    page = max(int(args.get("page", 1)), 1)
    start = (page - 1) * size
    window = scored[start : start + size]
    return {
        "items": [_project(job, score) for score, job in window],
        "total": total,
        "page": page,
        "size": size,
    }


def _passes_filters(job: dict[str, Any], args: dict[str, Any]) -> bool:
    """Return whether ``job`` satisfies every supplied non-query filter."""
    if (m := args.get("models")) and job.get("winning_model") not in m:
        return False
    if (o := args.get("optimizers")) and job.get("optimizer_name") not in o:
        return False
    if (t := args.get("optimization_types")) and job.get("optimization_type") not in t:
        return False
    if (t := args.get("tasks")) and job.get("task_name") not in t:
        return False
    if (mo := args.get("modules")) and job.get("module_name") not in mo:
        return False
    created = (job.get("created_at") or "")[:10]
    if (df := args.get("date_from")) and created < df:
        return False
    if (dt := args.get("date_to")) and created > dt:
        return False
    if (ow := args.get("owner_username")) and job.get("owner_username", "").lower() != ow.lower():
        return False
    sw = args.get("shared_with_username")
    return not sw or sw.lower() in {u.lower() for u in (job.get("shared_with") or {})}


def _relevance(job: dict[str, Any], terms: list[str]) -> float:
    """Return the weighted count of query-term hits across ``job``'s text fields."""
    score = 0.0
    for field, weight in _FIELD_WEIGHTS:
        text = (job.get(field) or "").lower()
        for term in terms:
            if term in text:
                score += weight
    return score


def _sort_key(sort: str, score: float, job: dict[str, Any]) -> tuple[float, str]:
    """Return the ascending sort key for ``sort`` (results are reverse-sorted)."""
    created = job.get("created_at") or ""
    if sort == "recent":
        return (0.0, created)
    if sort == "gain":
        return (_gain(job), created)
    return (score, created)


def _gain(job: dict[str, Any]) -> float:
    """Return the metric gain (optimized minus baseline) for ``job``."""
    base = job.get("baseline_metric")
    opt = job.get("optimized_metric")
    if base is None or opt is None:
        return 0.0
    return round(opt - base, 6)


def _project(job: dict[str, Any], score: float) -> dict[str, Any]:
    """Return the public view of a corpus job with gain and relevance score."""
    fields = ("optimization_id", "name", "task_name", "module_name", "optimizer_name", "winning_model", "optimization_type", "baseline_metric", "optimized_metric", "summary_text", "description", "created_at", "owner_username")
    out = {k: job.get(k) for k in fields}
    out["gain"] = _gain(job)
    out["relevance"] = round(score, 6)
    return out
