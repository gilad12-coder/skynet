"use client";

import { CheckCircle, CircleNotch, Warning, XCircle } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import { formatMsg, msg } from "@/shared/lib/messages";

import type { EvidenceStatus } from "../../lib/validation-evidence";

/**
 * Where the evaluator check stands for the setup as it is right now. Passed
 * evidence names the model it ran with; anything edited since shows as stale
 * rather than as a failure, and an inherited scoring model that has no
 * optimization model yet explains when its check will run.
 */
export function EvidenceChip({
  status,
  pending,
  modelName,
  className,
}: {
  status: EvidenceStatus;
  pending: boolean;
  modelName?: string | null;
  className?: string;
}) {
  const base = "inline-flex items-center gap-1.5 text-[0.6875rem] font-medium";
  if (status === "running") {
    return (
      <span className={cn(base, "text-muted-foreground", className)} role="status">
        <CircleNotch className="size-3 shrink-0 animate-spin" aria-hidden="true" />
        {msg("submit.blackbox.evidence.running")}
      </span>
    );
  }
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
  if (status === "failed") {
    return (
      <span className={cn(base, "text-[#A3512B]", className)} role="status">
        <XCircle className="size-3 shrink-0" aria-hidden="true" />
        {msg("submit.blackbox.evidence.failed")}
      </span>
    );
  }
  if (status === "stale") {
    return (
      <span className={cn(base, "text-amber-700", className)} role="status">
        <Warning className="size-3 shrink-0" aria-hidden="true" />
        {msg("submit.blackbox.evidence.stale")}
      </span>
    );
  }
  return (
    <span className={cn(base, "font-normal text-muted-foreground", className)}>
      {msg(pending ? "submit.blackbox.evidence.pending" : "submit.blackbox.evidence.idle")}
    </span>
  );
}
