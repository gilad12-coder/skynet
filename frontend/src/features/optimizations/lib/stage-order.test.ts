import { test } from "node:test";
import assert from "node:assert/strict";
import type { OptimizationStatusResponse, ProgressEvent } from "@/shared/types/api";
import type { PipelineStage } from "../constants";
import { preparationStages, stageInPlan } from "./stage-order.ts";

const ev = (event: string, metrics: Record<string, unknown> = {}): ProgressEvent => ({
  timestamp: "",
  event,
  metrics,
});

const job = (o: Partial<OptimizationStatusResponse>): OptimizationStatusResponse =>
  o as OptimizationStatusResponse;

const plan = (...keys: PipelineStage[]) => keys.map((key) => ({ key }));

test("a black-box run has no split or up-front baseline", () => {
  assert.deepEqual(preparationStages(job({ optimization_type: "blackbox" }), null), []);
});

test("a DSPy run splits and measures a baseline on its test split", () => {
  assert.deepEqual(preparationStages(job({ optimization_type: "run" }), null), [
    "splitting",
    "baseline",
  ]);
});

test("a DSPy run without a test split skips the baseline", () => {
  const fromEvent = job({
    optimization_type: "run",
    progress_events: [ev("dataset_splits_ready", { test_examples: 0 })],
  });
  assert.deepEqual(preparationStages(fromEvent, null), ["splitting"]);
  const fromPayload = preparationStages(job({ optimization_type: "run" }), {
    optimization_id: "x",
    optimization_type: "run",
    payload: { split_fractions: { train: 0.8, val: 0.2, test: 0 } },
  });
  assert.deepEqual(fromPayload, ["splitting"]);
});

test("a stage the plan skips resolves to the next one it lists", () => {
  const blackbox = plan("validating", "optimizing", "refining", "evaluating");
  assert.equal(stageInPlan(blackbox, "splitting"), "optimizing");
  assert.equal(stageInPlan(blackbox, "baseline"), "optimizing");
  assert.equal(stageInPlan(blackbox, "validating"), "validating");
  assert.equal(
    stageInPlan(plan("validating", "optimizing", "evaluating"), "refining"),
    "evaluating",
  );
  assert.equal(stageInPlan(blackbox, "done"), "done");
});
