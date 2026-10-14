/**
 * The agent panel's side of the one authoring contract: the context the coding
 * agent writes run code plus a metric under, and the static validity check the
 * handoff waits on. Pure, so the panel and the tests build the same payloads.
 */
import { diffStats, lineDiff } from "@/shared/lib/line-diff";
import type { ValidateCodeResponse } from "@/shared/types/api";
import type { AgentThinking, AgentToolCall } from "@/shared/ui/agent/types";
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
// Extra files are imported by the run code only, so their failures sit with it.
const RUN_KEYS: ReadonlySet<ContractCheckKey> = new Set([
  "workspace.run_signature",
  "workspace.run",
  "workspace.files",
]);

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
  files: Readonly<Record<string, string>> = {},
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
    workspace: {
      run_code: runCode,
      metric_code: metricCode,
      ...(Object.keys(files).length > 0 && { files: { ...files } }),
    },
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

/**
 * The change a repeated ``request_code_authoring`` call asks the coding agent for.
 *
 * The first call seeds the code from the wizard's context. Once code exists
 * the coding agent does not seed again, so a later call carries its goal to
 * the agent as a follow-up turn; without it the card stays as it was while
 * the chat says the code is being changed.
 *
 * Args:
 *   args: The tool call's arguments.
 *   alreadyRan: Whether the coding agent already wrote code, in this
 *     conversation or an earlier screen's.
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

/**
 * Find the chat's most recent call of one tool.
 *
 * The coding tool's steps show the one live coding session, so only the
 * latest call renders them; an earlier call would repeat the same steps.
 *
 * Args:
 *   messages: The agent's chat, oldest first.
 *   tool: The tool name to look for.
 *
 * Returns:
 *   The id of the latest call of ``tool``, or null when it was never called.
 */
export function latestToolCallId(
  messages: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ id: string; tool: string }> }>,
  tool: string,
): string | null {
  for (const message of [...messages].reverse()) {
    const call = [...(message.toolCalls ?? [])].reverse().find((c) => c.tool === tool);
    if (call) return call.id;
  }
  return null;
}

/** One edit the coding agent made to a workspace file. */
export interface AuthoringEdit {
  /** The file's workspace path: run.py, metric.py or an extra file. */
  file: string;
  before: string;
  after: string;
  ts: number;
}

/**
 * Turn each file's version history into the edits that made them, oldest
 * first, as the transcript lists them.
 *
 * Args:
 *   runVersions: Each run code the agent landed, oldest first.
 *   metricVersions: Each metric the agent landed, oldest first.
 *   fileVersions: Each extra file's versions the agent landed, by path.
 *
 * Returns:
 *   One edit per version that changed its code; the first version of a file
 *   is an edit from empty.
 */
export function authoringEdits(
  runVersions: ReadonlyArray<{ code: string; ts: number }>,
  metricVersions: ReadonlyArray<{ code: string; ts: number }>,
  fileVersions: Readonly<Record<string, ReadonlyArray<{ code: string; ts: number }>>> = {},
): AuthoringEdit[] {
  const edits = (file: string, versions: typeof runVersions) =>
    versions.flatMap((v, i) => {
      const before = versions[i - 1]?.code ?? "";
      return v.code === before ? [] : [{ file, before, after: v.code, ts: v.ts }];
    });
  return [
    ...edits("run.py", runVersions),
    ...edits("metric.py", metricVersions),
    ...Object.entries(fileVersions).flatMap(([path, versions]) => edits(path, versions)),
  ].sort((a, b) => a.ts - b.ts);
}

/**
 * The coding tool's thinking row, or null when there is none to show.
 *
 * A run starts with its thinking timer open before the model sends anything,
 * and a model that streams no reasoning never sends any: the tool's live
 * "Editing" rows already say it is working, so a bare "Thinking" row there
 * would claim reasoning that never happened, and outlive the chat turn that
 * started the tool.
 *
 * Args:
 *   agent: The coding agent's reasoning text, its timer, and its status.
 *
 * Returns:
 *   The row's thinking state once reasoning has streamed, else null.
 */
