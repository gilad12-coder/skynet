import type { WizardStageId } from "./wizard-steps";

/** A concrete problem: toasted, and holding its stage until it is fixed. */
export interface WizardIssue {
  stage: WizardStageId;
  /** DOM id or `data-tutorial` handle of the control that fixes it. */
  fieldId?: string;
  message: string;
  /** Set for problems a setup check found: the issue clears once that setup changes. */
  identity?: string;
}
