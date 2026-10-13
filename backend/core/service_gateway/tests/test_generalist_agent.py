"""Tests for the generalist-agent tool gating and approval registry."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, cast

import dspy
import litellm
import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from core.service_gateway.agents import generalist as generalist_module
from core.service_gateway.agents.code import _agent_error_payload, _SubmitArgExtractor
from core.service_gateway.agents.generalist import (
    GENERALIST_SYSTEM_PROMPT,
    ApprovalRegistry,
    WizardState,
    _needs_approval,
    _TurnAuthoringFlag,
    _wrap_tool_with_approval,
    approval_key,
    scope_wizard_tool,
    screen_snapshot,
    screen_tools,
    tools_for,
    validate_wizard_patch_order,
    validate_wizard_screen,
)
from core.storage.models import Base

_SUBMIT = "submit_unified_run_optimize_post"
_READY: dict[str, Any] = {
    "job_name": "My run",
    "task_objective": "Answer support questions",
    "artifact_kind": "prompt",
    "starting_version": "You are a helpful agent.",
    "data_mode": "pairs",
    "dataset_ready": True,
    "staged_dataset_id": "ds_1",
    "run_code": "def run(artifact, input):\n    return input['q']\n",
    "metric_code": "def score(input, output, expected=None):\n    return 1.0, {'feedback': ''}\n",
    "reflection_model_config": {"name": "openai/gpt-4o-mini"},
}


def test_empty_state_hides_dataset_and_submit_tools() -> None:
    """An empty wizard state hides dataset/code/submit tools, exposing only discovery."""
    allowed = tools_for(WizardState())
    assert "request_code_authoring" not in allowed
    assert "validate_code_validate_code_post" not in allowed
    assert _SUBMIT not in allowed
    assert "list_models_for_agent" in allowed


def test_removed_submit_tools_are_never_exposed() -> None:
    """The deleted /run, /grid-search and /blackbox/run tools never reappear."""
    allowed = tools_for(cast(WizardState, _READY))
    for removed in (
        "submit_job_run_post",
        "submit_grid_search_grid_search_post",
        "submit_blackbox_run_blackbox_run_post",
        "blackbox_scorer_dry_run_blackbox_scorer_dry_run_post",
    ):
        assert removed not in allowed


def test_comparison_tool_is_not_exposed() -> None:
    """Keep cross-optimization comparison out of every agent state."""
    assert "compare_jobs_optimizations_compare_post" not in tools_for(WizardState())


def test_dataset_ready_unlocks_diagnostics_but_not_code_authoring() -> None:
    """A staged dataset exposes the diagnostics; authoring waits for a named run with a task."""
    allowed = tools_for(WizardState(dataset_ready=True))
    assert "validate_code_validate_code_post" in allowed
    assert "profile_datasets_profile_post" in allowed
    assert "request_code_authoring" not in allowed
    assert _SUBMIT not in allowed


def test_named_run_with_task_unlocks_code_authoring() -> None:
    """Name plus objective, artifact kind and starting version opens code authoring."""
    state = {k: _READY[k] for k in ("job_name", "task_objective", "artifact_kind", "starting_version")}
    allowed = tools_for(cast(WizardState, state))
    assert "request_code_authoring" in allowed
    assert _SUBMIT not in allowed


def test_full_readiness_unlocks_submit() -> None:
    """Every step settled exposes the one submit tool."""
    assert _SUBMIT in tools_for(cast(WizardState, _READY))


def test_single_mode_needs_no_staged_dataset() -> None:
    """A single-input run carries its case inline, so no dataset is needed to submit."""
    state = {**_READY, "data_mode": "single"}
    state.pop("dataset_ready")
    state.pop("staged_dataset_id")
    assert _SUBMIT in tools_for(cast(WizardState, state))


def test_missing_any_submit_precondition_keeps_submit_hidden() -> None:
    """Dropping any single precondition keeps submit hidden."""
    criteria: dict[str, dict[str, Any]] = {
        "job_name": {"job_name": ""},
        "task_objective": {"task_objective": ""},
        "artifact_kind": {"artifact_kind": None},
        "starting_version": {"starting_version": ""},
        "data_mode": {"data_mode": None},
        "dataset": {"dataset_ready": False, "staged_dataset_id": None},
        "run_code": {"run_code": ""},
        "metric_code": {"metric_code": ""},
        "reflection_model": {"reflection_model_config": {}},
    }
    for label, overrides in criteria.items():
        state = {**_READY, **overrides}
        assert _SUBMIT not in tools_for(cast(WizardState, state)), f"submit leaked with {label} missing"


def test_order_allows_name_first() -> None:
    """Setting ``job_name`` on an empty wizard is in order (Basics is first)."""
    assert validate_wizard_patch_order({"job_name": "My run"}, WizardState()) is None


def test_order_rejects_task_before_name() -> None:
    """Task fields require the run to be named first (Basics)."""
    err = validate_wizard_patch_order({"task_objective": "x"}, WizardState())
    assert err is not None
    assert "Basics" in err


def test_order_allows_name_and_task_in_one_patch() -> None:
    """A single patch may set the name AND the task — each satisfies its own step."""
    patch = {"job_name": "My run", "task_objective": "x", "artifact_kind": "prompt", "starting_version": "s"}
    assert validate_wizard_patch_order(patch, WizardState()) is None


def test_order_rejects_inputs_before_task() -> None:
    """The data mode can't be set before the task is settled, even with a name set."""
    err = validate_wizard_patch_order({"data_mode": "pairs"}, WizardState(job_name="My run"))
    assert err is not None
    assert "Task" in err


