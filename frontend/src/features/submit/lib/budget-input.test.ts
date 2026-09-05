import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBudgetInput } from "./budget-input.ts";

const value = (text: string, locale = "en") => parseBudgetInput(text, locale);

test("parseBudgetInput accepts whole credits with locale grouping", () => {
  assert.deepEqual(value("120"), { kind: "value", value: 120 });
  assert.deepEqual(value(" 1,200 "), { kind: "value", value: 1200 });
  assert.deepEqual(value("+120"), { kind: "value", value: 120 });
  assert.deepEqual(value("1200.00"), { kind: "value", value: 1200 });
  assert.deepEqual(value("1.200", "de"), { kind: "value", value: 1200 });
  assert.deepEqual(value("1'200", "de-CH"), { kind: "value", value: 1200 });
  assert.deepEqual(value("1 200", "fr"), { kind: "value", value: 1200 });
  assert.deepEqual(value("1 200", "ru"), { kind: "value", value: 1200 });
  assert.deepEqual(value("1,00,000", "en-IN"), { kind: "value", value: 100000 });
});

test("parseBudgetInput reads digits from any script", () => {
  assert.deepEqual(value("١٢٠", "ar"), { kind: "value", value: 120 });
  assert.deepEqual(value("١٬٢٠٠", "ar"), { kind: "value", value: 1200 });
  assert.deepEqual(value("۱۲۰", "fa"), { kind: "value", value: 120 });
  assert.deepEqual(value("१२०", "hi"), { kind: "value", value: 120 });
  assert.deepEqual(value("１２０", "ja"), { kind: "value", value: 120 });
  assert.deepEqual(value("‎١٢٠‏", "en"), { kind: "value", value: 120 });
});

test("parseBudgetInput rejects fractions instead of dropping the separator", () => {
  assert.deepEqual(value("120.50"), { kind: "fraction" });
  assert.deepEqual(value("1,5", "de"), { kind: "fraction" });
  assert.deepEqual(value("١٢٠٫٥", "ar"), { kind: "fraction" });
  assert.deepEqual(value("0.5"), { kind: "fraction" });
});

test("parseBudgetInput rejects negatives and zero instead of flipping the sign", () => {
  assert.deepEqual(value("-120"), { kind: "below_one" });
  assert.deepEqual(value("−120"), { kind: "below_one" });
  assert.deepEqual(value("0"), { kind: "below_one" });
  assert.deepEqual(value("000"), { kind: "below_one" });
});

test("parseBudgetInput reports text it cannot read", () => {
  assert.deepEqual(value("abc"), { kind: "invalid" });
  assert.deepEqual(value("12a"), { kind: "invalid" });
  assert.deepEqual(value("1e3"), { kind: "invalid" });
  assert.deepEqual(value("1,5"), { kind: "invalid" });
  assert.deepEqual(value("1.5", "de"), { kind: "invalid" });
  assert.deepEqual(value("1,0000"), { kind: "invalid" });
  assert.deepEqual(value("1.2.3"), { kind: "invalid" });
  assert.deepEqual(value("99999999999999999999"), { kind: "invalid" });
});

test("parseBudgetInput treats blank text as unset", () => {
  assert.deepEqual(value(""), { kind: "empty" });
  assert.deepEqual(value("   "), { kind: "empty" });
  assert.deepEqual(value("‎"), { kind: "empty" });
});
