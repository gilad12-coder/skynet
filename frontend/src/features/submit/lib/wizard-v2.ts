/**
 * Wizard v2 state: types, constants and pure helpers only.
 *
 * Four fixed steps (task, inputs, optimizer, metric) each own a slice. Editing
 * an earlier step never clears a later slice; a downstream break only makes
 * the contract check stale, which `contractSnapshot` detects.
 */
import type {
  BlackboxBudget,
  BlackboxProposer,
  BlackboxShinkaSettings,
  ModelConfig,
  SplitFractions,
} from "@/shared/types/api";
import type { ExperienceLevel } from "@/features/experience";
import type { ExecutionBudget } from "@/shared/types/execution-budget";
import {
  optimizersFor,
  resolveOptimizer,
  type ArtifactKind,
  type ContractCheckResponse,
  type DataMode,
  type OptimizerCatalogResponse,
  type OptimizerChoice,
  type TaskInterviewTurnResult,
  type UnifiedCase,
  type UnifiedChatTurn,
  type UnifiedRunRequest,
} from "@/shared/types/unified-run";
import type { CostBracket } from "./cost-bracket";

export type WizardStepId = "task" | "inputs" | "optimizer" | "metric";
export const WIZARD_V2_STEPS: readonly WizardStepId[] = ["task", "inputs", "optimizer", "metric"];

export const DEFAULT_UNIFIED_SPLIT: Readonly<SplitFractions> = {
  train: 0.7,
  val: 0.15,
  test: 0.15,
};
export const DEFAULT_METRIC_TIMEOUT_SECONDS = 60;

export interface TaskSlice {
  objective: string;
  background: string;
  artifactKind: ArtifactKind | null;
  startingVersion: string | Record<string, string> | null;
  artifactRationale: string;
  transcript: UnifiedChatTurn[];
}

export interface InputsSlice {
  mode: DataMode | null;
  cases: UnifiedCase[];
  stagedDatasetId: string | null;
  datasetLabel: string | null;
  columns: string[];
  sampleRows: Array<Record<string, unknown>>;
  rowCount: number;
  inputFields: string[];
  expectedField: string | null;
  split: SplitFractions;
  shuffle: boolean;
  rationale: string;
}

export interface OptimizerSlice {
  choice: OptimizerChoice;
  taskModel: ModelConfig | null;
  reflectionModel: ModelConfig | null;
  extraReflectionModels: ModelConfig[];
  budget: BlackboxBudget;
  maxCostCents: number | null;
  budgetUncapped: boolean;
  proposer: BlackboxProposer;
  shinka: BlackboxShinkaSettings | null;
}

export interface WorkspaceSlice {
  runCode: string;
  metricCode: string;
  metricModelMode: "inherit" | "explicit";
  metricModel: ModelConfig | null;
  metricTimeoutSeconds: number;
  lastCheck: ContractCheckResponse | null;
  lastCheckSnapshot: string | null;
}

export interface MetaSlice {
  name: string;
  description: string;
  isPrivate: boolean;
  folderId: string | null;
  tokenSource: "managed" | "byok";
  economyMode: boolean;
}

export interface WizardV2State {
  step: WizardStepId;
  furthestStep: WizardStepId;
  /** The user's experience level; it decides which steps show and how the Optimizer step looks. */
  level: ExperienceLevel;
  task: TaskSlice;
  inputs: InputsSlice;
  optimizer: OptimizerSlice;
  workspace: WorkspaceSlice;
  meta: MetaSlice;
}

// The default level mirrors DEFAULT_LEVEL; this module stays free of runtime
// imports so its tests load without the app's path aliases.
export function initialWizardV2State(
  level: ExperienceLevel = "guided",
  maxScorerRuns: number | null = null,
): WizardV2State {
  return {
    step: "task",
    furthestStep: "task",
    level,
    task: {
      objective: "",
      background: "",
      artifactKind: null,
      startingVersion: null,
      artifactRationale: "",
      transcript: [],
    },
    inputs: {
      mode: null,
      cases: [],
      stagedDatasetId: null,
      datasetLabel: null,
      columns: [],
      sampleRows: [],
      rowCount: 0,
      inputFields: [],
      expectedField: null,
      split: { ...DEFAULT_UNIFIED_SPLIT },
      shuffle: true,
      rationale: "",
    },
    optimizer: {
      choice: "auto",
      taskModel: null,
      reflectionModel: null,
      extraReflectionModels: [],
      // Mirrors the backend BlackboxBudget defaults.
      budget: { max_scorer_runs: maxScorerRuns ?? 200, max_iterations: null, stop_at_score: null },
      maxCostCents: null,
      budgetUncapped: false,
      // Same defaults as the legacy wizard's DEFAULT_PROPOSER.
      proposer: {
        harness: "codex",
        max_candidates_per_iter: 3,
        ralph: true,
        max_no_eval_seconds: 1_800,
        max_tool_calls: 100,
      },
      shinka: null,
    },
    workspace: {
      runCode: "",
      metricCode: "",
      metricModelMode: "inherit",
      metricModel: null,
      metricTimeoutSeconds: DEFAULT_METRIC_TIMEOUT_SECONDS,
      lastCheck: null,
      lastCheckSnapshot: null,
    },
    meta: {
      name: "",
      description: "",
      isPrivate: false,
      folderId: null,
      tokenSource: "managed",
      economyMode: false,
    },
  };
}