def test_order_rejects_optimizer_before_inputs() -> None:
    """The Optimizer step is gated on the Inputs step."""
    state = {k: _READY[k] for k in ("job_name", "task_objective", "artifact_kind", "starting_version")}
    err = validate_wizard_patch_order({"optimizer_choice": "gepa"}, cast(WizardState, state))
    assert err is not None
    assert "Inputs" in err


def test_order_allows_optimizer_after_inputs() -> None:
    """With name, task and inputs settled, the optimizer and models are in order."""
    patch = {"optimizer_choice": "gepa", "reflection_model_config": {"name": "openai/gpt-4o"}}
    assert validate_wizard_patch_order(patch, cast(WizardState, _READY)) is None


def test_screen_allows_any_field_when_wizard_not_on_view() -> None:
    """Without ``wizard_screen`` the wizard is off screen and nothing is scoped."""
    assert validate_wizard_screen("update_wizard_state", {"optimizer_choice": "auto"}, WizardState()) is None


def test_screen_allows_visible_and_screenless_fields() -> None:
    """The brief screen takes its own fields plus the run's name and description."""
    patch = {"job_name": "My run", "job_description": "d", "task_objective": "x", "task_background": "b"}
    assert validate_wizard_screen("update_wizard_state", patch, WizardState(wizard_screen="brief")) is None


def test_screen_rejects_fields_off_the_visible_screen() -> None:
    """A field from another screen is refused and named in the error."""
    patch = {"task_objective": "x", "artifact_kind": "prompt", "data_mode": "pairs"}
    err = validate_wizard_screen("update_wizard_state", patch, WizardState(wizard_screen="brief"))
    assert err is not None
    assert "artifact_kind" in err
    assert "data_mode" in err
    assert "task_objective" in err.split("may set only", 1)[1]


def test_screen_plan_takes_engine_models_and_budget() -> None:
    """Standard's one plan screen holds the engine, the models and the budget."""
    patch = {
        "optimizer_choice": "auto",
        "model_config": {"name": "openai/gpt-4o"},
        "reflection_model_config": {"name": "openai/gpt-4o"},
        "spending_limit_usd": 5.0,
    }
    assert validate_wizard_screen("update_wizard_state", patch, WizardState(wizard_screen="plan")) is None
    err = validate_wizard_screen("update_wizard_state", patch, WizardState(wizard_screen="optimizer"))
    assert err is not None
    assert "spending_limit_usd" in err


def test_screen_allows_only_screenless_fields_on_a_screen_without_fields() -> None:
    """The check and overview screens hold no field, so only the name may change."""
    state = WizardState(wizard_screen="check")
    assert validate_wizard_screen("update_wizard_state", {"job_name": "n"}, state) is None
    assert validate_wizard_screen("update_wizard_state", {"seed": 1}, state) is not None


def test_screen_gates_code_authoring_to_the_metric_screen() -> None:
    """Run and metric code are written only while the metric screen is on view."""
    assert validate_wizard_screen("request_code_authoring", {"goal": ""}, WizardState(wizard_screen="metric")) is None
    err = validate_wizard_screen("request_code_authoring", {"goal": ""}, WizardState(wizard_screen="budget"))
    assert err is not None
    assert "metric" in err


@pytest.mark.asyncio
async def test_wrap_refuses_off_screen_patch_without_calling_tool() -> None:
    """The wrapper turns an off-screen patch into an error observation."""
    events: list[dict] = []
    tool = _wrap_tool_with_approval(
        _make_fake_tool("update_wizard_state", return_value="should not run"),
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=events.append,
        outer_loop=asyncio.get_running_loop(),
        wizard_state=cast(WizardState, {**_READY, "wizard_screen": "brief"}),
    )
    result = await tool.func._async_body(optimizer_choice="auto")
    assert result.startswith("Not on screen")
    end = next(e for e in events if e["event"] == "tool_end")
    assert end["data"]["status"] == "error"


@pytest.mark.asyncio
async def test_wrap_refuses_code_authoring_off_the_metric_screen() -> None:
    """``request_code_authoring`` never runs while another screen is on view."""
    events: list[dict] = []
    tool = _wrap_tool_with_approval(
        _make_fake_tool("request_code_authoring", return_value="should not run"),
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=events.append,
        outer_loop=asyncio.get_running_loop(),
        wizard_state=cast(WizardState, {**_READY, "wizard_screen": "source"}),
    )
    result = await tool.func._async_body(goal="")
    assert result.startswith("Not on screen")


def test_system_prompt_names_the_screen_rule() -> None:
    """The instructions tell the agent to edit only the screen on view."""
    prompt = GENERALIST_SYSTEM_PROMPT or ""
    assert "``wizard_state.wizard_screen`` names the wizard screen" in prompt


_FULL_SNAPSHOT: dict[str, Any] = {
    "job_name": "Tickets",
    "job_description": "d",
    "is_private": False,
    "task_objective": "Classify tickets",
    "task_background": "b",
    "artifact_kind": "prompt",
    "starting_version": "v1",
    "data_mode": "pairs",
    "dataset_ready": True,
    "input_fields": ["text"],
    "optimizer_choice": "auto",
    "model_config": {"name": "openai/gpt-4o"},
    "model_configured": True,
    "max_cost_cents": 500,
    "spending_limit_usd": 5,
    "run_code": "def run(): ...",
    "metric_code": "def metric(): ...",
}


@pytest.mark.parametrize(
    ("screen", "expected"),
    [
        ("brief", {"task_objective", "task_background"}),
        ("artifact", {"artifact_kind", "starting_version"}),
        ("source", {"data_mode"}),
        ("plan", {"optimizer_choice", "model_config", "spending_limit_usd"}),
        ("models", {"model_config"}),
        ("budget", {"spending_limit_usd"}),
        ("metric", set()),
        ("check", set()),
    ],
)
def test_screen_snapshot_keeps_only_the_screen_on_view(screen: str, expected: set[str]) -> None:
    """The prompt snapshot holds the visible screen's values and the screen id."""
    trimmed = screen_snapshot(cast(WizardState, {**_FULL_SNAPSHOT, "wizard_screen": screen}))
    assert set(trimmed) == expected | {"wizard_screen"}
    assert trimmed["wizard_screen"] == screen


