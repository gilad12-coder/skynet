"""Request/response models for black-box text optimization jobs.

A black-box job optimizes any text artifact (a prompt, a policy, a config
file, a piece of code) against a user-supplied scorer, with no DSPy program
in the loop. The contract mirrors GEPA's ``optimize_anything`` surface —
starting point, cases, scorer, budget — plus Skynet's strategy layer (the
Auto explore → continue flow over the engine registry).

Pydantic class docstrings are part of the OpenAPI contract — see AGENTS.md
"Pydantic class docstrings" — so per-model annotations live in comments
above each class, not in class bodies.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .common import ModelConfig, SplitCounts, SplitFractions
from .results import LMActivity, ModelTokenUsage

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
BLACKBOX_HARNESS_CUSTOM = "custom"
BLACKBOX_HARNESSES = (
    BLACKBOX_HARNESS_PI,
    BLACKBOX_HARNESS_CODEX,
    BLACKBOX_HARNESS_CLAUDE_CODE,
    BLACKBOX_HARNESS_OPENCODE,
    BLACKBOX_HARNESS_CUSTOM,
)
# Engines that accept a multi-part (named files) starting point.
BLACKBOX_MULTI_PART_ENGINES = frozenset({BLACKBOX_ENGINE_GEPA, BLACKBOX_ENGINE_META_HARNESS})
# Stands in for ``module_name`` in the job overview and notifications, where
# DSPy jobs record the program they optimized.
BLACKBOX_MODULE_NAME = "blackbox"

# A text artifact under optimization. ``dict`` form names several parts that
# are optimized together (GEPA and Meta-Harness only).
BlackboxCandidate = str | dict[str, str]


# How a version is scored. ``python`` runs ``metric_code`` inside the worker's
# metric sandbox; ``remote`` POSTs the version and case to ``url`` with the
# shared ``secret`` as a bearer token (TODO-1: allow-list + SSRF guard).
# ``model`` is the model a python scorer may call through the injected
# ``llm(prompt, input=None)`` helper (e.g. to run the prompt under
# optimization on a case); its usage is billed with the run.
class BlackboxScorer(BaseModel):
    kind: Literal["python", "remote"] = "python"
    metric_code: str | None = None
    url: str | None = None
    secret: str | None = None
    timeout_seconds: float = Field(default=60.0, gt=0, le=600)
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
# version directly. ``agent``: every scorer run first launches a coding
# harness in its own throwaway sandbox with the version as the harness's
# instruction file(s), and the scorer judges the run record (what the agent
# produced) instead of the version. The ``(harness, model)`` pair is fixed
# for the whole run — the optimizer searches harness text only (joint
# harness + model search is a TODO). ``model`` is the target/worker model
# id as the agent gateway knows it; the optimizer model is
# ``reflection_model_config`` on the request.
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
    seed_candidate: BlackboxCandidate | None = None
    scorer: BlackboxScorer
    cases: list[dict[str, Any]] | None = Field(default=None, max_length=200_000)
    split_fractions: SplitFractions = Field(default_factory=SplitFractions)
    shuffle: bool = True
    seed: int | None = None
    budget: BlackboxBudget = Field(default_factory=BlackboxBudget)
    strategy: BlackboxStrategy = Field(default_factory=BlackboxStrategy)
    target: BlackboxTarget = Field(default_factory=BlackboxTarget)
    reflection_model_settings: ModelConfig = Field(alias="reflection_model_config")
    token_source: Literal["managed", "byok"] = "managed"
    is_private: bool = False
    max_cost_credits: int | None = Field(default=None, ge=1)
    estimated_credits_low: int | None = Field(default=None, ge=0)
    estimated_credits_high: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _ensure_starting_point(self) -> BlackboxRunRequest:
        """Reject starting points the engines cannot work from.

        Returns:
            The validated request instance.

        Raises:
            ValueError: When the seed is blank, an empty dict, or missing
                without an objective; when a multi-part seed is paired with
                an engine that only takes text; or when an agent target has
                no cases to run the agent on.
        """
        seed = self.seed_candidate
        if seed is None:
            if not (self.objective or "").strip():
                raise ValueError("Without a starting point, an objective is required.")
        elif isinstance(seed, dict):
            if not seed:
                raise ValueError("A multi-part starting point needs at least one part.")
            if self.strategy.mode == "single" and self.strategy.engine not in BLACKBOX_MULTI_PART_ENGINES:
                raise ValueError(
                    "Multi-part starting points are only supported by the "
                    f"{' and '.join(sorted(BLACKBOX_MULTI_PART_ENGINES))} engines."
                )
        elif not seed.strip():
            raise ValueError("The starting point cannot be blank.")
        if self.target.kind == BLACKBOX_TARGET_AGENT and not self.cases:
            raise ValueError("An agent target needs at least one case: the tasks the agent is run on.")
        return self


# ``POST /blackbox/scorer/dry-run``: score one version on one case before
# submitting, so a broken scorer fails in the wizard rather than in the job.
class ScorerDryRunRequest(BaseModel):
    scorer: BlackboxScorer
    candidate: BlackboxCandidate
    case: dict[str, Any] | None = None


class ScorerDryRunResponse(BaseModel):
    ok: bool
    score: float | None = None
    side_info: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    elapsed_ms: float
    usage_by_model: list[ModelTokenUsage] = Field(default_factory=list)


# One engine lane of a run. ``explore`` lanes share the budget; the
# ``continue`` lane resumes from the best explore result; ``relay`` lanes
# are the plateau strategy's hand-offs.
class BlackboxLaneResult(BaseModel):
    engine: str
    phase: Literal["explore", "continue", "single", "relay"]
    status: Literal["completed", "failed", "unavailable", "budget_exhausted", "plateaued"]
    best_score: float | None = None
    scorer_runs: int = 0
    error: str | None = None


# One distinct version the run scored, in the order versions first appeared.
# ``score`` is the mean over the cases it was scored on inside the budget;
# ``side_info`` is what the scorer returned for it last (images as data URLs).
class BlackboxVersion(BaseModel):
    candidate: BlackboxCandidate
    score: float | None = None
    evals: int = 0
    first_run: int = 0
    side_info: dict[str, Any] = Field(default_factory=dict)


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


class BlackboxEngineCatalogResponse(BaseModel):
    target_kind: Literal["text", "agent"]
    sandbox_available: bool
    sandbox_reason: str | None = None
    engines: list[BlackboxEngineInfo] = Field(default_factory=list)