export function authoringThinking(agent: {
  reasoning: string;
  reasoningStartedAt: number | null;
  reasoningEndedAt: number | null;
  status: string;
}): AgentThinking | null {
  if (!agent.reasoning) return null;
  return {
    reasoning: agent.reasoning,
    startedAt: agent.reasoningStartedAt,
    endedAt: agent.reasoningEndedAt,
    streaming: agent.status === "streaming",
  };
}

/** One file the coding agent deleted from the workspace. */
export interface AuthoringDelete {
  file: string;
  ts: number;
}

/** One ``verify_code`` call: running, then passed or failed with each failing file's findings. */
export interface AuthoringCheck {
  id: string;
  ts: number;
  state: "running" | "passed" | "failed";
  /** The files that failed and what the check found in each; an empty path is the whole workspace. */
  failures: Array<{ path: string; errors: string[] }>;
}

type ToolCallLike = {
  id: string;
  tool: string;
  status: string;
  startedAt: number;
  path?: string;
  verification?: { ok: boolean; files: ReadonlyArray<{ path: string; ok: boolean; errors: string[] }> };
};

/**
 * Read the coding agent's ``delete_file`` and ``verify_code`` calls as rows.
 *
 * Args:
 *   messages: The coding agent's chat.
 *   since: When this tool call started; earlier calls' rows are left out.
 *
 * Returns:
 *   The files deleted and each check, oldest first.
 */
export function authoringToolRows(
  messages: ReadonlyArray<{ toolCalls?: readonly ToolCallLike[] }>,
  since: number,
): { deletes: AuthoringDelete[]; checks: AuthoringCheck[] } {
  const deletes: AuthoringDelete[] = [];
  const checks: AuthoringCheck[] = [];
  for (const call of messages.flatMap((m) => m.toolCalls ?? [])) {
    if (call.startedAt < since) continue;
    if (call.tool === "delete_file" && call.status === "done" && call.path) {
      deletes.push({ file: call.path, ts: call.startedAt });
    } else if (call.tool === "verify_code") {
      const result = call.verification;
      // A call that errored without a result is a failed check with nothing to list.
      const state =
        call.status === "running" || (!result && call.status !== "error")
          ? "running"
          : result?.ok
            ? "passed"
            : "failed";
      checks.push({
        id: call.id,
        ts: call.startedAt,
        state,
        failures:
          state === "failed"
            ? (result?.files ?? []).filter((f) => !f.ok).map((f) => ({ path: f.path, errors: [...f.errors] }))
            : [],
      });
    }
  }
  return { deletes, checks };
}

/**
 * A finished coding-tool run, kept on its tool call so a reopened conversation
 * shows the same rows (edits with their diffs, deletes, each check) and the
 * generalist reads how the run ended instead of its "now writing" hand-off
 * result.
 */
export interface AuthoringOutcome {
  /** How the run ended: finished, failed, or stopped by the user. */
  status: "done" | "error" | "stopped";
  /** The last ``verify_code`` verdict of the run. */
  check: "passed" | "failed" | "none";
  /** What the last check flagged, when it failed. */
  errors: string[];
  edits: AuthoringEdit[];
  deletes: AuthoringDelete[];
  /** Every settled check, oldest first. Missing on outcomes stored before verify_code. */
  checks: AuthoringCheck[];
  thinking: { reasoning: string; startedAt: number | null; endedAt: number | null } | null;
  /** The run's error message, when it failed. */
  error: string | null;
  /** When the run settled, in ms; the turn's "Worked for" counts up to it. */
  endedAt: number;
}

// Kept inside the tool call's JSON, so a long reasoning trace is clipped.
const OUTCOME_REASONING_MAX_CHARS = 20_000;

const failureLines = (check: AuthoringCheck): string[] =>
  check.failures.flatMap((f) => f.errors.map((e) => (f.path ? `${f.path}: ${e}` : e)));

