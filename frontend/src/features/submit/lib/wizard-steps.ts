/**
 * Step order of the two submit wizards.
 *
 * Both recipes walk the same spine — basics, what you start from, the cases it
 * is judged on, how it is scored, how hard to search, how its rows are split,
 * review — but the Program wizard needs the cases before the starting point:
 * its signature and metric are drafted from the role-mapped columns, so the
 * Start step's agent has nothing to read until the rows exist. The Anything
 * wizard drafts its seed from the objective alone, so its cases stay optional
 * and come after. Hooks, step renderers and the tutorial address steps
 * through these index maps rather than literals so the two orders can differ
 * safely.
 */
export type WizardStepId =
  | "basics"
  | "start"
  | "cases"
  | "scorer"
  | "optimizer"
  | "split"
  | "review";

export const PROGRAM_STEP_ORDER: readonly WizardStepId[] = [
  "basics",
  "cases",
  "start",
  "scorer",
  "optimizer",
  "split",
  "review",
];

export const ANYTHING_STEP_ORDER: readonly WizardStepId[] = [
  "basics",
  "start",
  "cases",
  "scorer",
  "optimizer",
  "split",
  "review",
];

/** Maps every step id of `order` to its position. */
export function stepIndexMap(order: readonly WizardStepId[]): Record<WizardStepId, number> {
  return Object.fromEntries(order.map((id, index) => [id, index])) as Record<WizardStepId, number>;
}

export const PROGRAM_STEP = stepIndexMap(PROGRAM_STEP_ORDER);
export const ANYTHING_STEP = stepIndexMap(ANYTHING_STEP_ORDER);
