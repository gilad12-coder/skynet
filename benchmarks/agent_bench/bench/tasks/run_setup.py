"""Benchmark tasks for the ``setup`` category: configuring and submitting a run.

These tasks exercise the run-setup wizard end to end: a surgical single-field
edit, staging a bundled sample, assigning column roles, model discovery against
a described endpoint, a single-run submit of a ready wizard, and a grid-search
submit that requires resolving friendly model names to exact catalog ids. Each
task grades the final world state and reply, never a particular tool path.
"""

from __future__ import annotations

from typing import Any

from bench.checks import (
    answer_has_any,
    answer_is_hebrew,
    called,
    custom,
    no_mutations,
    not_called,
    only_mutated,
    state_check,
    state_eq,
)
from bench.task import Task
from bench.world import MUTATING, World

GPT4O = "openrouter/openai/gpt-4o"
GPT4O_MINI = "openrouter/openai/gpt-4o-mini"
CLAUDE_SONNET = "openrouter/anthropic/claude-sonnet-4.5"
CLAUDE_HAIKU = "openrouter/anthropic/claude-haiku-4.5"
GEMINI_PRO = "openrouter/google/gemini-2.5-pro"

_SUBMIT_TOOLS = ("submit_job_run_post", "submit_grid_search_grid_search_post")


def _model_names(models: Any) -> set[str]:
    """Return the set of model names in a generation/reflection list.

    Args:
        models: A list whose entries are either name strings or config dicts
            carrying a ``name`` key.

    Returns:
        The names as a set (empty when ``models`` is falsy).
    """
    out: set[str] = set()
    for m in models or []:
        out.add(m.get("name") if isinstance(m, dict) else m)
    return out


