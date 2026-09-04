import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAST_WIZARD_STAGE,
  LEGACY_PROGRAM_STEP_ORDER,
  LEGACY_STEP_STAGE,
  WIZARD_STAGE,
  WIZARD_STAGE_ORDER,
  isWizardStageId,
  migrateLegacyProgramFurthest,
  migrateLegacyProgramStep,
  stageAt,
} from "./wizard-steps.ts";

test("the four stages run Goal → Evaluation → Optimization → Review", () => {
  assert.deepEqual(WIZARD_STAGE_ORDER, ["goal", "evaluation", "optimization", "review"]);
  assert.equal(LAST_WIZARD_STAGE, 3);
});

test("stage positions round-trip through the order", () => {
  for (const [id, index] of Object.entries(WIZARD_STAGE)) {
    assert.equal(WIZARD_STAGE_ORDER[index], id);
    assert.equal(stageAt(index), id);
  }
});

test("stageAt clamps positions outside the flow", () => {
  assert.equal(stageAt(-1), "goal");
  assert.equal(stageAt(99), "review");
  assert.equal(stageAt(Number.NaN), "goal");
  assert.equal(stageAt(1.7), "evaluation");
});

test("isWizardStageId accepts stage ids only", () => {
  for (const id of WIZARD_STAGE_ORDER) assert.ok(isWizardStageId(id));
  assert.equal(isWizardStageId("basics"), false);
  assert.equal(isWizardStageId(1), false);
  assert.equal(isWizardStageId(undefined), false);
});

test("legacy steps migrate to the stage that owns their content", () => {
  assert.deepEqual(LEGACY_STEP_STAGE, {
    basics: "review",
    start: "goal",
    cases: "evaluation",
    scorer: "evaluation",
    split: "evaluation",
    optimizer: "optimization",
    review: "review",
  });
  LEGACY_PROGRAM_STEP_ORDER.forEach((id, index) => {
    assert.equal(migrateLegacyProgramStep(index), LEGACY_STEP_STAGE[id]);
  });
  assert.equal(migrateLegacyProgramStep(-3), LEGACY_STEP_STAGE.basics);
  assert.equal(migrateLegacyProgramStep(42), "review");
});

test("a legacy furthest step never unlocks Review through Basics alone", () => {
  assert.equal(migrateLegacyProgramFurthest(0), "goal");
  assert.equal(migrateLegacyProgramFurthest(1), "evaluation");
  assert.equal(migrateLegacyProgramFurthest(2), "evaluation");
  assert.equal(migrateLegacyProgramFurthest(4), "optimization");
  assert.equal(migrateLegacyProgramFurthest(5), "optimization");
  assert.equal(migrateLegacyProgramFurthest(6), "review");
  assert.equal(migrateLegacyProgramFurthest(99), "review");
});
