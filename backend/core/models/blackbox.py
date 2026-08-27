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
from .results import ModelTokenUsage

BLACKBOX_ENGINE_GEPA = "gepa"
BLACKBOX_ENGINE_BEST_OF_N = "best_of_n"
BLACKBOX_ENGINE_AUTORESEARCH = "autoresearch"
BLACKBOX_ENGINE_META_HARNESS = "meta_harness"
BLACKBOX_STRATEGY_AUTO = "auto"
# Stands in for ``module_name`` in the job overview and notifications, where
# DSPy jobs record the program they optimized.
BLACKBOX_MODULE_NAME = "blackbox"

# A text artifact under optimization. ``dict`` form names several parts that
# are optimized together (GEPA only — agent engines refuse dict seeds).
BlackboxCandidate = str | dict[str, str]


# How a version is scored. ``python`` runs ``metric_code`` inside the worker's
# metric sandbox; ``remote`` POSTs the version and case to ``url`` with the
# shared ``secret`` as a bearer token (TODO-1: allow-list + SSRF guard).
class BlackboxScorer(BaseModel):
    kind: Literal["python", "remote"] = "python"
    metric_code: str | None = None
    url: str | None = None
    secret: str | None = None
    timeout_seconds: float = Field(default=60.0, gt=0, le=600)

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
# ``stop_at_score`` ends the run early once a version reaches it.
class BlackboxBudget(BaseModel):
    max_scorer_runs: int = Field(default=200, ge=1, le=100_000)
    stop_at_score: float | None = None


# ``auto`` explores every available engine on a budget slice, then continues
# from the best version with GEPA; ``single`` runs one named engine.
class BlackboxStrategy(BaseModel):
    mode: Literal["auto", "single"] = "auto"
    engine: str | None = None

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
                without an objective; or when a multi-part seed is paired
                with a non-GEPA engine.
        """
        seed = self.seed_candidate
        if seed is None:
            if not (self.objective or "").strip():
                raise ValueError("Without a starting point, an objective is required.")
        elif isinstance(seed, dict):
            if not seed:
                raise ValueError("A multi-part starting point needs at least one part.")
            if self.strategy.mode == "single" and self.strategy.engine != BLACKBOX_ENGINE_GEPA:
                raise ValueError("Multi-part starting points are only supported by the gepa engine.")
        elif not seed.strip():
            raise ValueError("The starting point cannot be blank.")
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


# One engine lane of a run. ``explore`` lanes share the budget; the
# ``continue`` lane resumes from the best explore result.
class BlackboxLaneResult(BaseModel):
    engine: str
    phase: Literal["explore", "continue", "single"]
    status: Literal["completed", "failed", "unavailable", "budget_exhausted"]
    best_score: float | None = None
    scorer_runs: int = 0
    error: str | None = None


# Result persisted for a finished black-box job. ``baseline_test_metric`` /
# ``optimized_test_metric`` keep the DSPy result names so the summary and
# billing paths read them unchanged.
class BlackboxRunResponse(BaseModel):
    optimizer_name: str
    strategy_mode: Literal["auto", "single"]
    engine_used: str
    split_counts: SplitCounts
    baseline_test_metric: float | None = None
    optimized_test_metric: float | None = None
    metric_improvement: float | None = None
    seed_candidate: BlackboxCandidate | None = None
    best_candidate: BlackboxCandidate
    regression_guard_applied: bool = False
    lanes: list[BlackboxLaneResult] = Field(default_factory=list)
    total_scorer_runs: int = 0
    runtime_seconds: float
    num_lm_calls: int = 0
    total_tokens: int | None = None
    usage_by_model: list[ModelTokenUsage] = Field(default_factory=list)
    optimization_metadata: dict[str, Any] = Field(default_factory=dict)
    details: dict[str, Any] = Field(default_factory=dict)
