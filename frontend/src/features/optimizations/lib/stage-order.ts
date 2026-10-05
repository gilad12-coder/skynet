/**
 * Which of the optional stages a run goes through, and how a detected stage
 * maps onto a run's plan. Kept free of runtime imports so it unit-tests
 * without the app's module aliases.
 */
import type { OptimizationPayloadResponse, OptimizationStatusResponse } from "@/shared/types/api";
import type { PipelineStage } from "../constants";

const STAGE_ORDER: readonly PipelineStage[] = [
  "validating",
  "splitting",
  "baseline",
  "optimizing",
  "refining",
  "evaluating",
];

// A DSPy run measures its baseline on the test split, so a run without one
// goes straight from splitting to the optimizer.
function hasTestSplit(
  job: OptimizationStatusResponse,
  payload: OptimizationPayloadResponse | null | undefined,
): boolean {
  const splits = job.progress_events?.find((e) => e.event === "dataset_splits_ready");
  if (splits) return splits.metrics?.test_examples !== 0;
  const fractions = payload?.payload.split_fractions as { test?: number } | undefined;
  return fractions?.test !== 0;
}

/**
 * The stages a run passes through before its optimizer starts, besides
 * validation. Black-box runs have none: they never split cases and score
 * the starting point in the final evaluation.
 */
export function preparationStages(
  job: OptimizationStatusResponse,
  payload: OptimizationPayloadResponse | null | undefined,
): PipelineStage[] {
  if (job.optimization_type === "blackbox") return [];
  return hasTestSplit(job, payload) ? ["splitting", "baseline"] : ["splitting"];
}

/**
 * Map a detected stage onto the plan. Stage detection is shared across run
 * kinds, so it can name a stage this run skips (a black-box run reads as
 * "splitting" before its first candidate); the run is then in the next
 * stage the plan does list.
 */
export function stageInPlan(
  plan: ReadonlyArray<{ key: PipelineStage }>,
  stage: PipelineStage | "done",
): PipelineStage | "done" {
  if (stage === "done") return stage;
  const keys = new Set(plan.map((s) => s.key));
  return STAGE_ORDER.slice(STAGE_ORDER.indexOf(stage)).find((k) => keys.has(k)) ?? "done";
}
