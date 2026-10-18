/**
 * When the IDE's coding agent starts on its own as the Metric step opens.
 *
 * It starts only on work the user did not do: entry files that are still
 * blank, or its own code whose last Check failed. Code the user wrote or
 * changed by hand is theirs, and code that passes needs nothing. A
 * repository run has no run code, so only its metric.py counts.
 */

/** The turn the agent starts with: write the files, fix its failing code, or ask what it is missing. */
export type Kickoff = "write" | "fix" | "ask";

export interface KickoffInput {
  /** The step registered an authoring context, so the agent can write the wizard's files. */
  hasContext: boolean;
  /** The task's objective; a blank one leaves the agent nothing to write against. */
  objective: string;
  /** The agent has sample cases, or the task needs none. */
  dataKnown: boolean;
  runCode: string;
  metricCode: string;
  /** The last run.py / metric.py the agent wrote this session; null before it wrote one. */
  agentRun: string | null;
  agentMetric: string | null;
  /** The last Check's verdict on exactly these files; null when there is no fresh one. */
  lastCheckOk: boolean | null;
  /** A turn is running already. */
  busy: boolean;
  /** A repository run: the optimizer edits the repository, so there is no run.py to write. */
  repo?: boolean;
}

/**
 * Decide whether the coding agent starts a turn by itself, and which one.
 *
 * Args:
 *   input: The step's context, the files, what the agent last wrote, and the last Check.
 *
 * Returns:
 *   The turn to start, or null when the agent waits for the user.
 */
export function kickoffFor(input: KickoffInput): Kickoff | null {
  if (!input.hasContext || input.busy) return null;
  const { metricCode, repo = false } = input;
  const runCode = repo ? null : input.runCode;
  const handEdited =
    (runCode !== null && runCode.trim() !== "" && runCode !== input.agentRun) ||
    (metricCode.trim() !== "" && metricCode !== input.agentMetric);
  if (handEdited) return null;
  const blank = runCode?.trim() === "" || metricCode.trim() === "";
  if (!blank && input.lastCheckOk !== false) return null;
  if (!input.objective.trim() || !(repo || input.dataKnown)) return "ask";
  return blank ? "write" : "fix";
}

/**
 * The message key of a kickoff turn.
 *
 * Args:
 *   kickoff: The turn to start.
 *   repo: A repository run, whose turns talk about metric.py and the repository only.
 *
 * Returns:
 *   The i18n key of the hidden message that starts the turn.
 */
export function kickoffKey(kickoff: Kickoff, repo: boolean): string {
  return `submit.v2.ide.agent.kickoff.${repo ? `repo_${kickoff}` : kickoff}`;
}

/**
 * Decide whether a running agent turn must stop because the user left Auto.
 *
 * Manual and the builder hide the agent's panel, so the user can neither see
 * nor stop a turn that is still running. That turn would still write run.py
 * and metric.py, and replace the code or rewards the user is making.
 *
 * Args:
 *   auto: The metric is written in Auto mode, where the agent's panel shows.
 *   busy: A turn is running.
 *
 * Returns:
 *   True when the running turn must stop.
 */
export function stopsHiddenTurn(auto: boolean, busy: boolean): boolean {
  return busy && !auto;
}
