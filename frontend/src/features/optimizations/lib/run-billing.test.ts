import { test } from "node:test";
import assert from "node:assert/strict";
import { readBilling, runCostCents } from "./run-billing.ts";

test("no stamp before the run settles", () => {
  assert.equal(readBilling(undefined), null);
  assert.equal(readBilling({}), null);
});

test("a billed stamp is returned intact", () => {
  const billing = { outcome: "billed", cents: 12, estimated_low: 8, estimated_high: 20 };
  assert.deepEqual(readBilling({ billing }), billing);
});

test("malformed stamps are rejected", () => {
  assert.equal(readBilling({ billing: "billed" }), null);
  assert.equal(readBilling({ billing: { outcome: "billed" } }), null);
});

test("a legacy refunded stamp is ignored, not rendered", () => {
  // Stamped by the retired no-lift guarantee; its cents describe a refund,
  // not a charge, so surfacing it as a cost would misread history.
  assert.equal(readBilling({ billing: { outcome: "refunded", cents: 12 } }), null);
});

const budget = (fields: Record<string, unknown>) =>
  ({ billed_cents: 0, wallet_setup_spent_cents: "0", wallet_run_spent_cents: "0", ...fields }) as never;

test("the billing stamp wins over the budget", () => {
  const details = { billing: { outcome: "billed", cents: 12 } };
  assert.equal(runCostCents(details, budget({ billed_cents: 99 }), false), 12);
});

test("a settled budget run shows what the wallet was billed", () => {
  assert.equal(runCostCents({}, budget({ billed_cents: 56 }), false), 56);
});

test("a live budget run shows its wallet spend so far", () => {
  const live = budget({ wallet_setup_spent_cents: "4.2", wallet_run_spent_cents: "10.5" });
  assert.equal(runCostCents(undefined, live, true), 14.7);
});

test("no charge yet shows nothing", () => {
  assert.equal(runCostCents(undefined, undefined, false), null);
  assert.equal(runCostCents(undefined, budget({}), true), null);
});