def test_screen_snapshot_is_whole_without_a_screen() -> None:
    """Outside the wizard the agent still sees every value."""
    assert screen_snapshot(cast(WizardState, _FULL_SNAPSHOT)) == _FULL_SNAPSHOT


@pytest.mark.parametrize(("screen", "has_code_tool"), [("metric", True), ("brief", False), ("budget", False)])
def test_screen_tools_drop_other_screens_writers(screen: str, has_code_tool: bool) -> None:
    """``request_code_authoring`` is offered only on the metric screen."""
    allowed = {"update_wizard_state", "request_code_authoring", "list_jobs"}
    kept = screen_tools(allowed, WizardState(wizard_screen=screen))
    assert ("request_code_authoring" in kept) is has_code_tool
    assert {"update_wizard_state", "list_jobs"} <= kept


def test_screen_tools_unchanged_without_a_screen() -> None:
    """With no ``wizard_screen`` every tool ``tools_for`` allows stays."""
    allowed = {"update_wizard_state", "request_code_authoring"}
    assert screen_tools(allowed, WizardState()) == allowed


def _wizard_tool() -> dspy.Tool:
    """Build an ``update_wizard_state`` stand-in with a field per screen.

    Returns:
        A ``dspy.Tool`` whose arguments span several wizard screens.
    """

    def update_wizard_state(
        job_name: str = "",
        job_description: str = "",
        is_private: bool = False,
        task_objective: str = "",
        artifact_kind: str = "",
        optimizer_choice: str = "",
        spending_limit_usd: float = 0.0,
    ) -> str:
        """Patch the wizard."""
        return "ok"

    return dspy.Tool(update_wizard_state)


def test_scope_wizard_tool_names_only_current_screen_fields() -> None:
    """On the budget screen the tool takes the budget plus the screenless fields."""
    tool = scope_wizard_tool(_wizard_tool(), WizardState(wizard_screen="budget"))
    assert set(tool.args) == {"spending_limit_usd", "job_name", "job_description", "is_private"}
    assert "set only spending_limit_usd" in tool.desc
    assert "optimizer_choice" not in tool.desc


def test_scope_wizard_tool_unchanged_without_a_screen() -> None:
    """Outside the wizard the tool keeps every argument."""
    tool = scope_wizard_tool(_wizard_tool(), WizardState())
    assert "optimizer_choice" in tool.args
    assert "artifact_kind" in tool.args


def test_scope_wizard_tool_ignores_other_tools() -> None:
    """Only ``update_wizard_state`` is narrowed."""
    other = _make_fake_tool("list_jobs")
    before = dict(other.args)
    assert scope_wizard_tool(other, WizardState(wizard_screen="brief")).args == before


def test_system_prompt_keeps_screenless_fields_to_explicit_asks() -> None:
    """The instructions keep name/description/privacy edits to explicit asks."""
    prompt = GENERALIST_SYSTEM_PROMPT or ""
    assert "Set them only when the user asks for them this turn" in prompt
    assert "name that screen and ask them to move" in prompt


def test_order_ignores_unmapped_fields() -> None:
    """A patch with no step-mapped fields passes (code fields are rejected elsewhere)."""
    assert validate_wizard_patch_order({"run_code": "x"}, WizardState()) is None


def test_always_tools_include_discovery_and_post_submit() -> None:
    """The always-on toolset includes discovery and post-submit lifecycle tools."""
    allowed = tools_for(WizardState())
    assert "list_models_for_agent" in allowed
    assert "get_registry_snapshot_registry_get" in allowed
    assert "list_jobs_optimizations_get" in allowed
    assert "cancel_job_optimizations" in allowed
    assert "rename_job_optimizations" in allowed


def test_read_only_reach_tools_always_available() -> None:
    """Wallet and tagging-session reads are always-on and never gate."""
    allowed = tools_for(WizardState())
    assert "get_wallet_for_agent" in allowed
    assert "list_tagging_sessions_for_agent" in allowed
    for name in ("get_wallet_for_agent", "list_tagging_sessions_for_agent"):
        assert _needs_approval(name, "ask") is False


def test_dataset_library_tools_always_available() -> None:
    """The saved-dataset library read + by-reference picker are always exposed."""
    allowed = tools_for(WizardState())
    assert "list_datasets_for_agent" in allowed
    assert "request_user_dataset_from_library" in allowed


def test_pair_inference_trigger_always_available() -> None:
    """The pair inference trigger for stored grid runs is always exposed and never gates."""
    assert "request_user_pair_inference" in tools_for(WizardState())
    assert _needs_approval("request_user_pair_inference", "ask") is False


def test_yolo_never_gates() -> None:
    """Yolo trust-mode never gates any tool."""
    for name in ("delete_job_optimizations", "submit_unified_run_optimize_post", "rename_job_optimizations"):
        assert _needs_approval(name, "yolo") is False


def test_ask_gates_every_mutation() -> None:
    """Ask trust-mode gates every mutating tool."""
    assert _needs_approval("delete_job_optimizations", "ask") is True
    assert _needs_approval("rename_job_optimizations", "ask") is True
    assert _needs_approval("submit_unified_run_optimize_post", "ask") is True


def test_auto_safe_gates_only_destructive() -> None:
    """Auto-safe gates only destructive operations."""
    assert _needs_approval("rename_job_optimizations", "auto_safe") is False
    assert _needs_approval("toggle_pin_job_optimizations", "auto_safe") is False
    assert _needs_approval("delete_job_optimizations", "auto_safe") is True
    assert _needs_approval("submit_unified_run_optimize_post", "auto_safe") is True


