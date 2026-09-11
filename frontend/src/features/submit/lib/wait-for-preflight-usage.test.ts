import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionBudget } from "@/shared/types/execution-budget";
import type { WizardPreflightResponse } from "@/shared/types/wizard-preflight";
import { waitForPreflightUsage } from "./wait-for-preflight-usage.ts";

const budget = { id: "budget", revision: 1, pending_operations: 1 } as ExecutionBudget;
const pending: WizardPreflightResponse = {
  id: "evidence",
  fingerprint: "original-inputs",
  status: "pending",
  may_advance: false,
  pending_reason: { category: "usage_reconciliation", message: "Waiting" },
  checks: [{ key: "scorer", status: "succeeded" }],
  budget,
};
const immediate = async () => {};

test("waits without repeating validation and resumes once with the settled budget", async () => {
  let reads = 0;
  let resumes = 0;
  const settled = { ...budget, revision: 2, pending_operations: 0 };
  const success = { ...pending, status: "succeeded" as const, may_advance: true, budget: settled };
  const result = await waitForPreflightUsage(
    pending,
    async () => {
      reads += 1;
      return reads === 3 ? settled : budget;
    },
    async (current) => {
      resumes += 1;
      assert.equal(current, settled);
      return success;
    },
    undefined,
    immediate,
  );
  assert.equal(reads, 3);
  assert.equal(resumes, 1);
  assert.equal(result, success);
});

test("bounded waiting preserves pending evidence instead of declaring success", async () => {
  let reads = 0;
  const result = await waitForPreflightUsage(
    pending,
    async () => {
      reads += 1;
      return budget;
    },
    async () => {
      throw new Error("Must not execute while charges are pending");
    },
    undefined,
    immediate,
  );
  assert.equal(reads, 24);
  assert.deepEqual(result, pending);
});

test("does not poll failures, successes, or later-stage dependencies", async () => {
  for (const response of [
    { ...pending, status: "succeeded" as const },
    { ...pending, status: "failed" as const },
    {
      ...pending,
      pending_reason: { category: "later_stage_dependency" as const, message: "Needs seed" },
    },
  ]) {
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected request");
    };
    assert.equal(
      await waitForPreflightUsage(response, unexpected, unexpected, undefined, unexpected),
      response,
    );
  }
});

test("cancellation during settlement prevents another validation request", async () => {
  const controller = new AbortController();
  await assert.rejects(
    waitForPreflightUsage(
      pending,
      async () => {
        controller.abort();
        return { ...budget, pending_operations: 0 };
      },
      async () => {
        throw new Error("Must not resume cancelled setup");
      },
      controller.signal,
      immediate,
    ),
    { name: "AbortError" },
  );
});

test("reports each budget read so the wait can be shown as it happens", async () => {
  const seen: Array<[number, number]> = [];
  let reads = 0;
  const settled = { ...budget, pending_operations: 0 };
  await waitForPreflightUsage(
    pending,
    async () => {
      reads += 1;
      return reads === 2 ? settled : budget;
    },
    async () => ({ ...pending, status: "succeeded" as const, budget: settled }),
    undefined,
    immediate,
    (attempt, current) => seen.push([attempt, current.pending_operations]),
  );
  assert.deepEqual(seen, [
    [0, 1],
    [1, 1],
    [2, 0],
  ]);
});

test("a resumed pending result does not cause repeated execution", async () => {
  let resumes = 0;
  const result = await waitForPreflightUsage(
    pending,
    async () => ({ ...budget, pending_operations: 0 }),
    async () => {
      resumes += 1;
      return pending;
    },
    undefined,
    immediate,
  );
  assert.equal(resumes, 1);
  assert.equal(result, pending);
});
