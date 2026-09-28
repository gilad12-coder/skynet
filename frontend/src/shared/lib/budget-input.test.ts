import assert from "node:assert/strict";
import { test } from "node:test";

import { centsToBudgetText, parseBudgetInput } from "./budget-input.ts";

const value = (text: string, locale = "en") => parseBudgetInput(text, locale);

test("parseBudgetInput reads whole dollars as cents with locale grouping", () => {
  assert.deepEqual(value("120"), { kind: "value", value: 12000 });
  assert.deepEqual(value(" 1,200 "), { kind: "value", value: 120000 });
  assert.deepEqual(value("+120"), { kind: "value", value: 12000 });
  assert.deepEqual(value("1200.00"), { kind: "value", value: 120000 });
  assert.deepEqual(value("1.200", "de"), { kind: "value", value: 120000 });
  assert.deepEqual(value("1'200", "de-CH"), { kind: "value", value: 120000 });
  assert.deepEqual(value("1 200", "fr"), { kind: "value", value: 120000 });
  assert.deepEqual(value("1 200", "ru"), { kind: "value", value: 120000 });
  assert.deepEqual(value("1,00,000", "en-IN"), { kind: "value", value: 10000000 });
});

test("parseBudgetInput reads digits from any script", () => {
  assert.deepEqual(value("١٢٠", "ar"), { kind: "value", value: 12000 });
  assert.deepEqual(value("١٬٢٠٠", "ar"), { kind: "value", value: 120000 });
  assert.deepEqual(value("۱۲۰", "fa"), { kind: "value", value: 12000 });
  assert.deepEqual(value("१२०", "hi"), { kind: "value", value: 12000 });
  assert.deepEqual(value("１２０", "ja"), { kind: "value", value: 12000 });
  assert.deepEqual(value("‎١٢٠‏", "en"), { kind: "value", value: 12000 });
});

test("parseBudgetInput reads cents from up to two decimals", () => {
  assert.deepEqual(value("120.50"), { kind: "value", value: 12050 });
  assert.deepEqual(value("1.20"), { kind: "value", value: 120 });
  assert.deepEqual(value("0.5"), { kind: "value", value: 50 });
  assert.deepEqual(value("0.05"), { kind: "value", value: 5 });
  assert.deepEqual(value("0.01"), { kind: "value", value: 1 });
  assert.deepEqual(value("1,5", "de"), { kind: "value", value: 150 });
  assert.deepEqual(value("١٢٠٫٥", "ar"), { kind: "value", value: 12050 });
});

test("parseBudgetInput rejects sub-cent precision instead of rounding it away", () => {
  assert.deepEqual(value("0.005"), { kind: "fraction" });
  assert.deepEqual(value("1.234"), { kind: "fraction" });
  assert.deepEqual(value("120.505"), { kind: "fraction" });
  assert.deepEqual(value("١٢٠٫٥٥٥", "ar"), { kind: "fraction" });
});

test("parseBudgetInput rejects negatives and amounts below one cent", () => {
  assert.deepEqual(value("-120"), { kind: "below_one" });
  assert.deepEqual(value("−120"), { kind: "below_one" });
  assert.deepEqual(value("-0.5"), { kind: "below_one" });
  assert.deepEqual(value("0"), { kind: "below_one" });
  assert.deepEqual(value("000"), { kind: "below_one" });
  assert.deepEqual(value("0.00"), { kind: "below_one" });
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

test("centsToBudgetText renders cents as dollar text", () => {
  assert.equal(centsToBudgetText(250, "en"), "2.50");
  assert.equal(centsToBudgetText(1000, "en"), "10");
  assert.equal(centsToBudgetText(10, "en"), "0.10");
  assert.equal(centsToBudgetText(1, "en"), "0.01");
  assert.equal(centsToBudgetText(12050, "en"), "120.50");
  assert.equal(centsToBudgetText(150, "de"), "1,50");
});

test("centsToBudgetText round-trips through parseBudgetInput", () => {
  for (const cents of [1, 10, 99, 100, 150, 250, 1000, 12050, 120000]) {
    assert.deepEqual(parseBudgetInput(centsToBudgetText(cents, "en"), "en"), {
      kind: "value",
      value: cents,
    });
    assert.deepEqual(parseBudgetInput(centsToBudgetText(cents, "de"), "de"), {
      kind: "value",
      value: cents,
    });
  }
});