def _new_jobs(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Return jobs created at runtime by a submit (the ``22222222-`` prefix)."""
    return [j for j in state["jobs"].values() if str(j.get("optimization_id", "")).startswith("22222222")]


# --- Task 1: surgical single-field wizard edit -----------------------------

_EDIT_WIZARD = {
    "job_name": "email triage v3",
    "job_type": "run",
    "module_name": "predict",
    "optimizer_name": "gepa",
    "column_mapping": {"inputs": {"subject": "subject", "body": "body"}, "outputs": {"category": "category"}},
    "source_dataset_id": "ds_email_triage",
    "model_config": {"name": GPT4O_MINI, "temperature": 0.0},
    "split_fractions": {"train": 0.7, "val": 0.15, "test": 0.15},
}


def _oracle_edit_module(w: World) -> str:
    """Change only the wizard module to chain-of-thought and confirm."""
    w.call("update_wizard_state", {"module_name": "cot"})
    return "Done - the module is now Chain-of-Thought (cot). Everything else in the wizard is unchanged."


def _only_module_changed(r: Any) -> bool:
    """Pass when no server state mutated and every wizard field but the module held.

    Args:
        r: The graded run.

    Returns:
        True when the edit was surgical: no mutating tool succeeded and the
        untouched wizard fields equal their initial values.
    """
    if any(c["tool"] in MUTATING for c in r.ok_calls()):
        return False
    before, after = r.initial.get("wizard", {}), r.state.get("wizard", {})
    kept = ("job_name", "job_type", "optimizer_name", "column_mapping", "source_dataset_id",
            "model_config", "split_fractions")
    return all(after.get(k) == before.get(k) for k in kept)


# --- Task 2: stage the right Hebrew sample ---------------------------------


def _oracle_stage_sentiment(w: World) -> str:
    """Find the Hebrew sentiment sample and stage it for a new run."""
    samples = w.call("list_sample_datasets_datasets_samples_get")["samples"]
    target = next(s for s in samples if "ניתוח רגש" in s["name"])
    w.call("stage_sample_dataset_datasets_samples", {"sample_id": target["sample_id"]})
    return "טענתי את דוגמת ניתוח הרגש בעברית (12 שורות). אפשר להמשיך להגדרת ההרצה."


# --- Task 3: assign column roles with an ignored column --------------------


def _oracle_column_roles(w: World) -> str:
    """Map ticket_text to input and priority to output, ignoring row_id."""
    w.call(
        "set_column_roles_datasets_column_roles_post",
        {
            "dataset_columns": ["row_id", "ticket_text", "priority"],
            "column_roles": {"row_id": "ignore", "ticket_text": "input", "priority": "output"},
        },
    )
    return "Set ticket_text as the input and priority as the output; row_id is ignored."


def _roles_mapped(state: dict[str, Any]) -> bool:
    """Pass when the wizard column_mapping is exactly ticket_text->input, priority->output."""
    mapping = (state.get("wizard") or {}).get("column_mapping") or {}
    inputs = set((mapping.get("inputs") or {}).keys())
    outputs = set((mapping.get("outputs") or {}).keys())
    return inputs == {"ticket_text"} and outputs == {"priority"}


# --- Task 4: single-run submit of a ready wizard ---------------------------

_READY_WIZARD = {
    "job_name": "support-tickets classifier",
    "job_type": "run",
    "module_name": "cot",
    "optimizer_name": "gepa",
    "column_mapping": {"inputs": {"text": "text"}, "outputs": {"label": "label"}},
    "source_dataset_id": "ds_support_tickets",
    "model_config": {"name": GPT4O_MINI, "temperature": 0.0},
    "split_fractions": {"train": 0.7, "val": 0.15, "test": 0.15},
    "seed": 42,
}


def _oracle_submit_run(w: World) -> str:
    """Submit the single run described by the current wizard state."""
    wiz = w.s["wizard"]
    job = w.call(
        "submit_job_run_post",
        {
            "name": wiz["job_name"],
            "module_name": wiz["module_name"],
            "optimizer_name": wiz["optimizer_name"],
            "column_mapping": wiz["column_mapping"],
            "model_config": wiz["model_config"],
            "source_dataset_id": wiz["source_dataset_id"],
            "split_fractions": wiz["split_fractions"],
            "seed": wiz["seed"],
        },
    )
    return f"Submitted '{wiz['job_name']}' on gpt-4o-mini ({job['optimization_id']}); it is queued as pending."


def _single_run_created(state: dict[str, Any]) -> bool:
    """Pass when exactly one pending single run on gpt-4o-mini was created."""
    new = _new_jobs(state)
    if len(new) != 1:
        return False
    j = new[0]
    return (
        j.get("optimization_type") == "run"
        and j.get("status") == "pending"
        and j.get("module_name") == "cot"
        and j.get("model_name") == GPT4O_MINI
    )


# --- Task 5: grid-search submit with model-name resolution -----------------

_GRID_WIZARD = {
    "job_name": "sentiment model bake-off",
    "job_type": "run",
    "module_name": "predict",
    "optimizer_name": "gepa",
    "column_mapping": {"inputs": {"text": "text"}, "outputs": {"label": "label"}},
    "source_dataset_id": "ds_reviews_he",
    "model_config": {"name": GPT4O_MINI, "temperature": 0.0},
    "split_fractions": {"train": 0.7, "val": 0.15, "test": 0.15},
}


def _oracle_submit_grid(w: World) -> str:
    """Resolve the three named generation models and submit a grid search."""
    catalog = {m["name"]: m for m in w.call("list_models_for_agent")["models"]}
    gen = [{"name": n} for n in (GPT4O, CLAUDE_SONNET, GEMINI_PRO) if n in catalog]
    refl = [{"name": CLAUDE_HAIKU}]
    wiz = w.s["wizard"]
    job = w.call(
        "submit_grid_search_grid_search_post",
        {
            "name": wiz["job_name"],
            "module_name": wiz["module_name"],
            "optimizer_name": wiz["optimizer_name"],
            "column_mapping": wiz["column_mapping"],
            "source_dataset_id": wiz["source_dataset_id"],
            "generation_models": gen,
            "reflection_models": refl,
            "split_fractions": wiz["split_fractions"],
        },
    )
    return (
        f"Launched the bake-off '{wiz['job_name']}' ({job['optimization_id']}): 3 pairs - "
        "GPT-4o, Claude Sonnet 4.5 and Gemini 2.5 Pro as generation models, each reflecting "
        "with Claude Haiku 4.5. Status: pending."
    )


def _grid_created(state: dict[str, Any]) -> bool:
    """Pass when one pending grid with the three exact gen models and Haiku reflection exists."""
    new = _new_jobs(state)
    if len(new) != 1:
        return False
    j = new[0]
    return (
        j.get("optimization_type") == "grid_search"
        and j.get("status") == "pending"
        and _model_names(j.get("generation_models")) == {GPT4O, CLAUDE_SONNET, GEMINI_PRO}
        and _model_names(j.get("reflection_models")) == {CLAUDE_HAIKU}
    )


# --- Task 6: discovery blocked by a missing key -> refuse to submit --------


def _oracle_discover_blocked(w: World) -> str:
    """Probe the key-gated endpoint, find it needs a key, and refuse to submit."""
    w.call("discover_models_models_discover_post", {"base_url": "https://api.openai.com/v1"})
    return (
        "I could not list the models at https://api.openai.com/v1 - that endpoint requires an API key, "
        "which I do not have. Share a key for it and I will discover the models and set up the bake-off. "
        "I have not submitted anything."
    )


TASKS: list[Task] = [
    Task(
        id="setup-edit-module-only",
        category="setup",
        difficulty="easy",
        prompt="Change the module to chain-of-thought - leave everything else in the wizard exactly as it is.",
        wizard_state=_EDIT_WIZARD,
        checks=[
            state_eq("wizard.module_name", "cot", name="module set to cot"),
            answer_has_any("chain-of-thought", "chain of thought", "cot", name="answer names the new module"),
            custom("only the module changed, nothing submitted", _only_module_changed),
        ],
        oracle=_oracle_edit_module,
        skills=["wizard", "surgical-edit", "module-choice"],
        notes="Must patch only module_name; a wrong agent re-sends and clobbers other fields or submits the run.",
    ),
    Task(
        id="setup-stage-hebrew-sentiment",
        category="setup",
        difficulty="easy",
        prompt="אני רוצה להתחיל הרצה חדשה על דוגמת ניתוח הרגש בעברית שיש לכם. תטען אותה בשבילי.",
        checks=[
            state_eq("wizard.staged_dataset_id", "staged-sentiment-he", name="staged the sentiment sample"),
            answer_is_hebrew(),
            not_called(*_SUBMIT_TOOLS, name="did not submit a run yet"),
        ],
        oracle=_oracle_stage_sentiment,
        skills=["sample-dataset", "staging", "hebrew"],
        notes="Three look-alike Hebrew samples; must stage sentiment-he, not email-triage-he or qa-general-he, and not submit.",
    ),
    Task(
        id="setup-column-roles-ignore",
        category="setup",
        difficulty="medium",
        prompt=(
            "My dataset has three columns: row_id, ticket_text and priority. Set up the mapping so the model "
            "reads ticket_text and predicts priority - row_id is just an index, leave it out."
        ),
        checks=[
            state_check("column_mapping is ticket_text->input, priority->output only", _roles_mapped),
            answer_has_any("ticket_text", "priority", name="answer describes the mapping"),
            no_mutations(),
        ],
        oracle=_oracle_column_roles,
        skills=["column-roles", "wizard", "ignore-column"],
        notes="row_id must be ignored; a wrong agent maps it as an input or output. Needs set_column_roles (only route to column_mapping).",
    ),
    Task(
        id="setup-submit-ready-run",
        category="setup",
        difficulty="medium",
        prompt="This all looks right - go ahead and start the run.",
        wizard_state=_READY_WIZARD,
        checks=[
            state_check("one pending run on gpt-4o-mini created", _single_run_created),
            answer_has_any("submitted", "queued", "started", "launched", "pending", "running",
                           name="answer confirms the submission"),
            only_mutated("submit_job_run_post", name="only submitted a single run"),
        ],
        oracle=_oracle_submit_run,
        skills=["submit", "single-run", "wizard-complete"],
        notes="Translate the ready wizard into a single-run submit; do not submit a grid, and do not double-submit.",
    ),
    Task(
        id="setup-submit-grid-named-models",
        category="setup",
        difficulty="medium",
        prompt=(
            "Actually, don't just run one model - do a bake-off: compare GPT-4o, Claude Sonnet and Gemini 2.5 Pro "
            "as the generation model, each reflecting with Claude Haiku. Launch it."
        ),
        wizard_state=_GRID_WIZARD,
        checks=[
            state_check("pending grid with the three exact gen models + Haiku reflection", _grid_created),
            answer_has_any("bake-off", "grid", "3 pairs", "three", name="answer confirms the grid launch"),
            only_mutated("submit_grid_search_grid_search_post", name="only submitted a grid search"),
        ],
        oracle=_oracle_submit_grid,
        skills=["submit", "grid-search", "model-resolution"],
        notes="Must resolve friendly names to exact catalog ids (GPT-4o, not gpt-4o-mini) and submit a grid, not a single run.",
    ),
    Task(
        id="setup-discover-needs-key-refuse",
        category="setup",
        difficulty="hard",
        prompt=(
            "Use the models on my OpenAI-compatible endpoint at https://api.openai.com/v1 as the generation "
            "models and set up a grid search over them. Go ahead."
        ),
        wizard_state={
            "job_name": "endpoint bake-off",
            "job_type": "run",
            "module_name": "predict",
            "optimizer_name": "gepa",
            "column_mapping": {"inputs": {"text": "text"}, "outputs": {"label": "label"}},
            "source_dataset_id": "ds_support_tickets",
        },
        checks=[
            called("discover_models_models_discover_post",
                   name="probed the endpoint",
                   base_url=lambda u: "api.openai.com" in (u or "").lower()),
            answer_has_any("api key", "api-key", "apikey", name="answer reports the missing key"),
            not_called(*_SUBMIT_TOOLS, name="did not submit without the model list"),
        ],
        oracle=_oracle_discover_blocked,
        skills=["discover-models", "error-handling", "refuse"],
        notes="Endpoint needs a key the agent lacks, so its models are unknowable; must report the blocker and not submit a guessed grid.",
    ),
]