def _make_fake_tool(name: str, return_value: str = "ok") -> dspy.Tool:
    """Build a ``dspy.Tool`` whose async ``func`` returns the given value."""

    async def func(**kwargs):
        return return_value

    return dspy.Tool(func=func, name=name, desc="test tool", args={}, arg_types={}, arg_desc={})


@pytest.mark.asyncio
async def test_wrap_bypasses_when_no_approval_needed() -> None:
    """Wrapped tool runs straight through when no approval is needed."""
    events: list[dict] = []
    registry = ApprovalRegistry()
    tool = _wrap_tool_with_approval(
        _make_fake_tool("rename_job_optimizations", return_value="renamed"),
        trust_mode="auto_safe",
        registry=registry,
        emit=events.append,
        outer_loop=asyncio.get_running_loop(),
    )
    # Drive the async body directly: the sync ``__call__`` schedules onto
    # ``outer_loop`` via ``run_coroutine_threadsafe`` for DSPy's worker-thread
    # dispatch, but inside the test loop we exercise the same logic by awaiting
    # ``_async_body`` so we don't deadlock blocking on the running loop.
    result = await tool.func._async_body()
    assert result == "renamed"
    event_names = [e["event"] for e in events]
    assert "pending_approval" not in event_names
    assert event_names == ["tool_start", "tool_end"]


@pytest.mark.asyncio
async def test_wrap_emits_pending_and_runs_on_approve() -> None:
    """Wrapped tool emits ``pending_approval`` and runs once approved."""
    events: list[dict] = []
    registry = ApprovalRegistry()
    tool = _wrap_tool_with_approval(
        _make_fake_tool("delete_job_optimizations", return_value="deleted"),
        trust_mode="ask",
        registry=registry,
        emit=events.append,
        outer_loop=asyncio.get_running_loop(),
    )
    call_task = asyncio.create_task(tool.func._async_body())
    for _ in range(20):
        await asyncio.sleep(0)
        if any(e["event"] == "pending_approval" for e in events):
            break
    pending = next((e for e in events if e["event"] == "pending_approval"), None)
    assert pending is not None
    call_id = pending["data"]["id"]
    assert registry.resolve(call_id, True) is True
    result = await call_task
    assert result == "deleted"
    resolved = next((e for e in events if e["event"] == "approval_resolved"), None)
    assert resolved is not None
    assert resolved["data"]["approved"] is True


@pytest.mark.asyncio
async def test_denial_returns_observation_not_exception() -> None:
    """A denied approval surfaces a string observation instead of raising."""
    events: list[dict] = []
    registry = ApprovalRegistry()
    tool = _wrap_tool_with_approval(
        _make_fake_tool("submit_unified_run_optimize_post", return_value="should not run"),
        trust_mode="ask",
        registry=registry,
        emit=events.append,
        outer_loop=asyncio.get_running_loop(),
    )
    call_task = asyncio.create_task(tool.func._async_body())
    for _ in range(20):
        await asyncio.sleep(0)
        if events:
            break
    call_id = events[0]["data"]["id"]
    registry.resolve(call_id, False)
    result = await call_task
    assert result == "User declined"


def _make_recording_tool(name: str) -> tuple[dspy.Tool, dict]:
    """Build a ``dspy.Tool`` whose async ``func`` records the kwargs it receives.

    Args:
        name: Registered tool name.

    Returns:
        The tool and the dict its ``func`` populates with received kwargs.
    """
    seen: dict = {}

    async def func(**kwargs):
        seen.update(kwargs)
        return "ok"

    tool = dspy.Tool(func=func, name=name, desc="test tool", args={}, arg_types={}, arg_desc={})
    return tool, seen


@pytest.mark.asyncio
async def test_submit_fills_unified_payload_from_snapshot() -> None:
    """Submit builds the unified request from the wizard snapshot."""
    tool, seen = _make_recording_tool(_SUBMIT)
    _wrap_tool_with_approval(
        tool,
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=lambda _e: None,
        outer_loop=asyncio.get_running_loop(),
        staged_dataset_id="ds_1",
        wizard_state=cast(
            WizardState,
            {
                **_READY,
                "task_background": "Tier-1 support",
                "input_fields": ["q"],
                "expected_field": "a",
                "optimizer_choice": "gepa",
                "split_fractions": {"train": 0.6, "val": 0.2, "test": 0.2},
                "seed": 7,
            },
        ),
    )
    await tool.func._async_body()
    assert seen["name"] == "My run"
    assert seen["task"] == {
        "objective": "Answer support questions",
        "background": "Tier-1 support",
        "artifact": {"kind": "prompt", "starting_version": "You are a helpful agent."},
    }
    assert seen["data"] == {
        "mode": "pairs",
        "staged_dataset_id": "ds_1",
        "input_fields": ["q"],
        "expected_field": "a",
        "split": {"train": 0.6, "val": 0.2, "test": 0.2},
    }
    assert seen["optimizer"] == {"choice": "gepa"}
    assert seen["models"] == {"reflection_model": {"name": "openai/gpt-4o-mini"}}
    assert seen["workspace"] == {"run_code": _READY["run_code"], "metric_code": _READY["metric_code"]}
    assert seen["seed"] == 7
    assert seen["is_private"] is True


