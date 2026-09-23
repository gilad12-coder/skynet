import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNTHETIC_DEFAULT_ROWS,
  SYNTHETIC_MAX_ROWS,
  clampSyntheticRows,
  parseSyntheticColumns,
  syntheticSourceName,
} from "./synthetic.ts";

test("column list splits on commas and newlines, trims, dedupes and caps", () => {
  assert.deepEqual(parseSyntheticColumns(" text, channel,,text\nsentiment "), [
    "text",
    "channel",
    "sentiment",
  ]);
  assert.deepEqual(parseSyntheticColumns(""), []);
  assert.equal(parseSyntheticColumns("a,b,c,d,e,f,g,h").length, 6);
});

test("row count is clamped to the route's limits and defaults when unparsable", () => {
  assert.equal(clampSyntheticRows(Number.NaN), SYNTHETIC_DEFAULT_ROWS);
  assert.equal(clampSyntheticRows(0), 1);
  assert.equal(clampSyntheticRows(12.6), 13);
  assert.equal(clampSyntheticRows(10_000), SYNTHETIC_MAX_ROWS);
});

test("source name is the brief's first non-empty line, collapsed and capped", () => {
  assert.equal(syntheticSourceName("\n  Bank   support chats \nmore detail"), "Bank support chats");
  const long = syntheticSourceName("x".repeat(80));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});
