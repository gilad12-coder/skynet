import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBudgetAmount } from "./format-budget-amount.ts";

test("budget displays round to whole credits", () => {
  assert.equal(formatBudgetAmount("116.06994", "en"), "116");
  assert.equal(formatBudgetAmount("3.93006", "en"), "4");
  assert.equal(formatBudgetAmount("20.5", "en"), "21");
  assert.equal(formatBudgetAmount("-20.5", "en"), "-21");
  assert.equal(formatBudgetAmount("0.000000001", "en"), "0");
  assert.equal(formatBudgetAmount("-0.01", "en"), "0");
});

test("rounding preserves large integer precision and locale grouping", () => {
  assert.equal(formatBudgetAmount("9007199254740993.5", "en"), "9,007,199,254,740,994");
  assert.equal(formatBudgetAmount("1234.5", "de"), "1.235");
  assert.equal(formatBudgetAmount("20.000", "he"), "20");
});
