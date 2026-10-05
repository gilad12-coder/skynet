/** Contract: fold tiers track the CSS breakpoints and folded values find their column. */

import assert from "node:assert/strict";
import test from "node:test";

import { foldTier, glideKey, pairByText } from "./table-glide.ts";

test("fold tier counts the fold points a width sits at or below", () => {
  assert.equal(foldTier(1200, 16), 0);
  assert.equal(foldTier(960, 16), 1);
  assert.equal(foldTier(700, 16), 2);
  assert.equal(foldTier(500, 16), 3);
});

test("fold tier scales with the root font size", () => {
  assert.equal(foldTier(800, 20), 2);
});

test("glide key ignores whitespace differences between a cell and its folded copy", () => {
  assert.equal(glideKey("  GEPA\n  run "), "GEPA run");
  assert.equal(glideKey(null), "");
});

const text = (el: { t: string }) => el.t;

test("an appeared value pairs with the departed value showing the same text", () => {
  const cell = { t: "Running" };
  const inline = { t: "Running" };
  const pairs = pairByText([inline], [{ t: "12 rows" }, cell], text);
  assert.equal(pairs.get(inline), cell);
});

test("each departed value pairs once and empty text never pairs", () => {
  const a = { t: "x" };
  const b = { t: "x" };
  const gone = { t: "x" };
  const empty = { t: "" };
  const pairs = pairByText([a, b, empty], [gone, { t: "" }], text);
  assert.equal(pairs.get(a), gone);
  assert.equal(pairs.has(b), false);
  assert.equal(pairs.has(empty), false);
});
