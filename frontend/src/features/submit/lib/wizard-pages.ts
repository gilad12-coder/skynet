/**
 * The screens inside each wizard step. The wizard never scrolls: every step is
 * split into screens that each fit the viewport, and the Back/Continue arrows
 * walk them in order before crossing into the next step.
 */
import type { WizardStepId, WizardV2State } from "./wizard-v2";

export type WizardPageId =
  | "brief"
  | "artifact"
  | "source"
  | "confirm"
  | "optimizer"
  | "models"
  | "budget"
  | "run"
  | "metric"
  | "check";

/** The screens of one step, in order. Screens that need earlier answers appear once they exist. */
export function stepPages(step: WizardStepId, state: WizardV2State): readonly WizardPageId[] {
  switch (step) {
    case "task":
      return ["brief", "artifact"];
    case "inputs":
      return state.inputs.cases.length > 0 ? ["source", "confirm"] : ["source"];
    case "optimizer":
      return state.task.artifactKind && state.inputs.mode
        ? ["optimizer", "models", "budget"]
        : ["optimizer"];
    case "metric":
      return ["run", "metric", "check"];
  }
}
