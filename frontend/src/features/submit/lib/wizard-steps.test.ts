import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAST_WIZARD_STAGE,
  WIZARD_STAGE,
  WIZARD_STAGE_ORDER,
  isWizardStageId,
} from "./wizard-steps.ts";

test("the four steps run Task → Inputs → Optimizer → Metric", () => {
  assert.deepEqual(WIZARD_STAGE_ORDER, ["task", "inputs", "optimizer", "metric"]);
  assert.equal(LAST_WIZARD_STAGE, 3);
});

test("step positions round-trip through the order", () => {
  for (const [id, index] of Object.entries(WIZARD_STAGE)) {
    assert.equal(WIZARD_STAGE_ORDER[index], id);
  }
});

test("isWizardStageId accepts step ids only", () => {
  for (const id of WIZARD_STAGE_ORDER) assert.ok(isWizardStageId(id));
  assert.equal(isWizardStageId("goal"), false);
  assert.equal(isWizardStageId(1), false);
  assert.equal(isWizardStageId(undefined), false);
});
