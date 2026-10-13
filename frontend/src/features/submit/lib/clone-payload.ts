import type { ModelConfig, SplitFractions } from "@/shared/types/api";
import type {
  ArtifactKind,
  DataMode,
  OptimizerChoice,
  UnifiedCase,
} from "@/shared/types/unified-run";
import type {
  InputsSlice,
  MetaSlice,
  OptimizerSlice,
  TaskSlice,
  WorkspaceSlice,
} from "./wizard-v2";

/**
 * `?clone=` hydration for the wizard. A stored payload is one of three
 * shapes: a unified run (`payload_kind: "unified_v1"`), a legacy black-box
 * run (objective, seed, cases, scorer) or a legacy DSPy run (dataset rows,
 * column mapping, metric code). Unified runs clone in full; legacy runs are
 * mapped best effort and leave the rest for the user to fill.
 *
 * Only type imports here, so node tests can load this file directly.
 */
export type ClonePayload = Record<string, unknown>;

export interface CloneSlices {
  task: Partial<TaskSlice>;
  inputs: Partial<InputsSlice>;
  optimizer: Partial<OptimizerSlice>;
  workspace: Partial<WorkspaceSlice>;
  meta: Partial<MetaSlice>;
}

const ARTIFACT_KINDS: readonly ArtifactKind[] = ["prompt", "code", "dspy_program", "text"];
const DATA_MODES: readonly DataMode[] = ["single", "pairs"];
// Mirrors BLACKBOX_OPTIMIZERS; a value import would stop node tests loading this file.
const BLACKBOX_ENGINES: readonly OptimizerChoice[] = [
  "gepa",
  "best_of_n",
  "autoresearch",
  "meta_harness",
  "autosaddler",
  "shinka_evolve",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const modelConfig = (value: unknown): ModelConfig | null =>
  isRecord(value) && typeof value.name === "string" && value.name.trim()
    ? (value as unknown as ModelConfig)
    : null;

/** A starting version is text or a map of named text parts; anything else is dropped. */
function startingVersion(value: unknown): string | Record<string, string> | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([, part]) => typeof part === "string")
    ? (Object.fromEntries(entries) as Record<string, string>)
    : undefined;
}

function split(value: unknown): SplitFractions | undefined {
  if (!isRecord(value)) return undefined;
  const { train, val, test } = value;
  return typeof train === "number" && typeof val === "number" && typeof test === "number"
    ? { train, val, test }
    : undefined;
}

/** The spending cap every payload shape stores at the top level, under either name. */
function maxCostCents(payload: ClonePayload): number | undefined {
  const cap = payload.max_cost_cents ?? payload.max_cost_credits;
  return typeof cap === "number" && Number.isFinite(cap) && cap >= 1 ? cap : undefined;
}

/** Fields every payload shape stores the same way; the job row's display name wins. */
function cloneMeta(payload: ClonePayload, jobName?: string | null): Partial<MetaSlice> {
  const meta: Partial<MetaSlice> = {};
  const name = text(jobName) ?? text(payload.name);
  if (name) meta.name = name;
  const description = text(payload.description);
  if (description) meta.description = description;
  if (typeof payload.is_private === "boolean") meta.isPrivate = payload.is_private;
  if (payload.economy_mode === true) meta.economyMode = true;
  return meta;
}

/** Inputs derived from a list of cases: the mode follows the count. */
function inputsFromCases(cases: UnifiedCase[], inputFields: string[]): Partial<InputsSlice> {
  if (cases.length === 0) return {};
  const columns = Object.keys(cases[0]?.input ?? {});
  return {
    mode: cases.length === 1 ? "single" : "pairs",
    cases,
    columns,
    sampleRows: cases.slice(0, 5).map((c) => c.input),
    rowCount: cases.length,
    inputFields: inputFields.length > 0 ? inputFields : columns,
  };
}

