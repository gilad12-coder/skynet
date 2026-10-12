/**
 * The screens inside each wizard step. The wizard never scrolls: every step is
 * split into screens that each fit the viewport, and the Back/Continue arrows
 * walk them in order before crossing into the next step.
 */
import type { ExperienceLevel } from "@/features/experience";

import type { WizardStepId, WizardV2State } from "./wizard-v2";

export type WizardPageId =
  | "brief"
  | "artifact"
  | "source"
  | "confirm"
  | "summary"
  | "optimizer"
  | "models"
  | "budget"
  | "run"
  | "metric"
  | "check";

/**
 * How the Optimizer step is laid out at a level: Guided sees one read-only
 * summary of the preset engine, models and budget; Standard sees the same
 * summary with a Change that opens the full screens; Expert goes straight to
 * the engine, models and budget screens.
 */
export type OptimizerLayout = "summary" | "summary_with_change" | "full";

export function optimizerLayout(level: ExperienceLevel): OptimizerLayout {
  if (level === "guided") return "summary";
  return level === "standard" ? "summary_with_change" : "full";
}

const OPTIMIZER_SCREENS: readonly WizardPageId[] = ["optimizer", "models", "budget"];

function optimizerPages(state: WizardV2State): readonly WizardPageId[] {
  if (!state.task.artifactKind || !state.inputs.mode) return ["optimizer"];
  switch (optimizerLayout(state.level)) {
    case "full":
      return OPTIMIZER_SCREENS;
    case "summary":
    case "summary_with_change":
      // Expanded keeps the summary as the last screen, so the full screens
      // walk on to it showing what was just chosen.
      return state.optimizer.expanded ? [...OPTIMIZER_SCREENS, "summary"] : ["summary"];
  }
}

/** The screens of one step, in order. Screens that need earlier answers appear once they exist. */
export function stepPages(step: WizardStepId, state: WizardV2State): readonly WizardPageId[] {
  switch (step) {
    case "task":
      return ["brief", "artifact"];
    case "inputs":
      return state.inputs.cases.length > 0 ? ["source", "confirm"] : ["source"];
    case "optimizer":
      return optimizerPages(state);
    case "metric":
      return ["run", "metric", "check"];
  }
}
