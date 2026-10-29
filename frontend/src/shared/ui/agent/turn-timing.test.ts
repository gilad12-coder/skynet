import assert from "node:assert/strict";
import { test } from "node:test";

import { earliestStart, finishedTurnMs, turnStart, visibleThinking } from "./turn-timing.ts";

test("a thinking segment with no reasoning is no row", () => {
  const segments = [
    { reasoning: "", startedAt: 1, endedAt: null },
    { reasoning: "plan", startedAt: 2, endedAt: 3 },
  ];
  assert.deepEqual(visibleThinking(segments), [segments[1]]);
});

test("the live timer's start only ever moves earlier", () => {
  // The reasoning-less segment that started the turn drops out of the rows;
  // the start it set must stay, or "Working for 2s" turns into "1s".
  let start = earliestStart(null, turnStart([{ startedAt: 1000, endedAt: null }], []));
  start = earliestStart(start, turnStart([], [{ call: { startedAt: 2000, endedAt: null } }]));
  assert.equal(start, 1000);
  assert.equal(earliestStart(start, null), 1000);
  assert.equal(earliestStart(null, null), null);
});

test("a finished turn counts up to the coding tool's end, after the reply", () => {
  const steps = [{ call: { startedAt: 1000, endedAt: 9000 } }];
  assert.equal(finishedTurnMs(1000, [], steps, 2000), 8000);
  assert.equal(finishedTurnMs(1000, [], [{ call: { startedAt: 1000, endedAt: 1500 } }], 2000), 2000);
  assert.equal(finishedTurnMs(null, [], [], null), 0);
});
