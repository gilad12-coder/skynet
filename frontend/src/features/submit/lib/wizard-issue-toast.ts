import { toast } from "react-toastify";

import type { WizardIssue } from "./wizard-issue";

const TOAST_ID = "wizard-issue";

/** One error toast for the stage's problem, rewritten in place when the problem changes. */
export function toastWizardIssue(issue: WizardIssue): void {
  if (toast.isActive(TOAST_ID)) toast.update(TOAST_ID, { render: issue.message, type: "error" });
  else toast.error(issue.message, { toastId: TOAST_ID });
}
