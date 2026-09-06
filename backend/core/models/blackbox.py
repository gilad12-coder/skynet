"""Request/response models for black-box text optimization jobs.

A black-box job optimizes any text artifact (a prompt, a policy, a config
file, a piece of code) against a user-supplied scorer, with no DSPy program
in the loop. The contract mirrors GEPA's ``optimize_anything`` surface —
starting point, cases, scorer, budget — plus execution location and model
routing for the pinned upstream engines and compositions.

Pydantic class docstrings are part of the OpenAPI contract — see AGENTS.md
"Pydantic class docstrings" — so per-model annotations live in comments
above each class, not in class bodies.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .common import ModelConfig, SplitCounts, SplitFractions
from .results import LMActivity, ModelTokenUsage
from .scorer_dependencies import ScorerDependencyLock

BLACKBOX_ENGINE_GEPA = "gepa"
BLACKBOX_ENGINE_BEST_OF_N = "best_of_n"
BLACKBOX_ENGINE_AUTORESEARCH = "autoresearch"
BLACKBOX_ENGINE_META_HARNESS = "meta_harness"
BLACKBOX_STRATEGY_AUTO = "auto"
BLACKBOX_STRATEGY_PLATEAU = "plateau"
BLACKBOX_TARGET_TEXT = "text"
BLACKBOX_TARGET_AGENT = "agent"
BLACKBOX_HARNESS_PI = "pi"
BLACKBOX_HARNESS_CODEX = "codex"
BLACKBOX_HARNESS_CLAUDE_CODE = "claude_code"
BLACKBOX_HARNESS_OPENCODE = "opencode"
BLACKBOX_HARNESS_PRIME = "prime"
BLACKBOX_HARNESS_CUSTOM = "custom"
BLACKBOX_HARNESSES = (
    BLACKBOX_HARNESS_PI,
    BLACKBOX_HARNESS_CODEX,
    BLACKBOX_HARNESS_CLAUDE_CODE,
    BLACKBOX_HARNESS_OPENCODE,
    BLACKBOX_HARNESS_PRIME,
    BLACKBOX_HARNESS_CUSTOM,
)
# Engines that accept a multi-part (named files) starting point.
BLACKBOX_MULTI_PART_ENGINES = frozenset({BLACKBOX_ENGINE_GEPA})
# Stands in for ``module_name`` in the job overview and notifications, where
# DSPy jobs record the program they optimized.
BLACKBOX_MODULE_NAME = "blackbox"

# A text artifact under optimization. ``dict`` form names several parts that
# are optimized together (the pinned GEPA engine only).
BlackboxCandidate = str | dict[str, str]


# How a version is scored. ``python`` runs ``metric_code`` inside the managed
# sandbox; ``remote`` POSTs the version and case to ``url`` through the trusted
# parent relay with the
# shared ``secret`` as a bearer token (TODO-1: allow-list + SSRF guard).
# ``model`` is the model a python scorer may call through the injected
# ``llm(prompt, input=None)`` helper (e.g. to run the prompt under
# optimization on a case); its usage is billed with the run.
# ``install_command`` runs inside the offline managed sandbox. It may use
# dependencies already in the immutable image or deployment-owned package
# artifacts; it cannot reach a public package registry at run time.
class BlackboxScorer(BaseModel):
    kind: Literal["python", "remote"] = "python"
    metric_code: str | None = None
    url: str | None = None
    secret: str | None = None
    timeout_seconds: float = Field(default=60.0, gt=0, le=600)
    install_command: str | None = None
    dependency_lock: ScorerDependencyLock | None = None
    model: ModelConfig | None = None

    @model_validator(mode="after")
    def _ensure_kind_fields(self) -> BlackboxScorer:
        """Require the field the chosen scorer kind reads from.

        Returns:
            The validated scorer instance.

        Raises:
            ValueError: When a python scorer has no code or a remote scorer
                has no URL.
        """
        if self.kind == "python" and not (self.metric_code or "").strip():
            raise ValueError("A python scorer needs metric_code.")
        if self.kind == "remote" and not (self.url or "").strip():
            raise ValueError("A remote scorer needs a url.")
        return self


# Hard stops for a run. ``max_scorer_runs`` caps optimizer-driven scorer
# calls (the baseline/final test-set evaluations are outside the cap);
# ``max_iterations`` caps proposer rounds for the engines that iterate
# (Meta-Harness); ``stop_at_score`` ends the run early once a version
# reaches it.
class BlackboxBudget(BaseModel):
    max_scorer_runs: int = Field(default=200, ge=1, le=100_000)
    max_iterations: int | None = Field(default=None, ge=1, le=1_000)
    stop_at_score: float | None = None


# What the versions under optimization drive. ``text``: the scorer reads a
# version directly. ``agent``: every scorer run launches a coding harness in a
# private workspace inside the run's managed sandbox, with the version as the
# harness's instruction file(s), and the scorer judges the run record (what
# the agent produced) instead of the version. The ``(harness, model)`` pair is fixed
# for the whole run — the optimizer searches harness text only (joint
# harness + model search is a TODO). ``model`` is the target/worker model
# id as the agent gateway knows it; the optimizer model is
# ``reflection_model_config`` on the request. Clients also send the full
# target role as ``task_model_config`` on the request so its credential source
# can be metered independently; ``model`` remains for stored-client compatibility.
class BlackboxTarget(BaseModel):
    kind: Literal["text", "agent"] = BLACKBOX_TARGET_TEXT
    harness: str = BLACKBOX_HARNESS_PI
    model: str | None = None
    timeout_seconds: float = Field(default=600.0, gt=0, le=2_700)
    concurrency: int = Field(default=2, ge=1, le=8)
    setup_command: str | None = None
    install_command: str | None = None
    run_command: str | None = None

    @model_validator(mode="after")
    def _ensure_agent_fields(self) -> BlackboxTarget:
        """Require what an agent target needs to launch.

        Returns:
            The validated target instance.

        Raises:
            ValueError: When an agent target names no model or an unknown
                harness, or a custom harness has no run command.
        """
        if self.kind != BLACKBOX_TARGET_AGENT:
            return self
        if not (self.model or "").strip():
            raise ValueError("An agent target needs a model.")
        if self.harness not in BLACKBOX_HARNESSES:
            raise ValueError(f"Unknown harness '{self.harness}'. Known harnesses: {', '.join(BLACKBOX_HARNESSES)}.")
        if self.harness == BLACKBOX_HARNESS_CUSTOM and not (self.run_command or "").strip():
            raise ValueError("A custom harness needs a run_command.")
        return self


# ``auto`` explores every available engine on a budget slice, then continues
# from the best version with GEPA; ``single`` runs one named engine;
# ``plateau`` relays over the available engines in Auto's order, handing the
# best version to the next engine whenever ``patience`` scorer runs pass
# without improvement, until the budget, the target score or a full round
# without progress.
class BlackboxStrategy(BaseModel):
    mode: Literal["auto", "single", "plateau"] = "auto"
    engine: str | None = None
    patience: int = Field(default=40, ge=5, le=10_000)

    @model_validator(mode="after")
    def _ensure_engine_for_single(self) -> BlackboxStrategy:
        """Require an engine id when a single engine is requested.

        Returns:
            The validated strategy instance.

        Raises:
            ValueError: When ``mode`` is ``single`` and no engine is named.
        """
        if self.mode == "single" and not (self.engine or "").strip():
            raise ValueError("strategy.engine is required when mode is 'single'.")
        return self


# Submission payload for ``POST /blackbox/run``. Not a subclass of the DSPy
# request base: there is no module, signature or column mapping here.
class BlackboxRunRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str | None = None
    description: str | None = Field(default=None, max_length=280)
    username: str | None = None
    objective: str | None = None
    background: str | None = None
    # Which wizard recipe authored the run ("prompt" / "code" / "anything").
    # Engines ignore it; cloning reads it back to preselect the recipe picker.
    recipe: Literal["prompt", "code", "anything"] | None = None
    seed_candidate: BlackboxCandidate | None = None
    scorer: BlackboxScorer
    cases: list[dict[str, Any]] | None = Field(default=None, max_length=200_000)
    split_fractions: SplitFractions = Field(default_factory=SplitFractions)
    shuffle: bool = True
    seed: int | None = None
    budget: BlackboxBudget = Field(default_factory=BlackboxBudget)
    strategy: BlackboxStrategy = Field(default_factory=BlackboxStrategy)
    target: BlackboxTarget = Field(default_factory=BlackboxTarget)
    proposer_runtime: Literal["vercel"] = "vercel"
    task_model_settings: ModelConfig | None = Field(default=None, alias="task_model_config")
    reflection_model_settings: ModelConfig = Field(alias="reflection_model_config")
    token_source: Literal["managed", "byok"] = "managed"
    is_private: bool = False
    preflight_id: str | None = Field(default=None, min_length=1, max_length=64)
    preflight_fingerprint: str | None = Field(default=None, min_length=1, max_length=128)
    execution_budget_id: str | None = Field(default=None, min_length=1, max_length=64)
    execution_budget_revision: int | None = Field(default=None, ge=1)
    execution_budget_generation: int | None = Field(default=None, ge=0)
    max_cost_credits: int | None = Field(default=None, ge=1)
    estimated_credits_low: int | None = Field(default=None, ge=0)
    estimated_credits_high: int | None = Field(default=None, ge=0)

    @model_validator(mode="before")
    @classmethod
    def _normalize_proposer_runtime(cls, data: Any) -> Any:
        """Map the retired worker selection onto the managed sandbox.

        Args:
            data: Raw request data before field validation.

        Returns:
            A copied mapping with the canonical Vercel runtime when the
            retired worker value was supplied, otherwise the input unchanged.
        """
        if isinstance(data, dict) and data.get("proposer_runtime") == "worker":
            return {**data, "proposer_runtime": "vercel"}
        return data

    @model_validator(mode="after")
    def _ensure_starting_point(self) -> BlackboxRunRequest:
        """Reject starting points and limits the selected engine cannot honor.

        Returns:
            The validated request instance.

        Raises:
            ValueError: When the seed is blank, an empty dict, or missing
                without an objective; when a multi-part seed is paired with
                an engine that only takes text; or when an agent target has
                no cases to run the agent on; or when an iteration cap is
                supplied outside a single Meta-Harness run.
        """
        seed = self.seed_candidate
        if seed is None:
            if not (self.objective or "").strip():
                raise ValueError("Without a starting point, an objective is required.")
        elif isinstance(seed, dict):
            if not seed:
                raise ValueError("A multi-part starting point needs at least one part.")
            if self.strategy.mode != "single" or self.strategy.engine not in BLACKBOX_MULTI_PART_ENGINES:
                raise ValueError(
                    "Multi-part starting points are only supported by the "
                    f"{' and '.join(sorted(BLACKBOX_MULTI_PART_ENGINES))} engines."
                )
        elif not seed.strip():
            raise ValueError("The starting point cannot be blank.")
        if self.target.kind == BLACKBOX_TARGET_AGENT and not self.cases:
            raise ValueError("An agent target needs at least one case: the tasks the agent is run on.")
        if self.target.kind == BLACKBOX_TARGET_AGENT and self.task_model_settings is not None:
            task_model = self.task_model_settings.normalized_identifier()
            if not task_model:
                raise ValueError("An agent target needs a task model.")
            if self.target.model and self.target.model.strip("/") != task_model:
                raise ValueError("target.model and task_model_config.name must identify the same model.")
            self.target.model = self.task_model_settings.name
        if self.target.kind != BLACKBOX_TARGET_AGENT and self.task_model_settings is not None:
            raise ValueError("task_model_config is only used when the evaluated target is an agent.")
        if self.budget.max_iterations is not None and (
            self.strategy.mode != "single" or self.strategy.engine != BLACKBOX_ENGINE_META_HARNESS
        ):
            raise ValueError("An iteration limit is only supported by single Meta-Harness runs.")
        return self


# ``POST /blackbox/scorer/dry-run``: score one version on one case before
# submitting, so a broken scorer fails in the wizard rather than in the job.
class ScorerDryRunRequest(BaseModel):
    scorer: BlackboxScorer
    candidate: BlackboxCandidate
    case: dict[str, Any] | None = None
    execution_budget_id: str | None = Field(default=None, min_length=1, max_length=64)
    execution_budget_revision: int | None = Field(default=None, ge=1)


class ScorerDryRunResponse(BaseModel):
    ok: bool
    score: float | None = None
    side_info: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    elapsed_ms: float
    usage_by_model: list[ModelTokenUsage] = Field(default_factory=list)
    # What this one check debited, so the wizard can show setup spend against the total budget.
    credits_charged: int = 0
    budget: dict[str, Any] | None = None
    preview_status: Literal["succeeded", "failed", "pending"] | None = None
    preflight_id: str | None = None


# One engine lane of a run. ``explore`` lanes share the budget; the
# ``continue`` lane resumes from the best explore result; ``relay`` lanes
# are the plateau strategy's hand-offs.
class BlackboxLaneResult(BaseModel):
    engine: str
    phase: Literal["explore", "continue", "single", "relay"]
    status: Literal["completed", "failed", "unavailable", "budget_exhausted", "plateaued", "stopped"]
    best_score: float | None = None
    scorer_runs: int = 0
    error: str | None = None


# One distinct version the run scored, in the order versions first appeared.
# ``score`` is the number the run ranked it by: the engine's validation-set
# aggregate when it recorded one (the figure the candidate tree shows), else
# the running mean over its ``evals`` scorer calls, which ``mean_score``
# always carries (``None`` on runs recorded before it existed). ``side_info``
# is what the scorer returned for it last (images as data URLs).
class BlackboxVersion(BaseModel):
    candidate: BlackboxCandidate
    score: float | None = None
    mean_score: float | None = None
    evals: int = 0
    first_run: int = 0
    side_info: dict[str, Any] = Field(default_factory=dict)


# One candidate in the engine's lineage: ``parents`` are indices into the
# same list (``None`` marks the seed), ``val_score`` is the mean validation
# score and ``discovery_evals`` the metric-call count when it appeared.
# Only the GEPA engine records lineage today.
class BlackboxCandidateNode(BaseModel):
    candidate: BlackboxCandidate
    parents: list[int | None] = Field(default_factory=list)
    val_score: float | None = None
    discovery_evals: int = 0


# Result persisted for a finished black-box job. ``baseline_test_metric`` /
# ``optimized_test_metric`` keep the DSPy result names so the summary and
# billing paths read them unchanged.
class BlackboxRunResponse(BaseModel):
    optimizer_name: str
    strategy_mode: Literal["auto", "single", "plateau"]
    engine_used: str
    split_counts: SplitCounts
    baseline_test_metric: float | None = None
    optimized_test_metric: float | None = None
    metric_improvement: float | None = None
    seed_candidate: BlackboxCandidate | None = None
    best_candidate: BlackboxCandidate
    regression_guard_applied: bool = False
    lanes: list[BlackboxLaneResult] = Field(default_factory=list)
    versions: list[BlackboxVersion] = Field(default_factory=list)
    # GEPA's evolutionary lineage; empty for engines that record none.
    candidate_tree: list[BlackboxCandidateNode] = Field(default_factory=list)
    total_scorer_runs: int = 0
    runtime_seconds: float
    num_lm_calls: int = 0
    total_tokens: int | None = None
    usage_by_model: list[ModelTokenUsage] = Field(default_factory=list)
    # Reflection-LM timing on the shared LMActivity shape, so the run view
    # renders the same stage matrix as DSPy runs. Only ``reflection`` is
    # populated — black-box engines drive no generation LM.
    lm_activity: LMActivity | None = None
    optimization_metadata: dict[str, Any] = Field(default_factory=dict)
    details: dict[str, Any] = Field(default_factory=dict)


# One sandboxed agent run of a black-box job, as ``GET
# /optimizations/{id}/agent-runs/{run_id}`` serves it. ``transcript`` starts
# at ``transcript_offset`` so a live viewer fetches only what it lacks.
class BlackboxAgentRunResponse(BaseModel):
    run_id: int
    phase: str
    trial: int | None = None
    example_id: str | None = None
    case_id: str | None = None
    label: str = ""
    status: str
    started_at: str | None = None
    finished_at: str | None = None
    model: str | None = None
    exit_code: int | None = None
    timed_out: bool = False
    elapsed_seconds: float | None = None
    error: str | None = None
    usage: dict[str, Any] = Field(default_factory=dict)
    check: dict[str, Any] | None = None
    output: str | None = None
    transcript: str = ""
    transcript_offset: int = 0
    transcript_length: int = 0


# One entry of ``GET /blackbox/engines``: the catalog the wizard renders,
# with availability resolved for the requested target kind.
class BlackboxEngineInfo(BaseModel):
    id: str
    label: str
    description: str
    available: bool
    unavailable_reason: str | None = None
    requires_agent_target: bool = False
    supports_parts: bool = False
    checkpoint_recovery_supported: bool = False
    checkpoint_recovery_reason: str | None = None


class SandboxRuntimeCost(BaseModel):
    billing_basis: Literal["at_cost", "included_in_model_markup"]
    minimum_session_credits: str | None = None
    maximum_session_credits: str | None = None
    maximum_lifetime_seconds: float | None = None
    vcpus: int | None = None


class BlackboxProposerRuntimeInfo(BaseModel):
    id: Literal["vercel"]
    available: bool
    unavailable_reason: str | None = None
    cost: SandboxRuntimeCost
    checkpoint_restore_supported: bool = False
    checkpoint_restore_reason: str | None = None


class BlackboxEngineCatalogResponse(BaseModel):
    target_kind: Literal["text", "agent"]
    sandbox_available: bool
    sandbox_reason: str | None = None
    engines: list[BlackboxEngineInfo] = Field(default_factory=list)
    # The engines Auto's execution recipe can actually invoke here: a visible
    # catalog entry is not the same as one Auto may run.
    auto_engines: list[str] = Field(default_factory=list)
    auto_available: bool = False
    auto_unavailable_reason: str | None = None
    auto_checkpoint_recovery_supported: bool = False
    auto_checkpoint_recovery_reason: str | None = None
    proposer_runtimes: list[BlackboxProposerRuntimeInfo] = Field(default_factory=list)
    upstream_revision: str | None = None
    run_recovery_eligibility: str = "Requires a supported engine, a compatible saved checkpoint, and funded headroom."
