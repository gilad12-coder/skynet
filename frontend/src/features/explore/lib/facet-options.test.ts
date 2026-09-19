import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLAPSE_LIMIT,
  countOccurrences,
  isCollapsible,
  isExhausted,
  visibleOptions,
} from "./facet-options.ts";

const identity = (v: string) => v;

function options(...pairs: Array<[string, number]>) {
  return pairs.map(([value, count]) => ({ value, count }));
}

test("short sections show every option in the given order", () => {
  const opts = options(["cot", 0], ["predict", 3], ["react", 1]);
  const shown = visibleOptions(opts, [], { expanded: false, query: "", labelOf: identity });
  assert.deepEqual(
    shown.map((o) => o.value),
    ["cot", "predict", "react"],
  );
  assert.equal(isCollapsible(opts), false);
});

test("collapsed long sections pin selected values then the busiest of the rest", () => {
  const opts = options(
    ...Array.from({ length: COLLAPSE_LIMIT + 4 }, (_, i): [string, number] => [`m${i}`, i]),
  );
  const shown = visibleOptions(opts, ["m0"], { expanded: false, query: "", labelOf: identity });
  assert.equal(shown.length, COLLAPSE_LIMIT);
  assert.equal(shown[0].value, "m0");
  assert.deepEqual(
    shown.slice(1).map((o) => o.count),
    [11, 10, 9, 8, 7, 6, 5],
  );
});

test("expanding a long section shows everything in the given order", () => {
  const opts = options(
    ...Array.from({ length: COLLAPSE_LIMIT + 1 }, (_, i): [string, number] => [`m${i}`, 0]),
  );
  const shown = visibleOptions(opts, [], { expanded: true, query: "", labelOf: identity });
  assert.equal(shown.length, COLLAPSE_LIMIT + 1);
  assert.equal(shown[0].value, "m0");
});

test("a search query matches on value or label and ignores collapsing", () => {
  const opts = options(["openrouter/openai/gpt-5.4-mini", 2], ["anthropic/claude", 1]);
  const labelOf = (v: string) => v.split("/").pop() ?? v;
  const byLabel = visibleOptions(opts, [], { expanded: false, query: "MINI", labelOf });
  assert.deepEqual(
    byLabel.map((o) => o.value),
    ["openrouter/openai/gpt-5.4-mini"],
  );
  const byValue = visibleOptions(opts, [], { expanded: false, query: "anthropic", labelOf });
  assert.equal(byValue.length, 1);
});

test("a section is exhausted only when every option counts zero", () => {
  assert.equal(isExhausted(options(["a", 0], ["b", 0])), true);
  assert.equal(isExhausted(options(["a", 0], ["b", 1])), false);
  assert.equal(isExhausted([]), false);
});

test("countOccurrences tallies non-empty values alphabetically", () => {
  assert.deepEqual(countOccurrences(["predict", null, "cot", "predict", "", undefined]), [
    { value: "cot", count: 1 },
    { value: "predict", count: 2 },
  ]);
});