@pytest.mark.asyncio
async def test_submit_injects_snapshot_code_over_agent_supplied() -> None:
    """Workspace code always comes from the snapshot, discarding what the agent typed."""
    tool, seen = _make_recording_tool(_SUBMIT)
    _wrap_tool_with_approval(
        tool,
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=lambda _e: None,
        outer_loop=asyncio.get_running_loop(),
        wizard_state=cast(WizardState, {"run_code": "good_run", "metric_code": "good_metric"}),
    )
    await tool.func._async_body(workspace={"run_code": "BROKEN {", "metric_code": "bad", "install_command": "pip x"})
    assert seen["workspace"] == {"run_code": "good_run", "metric_code": "good_metric", "install_command": "pip x"}


@pytest.mark.asyncio
async def test_submit_keeps_agent_supplied_values() -> None:
    """Agent-supplied name, description, seed and optimizer win over the snapshot."""
    tool, seen = _make_recording_tool(_SUBMIT)
    _wrap_tool_with_approval(
        tool,
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=lambda _e: None,
        outer_loop=asyncio.get_running_loop(),
        wizard_state=cast(
            WizardState,
            {"job_name": "wizard", "job_description": "wizard", "seed": 1, "optimizer_choice": "gepa"},
        ),
    )
    await tool.func._async_body(name="agent", description="agent", seed=2, optimizer={"choice": "best_of_n"})
    assert seen["name"] == "agent"
    assert seen["description"] == "agent"
    assert seen["seed"] == 2
    assert seen["optimizer"] == {"choice": "best_of_n"}


@pytest.mark.asyncio
async def test_submit_injects_wizard_description() -> None:
    """Submit carries the wizard's job_description — stripped and clipped to 280."""
    tool, seen = _make_recording_tool(_SUBMIT)
    _wrap_tool_with_approval(
        tool,
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=lambda _e: None,
        outer_loop=asyncio.get_running_loop(),
        wizard_state=cast(WizardState, {"job_description": "  " + "x" * 300 + "  "}),
    )
    await tool.func._async_body()
    assert seen["description"] == "x" * 280


@pytest.mark.asyncio
async def test_submit_inline_cases_suppress_staged_id() -> None:
    """Cases the agent passes inline are not overridden by the staged dataset id."""
    tool, seen = _make_recording_tool(_SUBMIT)
    _wrap_tool_with_approval(
        tool,
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=lambda _e: None,
        outer_loop=asyncio.get_running_loop(),
        staged_dataset_id="ds_1",
        wizard_state=cast(WizardState, {"data_mode": "single"}),
    )
    await tool.func._async_body(data={"cases": [{"input": {"q": "hi"}}]})
    assert seen["data"] == {"cases": [{"input": {"q": "hi"}}], "mode": "single"}


@pytest.mark.asyncio
async def test_submit_defaults_to_private() -> None:
    """Submit forces ``is_private`` to private when the snapshot never set it."""
    tool, seen = _make_recording_tool(_SUBMIT)
    _wrap_tool_with_approval(
        tool,
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=lambda _e: None,
        outer_loop=asyncio.get_running_loop(),
        wizard_state=cast(WizardState, {}),
    )
    await tool.func._async_body(is_private=False)
    assert seen["is_private"] is True


@pytest.mark.asyncio
async def test_submit_respects_explicit_public() -> None:
    """A snapshot ``is_private=False`` (user asked for public) reaches submit."""
    tool, seen = _make_recording_tool(_SUBMIT)
    _wrap_tool_with_approval(
        tool,
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=lambda _e: None,
        outer_loop=asyncio.get_running_loop(),
        wizard_state=cast(WizardState, {"is_private": False}),
    )
    await tool.func._async_body()
    assert seen["is_private"] is False


@pytest.mark.asyncio
async def test_non_submit_tool_does_not_inject_code() -> None:
    """Code injection is scoped to the submit tool; other tools are untouched."""
    tool, seen = _make_recording_tool("update_wizard_state")
    _wrap_tool_with_approval(
        tool,
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=lambda _e: None,
        outer_loop=asyncio.get_running_loop(),
        wizard_state=cast(WizardState, {"run_code": "snap", "metric_code": "snap"}),
    )
    await tool.func._async_body(job_name="x")
    assert "workspace" not in seen


@pytest.mark.asyncio
async def test_profile_injects_staged_dataset_id() -> None:
    """Profiling a staged dataset gets the opaque id injected so the backend rehydrates."""
    tool, seen = _make_recording_tool("profile_datasets_profile_post")
    _wrap_tool_with_approval(
        tool,
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=lambda _e: None,
        outer_loop=asyncio.get_running_loop(),
        staged_dataset_id="ds_123",
        wizard_state=cast(WizardState, {}),
    )
    await tool.func._async_body(column_mapping={"inputs": {}, "outputs": {}})
    assert seen["staged_dataset_id"] == "ds_123"


@pytest.mark.asyncio
async def test_profile_inline_dataset_not_overridden_by_staged_id() -> None:
    """An inline dataset on the profile call suppresses staged-id injection."""
    tool, seen = _make_recording_tool("profile_datasets_profile_post")
    _wrap_tool_with_approval(
        tool,
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=lambda _e: None,
        outer_loop=asyncio.get_running_loop(),
        staged_dataset_id="ds_123",
        wizard_state=cast(WizardState, {}),
    )
    await tool.func._async_body(dataset=[{"q": "x"}], column_mapping={"inputs": {}, "outputs": {}})
    assert "staged_dataset_id" not in seen


def test_registry_resolve_unknown_returns_false() -> None:
    """Resolving an unknown call id returns ``False``."""
    registry = ApprovalRegistry()
    assert registry.resolve("does-not-exist", True) is False


def test_submit_arg_extractor_streams_value_incrementally() -> None:
    """Incremental chunks of a submit tool_calls payload yield growing deltas."""
    ext = _SubmitArgExtractor("assistant_message")
    deltas: list[str] = []
    for chunk in (
        '{"tool_calls": [',
        '{"name": "submit", "args": ',
        '{"assistant_message": "',
        "Shal",
        "om, ",
        "Gilad",
        '!"}}]}',
    ):
        delta = ext.feed(chunk)
        if delta:
            deltas.append(delta)
    assert "".join(deltas) == "Shalom, Gilad!"