/**
 * Snapshot a settled coding run as the outcome its tool call keeps.
 *
 * Args:
 *   agent: The coding agent's state once it settled.
 *   since: When the tool call started; edits from earlier calls are left out.
 *   now: The current time in ms.
 *
 * Returns:
 *   The outcome to render and persist.
 */
export function authoringOutcome(
  agent: {
    status: string;
    error: string | null;
    signatureVersions: ReadonlyArray<{ code: string; ts: number }>;
    metricVersions: ReadonlyArray<{ code: string; ts: number }>;
    fileVersions?: Readonly<Record<string, ReadonlyArray<{ code: string; ts: number }>>>;
    messages: ReadonlyArray<{ toolCalls?: readonly ToolCallLike[] }>;
    reasoning: string;
    reasoningStartedAt: number | null;
    reasoningEndedAt: number | null;
  },
  since: number,
  now: number,
): AuthoringOutcome {
  const rows = authoringToolRows(agent.messages, since);
  // A check the run was stopped in the middle of never reached a verdict.
  const checks = rows.checks.filter((c) => c.state !== "running");
  const last = checks.at(-1);
  return {
    status: agent.status === "error" ? "error" : agent.status === "done" ? "done" : "stopped",
    check: last?.state === "passed" ? "passed" : last?.state === "failed" ? "failed" : "none",
    errors: last?.state === "failed" ? failureLines(last) : [],
    edits: authoringEdits(agent.signatureVersions, agent.metricVersions, agent.fileVersions).filter(
      (e) => e.ts >= since,
    ),
    deletes: rows.deletes,
    checks,
    thinking: agent.reasoning
      ? {
          reasoning: agent.reasoning.slice(0, OUTCOME_REASONING_MAX_CHARS),
          startedAt: agent.reasoningStartedAt,
          endedAt: agent.reasoningEndedAt ?? now,
        }
      : null,
    error: agent.status === "error" ? agent.error : null,
    endedAt: now,
  };
}

const strings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
const numOrNull = (raw: unknown): number | null => (typeof raw === "number" ? raw : null);
const records = (raw: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(raw) ? raw : []).filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
// Outcomes stored before extra files named the two files "run" and "metric".
const LEGACY_FILES: Readonly<Record<string, string>> = { run: "run.py", metric: "metric.py" };
const filePath = (raw: unknown): string | null =>
  typeof raw === "string" && raw ? (LEGACY_FILES[raw] ?? raw) : null;

/**
 * Read an outcome back from a tool call's payload, which is stored JSON.
 *
 * Args:
 *   raw: ``payload.outcome`` of a coding tool call.
 *
 * Returns:
 *   The outcome, or null when the call has none or it is malformed.
 */
export function parseAuthoringOutcome(raw: unknown): AuthoringOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.endedAt !== "number") return null;
  const edits = records(o.edits).flatMap((r): AuthoringEdit[] => {
    const file = filePath(r.file);
    if (!file || typeof r.after !== "string") return [];
    return [{ file, before: typeof r.before === "string" ? r.before : "", after: r.after, ts: numOrNull(r.ts) ?? 0 }];
  });
  const deletes = records(o.deletes).flatMap((r): AuthoringDelete[] => {
    const file = filePath(r.file);
    return file ? [{ file, ts: numOrNull(r.ts) ?? 0 }] : [];
  });
  const checks = records(o.checks).flatMap((r): AuthoringCheck[] => {
    if (r.state !== "passed" && r.state !== "failed") return [];
    return [
      {
        id: typeof r.id === "string" ? r.id : "",
        ts: numOrNull(r.ts) ?? 0,
        state: r.state,
        failures: records(r.failures).map((f) => ({
          path: typeof f.path === "string" ? f.path : "",
          errors: strings(f.errors),
        })),
      },
    ];
  });
  const t = (o.thinking ?? null) as Record<string, unknown> | null;
  return {
    status: o.status === "error" || o.status === "stopped" ? o.status : "done",
    check: o.check === "passed" || o.check === "failed" ? o.check : "none",
    errors: strings(o.errors),
    edits,
    deletes,
    checks,
    thinking:
      t && typeof t.reasoning === "string" && t.reasoning
        ? { reasoning: t.reasoning, startedAt: numOrNull(t.startedAt), endedAt: numOrNull(t.endedAt) }
        : null,
    error: typeof o.error === "string" ? o.error : null,
    endedAt: o.endedAt,
  };
}

