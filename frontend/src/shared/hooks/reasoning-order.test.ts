import { test } from "node:test";
import assert from "node:assert/strict";

import { liveLanesLast } from "./reasoning-order.ts";

test("a finished lane moves above the lane still thinking", () => {
  assert.deepEqual(liveLanesLast(["metric", "signature"], new Set(["metric"])), [
    "signature",
    "metric",
  ]);
});

test("arrival order holds among live lanes and among finished ones", () => {
  assert.deepEqual(liveLanesLast(["metric", "signature"], new Set(["metric", "signature"])), [
    "metric",
    "signature",
  ]);
  assert.deepEqual(liveLanesLast(["metric", "signature"], new Set()), ["metric", "signature"]);
});
