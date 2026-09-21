"""Shared helpers for the benchmark tool handlers.

Access control, job lookup, status buckets, and the compact summary projection
all live here so the per-domain handler modules stay small. No handler is
registered in this module; it only exports helpers the others import.
"""

from __future__ import annotations

from typing import Any

from bench.world import ToolError, World

ACTIVE_STATUSES = {"pending", "validating", "running"}
TERMINAL_STATUSES = {"success", "failed", "cancelled", "stopped", "paused"}
ROLE_RANK = {"viewer": 1, "editor": 2, "owner": 3}

SUMMARY_FIELDS = (
    "optimization_id", "name", "description", "status", "optimization_type", "composition",
    "module_name", "optimizer_name", "model_name", "reflection_model_name", "username", "pinned",
    "created_at", "started_at", "completed_at", "elapsed", "elapsed_seconds", "estimated_remaining",
    "baseline_test_metric", "optimized_test_metric", "metric_improvement", "metric_name",
    "dataset_rows", "source_dataset_id", "stop_reason", "message", "resumable", "pausable",
    "total_pairs", "completed_pairs", "failed_pairs", "best_pair_label", "summary_text",
    "latest_metrics", "generation_models", "reflection_models", "execution_budget",
)


def current_username(w: World) -> str:
    """Return the authenticated caller's username."""
    return w.s["user"]["username"]


def is_admin(w: World) -> bool:
    """Return whether the caller is an administrator."""
    return bool(w.s["user"].get("is_admin"))


def job_role(w: World, job: dict[str, Any]) -> str | None:
    """Return the caller's role on ``job``, or None when they have no access.

    Args:
        w: The world.
        job: A job dict.

    Returns:
        ``"owner"`` for the owner or an admin, the member grant tier
        (``viewer``/``editor``/``owner``) for a shared user, or None.
    """
    user = current_username(w).lower()
    if job.get("username", "").lower() == user or is_admin(w):
        return "owner"
    for uname, role in (job.get("grants") or {}).items():
        if uname.lower() == user:
            return role
    return None


def get_job(w: World, oid: str | None, *, need: str = "read") -> dict[str, Any]:
    """Resolve an accessible job by id, enforcing the access model.

    Args:
        w: The world.
        oid: The optimization id.
        need: ``"read"`` or ``"write"``; write requires editor or owner.

    Returns:
        The job dict.

    Raises:
        ToolError: 422 when ``oid`` is missing, 404 when the job does not exist
            or the caller cannot see it (existence is never leaked as 403), and
            403 when a viewer attempts a write.
    """
    if not oid:
        raise ToolError(422, "optimization_id is required")
    job = w.s["jobs"].get(oid)
    if job is None:
        raise ToolError(404, f"Optimization {oid} not found")
    role = job_role(w, job)
    if role is None:
        raise ToolError(404, f"Optimization {oid} not found")
    if need == "write" and ROLE_RANK.get(role, 0) < ROLE_RANK["editor"]:
        raise ToolError(403, "You do not have edit access to this optimization")
    return job


def accessible_jobs(w: World, *, include_shared: bool = False) -> list[dict[str, Any]]:
    """Return jobs the caller may see, newest first.

    Args:
        w: The world.
        include_shared: Also include runs shared with the caller via a grant.

    Returns:
        Owned jobs (all jobs for an admin), plus shared jobs when requested,
        sorted by ``created_at`` descending.
    """
    user = current_username(w).lower()
    admin = is_admin(w)
    out = []
    for job in w.s["jobs"].values():
        owned = admin or job.get("username", "").lower() == user
        shared = not owned and include_shared and user in {u.lower() for u in (job.get("grants") or {})}
        if owned or shared:
            out.append(job)
    out.sort(key=lambda j: j.get("created_at") or "", reverse=True)
    return out


def job_summary(w: World, job: dict[str, Any]) -> dict[str, Any]:
    """Project a job into the compact dashboard-card shape.

    Args:
        w: The world.
        job: A job dict.

    Returns:
        A dict of the stable summary fields plus the caller's ``role`` and an
        ``is_owner`` flag.
    """
    out = {k: job.get(k) for k in SUMMARY_FIELDS}
    out["role"] = job_role(w, job)
    out["is_owner"] = job.get("username", "").lower() == current_username(w).lower()
    return out


def new_job_id(w: World) -> str:
    """Return a fresh deterministic optimization id for a newly created job."""
    seq = w.s.get("_seq", 0)
    w.s["_seq"] = seq + 1
    return f"22222222-0000-4000-8000-{seq:012d}"


def spendable_credits(w: World) -> int:
    """Return the caller's total spendable credits (paid balance + free grant)."""
    wallet = w.s["wallet"]
    return wallet["paid_balance_credits"] + wallet["free_grant"]["credits_remaining"]


def push_card(w: World, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Append a chat UI card of ``kind`` to ``ui_cards`` and return it.

    Args:
        w: The world.
        kind: The card type the chat UI should render.
        payload: Card-specific fields.

    Returns:
        ``{"ok": True, "card": {...}}``.
    """
    card = {"id": f"card-{len(w.s['ui_cards'])}", "kind": kind, **payload}
    w.s["ui_cards"].append(card)
    return {"ok": True, "card": card}


def require_credits(w: World) -> None:
    """Raise 402 when the caller has no spendable credits left.

    Mirrors the real submit route, which gates only on an empty balance and
    never rejects a submission by comparing an estimate against the balance.

    Raises:
        ToolError: 402 when spendable credits are zero or below.
    """
    if spendable_credits(w) <= 0:
        raise ToolError(402, "Insufficient credits: your balance is empty. Top up to submit new runs.")