function cloneUnified(payload: ClonePayload): Omit<CloneSlices, "meta"> {
  const task = isRecord(payload.task) ? payload.task : {};
  const artifact = isRecord(task.artifact) ? task.artifact : {};
  const data = isRecord(payload.data) ? payload.data : {};
  const optimizer = isRecord(payload.optimizer) ? payload.optimizer : {};
  const models = isRecord(payload.models) ? payload.models : {};
  const workspace = isRecord(payload.workspace) ? payload.workspace : {};

  const kind = ARTIFACT_KINDS.find((k) => k === artifact.kind) ?? null;
  const taskSlice: Partial<TaskSlice> = {
    objective: typeof task.objective === "string" ? task.objective : "",
    background: typeof task.background === "string" ? task.background : "",
    artifactKind: kind,
    startingVersion: startingVersion(artifact.starting_version) ?? null,
  };

  const cases = Array.isArray(data.cases)
    ? data.cases.filter(isRecord).map(
        (c): UnifiedCase => ({
          input: isRecord(c.input) ? c.input : {},
          expected: c.expected ?? null,
        }),
      )
    : [];
  const inputFields = Array.isArray(data.input_fields)
    ? data.input_fields.filter((f): f is string => typeof f === "string")
    : [];
  const inputsSlice: Partial<InputsSlice> = {
    ...inputsFromCases(cases, inputFields),
    expectedField: typeof data.expected_field === "string" ? data.expected_field : null,
    shuffle: typeof data.shuffle === "boolean" ? data.shuffle : true,
  };
  const mode = DATA_MODES.find((m) => m === data.mode);
  if (mode) inputsSlice.mode = mode;
  const fractions = split(data.split);
  if (fractions) inputsSlice.split = fractions;

  const optimizerSlice: Partial<OptimizerSlice> = {
    taskModel: modelConfig(models.task_model),
    reflectionModel: modelConfig(models.reflection_model),
    extraReflectionModels: Array.isArray(models.extra_reflection_models)
      ? models.extra_reflection_models.map(modelConfig).filter((m): m is ModelConfig => m !== null)
      : [],
  };
  if (typeof optimizer.choice === "string")
    optimizerSlice.choice = optimizer.choice as OptimizerChoice;
  if (isRecord(optimizer.budget))
    optimizerSlice.budget = optimizer.budget as unknown as OptimizerSlice["budget"];
  if (isRecord(optimizer.proposer))
    optimizerSlice.proposer = optimizer.proposer as unknown as OptimizerSlice["proposer"];
  if (isRecord(optimizer.shinka))
    optimizerSlice.shinka = optimizer.shinka as unknown as OptimizerSlice["shinka"];

  const metricModel = modelConfig(models.metric_model);
  const reflectionName = optimizerSlice.reflectionModel?.name ?? null;
  const workspaceSlice: Partial<WorkspaceSlice> = {
    runCode: typeof workspace.run_code === "string" ? workspace.run_code : "",
    metricCode: typeof workspace.metric_code === "string" ? workspace.metric_code : "",
    // A metric model that is the reflection model was inherited, not picked.
    metricModelMode: metricModel && metricModel.name !== reflectionName ? "explicit" : "inherit",
    metricModel: metricModel && metricModel.name !== reflectionName ? metricModel : null,
  };
  if (typeof workspace.metric_timeout_seconds === "number")
    workspaceSlice.metricTimeoutSeconds = workspace.metric_timeout_seconds;

  return {
    task: taskSlice,
    inputs: inputsSlice,
    optimizer: optimizerSlice,
    workspace: workspaceSlice,
  };
}

