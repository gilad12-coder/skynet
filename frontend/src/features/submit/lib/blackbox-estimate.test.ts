import assert from "node:assert/strict";
import test from "node:test";

import { blackboxEstimatedScorerRuns, blackboxFinalScorerRuns } from "./blackbox-estimate.ts";

test("the final run scores both versions once each without cases", () => {
  assert.equal(blackboxFinalScorerRuns(0, true), 2);
  assert.equal(blackboxFinalScorerRuns(0, false), 1);
});

test("the final run scores both versions on every case", () => {
  assert.equal(blackboxFinalScorerRuns(1, true), 2);
  assert.equal(blackboxFinalScorerRuns(25, true), 50);
  assert.equal(blackboxFinalScorerRuns(25, false), 25);
});

test("the estimate adds the final run to the search budget", () => {
  assert.equal(blackboxEstimatedScorerRuns(100, 0, true), 102);
  assert.equal(blackboxEstimatedScorerRuns(100, 10, true), 120);
});

test("a run with zero cases still counts the final run on top of the budget", () => {
  assert.equal(blackboxEstimatedScorerRuns(100, 0, true), 102);
  assert.equal(blackboxEstimatedScorerRuns(0, 0, false), 1);
});