const hasModel = (config: ModelConfig | null): boolean => Boolean(config?.name.trim());

/**
 * The i18n key of what the task step still lacks, or null when Continue may
 * move on. There is no separate confirm: Continue is the confirmation.
 */
export function taskIssue(task: TaskSlice): string | null {
  if (!task.objective.trim()) return "submit.v2.task.issue.objective";
  if (!task.artifactKind) return "submit.v2.task.issue.kind";
  const v = task.startingVersion;
  const empty =
    v === null ||
    (typeof v === "string" ? !v.trim() : Object.values(v).every((part) => !part.trim()));
  return empty ? "submit.v2.task.issue.starting" : null;
}

/**
 * The task fields an interview turn may write: only what it actually filled,
 * and nothing the user has edited by hand since. The rationale explains the
 * artifact kind, so it is kept only from a turn that names the kind the card
 * shows; an early turn otherwise fills it with "not yet known" filler.
 */
export function taskInterviewPatch(
  result: TaskInterviewTurnResult,
  dirty: ReadonlySet<keyof TaskSlice>,
): Partial<TaskSlice> {
  const patch: Partial<TaskSlice> = {};
  if (result.objective.trim() && !dirty.has("objective")) patch.objective = result.objective;
  if (result.background.trim() && !dirty.has("background")) patch.background = result.background;
  if (result.artifact_kind && !dirty.has("artifactKind")) {
    patch.artifactKind = result.artifact_kind;
    if (result.artifact_rationale.trim()) patch.artifactRationale = result.artifact_rationale;
  }
  if (result.starting_version != null && !dirty.has("startingVersion")) {
    patch.startingVersion = result.starting_version;
  }
  return patch;
}

/** Whether the models the chosen artifact needs to run are set. */
export function optimizerModelsReady(s: WizardV2State): boolean {
  if (s.task.artifactKind === "dspy_program" && !hasModel(s.optimizer.taskModel)) return false;
  return hasModel(s.optimizer.reflectionModel);
}

/**
 * The steps the wizard walks. Guided skips the Optimizer step and runs on the
 * defaults, unless they can't run (`optimizerBlocked`: no default model, or a
 * choice that doesn't fit the task) or the user is on it, so nothing blocks
 * the run out of sight.
 */
export function wizardSteps(s: WizardV2State, optimizerBlocked: boolean): readonly WizardStepId[] {
  if (s.level !== "guided" || optimizerBlocked || s.step === "optimizer") return WIZARD_V2_STEPS;
  return WIZARD_V2_STEPS.filter((step) => step !== "optimizer");
}

/**
 * The state after switching to `level`. Everything entered stays; when the
 * current step leaves the flow, the wizard moves on to the next step.
 */
export function withLevel(
  s: WizardV2State,
  level: ExperienceLevel,
  optimizerBlocked: boolean,
): WizardV2State {
  if (level === s.level) return s;
  const next = { ...s, level };
  // Laid out as if the user stood elsewhere, so the current step can drop out.
  const steps = wizardSteps({ ...next, step: "task" }, optimizerBlocked);
  if (steps.includes(s.step)) return next;
  const order = WIZARD_V2_STEPS.indexOf(s.step);
  const step = steps.find((id) => WIZARD_V2_STEPS.indexOf(id) > order) ?? s.step;
  const furthest =
    WIZARD_V2_STEPS.indexOf(step) > WIZARD_V2_STEPS.indexOf(s.furthestStep) ? step : s.furthestStep;
  return { ...next, step, furthestStep: furthest };
}

/**
 * The task and reflection models a new wizard starts with: each role's
 * default from Settings, else the catalog's pick: the best-value default for
 * the task model, the strongest model (else that default) for reflection.
 * Returns null once either model holds anything, so a user's pick, a cloned
 * run or an agent-set model is never overwritten.
 */
export function presetModels(
  optimizer: Pick<OptimizerSlice, "taskModel" | "reflectionModel">,
  defaults: { taskModel: ModelConfig | null; reflectionModel: ModelConfig | null },
  catalogDefault: string | null | undefined,
  catalogStrongest?: string | null,
): Pick<OptimizerSlice, "taskModel" | "reflectionModel"> | null {
  if (optimizer.taskModel !== null || optimizer.reflectionModel !== null) return null;
  const pick = (
    pref: ModelConfig | null,
    automatic: string | null | undefined,
  ): ModelConfig | null => {
    if (pref && hasModel(pref)) return pref;
    return automatic ? { name: automatic, token_source: "managed" } : null;
  };
  const taskModel = pick(defaults.taskModel, catalogDefault);
  const reflectionModel = pick(defaults.reflectionModel, catalogStrongest || catalogDefault);
  return taskModel || reflectionModel ? { taskModel, reflectionModel } : null;
}

