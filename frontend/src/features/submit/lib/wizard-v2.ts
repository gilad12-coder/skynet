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
  resolveOptimizer,
  type ArtifactKind,
  type ContractCheckResponse,
  type DataMode,
  type MetricShape,
  type OptimizerCatalogResponse,
  type OptimizerChoice,
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
  confirmed: boolean;
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
  confirmed: boolean;
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
  /**
   * The full engine, models and budget screens show at a summary level:
   * Standard pressed Change, or the step opened without the models it needs.
   */
  expanded: boolean;
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
  /** The user's experience level; it decides how the Optimizer step is laid out. */
  level: ExperienceLevel;
  task: TaskSlice;
  inputs: InputsSlice;
  optimizer: OptimizerSlice;
  workspace: WorkspaceSlice;
  meta: MetaSlice;
}

// The default level mirrors DEFAULT_LEVEL; this module stays free of runtime
// imports so its tests load without the app's path aliases.
export function initialWizardV2State(level: ExperienceLevel = "guided"): WizardV2State {
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
      confirmed: false,
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
      confirmed: false,
    },
    optimizer: {
      choice: "auto",
      taskModel: null,
      reflectionModel: null,
      extraReflectionModels: [],
      // Mirrors the backend BlackboxBudget defaults.
      budget: { max_scorer_runs: 200, max_iterations: null, stop_at_score: null },
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
      expanded: false,
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

/** Whether the models the chosen artifact needs to run are set. */
export function optimizerModelsReady(s: WizardV2State): boolean {
  if (s.task.artifactKind === "dspy_program" && !hasModel(s.optimizer.taskModel)) return false;
  return hasModel(s.optimizer.reflectionModel);
}

/**
 * The state after moving to `step`. Entering the Optimizer step without the
 * models it needs (no catalog default) expands it, so every level reaches the
 * models screen instead of a summary it can't leave.
 */
export function enterStep(
  s: WizardV2State,
  step: WizardStepId,
  furthest: WizardStepId,
): WizardV2State {
  const expand = step === "optimizer" && !s.optimizer.expanded && !optimizerModelsReady(s);
  return {
    ...s,
    step,
    furthestStep: furthest,
    ...(expand && { optimizer: { ...s.optimizer, expanded: true } }),
  };
}

/**
 * The task and reflection models a new wizard starts with: the catalog's
 * default model for both. Returns null once either model holds anything, so a
 * user's pick, a cloned run or an agent-set model is never overwritten.
 */
export function presetModels(
  optimizer: Pick<OptimizerSlice, "taskModel" | "reflectionModel">,
  defaultModel: string | null | undefined,
): Pick<OptimizerSlice, "taskModel" | "reflectionModel"> | null {
  if (!defaultModel || optimizer.taskModel !== null || optimizer.reflectionModel !== null)
    return null;
  return {
    taskModel: { name: defaultModel, token_source: "managed" },
    reflectionModel: { name: defaultModel, token_source: "managed" },
  };
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
  canEnter(step: WizardStepId): boolean;
  /** An i18n key describing what blocks the step; never auto-resets anything. */
  stepIssue(step: WizardStepId): string | null;
  patchTask(p: Partial<TaskSlice>): void;
  patchInputs(p: Partial<InputsSlice>): void;
  patchOptimizer(p: Partial<OptimizerSlice>): void;
  patchWorkspace(p: Partial<WorkspaceSlice>): void;
  patchMeta(p: Partial<MetaSlice>): void;
  metricShape: MetricShape | null;
  resolvedOptimizer: string | null;
  optimizerCatalog: OptimizerCatalogResponse | null;
  optimizerCatalogLoading: boolean;
  /** `lastCheckSnapshot !== contractSnapshot(state)`. */
  contractStale: boolean;
  /** An i18n key or the exact contract error text. */
  runBlockedReason: string | null;
  buildPayload(): UnifiedRunRequest | null;
  /** The wizard's execution budget, created on first use; the sandboxed check bills to it. */
  ensureBudget(): Promise<ExecutionBudget>;
  submit(): Promise<void>;
  submitting: boolean;
  // TotalBudgetCard BudgetContext fields.
  costBracket: CostBracket | null;
  suggestedCeiling: number | null;
  maxCostCents: number | null;
  setMaxCostCents(v: number | null): void;
  budgetUncapped: boolean;
  setBudgetUncapped(v: boolean): void;
  /** Guided users get the plainer `<key>.guided` copy where it exists. */
  guided: boolean;
}
