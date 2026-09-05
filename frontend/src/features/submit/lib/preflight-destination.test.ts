import assert from "node:assert/strict";
import { test } from "node:test";
import { preflightDestination } from "./preflight-destination.ts";

test("execution failures return to the stage that owns the failed field", () => {
  assert.deepEqual(preflightDestination("anything", "scorer", "execution"), {
    stage: "evaluation",
    fieldId: "bb-scorer-code",
  });
  assert.deepEqual(preflightDestination("dspy", "metric", "execution"), {
    stage: "evaluation",
    fieldId: "metric-editor",
  });
  assert.deepEqual(preflightDestination("anything", "model.optimization", "execution"), {
    stage: "optimization",
    fieldId: "bb-optimization-model",
  });
  assert.deepEqual(preflightDestination("dspy", "runtime", "evaluation"), {
    stage: "optimization",
    fieldId: "wizard-stage-optimization",
  });
  assert.deepEqual(preflightDestination("dspy", "usage", "execution"), {
    stage: "optimization",
    fieldId: "totalBudgetInput",
  });
});

test("unrecognized checks focus a real stage instead of a nonexistent API field", () => {
  assert.deepEqual(preflightDestination("anything", "setup", "execution"), {
    stage: "optimization",
    fieldId: "wizard-stage-optimization",
  });
});