/**
 * The engine a new wizard switches to once its task and inputs are known: the
 * Settings default, when it fits them. Null when it doesn't, when the default
 * is Auto, or when the choice already moved off Auto.
 */
export function presetEngine(
  choice: OptimizerChoice,
  engine: OptimizerChoice,
  kind: ArtifactKind,
  mode: DataMode,
): OptimizerChoice | null {
  if (choice !== "auto" || engine === "auto") return null;
  return optimizersFor(kind, mode).includes(engine) ? engine : null;
}

/** The metric model the run will use: the reflection model unless one was picked explicitly. */
export function resolvedMetricModel(s: WizardV2State): ModelConfig | null {
  return s.workspace.metricModelMode === "inherit"
    ? s.optimizer.reflectionModel
    : s.workspace.metricModel;
}

/** Recursively sorts object keys so equal values always serialize the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 32-bit FNV-1a of a string, as hex; keeps the snapshot short when the cases are large. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Stable JSON of everything a contract check depends on. A check is current
 * only while its stored snapshot equals this value for the live state.
 * The sandboxed check samples the cases through the split, and DSPy run code
 * calls the task model, so the data and both of those count too.
 */
export function contractSnapshot(s: WizardV2State): string {
  const kind = s.task.artifactKind;
  return stableJson({
    artifactKind: kind,
    startingVersion: s.task.startingVersion,
    mode: s.inputs.mode,
    cases: s.inputs.cases.length > 0 ? fnv1a(stableJson(s.inputs.cases)) : null,
    stagedDatasetId: s.inputs.cases.length > 0 ? null : s.inputs.stagedDatasetId,
    inputFields: s.inputs.inputFields,
    expectedField: s.inputs.expectedField,
    split: s.inputs.split,
    shuffle: s.inputs.shuffle,
    resolvedOptimizer: kind ? resolveOptimizer(s.optimizer.choice, kind) : null,
    taskModel: s.optimizer.taskModel?.name.trim() || null,
    runCode: s.workspace.runCode,
    metricCode: s.workspace.metricCode,
    metricModel: resolvedMetricModel(s)?.name ?? null,
    metricTimeoutSeconds: s.workspace.metricTimeoutSeconds,
  });
}

/**
 * The spec the sandboxed contract check sends: the server bills the check to
 * an execution budget and refuses one that names none.
 */
export function withContractBudget(
  spec: UnifiedRunRequest,
  budget: Pick<ExecutionBudget, "id" | "revision">,
): UnifiedRunRequest {
  return { ...spec, execution_budget_id: budget.id, execution_budget_revision: budget.revision };
}

export interface WizardV2Context {
  state: WizardV2State;
  goTo(step: WizardStepId): void;
  goNext(): void;
  goPrev(): void;
  /** The steps this wizard walks, in order; Guided leaves the Optimizer step out. */
  steps: readonly WizardStepId[];
  canEnter(step: WizardStepId): boolean;
  /** An i18n key describing what blocks the step; never auto-resets anything. */
  stepIssue(step: WizardStepId): string | null;
  patchTask(p: Partial<TaskSlice>): void;
  patchInputs(p: Partial<InputsSlice>): void;
  patchOptimizer(p: Partial<OptimizerSlice>): void;
  patchWorkspace(p: Partial<WorkspaceSlice>): void;
  patchMeta(p: Partial<MetaSlice>): void;
  resolvedOptimizer: string | null;
  optimizerCatalog: OptimizerCatalogResponse | null;
  optimizerCatalogLoading: boolean;
  /** `lastCheckSnapshot !== contractSnapshot(state)`. */
  contractStale: boolean;
  /** An i18n key or the exact contract error text. */
  runBlockedReason: string | null;
  /** The Metric step's coding agent reports whether it is writing the code. */
  setAgentWriting(writing: boolean): void;
  /** Whether the Inputs step's inference is still deciding the column roles. */
  inputsInferring: boolean;
  /** The Inputs step reports whether its inference is in flight. */
  setInputsInferring(inferring: boolean): void;
  buildPayload(): UnifiedRunRequest | null;
  /** The wizard's execution budget, created on first use; the sandboxed check bills to it. */
  ensureBudget(): Promise<ExecutionBudget>;
  submit(): Promise<void>;
  submitting: boolean;
  // TotalBudgetCard BudgetContext fields.
  costBracket: CostBracket | null;
  /** The charged estimate with another engine picked, everything else unchanged. */
  estimateFor(choice: OptimizerChoice): { lowCents: number; highCents: number } | null;
  suggestedCeiling: number | null;
  maxCostCents: number | null;
  setMaxCostCents(v: number | null): void;
  budgetUncapped: boolean;
  setBudgetUncapped(v: boolean): void;
  /** Guided users get the plainer `<key>.guided` copy where it exists. */
  guided: boolean;
}
