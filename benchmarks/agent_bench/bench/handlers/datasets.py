"""Handlers for datasets: library, sample catalog, staging, profiling, validation.

Also hosts column-role validation, tagging-session listing, and the two
dataset-request UI cards. Staging, profiling, validation and role-setting return
a ``wizard_state`` patch or a profile and are registered non-mutating; the
request tools only append a UI card.
"""

from __future__ import annotations

from typing import Any

from bench.handlers._common import current_username, push_card
from bench.world import ToolError, World, tool


@tool("list_datasets_for_agent")
def list_datasets(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Return the caller's datasets plus, optionally, those shared with them.

    Args:
        w: The world.
        args: Optional ``include_shared`` (default True).

    Returns:
        ``{"datasets": [...], "total": n}``.
    """
    include_shared = bool(args.get("include_shared", True))
    user = current_username(w).lower()
    out = []
    for ds in w.s["datasets"]:
        owned = ds.get("owner_username", "").lower() == user
        shared = not owned and include_shared and user in {u.lower() for u in (ds.get("shared_with") or {})}
        if owned or shared:
            entry = {k: v for k, v in ds.items() if k != "shared_with"}
            entry["is_owner"] = owned
            out.append(entry)
    return {"datasets": out, "total": len(out)}


@tool("list_sample_datasets_datasets_samples_get")
def list_sample_datasets(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Return the catalog of bundled demo datasets without the rows."""
    catalog = [
        {
            "sample_id": s["sample_id"],
            "name": s["name"],
            "description": s["description"],
            "task_type": s["task_type"],
            "dataset_filename": s["dataset_filename"],
            "input_columns": list(s["input_columns"]),
            "output_columns": list(s["output_columns"]),
            "row_count": len(s["rows"]),
        }
        for s in w.s["samples"]
    ]
    return {"samples": catalog, "total": len(catalog)}


@tool("stage_sample_dataset_datasets_samples")
def stage_sample_dataset(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Stage a sample's rows for the caller and return a ``wizard_state`` patch.

    Raises:
        ToolError: 404 when no sample matches ``sample_id``.
    """
    sample_id = args.get("sample_id")
    sample = next((s for s in w.s["samples"] if s["sample_id"] == sample_id), None)
    if sample is None:
        raise ToolError(404, f"Sample dataset {sample_id} not found")
    staged_id = f"staged-{sample_id}"
    w.s["staged"][staged_id] = {"rows": [dict(r) for r in sample["rows"]], "sample_id": sample_id}
    column_roles = dict.fromkeys(sample["input_columns"], "input")
    column_roles.update(dict.fromkeys(sample["output_columns"], "output"))
    return {
        "staged_dataset_id": staged_id,
        "row_count": len(sample["rows"]),
        "dataset_filename": sample["dataset_filename"],
        "wizard_state": {
            "staged_dataset_id": staged_id,
            "dataset_filename": sample["dataset_filename"],
            "column_roles": column_roles,
            "signature_code": sample["signature_code"],
            "metric_code": sample["metric_code"],
            "job_name": sample["name"],
        },
    }


@tool("profile_datasets_profile_post")
def profile_datasets(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Return a dataset profile and a recommended split plan.

    Args:
        w: The world.
        args: ``column_mapping`` plus either an inline ``dataset`` or a
            ``staged_dataset_id``; optional ``seed`` and ``engine``.

    Returns:
        ``{"profile": {...}, "split_plan": {...}}``.

    Raises:
        ToolError: 422 when no rows are provided, 404 for an unknown staged id.
    """
    rows = _rows_from_args(w, args)
    mapping = args.get("column_mapping") or {}
    inputs = list((mapping.get("inputs") or {}).values())
    outputs = list((mapping.get("outputs") or {}).values())
    columns = sorted({k for r in rows for k in r})
    profile = {
        "row_count": len(rows),
        "column_count": len(columns),
        "columns": columns,
        "input_columns": inputs,
        "output_columns": outputs,
        "missing_columns": [c for c in inputs + outputs if c not in columns],
        "duplicate_rows": len(rows) - len({tuple(sorted(r.items())) for r in rows}),
    }
    split_plan = _split_plan(len(rows), args.get("engine"))
    return {"profile": profile, "split_plan": split_plan, "seed": args.get("seed", 42)}


@tool("validate_datasets_validate_post")
def validate_datasets(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Validate a split plan against a row count.

    Args:
        w: The world.
        args: ``row_count`` and ``fractions`` (train/val/test).

    Returns:
        ``{"valid", "split_counts", "warnings", "errors"}``.
    """
    row_count = int(args.get("row_count", 0))
    fractions = args.get("fractions") or {}
    train = float(fractions.get("train", 0.7))
    val = float(fractions.get("val", 0.15))
    test = float(fractions.get("test", 0.15))
    errors, warnings = [], []
    if abs((train + val + test) - 1.0) > 1e-6:
        errors.append("fractions must sum to 1.0")
    counts = {
        "train": int(row_count * train),
        "val": int(row_count * val),
        "test": row_count - int(row_count * train) - int(row_count * val),
    }
    for name, n in counts.items():
        if n < 1:
            errors.append(f"{name} split would be empty ({n} rows)")
    if row_count < 20 and not errors:
        warnings.append(f"only {row_count} rows: splits are small and metrics will be noisy")
    return {"valid": not errors, "split_counts": counts, "warnings": warnings, "errors": errors}


@tool("set_column_roles_datasets_column_roles_post")
def set_column_roles(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Validate a proposed column-role map and return a ``wizard_state`` patch.

    Args:
        w: The world.
        args: ``dataset_columns``, ``column_roles`` (column -> input/output/ignore),
            and optional ``job_name``.

    Returns:
        A ``wizard_state`` patch carrying the derived ``column_mapping``.

    Raises:
        ToolError: 422 for an unknown role, a role on a missing column, or no
            input/output selected.
    """
    columns = args.get("dataset_columns") or []
    roles = args.get("column_roles") or {}
    unknown = [c for c in roles if c not in columns]
    if unknown:
        raise ToolError(422, f"column_roles references unknown column(s): {', '.join(unknown)}")
    bad = [r for r in roles.values() if r not in {"input", "output", "ignore"}]
    if bad:
        raise ToolError(422, f"invalid role(s): {', '.join(sorted(set(bad)))}")
    inputs = {c: c for c, r in roles.items() if r == "input"}
    outputs = {c: c for c, r in roles.items() if r == "output"}
    if not inputs:
        raise ToolError(422, "at least one column must be an input")
    if not outputs:
        raise ToolError(422, "at least one column must be an output")
    patch: dict[str, Any] = {"column_roles": dict(roles), "column_mapping": {"inputs": inputs, "outputs": outputs}}
    if args.get("job_name"):
        patch["job_name"] = args["job_name"]
    return {"valid": True, "column_mapping": {"inputs": inputs, "outputs": outputs}, "wizard_state": patch}


@tool("list_tagging_sessions_for_agent")
def list_tagging_sessions(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Return the caller's tagging sessions, pinned first then newest activity.

    Args:
        w: The world.
        args: Optional ``limit`` (default 100) and ``offset``.

    Returns:
        ``{"sessions": [...], "total": n}``.
    """
    user = current_username(w).lower()
    sessions = [
        s for s in w.s["tagging_sessions"]
        if s.get("owner_username", "").lower() == user or user in {u.lower() for u in (s.get("shared_with") or {})}
    ]
    sessions.sort(key=lambda s: (not s.get("pinned"), _neg_iso(s.get("updated_at"))))
    offset = max(int(args.get("offset", 0)), 0)
    limit = min(int(args.get("limit", 100)), 200)
    page = [{k: v for k, v in s.items() if k != "shared_with"} for s in sessions[offset : offset + limit]]
    return {"sessions": page, "total": len(sessions)}


@tool("request_user_dataset_datasets_request_upload_post")
def request_user_dataset(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Signal the chat UI to render an inline dataset-upload card."""
    return push_card(w, "dataset_upload", {"prompt": args.get("prompt", "")})


@tool("request_user_dataset_from_library")
def request_user_dataset_from_library(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Signal the chat UI to render an inline saved-dataset picker."""
    return push_card(w, "dataset_library", {"prompt": args.get("prompt", "")})


def _rows_from_args(w: World, args: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the rows to profile from an inline dataset or a staged id."""
    if args.get("staged_dataset_id"):
        staged = w.s["staged"].get(args["staged_dataset_id"])
        if staged is None:
            raise ToolError(404, f"Staged dataset {args['staged_dataset_id']} not found")
        return staged["rows"]
    rows = args.get("dataset") or []
    if not rows:
        raise ToolError(422, "provide a non-empty dataset or a staged_dataset_id")
    return rows


def _split_plan(row_count: int, engine: str | None) -> dict[str, Any]:
    """Return recommended split fractions and counts for ``row_count`` rows.

    Args:
        row_count: Number of available rows.
        engine: The black-box engine the split feeds, if any; scorer-heavy
            engines shift more mass to the test set.

    Returns:
        A dict with ``fractions``, ``counts``, and any ``warnings``.
    """
    if engine in {"best_of_n", "meta_harness"}:
        fractions = {"train": 0.5, "val": 0.2, "test": 0.3}
    else:
        fractions = {"train": 0.7, "val": 0.15, "test": 0.15}
    counts = {
        "train": int(row_count * fractions["train"]),
        "val": int(row_count * fractions["val"]),
        "test": row_count - int(row_count * fractions["train"]) - int(row_count * fractions["val"]),
    }
    warnings = []
    if any(n < 1 for n in counts.values()):
        warnings.append(f"{row_count} rows is too few to split into train/val/test")
    return {"fractions": fractions, "counts": counts, "warnings": warnings}


def _neg_iso(ts: str | None) -> str:
    """Return a key that sorts ISO timestamps newest-first via ascending sort."""
    return "".join(chr(255 - ord(c)) for c in (ts or ""))
