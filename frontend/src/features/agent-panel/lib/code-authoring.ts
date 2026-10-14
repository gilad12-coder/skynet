/**
 * The agent panel's side of the one authoring contract: the context the coding
 * agent writes run code plus a metric under, and the static validity check the
 * handoff waits on. Pure, so the panel and the tests build the same payloads.
 */
import type { ValidateCodeResponse } from "@/shared/types/api";
import {
  type ContractCheckItem,
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
  // Keyed by the expected field, as the wizard's cases and the run's harness
  // pass it, so the metric the agent writes reads the shape it is scored with.
  return dataset.rows.slice(0, SAMPLE_CASE_LIMIT).map((row) => {
    const input = Object.fromEntries(inputFields.map((field) => [field, row[field]]));
    return expectedField ? { input, expected: { [expectedField]: row[expectedField] ?? null } } : { input };
  });
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

/**
 * Split a validity check's failures onto the run-code and metric editors.
 * `message` renders an item in the active locale; injected so this stays pure.
 */
export function contractValidations(
  result: ContractCheckResponse,
  message: (check: ContractCheckItem) => string = (check) => check.message,
): {
  run: ValidateCodeResponse;
  metric: ValidateCodeResponse;
} {
  const run: string[] = [];
  const metric: string[] = [];
  for (const check of result.checks) {
    if (check.status !== "failed") continue;
    const text = check.detail ? `${message(check)} ${check.detail}` : message(check);
    (RUN_KEYS.has(check.key) ? run : metric).push(text);
  }
  return { run: editorResult(run), metric: editorResult(metric) };
}

/** One time a failed check went back to the coding agent for a fix. */
export interface AuthoringFixAttempt {
  /** 1-based, counted per conversation. */
  attempt: number;
  /** What the check flagged on the agent's code. */
  failures: string[];
  /** What the agent did about it; null while its fix turn is still running. */
  fix: { reply: string; runChanged: boolean; metricChanged: boolean } | null;
}

/** A fix the check asked for, before it is paired with the agent's reply. */
export interface FixRecord {
  attempt: number;
  failures: string[];
  runBefore: string;
  metricBefore: string;
  /** How many agent messages existed when the fix was asked for; null until sent. */
  from: number | null;
}

/**
 * Pair each fix the check asked for with what the agent did about it.
 *
 * Args:
 *   fixes: The fixes asked for, oldest first.
 *   messages: The coding agent's chat.
 *   streaming: Whether a coding turn is running right now.
 *   runCode: The run code now.
 *   metricCode: The metric now.
 *
 * Returns:
 *   One attempt per fix; its ``fix`` stays null until the fix turn finished.
 */
export function describeFixes(
  fixes: readonly FixRecord[],
  messages: ReadonlyArray<{ role: string; content: string }>,
  streaming: boolean,
  runCode: string,
  metricCode: string,
): AuthoringFixAttempt[] {
  return fixes.map((f, i) => {
    const base = { attempt: f.attempt, failures: f.failures };
    const next = fixes[i + 1];
    if (f.from === null || (!next && streaming)) return { ...base, fix: null };
    const until = next?.from ?? messages.length;
    const replies = messages.slice(f.from, until).filter((m) => m.role === "assistant");
    if (replies.length === 0) return { ...base, fix: null };
    return {
      ...base,
      fix: {
        reply: replies
          .map((m) => m.content.trim())
          .filter(Boolean)
          .join("\n\n"),
        runChanged: (next ? next.runBefore : runCode) !== f.runBefore,
        metricChanged: (next ? next.metricBefore : metricCode) !== f.metricBefore,
      },
    };
  });
}

/**
 * The change a repeated ``request_code_authoring`` call asks the coding agent for.
 *
 * The first call seeds the code from the wizard's context. The coding agent
 * seeds only once per conversation, so a later call carries its goal to the
 * agent as a follow-up turn; without it the card stays as it was while the
 * chat says the code is being changed.
 *
 * Args:
 *   args: The tool call's arguments.
 *   alreadyRan: Whether the coding agent already wrote code in this conversation.
 *
 * Returns:
 *   The goal to send as a follow-up, or null when there is none to send.
 */
export function followUpAuthoringGoal(
  args: Readonly<Record<string, unknown>>,
  alreadyRan: boolean,
): string | null {
  if (!alreadyRan) return null;
  const goal = typeof args.goal === "string" ? args.goal.trim() : "";
  return goal || null;
}
