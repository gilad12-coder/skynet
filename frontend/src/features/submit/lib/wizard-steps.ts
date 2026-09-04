/**
 * Stage model of the submission wizard.
 *
 * Both recipes — the Program (DSPy) wizard and the Anything (blackbox) wizard —
 * walk the same four stages: Goal, Evaluation, Optimization, Review. Stage IDs
 * are the identity used by saved drafts, validation destinations, tutorial
 * targets and review Edit actions; the numeric position is derived from the
 * order for display and the slide direction only.
 */
export type WizardStageId = "goal" | "evaluation" | "optimization" | "review";

export const WIZARD_STAGE_ORDER: readonly WizardStageId[] = [
  "goal",
  "evaluation",
  "optimization",
  "review",
];

export const LAST_WIZARD_STAGE = WIZARD_STAGE_ORDER.length - 1;

/** Position of each stage — the `step` index the hooks animate and validate by. */
export const WIZARD_STAGE: Readonly<Record<WizardStageId, number>> = {
  goal: 0,
  evaluation: 1,
  optimization: 2,
  review: 3,
};

export function isWizardStageId(value: unknown): value is WizardStageId {
  return typeof value === "string" && (WIZARD_STAGE_ORDER as readonly string[]).includes(value);
}

function clampIndex(index: number, last: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), last);
}

/** Stage at a numeric position; out-of-range positions clamp to the nearest end. */
export function stageAt(index: number): WizardStageId {
  return WIZARD_STAGE_ORDER[clampIndex(index, LAST_WIZARD_STAGE)] ?? "goal";
}

/**
 * The seven-step layout the Program wizard used before the stage model. Kept
 * only so a draft saved by that layout restores into the stage that now owns
 * its content; nothing renders from it.
 */
export type LegacyWizardStepId =
  | "basics"
  | "start"
  | "cases"
  | "scorer"
  | "optimizer"
  | "split"
  | "review";

export const LEGACY_PROGRAM_STEP_ORDER: readonly LegacyWizardStepId[] = [
  "basics",
  "cases",
  "start",
  "scorer",
  "optimizer",
  "split",
  "review",
];

export const LEGACY_STEP_STAGE: Readonly<Record<LegacyWizardStepId, WizardStageId>> = {
  basics: "review",
  start: "goal",
  cases: "evaluation",
  scorer: "evaluation",
  split: "evaluation",
  optimizer: "optimization",
  review: "review",
};

/** The stage that now owns the content of a legacy Program-wizard step index. */
export function migrateLegacyProgramStep(index: number): WizardStageId {
  const id =
    LEGACY_PROGRAM_STEP_ORDER[clampIndex(index, LEGACY_PROGRAM_STEP_ORDER.length - 1)] ?? "start";
  return LEGACY_STEP_STAGE[id];
}

/**
 * The furthest stage a legacy draft has earned. Basics moved from the front
 * of the flow to Review, so having seen it unlocks nothing — otherwise every
 * old draft would open with Review reachable.
 */
export function migrateLegacyProgramFurthest(index: number): WizardStageId {
  const reached = LEGACY_PROGRAM_STEP_ORDER.slice(
    0,
    clampIndex(index, LEGACY_PROGRAM_STEP_ORDER.length - 1) + 1,
  ).filter((id) => id !== "basics");
  const furthest = Math.max(0, ...reached.map((id) => WIZARD_STAGE[LEGACY_STEP_STAGE[id]]));
  return WIZARD_STAGE_ORDER[furthest] ?? "goal";
}
