import type { WizardIssue } from "./wizard-issue";
import type { WizardStageId } from "./wizard-steps";

/** The black-box stage holding an issue's field, which may differ from the stage that reports it. */
export function blackboxIssueStage({ stage, fieldId }: WizardIssue): WizardStageId {
  if (fieldId === "totalBudgetInput" || fieldId === "bb-cases") return "evaluation";
  return stage;
}
