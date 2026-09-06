import assert from "node:assert/strict";
import { test } from "node:test";
import { splitExampleCounts } from "./split-example-counts.ts";

test("counts match backend truncation and put remaining examples in test", () => {
  assert.deepEqual(splitExampleCounts(7, { train: 0.6, val: 0.2, test: 0.2 }), {
    train: 4,
    val: 1,
    test: 2,
  });
  assert.deepEqual(splitExampleCounts(101, { train: 0.8, val: 0.2, test: 0 }), {
    train: 80,
    val: 20,
    test: 1,
  });
});

test("counts update with edited ratios and dataset size", () => {
  assert.deepEqual(splitExampleCounts(100, { train: 0.5, val: 0.3, test: 0.2 }), {
    train: 50,
    val: 30,
    test: 20,
  });
  assert.deepEqual(splitExampleCounts(20, { train: 1, val: 0, test: 0 }), {
    train: 20,
    val: 0,
    test: 0,
  });
  assert.deepEqual(splitExampleCounts(0, { train: 0.6, val: 0.2, test: 0.2 }), {
    train: 0,
    val: 0,
    test: 0,
  });
});

test("unfinished edits preview each requested share without negative counts", () => {
  assert.deepEqual(splitExampleCounts(100, { train: 0.8, val: 0.3, test: 0.2 }), {
    train: 80,
    val: 30,
    test: 20,
  });
});