const HISTORY_ERROR_MAX_CHARS = 160;

/** The files a run edited, run code first, then the metric, then extra files as first edited. */
function editedFiles(edits: readonly AuthoringEdit[]): string[] {
  const rank = (file: string) => (file === "run.py" ? 0 : file === "metric.py" ? 1 : 2);
  const files = [...new Set(edits.map((e) => e.file))];
  return files.sort((a, b) => rank(a) - rank(b));
}

/**
 * The tool result a finished coding call shows the generalist on later turns.
 *
 * Its own result was written before the coding agent started and says it "is
 * now writing" the code; replayed later, the agent told the user the code was
 * on its way while nothing ran. The backend turns this into "FINISHED: ...".
 *
 * Args:
 *   outcome: The call's recorded outcome.
 *
 * Returns:
 *   JSON with the files written (with line counts), the files deleted, the
 *   last check and its errors.
 */
export function outcomeHistoryResult(outcome: AuthoringOutcome): string {
  const files = editedFiles(outcome.edits).map((file) => {
    const edits = outcome.edits.filter((e) => e.file === file);
    const { added, removed } = diffStats(lineDiff(edits[0]?.before ?? "", edits.at(-1)?.after ?? ""));
    return { file, added, removed };
  });
  return JSON.stringify({
    outcome: {
      status: outcome.status,
      files,
      ...(outcome.deletes.length > 0 && { deleted: outcome.deletes.map((d) => d.file) }),
      check: outcome.check,
      errors: outcome.errors.slice(0, 2).map((e) => e.slice(0, HISTORY_ERROR_MAX_CHARS)),
    },
  });
}

/**
 * Whether a coding run is still going. The agent checks its own code with
 * ``verify_code`` inside its turn, so the run is over once the turn is.
 *
 * Args:
 *   agent: The coding agent's status.
 *
 * Returns:
 *   True while the coding turn streams.
 */
export function authoringBusy(agent: { status: string }): boolean {
  return agent.status === "streaming";
}

/**
 * Mark the coding calls for display: the running one keeps its turn's header
 * live, and a stored run ends its call where the run ended, so the turn's
 * "Worked for" is the same live and after a reload.
 *
 * Args:
 *   messages: The chat, oldest first.
 *   tool: The coding tool's name.
 *   runningId: The call whose run is still going, or null.
 *
 * Returns:
 *   The messages, with only the coding calls that change replaced.
 */
export function withAuthoringState<
  M extends { toolCalls?: AgentToolCall[] },
>(messages: readonly M[], tool: string, runningId: string | null): M[] {
  return messages.map((m) => {
    if (!m.toolCalls?.some((c) => c.tool === tool)) return m;
    return {
      ...m,
      toolCalls: m.toolCalls.map((c) => {
        if (c.tool !== tool) return c;
        if (c.id === runningId) return { ...c, working: true };
        const outcome = parseAuthoringOutcome(c.payload?.outcome);
        return outcome ? { ...c, endedAt: outcome.endedAt } : c;
      }),
    };
  });
}

/** Everything the coding tool's rows show, from the live agent or a stored outcome. */
export interface AuthoringView {
  thinking: AgentThinking | null;
  edits: AuthoringEdit[];
  deletes: AuthoringDelete[];
  checks: AuthoringCheck[];
  /** Files whose code is reaching the editors right now. */
  writing: string[];
}

/**
 * The rows of a live coding run.
 *
 * Args:
 *   agent: The live coding agent.
 *   since: When this tool call started; earlier calls' rows are left out.
 *
 * Returns:
 *   The view to render.
 */
