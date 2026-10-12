/**
 * The agent panel's side of the one authoring contract: the context the coding
 * agent writes run code plus a metric under, and the static validity check the
 * handoff waits on. Pure, so the panel and the tests build the same payloads.
 */
import type { ValidateCodeResponse } from "@/shared/types/api";
import {
  metricShapeFor,
  type ContractCheckKey,
  type ContractCheckResponse,
  type UnifiedAuthoringContext,
  type UnifiedCase,
  type UnifiedRunRequest,
} from "@/shared/types/unified-run";

import type { WizardState } from "./types";

const SAMPLE_CASE_LIMIT = 5;
// The static check reads only the code, the artifact kind, the optimizer and
// the metric model; the schema still requires a reflection model, which the
// panel may not have picked yet when the code is written.
const STATIC_CHECK_REFLECTION_MODEL = { name: "static-check" };
const RUN_KEYS: ReadonlySet<ContractCheckKey> = new Set(["workspace.run_signature", "workspace.run"]);

/** The dataset the user confirmed in the panel, as far as authoring needs it. */
export interface AuthoringDataset {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  columnRoles: Record<string, "input" | "output" | "ignore">;
}

function sampleCases(
  dataset: AuthoringDataset | null,
  inputFields: string[],
  expectedField: string | null,
): Array<Record<string, unknown>> {
  if (!dataset) return [];
  return dataset.rows.slice(0, SAMPLE_CASE_LIMIT).map((row) => ({
    input: Object.fromEntries(inputFields.map((field) => [field, row[field]])),
    expected: expectedField ? (row[expectedField] ?? null) : null,
  }));
}

/**
 * Build the authoring context from the panel's wizard state and dataset, the
 * same context the wizard's Metric step hands the coding agent.
 *
 * Returns null until the artifact kind, the objective and the data mode are
 * set, and, for pairs, until the user confirmed a dataset.
 */
export function panelAuthoringContext(
  wizard: WizardState,
  dataset: AuthoringDataset | null,
): UnifiedAuthoringContext | null {
  const kind = wizard.artifact_kind;
  const mode = wizard.data_mode;
  const objective = wizard.task_objective?.trim() ?? "";
  if (!kind || !mode || !objective) return null;
  if (mode === "pairs" && !dataset) return null;
  const roles = dataset?.columnRoles ?? {};
  const inputFields =
    wizard.input_fields && wizard.input_fields.length > 0
      ? wizard.input_fields
      : (dataset?.columns ?? []).filter((column) => roles[column] === "input");
  const expectedField =
    wizard.expected_field ??
    (dataset?.columns ?? []).find((column) => roles[column] === "output") ??
    null;
  const optimizer = wizard.optimizer_choice ?? "auto";
  return {
    task: {
      objective,
      background: wizard.task_background ?? "",
      artifact: { kind, starting_version: wizard.starting_version ?? "" },
    },
    data_mode: mode,
    input_fields: inputFields,
    expected_field: expectedField,
    sample_cases: sampleCases(dataset, inputFields, expectedField),
    optimizer,
    metric_shape: metricShapeFor(optimizer, kind),
    // The panel has no metric model to attach, so the metric scores without one.
    metric_has_model: false,
    focus: "run",
  };
}

/** The spec the static validity check reads for this context and code. */
export function panelContractSpec(
  context: UnifiedAuthoringContext,
  runCode: string,
  metricCode: string,
): UnifiedRunRequest {
  // Every sample case is built by ``sampleCases`` as an ``{input, expected}`` case.
  const cases = (context.sample_cases ?? []) as unknown as UnifiedCase[];
  return {
    payload_kind: "unified_v1",
    task: context.task,
    data: {
      mode: context.data_mode,
      cases: context.data_mode === "single" ? [cases[0] ?? { input: {} }] : cases,
      input_fields: context.input_fields ?? [],
      expected_field: context.expected_field ?? null,
    },
    optimizer: { choice: context.optimizer, budget: { max_scorer_runs: 200 } },
    models: { reflection_model: STATIC_CHECK_REFLECTION_MODEL, metric_model: null },
    workspace: { run_code: runCode, metric_code: metricCode },
  };
}

function editorResult(failures: string[]): ValidateCodeResponse {
  return { valid: failures.length === 0, errors: failures, warnings: [] };
}

/** Split a validity check's failures onto the run-code and metric editors. */
export function contractValidations(result: ContractCheckResponse): {
  run: ValidateCodeResponse;
  metric: ValidateCodeResponse;
} {
  const run: string[] = [];
  const metric: string[] = [];
  for (const check of result.checks) {
    if (check.status !== "failed") continue;
    const text = check.detail ? `${check.message} ${check.detail}` : check.message;
    (RUN_KEYS.has(check.key) ? run : metric).push(text);
  }
  return { run: editorResult(run), metric: editorResult(metric) };
}