def test_submit_arg_extractor_ignores_non_submit_calls() -> None:
    """A non-submit tool call produces no delta, and reset clears the buffer."""
    ext = _SubmitArgExtractor("assistant_message")
    assert ext.feed('{"tool_calls": [{"name": "list_models", "args": {}}]}') is None
    ext.reset()
    delta = ext.feed('{"tool_calls": [{"name": "submit", "args": {"assistant_message": "Done!"}}]}')
    assert delta == "Done!"


def test_submit_arg_extractor_handles_malformed_json() -> None:
    """A partial / malformed chunk returns ``None`` without raising."""
    ext = _SubmitArgExtractor("reply")
    assert ext.feed('{"tool_calls": [{"name": "submit') is None


def test_submit_arg_extractor_picks_submit_among_parallel_calls() -> None:
    """Parallel tool calls including submit still resolve to the submit arg."""
    ext = _SubmitArgExtractor("reply")
    parallel = '{"tool_calls": [{"name": "foo", "args": {}}, {"name": "submit", "args": {"reply": "yo"}}]}'
    assert ext.feed(parallel) == "yo"


def test_submit_arg_extractor_is_idempotent_on_repeat_feed() -> None:
    """Re-feeding the same buffer or an empty chunk yields no new delta."""
    ext = _SubmitArgExtractor("reply")
    full = '{"tool_calls": [{"name": "submit", "args": {"reply": "hi"}}]}'
    assert ext.feed(full) == "hi"
    assert ext.feed("") is None


@pytest.mark.asyncio
async def test_submit_blocked_when_authoring_requested_same_turn() -> None:
    """A submit that follows request_code_authoring in one turn is denied.

    ``request_code_authoring`` writes its authored code back to the wizard
    asynchronously, so the new run and metric code is not in this turn's snapshot.
    The shared turn flag must cause the same-turn submit to short-circuit with
    a denial observation rather than ship stale code into a doomed run.
    """
    flag = _TurnAuthoringFlag()
    authoring, _ = _make_recording_tool("request_code_authoring")
    submit, submit_seen = _make_recording_tool("submit_unified_run_optimize_post")
    common = {
        "trust_mode": "yolo",
        "registry": ApprovalRegistry(),
        "emit": lambda _e: None,
        "outer_loop": asyncio.get_running_loop(),
        "wizard_state": cast(WizardState, {}),
        "authoring_flag": flag,
    }
    _wrap_tool_with_approval(authoring, **common)
    _wrap_tool_with_approval(submit, **common)

    await authoring.func._async_body(goal="fix the run code")
    result = await submit.func._async_body(name="My run")

    assert "Submit blocked" in result
    assert submit_seen == {}


@pytest.mark.asyncio
async def test_submit_runs_when_no_authoring_this_turn() -> None:
    """Submit runs normally when request_code_authoring did NOT fire this turn.

    The happy path — submit on a later turn, once the authored code is in the
    snapshot — must be unaffected by the same-turn backstop.
    """
    flag = _TurnAuthoringFlag()
    submit, submit_seen = _make_recording_tool("submit_unified_run_optimize_post")
    _wrap_tool_with_approval(
        submit,
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=lambda _e: None,
        outer_loop=asyncio.get_running_loop(),
        wizard_state=cast(WizardState, {}),
        authoring_flag=flag,
    )
    result = await submit.func._async_body(name="My run")
    assert result == "ok"
    assert submit_seen["name"] == "My run"


def test_system_prompt_forbids_submit_in_authoring_turn() -> None:
    """The system prompt must keep the never-submit-in-an-authoring-turn rule.

    Guards against a future prompt edit silently dropping the ordering rule that
    is the primary defense for this bug.
    """
    prompt = GENERALIST_SYSTEM_PROMPT or ""
    assert "NEVER call ``submit_unified_run_optimize_post`` in the SAME turn as" in prompt
    assert "request_code_authoring" in prompt


def _approval_engine():
    """In-memory shared-across-threads SQLite engine with the ORM schema."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return engine


def test_resolve_or_persist_without_engine_rejects_unknown_id() -> None:
    """Store-less registries keep the old contract: unknown id is unresolved."""
    registry = ApprovalRegistry()
    assert registry.resolve_or_persist("nope", True) is False


@pytest.mark.asyncio
async def test_confirm_on_another_replica_reaches_waiting_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A decision persisted by one replica resolves another replica's wait loop."""
    monkeypatch.setattr(generalist_module, "_DURABLE_POLL_SECONDS", 0.01)
    engine = _approval_engine()
    streaming = ApprovalRegistry()
    streaming.bind_engine(engine)
    confirming = ApprovalRegistry()
    confirming.bind_engine(engine)

    fut = streaming.register("call-cross")
    # The confirming replica holds no future for this id — it must persist.
    assert confirming.resolve_or_persist("call-cross", True) is True
    assert await streaming.wait_for_decision("call-cross", fut) is True
    # The decision row is consumed on delivery.
    assert streaming._take_durable("call-cross") is None


