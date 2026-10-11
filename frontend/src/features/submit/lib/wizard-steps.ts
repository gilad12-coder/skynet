/**
 * Step model of the submission wizard.
 *
 * One fixed wizard walks four steps: Task, Inputs, Optimizer, Metric. Step
 * ids are the identity used by validation destinations, tutorial targets and
 * Edit actions; the numeric position is derived from the order for display
 * and the slide direction only.
 */
import type { WizardStepId } from "./wizard-v2";

export type WizardStageId = WizardStepId;

// Same order as WIZARD_V2_STEPS, inlined so node tests load this file without path aliases.
export const WIZARD_STAGE_ORDER: readonly WizardStageId[] = ["task", "inputs", "optimizer", "metric"];

export const LAST_WIZARD_STAGE = WIZARD_STAGE_ORDER.length - 1;

/** Position of each step: the index the wizard animates and validates by. */
export const WIZARD_STAGE: Readonly<Record<WizardStageId, number>> = {
  task: 0,
  inputs: 1,
  optimizer: 2,
  metric: 3,
};

export function isWizardStageId(value: unknown): value is WizardStageId {
  return typeof value === "string" && (WIZARD_STAGE_ORDER as readonly string[]).includes(value);
}

/** Step at a numeric position; out-of-range positions clamp to the nearest end. */
export function stageAt(index: number): WizardStageId {
  const clamped = Number.isFinite(index)
    ? Math.min(Math.max(Math.trunc(index), 0), LAST_WIZARD_STAGE)
    : 0;
  return WIZARD_STAGE_ORDER[clamped] ?? "task";
}