function cloneLegacyBlackbox(payload: ClonePayload): Omit<CloneSlices, "meta"> {
  const seed = startingVersion(payload.seed_candidate);
  const task: Partial<TaskSlice> = {
    objective: text(payload.objective) ?? "",
    background: text(payload.background) ?? "",
  };
  if (seed !== undefined) task.startingVersion = seed;
  // Legacy cases are flat rows the scorer read whole; an `expected` key, when
  // present, was the answer the scorer compared against.
  const cases = Array.isArray(payload.cases)
    ? payload.cases.filter(isRecord).map((row): UnifiedCase => {
        const { expected, ...input } = row;
        return { input, expected: expected ?? null };
      })
    : [];
  const scorer = isRecord(payload.scorer) ? payload.scorer : {};
  const workspace: Partial<WorkspaceSlice> = {};
  if (typeof scorer.metric_code === "string") workspace.metricCode = scorer.metric_code;
  const scorerModel = modelConfig(scorer.model);
  if (scorerModel) {
    workspace.metricModelMode = "explicit";
    workspace.metricModel = scorerModel;
  }
  if (typeof scorer.timeout_seconds === "number" && scorer.timeout_seconds > 0)
    workspace.metricTimeoutSeconds = scorer.timeout_seconds;

  // Stored payloads may be dumped by alias or by field name.
  const extras = payload.extra_reflection_model_configs ?? payload.extra_reflection_model_settings;
  const optimizer: Partial<OptimizerSlice> = {
    taskModel: modelConfig(payload.task_model_config ?? payload.task_model_settings),
    reflectionModel: modelConfig(
      payload.reflection_model_config ?? payload.reflection_model_settings,
    ),
    extraReflectionModels: Array.isArray(extras)
      ? extras.map(modelConfig).filter((m): m is ModelConfig => m !== null)
      : [],
  };
  // Auto mode, or an engine this wizard no longer offers, keeps the default choice.
  const strategy = isRecord(payload.strategy) ? payload.strategy : {};
  const engine = BLACKBOX_ENGINES.find((e) => e === strategy.engine);
  if (strategy.mode === "single" && engine) optimizer.choice = engine;
  if (isRecord(payload.budget))
    optimizer.budget = payload.budget as unknown as OptimizerSlice["budget"];
  if (isRecord(payload.proposer))
    optimizer.proposer = payload.proposer as unknown as OptimizerSlice["proposer"];
  if (isRecord(payload.shinka))
    optimizer.shinka = payload.shinka as unknown as OptimizerSlice["shinka"];
  return {
    task,
    inputs: inputsFromCases(cases, []),
    optimizer,
    workspace,
  };
}

function cloneLegacyDspy(payload: ClonePayload): Omit<CloneSlices, "meta"> {
  const mapping = isRecord(payload.column_mapping) ? payload.column_mapping : {};
  const inputCols = Object.keys(isRecord(mapping.inputs) ? mapping.inputs : {});
  const outputCols = Object.keys(isRecord(mapping.outputs) ? mapping.outputs : {});
  const rows = Array.isArray(payload.dataset) ? payload.dataset.filter(isRecord) : [];
  const cases = rows.map(
    (row): UnifiedCase => ({
      input: Object.fromEntries(inputCols.map((col) => [col, row[col]])),
      expected:
        outputCols.length > 0 ? Object.fromEntries(outputCols.map((col) => [col, row[col]])) : null,
    }),
  );
  const inputs: Partial<InputsSlice> =
    inputCols.length > 0 ? inputsFromCases(cases, inputCols) : {};
  const fractions = split(payload.split_fractions);
  if (fractions) inputs.split = fractions;
  if (typeof payload.shuffle === "boolean") inputs.shuffle = payload.shuffle;
  if (outputCols.length === 1) inputs.expectedField = outputCols[0] ?? null;
  const workspace: Partial<WorkspaceSlice> = {};
  if (typeof payload.metric_code === "string") workspace.metricCode = payload.metric_code;
  return {
    task: { artifactKind: "dspy_program" },
    inputs,
    optimizer: {
      taskModel: modelConfig(payload.model_config ?? payload.model_settings),
      reflectionModel: modelConfig(
        payload.reflection_model_config ?? payload.reflection_model_settings,
      ),
    },
    workspace,
  };
}

/**
 * The wizard slices a stored run fills. A cloned setup is still walked step
 * by step and its contract checked again before Run.
 */
export function cloneToSlices(
  optimizationType: string,
  payload: ClonePayload,
  jobName?: string | null,
): CloneSlices {
  const body =
    payload.payload_kind === "unified_v1"
      ? cloneUnified(payload)
      : optimizationType === "blackbox"
        ? cloneLegacyBlackbox(payload)
        : cloneLegacyDspy(payload);
  const cap = maxCostCents(payload);
  if (cap !== undefined) body.optimizer = { ...body.optimizer, maxCostCents: cap };
  return { ...body, meta: cloneMeta(payload, jobName) };
}