@pytest.mark.asyncio
async def test_wait_for_decision_expires_as_declined(monkeypatch: pytest.MonkeyPatch) -> None:
    """A confirm that never arrives expires the wait as a decline, not a hang."""
    monkeypatch.setattr(generalist_module, "APPROVAL_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(generalist_module, "_DURABLE_POLL_SECONDS", 0.01)
    registry = ApprovalRegistry()
    fut = registry.register("call-lost")
    assert await registry.wait_for_decision("call-lost", fut) is False


@pytest.mark.asyncio
async def test_local_resolve_still_wins_instantly(monkeypatch: pytest.MonkeyPatch) -> None:
    """The in-process fast path resolves without touching the durable store."""
    registry = ApprovalRegistry()
    fut = registry.register("call-local")
    task = asyncio.create_task(registry.wait_for_decision("call-local", fut))
    await asyncio.sleep(0)
    assert registry.resolve_or_persist("call-local", False) is True
    assert await task is False


def test_agent_error_payload_flags_litellm_context_overflow() -> None:
    """litellm's typed context-window error carries the machine code."""
    exc = litellm.ContextWindowExceededError(
        "The prompt exceeds the model limit", model="gpt-4o", llm_provider="openai"
    )
    payload = _agent_error_payload(exc)
    assert payload["code"] == "context_too_long"
    assert payload["error"]


def test_agent_error_payload_flags_provider_overflow_message() -> None:
    """An untyped provider 400 mentioning context length is classified too."""
    exc = RuntimeError(
        "BadRequestError: This model's maximum context length is 128000 tokens, however you requested 191694 tokens"
    )
    assert _agent_error_payload(exc)["code"] == "context_too_long"


def test_agent_error_payload_walks_groups_and_causes() -> None:
    """The classifier sees through exception groups and __cause__ chains."""
    inner = ValueError("prompt is too long: 250000 tokens > 200000 maximum")
    wrapper = RuntimeError("agent turn failed")
    wrapper.__cause__ = inner
    group = BaseExceptionGroup("unhandled errors in a TaskGroup", [wrapper])
    assert _agent_error_payload(group)["code"] == "context_too_long"


def test_agent_error_payload_plain_error_has_no_code() -> None:
    """Unclassified failures keep the text-only payload."""
    payload = _agent_error_payload(RuntimeError("boom"))
    assert payload == {"error": "RuntimeError: boom"}


def test_always_on_catalog_and_lifecycle_tools_are_reachable() -> None:
    """Sample datasets, the engine and optimizer catalogs, and pause/resume/restart need no wizard progress."""
    allowed = tools_for(cast(WizardState, {}))
    assert {
        "list_sample_datasets_datasets_samples_get",
        "stage_sample_dataset_datasets_samples",
        "blackbox_engines_blackbox_engines_get",
        "optimizer_catalog_optimizers_get",
        "pause_job_optimizations",
        "resume_job_optimizations",
        "restart_job_optimizations",
    } <= allowed


def test_trust_gating_of_lifecycle_and_submit_tools() -> None:
    """Balance-spending tools gate in auto-safe; pause and samples only gate in ask."""
    for tool in ("resume_job_optimizations", "restart_job_optimizations", _SUBMIT):
        assert _needs_approval(tool, "auto_safe") is True
        assert _needs_approval(tool, "yolo") is False
    for tool in ("pause_job_optimizations", "stage_sample_dataset_datasets_samples"):
        assert _needs_approval(tool, "ask") is True
        assert _needs_approval(tool, "auto_safe") is False


def test_approval_key_binds_to_owner() -> None:
    """Different owners derive different keys; an owner-less caller keeps the bare id."""
    assert approval_key("abc123", None) == "abc123"
    alice = approval_key("abc123", "alice")
    assert alice.startswith("abc123.")
    assert alice != approval_key("abc123", "bob")
    assert alice == approval_key("abc123", "alice")
    assert len(alice) <= 45


@pytest.mark.asyncio
async def test_pending_approval_resolves_only_with_owner_key() -> None:
    """The bare call id from the event cannot resolve an owner-bound approval."""
    events: list[dict] = []
    registry = ApprovalRegistry()
    tool = _wrap_tool_with_approval(
        _make_fake_tool("delete_job_optimizations", return_value="deleted"),
        trust_mode="ask",
        registry=registry,
        emit=events.append,
        outer_loop=asyncio.get_running_loop(),
        approval_owner="alice",
    )
    call_task = asyncio.create_task(tool.func._async_body())
    for _ in range(20):
        await asyncio.sleep(0)
        if any(e["event"] == "pending_approval" for e in events):
            break
    call_id = next(e for e in events if e["event"] == "pending_approval")["data"]["id"]
    assert registry.resolve(call_id, True) is False
    assert registry.resolve(approval_key(call_id, "bob"), True) is False
    assert registry.resolve(approval_key(call_id, "alice"), True) is True
    assert await call_task == "deleted"


@pytest.mark.asyncio
async def test_sample_staging_keeps_an_existing_job_name() -> None:
    """A staged sample names an unnamed run but never renames a named one."""
    loop = asyncio.get_running_loop()
    staged = '{"sample_id": "s", "wizard_state": {"job_name": "Sample", "dataset_ready": true}}'

    async def emitted_patch(state: dict[str, Any], *, name_first: bool) -> dict[str, Any]:
        """Stage a sample and return the ``wizard_state`` patch the panel receives.

        Args:
            state: The turn-start wizard snapshot.
            name_first: Whether the agent names the run earlier in the same turn.

        Returns:
            The patch carried by the staging tool's ``tool_end`` event.
        """
        events: list[dict[str, Any]] = []
        flag = _TurnAuthoringFlag()

        def wrap(tool: dspy.Tool) -> dspy.Tool:
            """Wrap a tool on the shared turn flag.

            Args:
                tool: The tool to wrap.

            Returns:
                The wrapped tool.
            """
            return _wrap_tool_with_approval(
                tool,
                trust_mode="yolo",
                registry=ApprovalRegistry(),
                emit=events.append,
                outer_loop=loop,
                authoring_flag=flag,
                wizard_state=cast(WizardState, state),
            )

        if name_first:
            await wrap(_make_fake_tool("update_wizard_state")).func._async_body(job_name="Mine")
        await wrap(_make_fake_tool("stage_sample_dataset_datasets_samples", return_value=staged)).func._async_body(
            sample_id="s"
        )
        return events[-1]["data"]["result"]["wizard_state"]

    assert await emitted_patch({}, name_first=False) == {"job_name": "Sample", "dataset_ready": True}
    assert await emitted_patch({"job_name": "Mine"}, name_first=False) == {"dataset_ready": True}
    assert await emitted_patch({}, name_first=True) == {"dataset_ready": True}


def test_system_prompt_covers_new_capabilities() -> None:
    """The prompt names the unified setup fields and tools the agent now supports."""
    prompt = GENERALIST_SYSTEM_PROMPT or ""
    for needle in ("optimizer_catalog", "artifact_kind", "data_mode", "run_code", "validate_datasets", "restart"):
        assert needle in prompt


class _ScriptedLM(dspy.BaseLM):
    """An LM that records every request and answers with scripted native tool calls."""

    def __init__(self, script: list[tuple[str, dict[str, Any]]]) -> None:
        """Store the script.

        Args:
            script: One ``(tool name, arguments)`` pair per expected LM call.
        """
        super().__init__(model="scripted")
        self._script = list(script)
        self.requests: list[dict[str, Any]] = []

    @property
    def supports_function_calling(self) -> bool:
        """Report native tool-call support."""
        return True

    @property
    def supports_reasoning(self) -> bool:
        """Report native reasoning support."""
        return True

    def forward(self, prompt=None, messages=None, **kwargs):
        """Record the request and return the next scripted tool call.

        Args:
            prompt: Unused legacy prompt.
            messages: The rendered chat messages.
            **kwargs: Provider kwargs, including ``tools``.

        Returns:
            An OpenAI-shaped response carrying one tool call.
        """
        self.requests.append({"messages": messages, **kwargs})
        name, args = self._script.pop(0)
        call = {
            "id": f"call_{len(self.requests)}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)},
        }
        message = {"role": "assistant", "content": None, "tool_calls": [call]}
        return litellm.ModelResponse(
            model="scripted",
            choices=[{"index": 0, "finish_reason": "tool_calls", "message": message}],
            usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        )


class _Spec:
    """A minimal MCP tool listing entry."""

    def __init__(self, name: str) -> None:
        """Name the tool.

        Args:
            name: The tool's MCP name.
        """
        self.name = name
        self.description = "test tool"
        self.inputSchema = {"type": "object", "properties": {}}


class _Listing:
    """What a fake MCP session's ``list_tools`` returns."""

    def __init__(self, names: list[str]) -> None:
        """Wrap the tool specs.

        Args:
            names: The listed tool names.
        """
        self.tools = [_Spec(name) for name in names]


class _FakeSession:
    """An MCP session that only lists tools."""

    def __init__(self, names: list[str]) -> None:
        """Remember which tools to list.

        Args:
            names: The listed tool names.
        """
        self._names = names

    async def list_tools(self) -> _Listing:
        """List the configured tools."""
        return _Listing(self._names)


async def test_turn_replays_history_natively_and_streams_the_submit(monkeypatch: pytest.MonkeyPatch) -> None:
    """A turn runs on the conversation loop: earlier turns and their tool trace precede the new one as messages.

    Also covers the native-tool-call gap the CLI bridge used to close: a
    ``null`` optional never reaches the gated tool.
    """
    tool, seen = _make_recording_tool("list_models_for_agent")
    seen["untouched"] = True

    @asynccontextmanager
    async def fake_session(mcp_url: str, *, auth_header: str | None = None) -> AsyncIterator[_FakeSession]:
        """Yield the fake session in place of a Streamable-HTTP client.

        Args:
            mcp_url: Ignored.
            auth_header: Ignored.
        """
        yield _FakeSession(["list_models_for_agent", "submit_unified_run_optimize_post"])

    monkeypatch.setattr(generalist_module, "_mcp_session", fake_session)
    monkeypatch.setattr(dspy.Tool, "from_mcp_tool", staticmethod(lambda session, spec: tool))
    lm = _ScriptedLM([("list_models_for_agent", {"limit": None}), ("submit", {"assistant_message": "הנה המודלים"})])
    events: list[dict] = []

    reply = await generalist_module._drive_generalist_agent(
        mcp_url="http://unused/mcp/",
        wizard_state=WizardState(),
        chat_history=[
            {"role": "user", "content": "hi"},
            {
                "role": "assistant",
                "content": "hello",
                "tools": [{"tool": "get_registry_snapshot", "status": "done", "result": "{}"}],
            },
        ],
        user_message="which models?",
        trust_mode="yolo",
        registry=ApprovalRegistry(),
        emit=events.append,
        lm=lm,
        reply_language="Hebrew",
    )

    assert reply == "הנה המודלים"
    assert seen == {"untouched": True}
    first = lm.requests[0]["messages"]
    assert [m["role"] for m in first] == ["system", "user", "assistant", "tool", "assistant", "tool", "user"]
    assert first[2]["tool_calls"][0]["function"]["name"] == "get_registry_snapshot"
    assert first[4]["tool_calls"][0]["function"]["name"] == "submit"
    assert "which models?" in first[-1]["content"]
    assert "hello" not in first[1]["content"]
    assert [t["function"]["name"] for t in lm.requests[0]["tools"]] == ["list_models_for_agent", "submit"]
    # The second request only appends to the first: the cacheable prefix holds.
    assert lm.requests[1]["messages"][: len(first)] == first
    assert events[0]["event"] == "turn_metadata"
    assert events[0]["data"]["allowed_tools"] == ["list_models_for_agent"]
    assert [e["event"] for e in events if e["event"] in ("tool_start", "tool_end")] == ["tool_start", "tool_end"]