export function liveAuthoringView(
  agent: {
    isWorkflow: boolean;
    signatureStatus: string;
    metricStatus: string;
    signatureFlowing: boolean;
    metricFlowing: boolean;
    writingFiles: readonly string[];
    reasoning: string;
    reasoningStartedAt: number | null;
    reasoningEndedAt: number | null;
    status: string;
    signatureVersions: ReadonlyArray<{ code: string; ts: number }>;
    metricVersions: ReadonlyArray<{ code: string; ts: number }>;
    fileVersions: Readonly<Record<string, ReadonlyArray<{ code: string; ts: number }>>>;
    messages: ReadonlyArray<{ toolCalls?: readonly ToolCallLike[] }>;
  },
  since = 0,
): AuthoringView {
  // A lane is "writing" from the run's start; its row waits on its first chunk.
  // An extra file is only listed once its first chunk arrived.
  const writing = [
    !agent.isWorkflow && agent.signatureStatus === "writing" && agent.signatureFlowing ? "run.py" : null,
    agent.metricStatus === "writing" && agent.metricFlowing ? "metric.py" : null,
    ...(agent.isWorkflow ? [] : agent.writingFiles),
  ].filter((file): file is string => file !== null);
  const rows = agent.isWorkflow ? { deletes: [], checks: [] } : authoringToolRows(agent.messages, since);
  return {
    thinking: authoringThinking(agent),
    edits: authoringEdits(agent.signatureVersions, agent.metricVersions, agent.fileVersions).filter(
      (e) => e.ts >= since,
    ),
    deletes: rows.deletes,
    checks: rows.checks,
    writing,
  };
}

/**
 * The rows of a finished run, as its tool call stored them.
 *
 * Args:
 *   outcome: The call's stored outcome.
 *
 * Returns:
 *   The view to render; identical to the live one the run ended with.
 */
export function outcomeAuthoringView(outcome: AuthoringOutcome): AuthoringView {
  // An outcome stored before verify_code keeps only the last verdict; it shows
  // as one check after the edits.
  const checks =
    outcome.checks.length === 0 && outcome.check !== "none"
      ? [
          {
            id: "check",
            ts: outcome.endedAt,
            state: outcome.check,
            failures: outcome.errors.length > 0 ? [{ path: "", errors: outcome.errors }] : [],
          },
        ]
      : outcome.checks;
  return {
    thinking: outcome.thinking ? { ...outcome.thinking, streaming: false } : null,
    edits: outcome.edits,
    deletes: outcome.deletes,
    checks,
    writing: [],
  };
}

/** The closing line's message and the files it names, run code first. */
export interface OutcomeLine {
  key:
    | "agent.coding_tool.outcome.passed"
    | "agent.coding_tool.outcome.failed"
    | "agent.coding_tool.outcome.unchecked"
    | "agent.coding_tool.outcome.stopped"
    | "agent.coding_tool.outcome.none";
  files: string[];
}

/**
 * Pick the closing line a finished run gets after its turn's text: what it
 * wrote and how its last check ended. The generalist's reply is written
 * before the run starts, so it cannot say this.
 *
 * Args:
 *   outcome: The run's stored outcome.
 *
 * Returns:
 *   The line, or null for a run that failed (its error row says why) or one
 *   that only deleted files (its rows say which).
 */
export function outcomeLine(outcome: AuthoringOutcome): OutcomeLine | null {
  if (outcome.status === "error") return null;
  if (outcome.status === "stopped") return { key: "agent.coding_tool.outcome.stopped", files: [] };
  const files = editedFiles(outcome.edits);
  if (files.length === 0) {
    return outcome.deletes.length > 0 ? null : { key: "agent.coding_tool.outcome.none", files };
  }
  const key =
    outcome.check === "passed"
      ? "agent.coding_tool.outcome.passed"
      : outcome.check === "failed"
        ? "agent.coding_tool.outcome.failed"
        : "agent.coding_tool.outcome.unchecked";
  return { key, files };
}
