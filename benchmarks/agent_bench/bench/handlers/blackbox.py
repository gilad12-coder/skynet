"""Handlers for black-box (prompt/code) optimization: engines, dry run, submit.

The scorer dry run parses the scorer's ``metric_code`` with :mod:`ast` and never
executes it, so a task can exercise the dry-run path without running arbitrary
user code. ``submit_blackbox_run`` creates a pending ``blackbox`` job and, like
the other submit routes, gates only on an empty credit balance.
"""

from __future__ import annotations

import ast
from typing import Any

from bench.fixtures import make_job
from bench.handlers._common import current_username, new_job_id, require_credits
from bench.world import ToolError, World, tool


@tool("blackbox_engines_blackbox_engines_get")
def blackbox_engines(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Return the black-box engine catalog and Auto-recipe availability.

    Args:
        w: The world.
        args: Optional ``target`` (the optimization target the engines feed);
            echoed back so the caller can correlate the response.

    Returns:
        The catalog: ``sandbox_available``, ``auto_engines``, ``auto_available``,
        the ``engines`` list (each with ``available``/``unavailable_reason``), and
        the requested ``target``.
    """
    catalog = w.s["blackbox"]
    return {
        "target": args.get("target"),
        "sandbox_available": catalog["sandbox_available"],
        "sandbox_reason": catalog["sandbox_reason"],
        "auto_engines": list(catalog["auto_engines"]),
        "auto_available": catalog["auto_available"],
        "auto_unavailable_reason": catalog["auto_unavailable_reason"],
        "auto_checkpoint_recovery_supported": catalog["auto_checkpoint_recovery_supported"],
        "auto_checkpoint_recovery_reason": catalog["auto_checkpoint_recovery_reason"],
        "proposer_runtimes": [dict(r) for r in catalog["proposer_runtimes"]],
        "upstream_revision": catalog["upstream_revision"],
        "engines": [dict(e) for e in catalog["engines"]],
    }


@tool("blackbox_scorer_dry_run_blackbox_scorer_dry_run_post")
def blackbox_scorer_dry_run(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Statically check a scorer against a candidate without executing it.

    Args:
        w: The world.
        args: ``scorer`` (with ``metric_code`` for a python scorer), ``candidate``
            (string or field map), and an optional ``case``.

    Returns:
        ``{"valid", "errors", "function_name", "score", "note"}``. ``score`` is
        always None because the scorer is parsed, never run.

    Raises:
        ToolError: 422 when no scorer is supplied.
    """
    scorer = args.get("scorer")
    if not isinstance(scorer, dict) or not scorer:
        raise ToolError(422, "scorer is required")
    errors: list[str] = []
    function_name = None
    code = scorer.get("metric_code") or scorer.get("code")
    kind = scorer.get("kind", "python")
    if code:
        try:
            function_name = _first_function(code)
            if function_name is None:
                errors.append("scorer code defines no top-level function")
        except SyntaxError as exc:
            errors.append(f"scorer code has a syntax error: {exc.msg} (line {exc.lineno})")
    elif kind == "python":
        errors.append("python scorer requires metric_code")
    if args.get("candidate") in (None, "", {}):
        errors.append("candidate is required for a dry run")
    return {
        "valid": not errors,
        "errors": errors,
        "function_name": function_name,
        "score": None,
        "note": "Dry run is static: the scorer is parsed but never executed.",
    }


@tool("submit_blackbox_run_blackbox_run_post", mutates=True)
def submit_blackbox_run(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Queue a black-box optimization run.

    Args:
        w: The world.
        args: Requires ``scorer`` and ``reflection_model_config``; optional
            ``objective``, ``recipe``, ``strategy`` (mode/engine), ``seed_candidate``,
            ``cases`` / ``staged_dataset_id``, ``name`` and ``is_private``.

    Returns:
        A compact summary of the newly created pending black-box run.

    Raises:
        ToolError: 422 for a missing scorer/reflection model or an unavailable
            engine, 402 when the caller has no spendable credits.
    """
    scorer = args.get("scorer")
    if not isinstance(scorer, dict) or not scorer:
        raise ToolError(422, "scorer is required")
    if not args.get("reflection_model_config"):
        raise ToolError(422, "reflection_model_config is required")
    _check_engine(w, args.get("strategy"))
    require_credits(w)
    reflection = args["reflection_model_config"]
    oid = new_job_id(w)
    job = make_job(
        optimization_id=oid,
        name=args.get("name") or "untitled blackbox run",
        description=args.get("description"),
        username=current_username(w),
        status="pending",
        optimization_type="blackbox",
        module_name="blackbox",
        optimizer_name=(args.get("strategy") or {}).get("engine") or "gepa",
        model_name=(args.get("task_model_config") or {}).get("name"),
        model_settings=args.get("task_model_config"),
        reflection_model_name=reflection.get("name") if isinstance(reflection, dict) else None,
        column_mapping=None,
        created_at=w.s["now"],
        seed=args.get("seed", 42),
        shuffle=bool(args.get("shuffle", True)),
        payload=dict(args),
        logs=[{"timestamp": w.s["now"], "level": "INFO", "logger": "worker", "message": "Blackbox run queued", "pair_index": None}],
    )
    if args.get("is_private"):
        job["is_private"] = True
    w.s["jobs"][oid] = job
    return _summary(w, job)


def _check_engine(w: World, strategy: dict[str, Any] | None) -> None:
    """Reject a submission that names an unavailable engine or Auto recipe.

    Args:
        w: The world.
        strategy: The optional strategy block (``mode`` and/or ``engine``).

    Raises:
        ToolError: 422 when the engine is unknown/unavailable or Auto is off.
    """
    catalog = w.s["blackbox"]
    strategy = strategy or {}
    engine = strategy.get("engine")
    if engine:
        spec = next((e for e in catalog["engines"] if e["id"] == engine), None)
        if spec is None:
            raise ToolError(422, f"unknown blackbox engine '{engine}'")
        if not spec["available"]:
            raise ToolError(422, spec.get("unavailable_reason") or f"blackbox engine '{engine}' is not available")
    elif strategy.get("mode") == "auto" and not catalog["auto_available"]:
        raise ToolError(422, catalog.get("auto_unavailable_reason") or "the Auto recipe is not available")


def _summary(w: World, job: dict[str, Any]) -> dict[str, Any]:
    """Return the compact submit-acknowledgement summary for a new run."""
    return {
        "optimization_id": job["optimization_id"],
        "name": job["name"],
        "status": job["status"],
        "optimization_type": job["optimization_type"],
        "module_name": job["module_name"],
        "optimizer_name": job["optimizer_name"],
        "reflection_model_name": job["reflection_model_name"],
        "username": job["username"],
        "created_at": job["created_at"],
        "is_owner": job["username"].lower() == current_username(w).lower(),
    }


def _first_function(code: str) -> str | None:
    """Return the name of the first top-level function in ``code``, or None.

    Raises:
        SyntaxError: When ``code`` does not parse.
    """
    tree = ast.parse(code)
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return node.name
    return None
