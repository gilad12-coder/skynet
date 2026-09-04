import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBudgetAmount } from "./format-budget-amount.ts";

test("fractional budget balances remain exact at the supported billionth-credit precision", () => {
  assert.equal(formatBudgetAmount("1000000000.000000001", "en"), "1,000,000,000.000000001");
  assert.equal(formatBudgetAmount("0.000000001", "de"), "0,000000001");
  assert.equal(formatBudgetAmount("20.250000000", "en"), "20.25");
  assert.equal(formatBudgetAmount("20.000", "he"), "20");
});
