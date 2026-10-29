/**
 * The run page's live budget line, read from the pace the worker reports
 * with the optimizer bar.
 *
 * A run has no upfront estimate. After its first scorer runs the worker
 * divides the run's spend by the runs done and says how many more the
 * budget left can fund; until then it is still calibrating.
 */

export type BudgetPaceLine =
  | { kind: "calibrating" }
  | { kind: "iterations"; count: number }
  | { kind: "evaluations"; count: number };

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** The line to show, or null when the run reports no pace (an older run, or no budget). */
export function budgetPaceLine(metrics: Record<string, unknown>): BudgetPaceLine | null {
  if (metrics.tqdm_budget_calibrating === true) return { kind: "calibrating" };
  if (metrics.tqdm_budget_calibrating !== false) return null;
  const iterations = count(metrics.tqdm_budget_iterations_left);
  if (iterations != null) return { kind: "iterations", count: iterations };
  const evaluations = count(metrics.tqdm_budget_evals_left);
  if (evaluations != null) return { kind: "evaluations", count: evaluations };
  return null;
}
