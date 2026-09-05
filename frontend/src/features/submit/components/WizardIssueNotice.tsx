"use client";

import { msg } from "@/shared/lib/messages";
import { Warning } from "@/shared/ui/icons";

import type { WizardIssue } from "../lib/wizard-issue";

/** The stage's current problem, shown above the panel that holds its field. */
export function WizardIssueNotice({ issue, onFix }: { issue: WizardIssue; onFix?: () => void }) {
  // Stage-level handles only scroll; a Go-to affordance for them says nothing.
  const fixable = Boolean(issue.fieldId && !issue.fieldId.startsWith("wizard-stage-"));
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2.5 rounded-lg border border-[#A3512B]/25 bg-[#A3512B]/[0.06] px-3.5 py-2.5 text-sm text-[#3D2E22]"
    >
      <Warning className="mt-0.5 size-4 shrink-0 text-[#A3512B]" aria-hidden />
      <p className="min-w-0 flex-1 leading-snug" dir="auto">
        {issue.message}
      </p>
      {fixable && onFix && (
        <button
          type="button"
          onClick={onFix}
          className="shrink-0 text-xs font-semibold text-[#A3512B] underline-offset-2 hover:underline"
        >
          {msg("submit.issue.fix")}
        </button>
      )}
    </div>
  );
}
