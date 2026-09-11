"use client";

import { CheckCircle } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import { formatMsg, msg } from "@/shared/lib/messages";

import type { EvidenceStatus } from "../../lib/validation-evidence";

/**
 * Where the evaluator check stands for the setup as it is right now. Passed
 * evidence names the model it ran with. Before any check has run, while one
 * runs (the validation frame reports that) and once the setup changed since
 * the last one, there is nothing to say here, so the chip stays out of the
 * way.
 */
export function EvidenceChip({
  status,
  modelName,
  className,
}: {
  status: EvidenceStatus;
  modelName?: string | null;
  className?: string;
}) {
  const base = "inline-flex items-center gap-1.5 text-[0.6875rem] font-medium";
  if (status === "passed") {
    return (
      <span className={cn(base, "text-[#5A7247]", className)} role="status">
        <CheckCircle className="size-3 shrink-0" aria-hidden="true" />
        {modelName
          ? formatMsg("submit.blackbox.evidence.passed_with", { model: `⁦${modelName}⁩` })
          : msg("submit.blackbox.evidence.passed")}
      </span>
    );
  }
  return null;
}
