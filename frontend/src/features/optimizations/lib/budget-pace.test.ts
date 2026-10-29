import { test } from "node:test";
import assert from "node:assert/strict";

const { budgetPaceLine } = await import("./budget-pace.ts");

test("a run without a pace shows no budget line", () => {
  assert.equal(budgetPaceLine({}), null);
  assert.equal(budgetPaceLine({ tqdm_percent: 40 }), null);
});

test("the first scorer runs read as calibrating", () => {
  assert.deepEqual(budgetPaceLine({ tqdm_budget_calibrating: true }), { kind: "calibrating" });
});

test("a measured pace names the iterations left, else the evaluations", () => {
  assert.deepEqual(
    budgetPaceLine({
      tqdm_budget_calibrating: false,
      tqdm_budget_iterations_left: 6,
      tqdm_budget_evals_left: 64,
    }),
    { kind: "iterations", count: 6 },
  );
  assert.deepEqual(
    budgetPaceLine({
      tqdm_budget_calibrating: false,
      tqdm_budget_iterations_left: null,
      tqdm_budget_evals_left: 64,
    }),
    { kind: "evaluations", count: 64 },
  );
});

test("a pace without counts shows nothing rather than a guess", () => {
  assert.equal(
    budgetPaceLine({
      tqdm_budget_calibrating: false,
      tqdm_budget_iterations_left: null,
      tqdm_budget_evals_left: null,
    }),
    null,
  );
  assert.equal(
    budgetPaceLine({ tqdm_budget_calibrating: false, tqdm_budget_evals_left: -1 }),
    null,
  );
});
