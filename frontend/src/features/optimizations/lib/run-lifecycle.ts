import type { OptimizationSummaryResponse } from "@/shared/types/api";

export function isBudgetStop(
  job: Pick<OptimizationSummaryResponse, "status" | "stop_reason">,
): boolean {
  return job.status === "stopped" && job.stop_reason === "budget_reached";
}

/** The worker parked the run at a checkpoint because its measured burn outgrows the limit. */
export function isBudgetPause(
  job: Pick<OptimizationSummaryResponse, "status" | "stop_reason">,
): boolean {
  return job.status === "paused" && job.stop_reason === "budget_projected";
}

/** Only the worker's completed selection establishes an evaluated result. */
export function budgetResultKind(
  job: Pick<OptimizationSummaryResponse, "result_availability" | "terminal_evidence">,
): "seed" | "evaluated" | "none" {
  if (job.result_availability !== "evaluated") return "none";
  return job.terminal_evidence?.candidate_origin === "seed" ? "seed" : "evaluated";
}
