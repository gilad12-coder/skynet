"""Request/response models for the unified (wizard v2) optimization run.

One payload covers every optimizer: the DSPy optimizers and the black-box
engines all run through the black-box engine layer against the same workspace
contract (a ``run`` function or a ``build_program`` factory, plus a metric
whose shape the chosen optimizer fixes). Stored runs keep the ``blackbox``
optimization type and are told apart from legacy black-box runs by
``payload_kind``.

Pydantic class docstrings are part of the OpenAPI contract — see AGENTS.md
"Pydantic class docstrings" — so per-model annotations live in comments
above each class, not in class bodies.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator

from ..i18n_en import t_en
from ..i18n_keys import I18nKey
from .blackbox import (
    BlackboxBudget,
    BlackboxCandidate,
    BlackboxProposer,
    BlackboxShinkaSettings,
    UnifiedSplitCounts,
)
from .common import ModelConfig, SplitFractions
from .scorer_dependencies import ScorerDependencyLock

UNIFIED_PAYLOAD_KIND = "unified_v1"
ArtifactKind = Literal["prompt", "code", "dspy_program", "text"]
DataMode = Literal["single", "pairs"]
OptimizerChoice = Literal[
    "auto",
    "dspy_gepa",
    "dspy_miprov2",
    "dspy_bootstrap_fewshot",
    "gepa",
    "best_of_n",
    "autoresearch",
    "meta_harness",
    "autosaddler",
    "shinka_evolve",
]
OptimizerFamily = Literal["auto", "dspy", "blackbox"]
MetricShape = Literal["dspy_feedback", "dspy_scalar", "blackbox_side_info"]
DSPY_OPTIMIZERS: tuple[str, ...] = ("dspy_gepa", "dspy_miprov2", "dspy_bootstrap_fewshot")
BLACKBOX_OPTIMIZERS: tuple[str, ...] = (
    "gepa",
    "best_of_n",
    "autoresearch",
    "meta_harness",
    "autosaddler",
    "shinka_evolve",
)
# instantiate_optimizer() resolves names through resolve_optimizer_factory():
# only GEPA has a short alias, the others resolve by their dotted dspy path.
DSPY_OPTIMIZER_NAMES: dict[str, str] = {
    "dspy_gepa": "gepa",
    "dspy_miprov2": "dspy.teleprompt.MIPROv2",
    "dspy_bootstrap_fewshot": "dspy.teleprompt.BootstrapFewShot",
}
# "auto" is listed because both of its resolutions (DSPy GEPA, the black-box
# Auto strategy that continues with GEPA) consume feedback text.
FEEDBACK_OPTIMIZERS = frozenset({"dspy_gepa", "gepa", "auto"})
MIN_PAIRS_FOR_HELD_OUT = 5
CONTRACT_SAMPLE_MAX = 5
# How many samples a sandboxed contract check scores when the caller names none.
CONTRACT_SAMPLE_DEFAULT = 3
# Canonical-payload key carrying a contract check's sample count from the API
# into the setup sandbox; public so it is part of the evidence fingerprint.
CONTRACT_SAMPLE_COUNT_KEY = "contract_sample_count"
ARTIFACT_KIND_DSPY_PROGRAM = "dspy_program"
OPTIMIZER_AUTO = "auto"


def optimizers_for(artifact_kind: ArtifactKind, data_mode: DataMode) -> list[OptimizerChoice]:
    """List the optimizer choices that fit an artifact kind and data mode.

    Runtime availability (sandbox, installed engines) is filtered separately
    by the catalog route; this is the static relevance rule.

    Args:
        artifact_kind: What is being optimized.
        data_mode: Whether the run has one input or input/output pairs.

    Returns:
        The allowed choices, ``"auto"`` first.
    """
    if artifact_kind == ARTIFACT_KIND_DSPY_PROGRAM:
        if data_mode == "pairs":
            return ["auto", "dspy_gepa", "dspy_miprov2", "dspy_bootstrap_fewshot"]
        return ["auto", "dspy_gepa"]
    return ["auto", "gepa", "best_of_n", "autoresearch", "meta_harness", "autosaddler", "shinka_evolve"]


def resolve_optimizer(choice: OptimizerChoice, artifact_kind: ArtifactKind) -> str:
    """Resolve the user's choice to the optimizer that actually runs.

    Args:
        choice: The optimizer the user picked.
        artifact_kind: What is being optimized.

    Returns:
        ``"dspy_gepa"`` for Auto on a DSPy program, ``"auto"`` (the black-box
        Auto strategy) for Auto on anything else, otherwise ``choice``.
    """
    if choice == OPTIMIZER_AUTO:
        return "dspy_gepa" if artifact_kind == ARTIFACT_KIND_DSPY_PROGRAM else OPTIMIZER_AUTO
    return choice


def optimizer_family(resolved: str) -> OptimizerFamily:
    """Name the family a resolved optimizer belongs to.

    Args:
        resolved: An optimizer id as returned by :func:`resolve_optimizer`.

    Returns:
        ``"dspy"`` for the DSPy optimizers, ``"auto"`` for the black-box Auto
        strategy, otherwise ``"blackbox"``.
    """
    if resolved in DSPY_OPTIMIZERS:
        return "dspy"
    if resolved == OPTIMIZER_AUTO:
        return "auto"
    return "blackbox"


def metric_shape_for(choice: OptimizerChoice, artifact_kind: ArtifactKind) -> MetricShape:
    """Name the metric signature the resolved optimizer needs.

    Args:
        choice: The optimizer the user picked.
        artifact_kind: What is being optimized.

    Returns:
        ``"dspy_feedback"`` for DSPy GEPA, ``"dspy_scalar"`` for the other DSPy
        optimizers, otherwise ``"blackbox_side_info"``.
    """
    resolved = resolve_optimizer(choice, artifact_kind)
    if resolved == "dspy_gepa":
        return "dspy_feedback"
    if resolved in DSPY_OPTIMIZERS:
        return "dspy_scalar"
    return "blackbox_side_info"


# The coding agent's contract, its validators and the editors' hints all read
# these, so what the agent is told and what a person writing by hand is shown
# never drift apart.
METRIC_SIGNATURES: dict[str, str] = {
    "dspy_feedback": "def metric(gold, pred, trace=None, pred_name=None, pred_trace=None)",
    "dspy_scalar": "def metric(gold, pred, trace=None)",
    "blackbox_side_info": "def score(input, output, expected=None)",
}


def run_entry_for(artifact_kind: ArtifactKind) -> str:
    """Name the entry point the run code must define for an artifact kind.

    Args:
        artifact_kind: What is being optimized.

    Returns:
        ``def build_program()`` for a DSPy program (the DSPy optimizer needs
        the module itself), otherwise ``def run(artifact, input)``.
    """
    if artifact_kind == ARTIFACT_KIND_DSPY_PROGRAM:
        return "def build_program()"
    return "def run(artifact, input)"


# One case. ``expected`` is a dict keyed by output field names when a DSPy
# metric reads it as ``gold``.
class UnifiedCase(BaseModel):
    input: dict[str, Any]
    expected: Any | None = None


# The thing under optimization and where it starts.
class UnifiedArtifact(BaseModel):
    kind: ArtifactKind
    starting_version: BlackboxCandidate


class UnifiedTask(BaseModel):
    objective: str = Field(min_length=1, max_length=8000)
    background: str = Field(default="", max_length=20000)
    artifact: UnifiedArtifact


# ``expected_field`` names the table column the expected output came from
# when pairs were built from a dataset.
class UnifiedData(BaseModel):
    mode: DataMode
    cases: list[UnifiedCase] | None = Field(default=None, max_length=200_000)
    staged_dataset_id: str | None = Field(default=None, min_length=1, max_length=64)
    input_fields: list[str] = Field(default_factory=list)
    expected_field: str | None = None
    split: SplitFractions = Field(default_factory=SplitFractions)
    shuffle: bool = True

    @model_validator(mode="after")
    def _ensure_cases(self) -> UnifiedData:
        """Require cases (or a staged dataset) that fit the data mode.

        Returns:
            The validated data instance.

        Raises:
            ValueError: When neither cases nor a staged dataset is given, when
                single mode does not carry exactly one case, or when pairs mode
                carries fewer than two cases.
        """
        if self.cases is None:
            if self.staged_dataset_id is None:
                key = (
                    I18nKey.SUBMIT_UNIFIED_SINGLE_NEEDS_ONE_CASE
                    if self.mode == "single"
                    else I18nKey.SUBMIT_UNIFIED_PAIRS_NEED_CASES
                )
                raise ValueError(t_en(key))
            return self
        if self.mode == "single" and len(self.cases) != 1:
            raise ValueError(t_en(I18nKey.SUBMIT_UNIFIED_SINGLE_NEEDS_ONE_CASE))
        if self.mode == "pairs" and len(self.cases) < 2:
            raise ValueError(t_en(I18nKey.SUBMIT_UNIFIED_PAIRS_NEED_CASES))
        return self


# ``dspy_kwargs`` reaches the DSPy optimizer constructor; black-box engines
# ignore it, and DSPy optimizers ignore ``proposer`` and ``shinka``.
class UnifiedOptimizer(BaseModel):
    choice: OptimizerChoice = "auto"
    budget: BlackboxBudget = Field(default_factory=BlackboxBudget)
    proposer: BlackboxProposer = Field(default_factory=BlackboxProposer)
    shinka: BlackboxShinkaSettings | None = None
    dspy_kwargs: dict[str, Any] = Field(default_factory=dict)


# ``task_model`` is what ``skynet.llm`` calls inside run code;
# ``metric_model`` is what it calls inside the metric.
class UnifiedModels(BaseModel):
    task_model: ModelConfig | None = None
    reflection_model: ModelConfig
    extra_reflection_models: list[ModelConfig] = Field(default_factory=list, max_length=4)
    metric_model: ModelConfig | None = None


# The workspace code. ``metric_code`` never reaches an optimizer: it travels
# only here and in the engine Task's private context.
class UnifiedWorkspace(BaseModel):
    run_code: str = Field(min_length=1, max_length=200_000)
    metric_code: str = Field(min_length=1, max_length=200_000)
    metric_timeout_seconds: float = Field(default=60.0, gt=0, le=600)
    install_command: str | None = None
    dependency_lock: ScorerDependencyLock | None = None


# Submission payload for ``POST /optimize``.
class UnifiedRunRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    payload_kind: Literal["unified_v1"] = "unified_v1"
    name: str | None = None
    description: str | None = Field(default=None, max_length=280)
    username: str | None = None
    task: UnifiedTask
    data: UnifiedData
    optimizer: UnifiedOptimizer = Field(default_factory=UnifiedOptimizer)
    models: UnifiedModels
    workspace: UnifiedWorkspace
    seed: int | None = None
    token_source: Literal["managed", "byok"] = "managed"
    is_private: bool = False
    economy_mode: bool = False
    preflight_id: str | None = Field(default=None, min_length=1, max_length=64)
    preflight_fingerprint: str | None = Field(default=None, min_length=1, max_length=128)
    execution_budget_id: str | None = Field(default=None, min_length=1, max_length=64)
    execution_budget_revision: int | None = Field(default=None, ge=1)
    execution_budget_generation: int | None = Field(default=None, ge=0)
    max_cost_cents: int | None = Field(
        validation_alias=AliasChoices("max_cost_cents", "max_cost_credits"), default=None, ge=1
    )
    estimated_cents_low: int | None = Field(
        validation_alias=AliasChoices("estimated_cents_low", "estimated_credits_low"), default=None, ge=0
    )
    estimated_cents_high: int | None = Field(
        validation_alias=AliasChoices("estimated_cents_high", "estimated_credits_high"), default=None, ge=0
    )

    @model_validator(mode="after")
    def _ensure_optimizer_allowed(self) -> UnifiedRunRequest:
        """Reject an optimizer that does not fit the artifact kind and data mode.

        Returns:
            The validated request instance.

        Raises:
            ValueError: When ``optimizer.choice`` is not among
                :func:`optimizers_for` for this artifact kind and data mode.
        """
        allowed = optimizers_for(self.task.artifact.kind, self.data.mode)
        if self.optimizer.choice not in allowed:
            raise ValueError(
                t_en(
                    I18nKey.SUBMIT_UNIFIED_OPTIMIZER_NOT_ALLOWED,
                    optimizer=self.optimizer.choice,
                    allowed=", ".join(allowed),
                )
            )
        return self


class OptimizerOption(BaseModel):
    id: OptimizerChoice
    family: OptimizerFamily
    metric_shape: MetricShape
    metric_signature: str
    available: bool
    unavailable_reason: str | None = None
    needs_reflection_model: bool
    uses_feedback: bool
    supports_iteration_limit: bool
    native_proposer: bool


# ``GET /optimizers``. ``auto_resolves_to`` lists what Auto runs: DSPy GEPA
# for a DSPy program, otherwise the engines the Auto strategy explores.
# ``run_entry`` is the entry point the run code defines for this artifact kind.
class OptimizerCatalogResponse(BaseModel):
    artifact_kind: ArtifactKind
    data_mode: DataMode
    run_entry: str
    default: OptimizerChoice = "auto"
    options: list[OptimizerOption]
    auto_resolves_to: list[str]
    sandbox_available: bool
    sandbox_reason: str | None = None


ContractCheckKey = Literal[
    "workspace.run_signature",
    "metric.signature",
    "metric.model",
    "workspace.run",
    "metric.shape",
]


# ``message`` is localized for the user; ``detail`` is the exact error text,
# trimmed to frames from the user's own code.
class ContractCheckItem(BaseModel):
    key: ContractCheckKey
    status: Literal["passed", "failed", "pending", "skipped"]
    message: str
    sample_index: int | None = None
    detail: str | None = Field(default=None, max_length=4000)


class ContractSample(BaseModel):
    index: int
    input_preview: str
    output_preview: str | None = None
    score: float | None = None
    feedback_preview: str | None = None
    duration_ms: int | None = None


class ContractCheckRequest(BaseModel):
    spec: UnifiedRunRequest
    sample_count: int = Field(default=CONTRACT_SAMPLE_DEFAULT, ge=1, le=CONTRACT_SAMPLE_MAX)


# ``fingerprint`` is the sha256 hex of the canonical JSON of the inputs the
# check depends on, so the wizard can tell when a passing check went stale.
# ``uses_llm`` is whether the metric code calls ``llm``, so the wizard asks for
# a metric model only when the metric needs one.
class ContractCheckResponse(BaseModel):
    ok: bool
    optimizer_resolved: str
    metric_shape: MetricShape
    uses_llm: bool = False
    checks: list[ContractCheckItem]
    samples: list[ContractSample] = Field(default_factory=list)
    fingerprint: str


class UnifiedChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


# One clickable answer the task interview offers.
class InterviewOption(BaseModel):
    label: str = Field(max_length=80)
    description: str = Field(default="", max_length=400)


# ``POST /optimizations/task-interview``: one turn of the step-1 interview.
class TaskInterviewRequest(BaseModel):
    turns: list[UnifiedChatTurn] = Field(default_factory=list, max_length=40)
    objective: str = ""
    background: str = ""
    artifact_kind: ArtifactKind | None = None
    starting_version: BlackboxCandidate | None = None
    sample_cases: list[dict[str, Any]] = Field(default_factory=list, max_length=5)
    locale: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None


# Data of the interview's terminal ``interview_done`` event.
class TaskInterviewTurnResult(BaseModel):
    message: str
    options: list[InterviewOption] = Field(default_factory=list)
    done: bool
    objective: str = ""
    background: str = ""
    artifact_kind: ArtifactKind | None = None
    starting_version: BlackboxCandidate | None = None
    artifact_rationale: str = ""
    model: str | None = None
    served_model: str | None = None


# ``POST /optimizations/infer-inputs``: decide single input vs pairs from the
# task and a sample of the uploaded data.
class InputsInferenceRequest(BaseModel):
    objective: str
    background: str = ""
    artifact_kind: ArtifactKind
    starting_version: BlackboxCandidate | None = None
    columns: list[str] = Field(default_factory=list)
    sample_rows: list[dict[str, Any]] = Field(default_factory=list, max_length=5)
    row_count: int = Field(default=0, ge=0)
    user_note: str = Field(default="", max_length=4000)
    locale: str | None = None
    model: str | None = None


class InputsInferenceResponse(BaseModel):
    mode: DataMode
    input_fields: list[str]
    expected_field: str | None = None
    single_input: dict[str, Any] | None = None
    rationale: str
    suggested_split: SplitFractions
    held_out_count: int
    warnings: list[str] = Field(default_factory=list)
    model: str | None = None


# What the code agent needs to write run code and a metric for a unified run.
# ``focus`` names which of the two the user is working on.
class UnifiedAuthoringContext(BaseModel):
    task: UnifiedTask
    data_mode: DataMode
    input_fields: list[str] = Field(default_factory=list)
    expected_field: str | None = None
    sample_cases: list[dict[str, Any]] = Field(default_factory=list, max_length=5)
    optimizer: OptimizerChoice
    metric_shape: MetricShape
    metric_has_model: bool = False
    focus: Literal["run", "metric"] = "run"


__all__ = [
    "BLACKBOX_OPTIMIZERS",
    "CONTRACT_SAMPLE_COUNT_KEY",
    "CONTRACT_SAMPLE_DEFAULT",
    "CONTRACT_SAMPLE_MAX",
    "DSPY_OPTIMIZERS",
    "DSPY_OPTIMIZER_NAMES",
    "FEEDBACK_OPTIMIZERS",
    "MIN_PAIRS_FOR_HELD_OUT",
    "UNIFIED_PAYLOAD_KIND",
    "ArtifactKind",
    "ContractCheckItem",
    "ContractCheckKey",
    "ContractCheckRequest",
    "ContractCheckResponse",
    "ContractSample",
    "DataMode",
    "InputsInferenceRequest",
    "InputsInferenceResponse",
    "InterviewOption",
    "MetricShape",
    "OptimizerCatalogResponse",
    "OptimizerChoice",
    "OptimizerFamily",
    "OptimizerOption",
    "TaskInterviewRequest",
    "TaskInterviewTurnResult",
    "UnifiedArtifact",
    "UnifiedAuthoringContext",
    "UnifiedCase",
    "UnifiedChatTurn",
    "UnifiedData",
    "UnifiedModels",
    "UnifiedOptimizer",
    "UnifiedRunRequest",
    "UnifiedSplitCounts",
    "UnifiedTask",
    "UnifiedWorkspace",
    "metric_shape_for",
    "optimizer_family",
    "optimizers_for",
    "resolve_optimizer",
]
