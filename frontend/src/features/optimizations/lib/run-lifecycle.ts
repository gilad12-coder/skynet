import type { OptimizationSummaryResponse } from "@/shared/types/api";

export type RecoveryDisplayState = "recovering" | "recovered" | "unavailable";

/** Fall back safely when a legacy or future backend sends an unknown state. */
export function recoveryDisplayState(recovery: { state?: unknown } | null | undefined): RecoveryDisplayState {
  return recovery?.state === "recovering" || recovery?.state === "recovered" ? recovery.state : "unavailable";
}

export function isBudgetStop(
  job: Pick<OptimizationSummaryResponse, "status" | "stop_reason">,
): boolean {
  return job.status === "stopped" && job.stop_reason === "budget_reached";
}

/** Only the worker's completed selection establishes an evaluated result. */
export function budgetResultKind(
  job: Pick<OptimizationSummaryResponse, "result_availability" | "terminal_evidence">,
): "seed" | "evaluated" | "none" {
  if (job.result_availability !== "evaluated") return "none";
  return job.terminal_evidence?.candidate_origin === "seed" ? "seed" : "evaluated";
}

/** Heartbeats within one recovery attempt share one notification. */
export function recoveryEpisode(
  job: Pick<OptimizationSummaryResponse, "optimization_id" | "recovery">,
): string | null {
  if (!job.recovery) return null;
  return `${job.optimization_id}:${job.recovery.execution_generation ?? 0}:${job.recovery.checkpoint_revision ?? ""}`;
}
