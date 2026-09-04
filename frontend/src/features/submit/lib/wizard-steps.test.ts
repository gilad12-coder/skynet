import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANYTHING_STEP,
  ANYTHING_STEP_ORDER,
  PROGRAM_STEP,
  PROGRAM_STEP_ORDER,
  stepIndexMap,
} from "./wizard-steps.ts";

test("both wizards walk the same seven steps, from basics to review", () => {
  assert.deepEqual([...PROGRAM_STEP_ORDER].sort(), [...ANYTHING_STEP_ORDER].sort());
  assert.equal(new Set(PROGRAM_STEP_ORDER).size, PROGRAM_STEP_ORDER.length);
  for (const order of [PROGRAM_STEP_ORDER, ANYTHING_STEP_ORDER]) {
    assert.equal(order[0], "basics");
    assert.equal(order[order.length - 1], "review");
  }
});

test("the Program wizard collects the cases before the starting point", () => {
  assert.ok(PROGRAM_STEP.cases < PROGRAM_STEP.start);
  assert.ok(PROGRAM_STEP.start < PROGRAM_STEP.scorer);
  assert.ok(PROGRAM_STEP.optimizer < PROGRAM_STEP.split);
  assert.ok(PROGRAM_STEP.split < PROGRAM_STEP.review);
});

test("the Anything wizard drafts the starting point before the cases", () => {
  assert.ok(ANYTHING_STEP.start < ANYTHING_STEP.cases);
  assert.ok(ANYTHING_STEP.cases < ANYTHING_STEP.scorer);
  assert.ok(ANYTHING_STEP.optimizer < ANYTHING_STEP.split);
  assert.ok(ANYTHING_STEP.split < ANYTHING_STEP.review);
});

test("stepIndexMap round-trips every id to its position", () => {
  for (const order of [PROGRAM_STEP_ORDER, ANYTHING_STEP_ORDER]) {
    const index = stepIndexMap(order);
    for (const id of order) assert.equal(order[index[id]], id);
  }
});
