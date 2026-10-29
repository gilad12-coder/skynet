/**
 * When a step's agent moves the wizard past a screen by itself. The agents
 * act only on the first pass through the wizard: a user who comes back to a
 * screen to change something is never pulled forward again.
 */

export interface TaskAdvanceInput {
  /** The Task step's Auto/Manual switch is on Auto. */
  auto: boolean;
  /** The user has not been past the Task step yet. */
  firstPass: boolean;
  /** The Task step is on view. */
  onStep: boolean;
  /** The interview's last turn said it has what it needs. */
  done: boolean;
  busy: boolean;
  /** The task has nothing Continue would refuse. */
  valid: boolean;
  /** The Task step's screen on view: 0 is the brief, 1 the artifact. */
  page: number;
}

/** The Task screen to continue past, or null to stay. */
export function taskAdvanceFrom(input: TaskAdvanceInput): "brief" | "artifact" | null {
  if (!input.auto || !input.firstPass || !input.onStep) return null;
  if (!input.done || input.busy || !input.valid) return null;
  return input.page === 0 ? "brief" : "artifact";
}

export interface InputsAdvanceInput {
  /** The Inputs step's Auto/Manual switch is on Auto. */
  auto: boolean;
  /** The user has not been past the Inputs step yet. */
  firstPass: boolean;
  /** The Inputs step is on view. */
  onStep: boolean;
  /** A cloned run arrives with its data, so it waits for the user. */
  cloned: boolean;
  /** A table is loaded. */
  hasData: boolean;
  /** Column-role inference is still running. */
  inferring: boolean;
  /** The step has nothing Continue would refuse. */
  valid: boolean;
}

/**
 * The Inputs screen to continue past, or null to stay. Data the user brings
 * by hand (upload, library, import) moves on as the agent's would, once its
 * column roles are settled.
 */
export function inputsAdvanceFrom(input: InputsAdvanceInput): "source" | null {
  if (!input.auto || !input.firstPass || !input.onStep || input.cloned) return null;
  if (!input.hasData || input.inferring || !input.valid) return null;
  return "source";
}

export interface MetricAdvanceInput {
  /** The Metric step is on view. */
  onStep: boolean;
  /** The overview has been on view before. */
  overviewSeen: boolean;
  /** The coding agent is mid-turn. */
  busy: boolean;
  /** The workspace is exactly what the agent's last writing turn left. */
  agentLeftFiles: boolean;
  /** The agent's verify_code, or a Check, passed these files. */
  editorPassed: boolean;
  /** The sandboxed Check passed these files. */
  checkPassed: boolean;
  /** A repository run has no Check screen. */
  repo: boolean;
  /** The Metric step's screen on view: 0 is the editor, then Check, then the overview. */
  page: number;
}

/** The Metric screen to continue past, or null to stay. The overview holds Run, so it never is. */
export function metricAdvanceFrom(input: MetricAdvanceInput): "metric" | "check" | null {
  if (!input.onStep || input.overviewSeen || input.busy || !input.agentLeftFiles) return null;
  if (input.page === 0) return input.editorPassed ? "metric" : null;
  if (input.page === 1 && !input.repo) return input.checkPassed ? "check" : null;
  return null;
}
