import { test } from "node:test";
import assert from "node:assert/strict";
import {
  creditsToUsd,
  totalCredits,
  walletStatus,
  formatCredits,
  formatCreditsUsd,
  formatBudgetUsd,
  formatUsd,
  formatResetDate,
  EMPTY_WALLET,
  type CreditWallet,
} from "./credit.ts";

/** Assert two floats match within a tolerance — credit→USD is fractional. */
function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
}

const walletWith = (paidBalanceCredits: number, freeRemaining: number): CreditWallet => ({
  ...EMPTY_WALLET,
  paidBalanceCredits,
  freeGrant: { ...EMPTY_WALLET.freeGrant, creditsRemaining: freeRemaining },
});

test("empty wallet never seeds demo balances or activity", () => {
  assert.equal(EMPTY_WALLET.paidBalanceCredits, 0);
  assert.equal(EMPTY_WALLET.freeGrant.creditsRemaining, 0);
  assert.deepEqual(EMPTY_WALLET.usage, []);
});

test("creditsToUsd values each credit at one cent", () => {
  near(creditsToUsd(100), 1);
  near(creditsToUsd(250), 2.5);
  near(creditsToUsd(0), 0);
});

test("totalCredits sums the free grant remaining and the purchased balance", () => {
  assert.equal(totalCredits(walletWith(1240, 480)), 1720);
  assert.equal(totalCredits(walletWith(0, 0)), 0);
});

test("walletStatus buckets the wallet by spendable value", () => {
  assert.equal(walletStatus(walletWith(0, 0)), "empty");
  // 30 credits = $0.30, under the $0.50 low-balance line.
  assert.equal(walletStatus(walletWith(30, 0)), "low");
  assert.equal(walletStatus(walletWith(1000, 0)), "healthy");
});

test("formatCredits groups thousands in the given locale", () => {
  assert.equal(formatCredits(1240, "en-US"), "1,240");
  assert.equal(formatCredits(0, "en-US"), "0");
});

test("formatUsd keeps sub-cent precision but two decimals otherwise", () => {
  assert.equal(formatUsd(1, "en-US"), "$1.00");
  assert.equal(formatUsd(0, "en-US"), "$0.00");
  assert.equal(formatUsd(0.003, "en-US"), "$0.003");
});

test("formatCreditsUsd renders a credit balance in dollars at par", () => {
  assert.equal(formatCreditsUsd(4512, "en-US"), "$45.12");
  assert.equal(formatCreditsUsd(500, "en-US"), "$5.00");
  assert.equal(formatCreditsUsd(0, "en-US"), "$0.00");
});

test("formatBudgetUsd renders a decimal credit string in dollars", () => {
  assert.equal(formatBudgetUsd("116.06994", "en-US"), "$1.16");
  assert.equal(formatBudgetUsd("2000", "en-US"), "$20.00");
  // A fraction of a cent keeps sub-cent precision instead of collapsing to $0.00.
  assert.equal(formatBudgetUsd("0.4", "en-US"), "$0.004");
});

test("formatResetDate renders the reset date in the given locale", () => {
  assert.match(formatResetDate("2026-07-01T12:00:00Z", "en-US"), /2026/);
});
