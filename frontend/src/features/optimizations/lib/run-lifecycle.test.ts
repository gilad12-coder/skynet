import assert from "node:assert/strict";
import { test } from "node:test";
import {
  budgetResultKind,
  isBudgetPause,
  isBudgetStop,
  recoveryDisplayState,
  recoveryEpisode,
} from "./run-lifecycle.ts";

test("budget stops require a structured terminal reason", () => {
  assert.equal(isBudgetStop({ status: "stopped", stop_reason: "budget_reached" }), true);
  assert.equal(isBudgetStop({ status: "failed", stop_reason: "budget_reached" }), false);
  assert.equal(isBudgetStop({ status: "cancelled", stop_reason: "budget_reached" }), false);
  assert.equal(isBudgetStop({ status: "stopped", stop_reason: "other" }), false);
});

test("budget pauses are paused runs parked by the projection, never by the user", () => {
  assert.equal(isBudgetPause({ status: "paused", stop_reason: "budget_projected" }), true);
  assert.equal(isBudgetPause({ status: "paused", stop_reason: null }), false);
  assert.equal(isBudgetPause({ status: "stopped", stop_reason: "budget_projected" }), false);
  assert.equal(isBudgetStop({ status: "paused", stop_reason: "budget_projected" }), false);
});

test("a seed or score without completed selection never becomes an evaluated result", () => {
  assert.equal(
    budgetResultKind({ terminal_evidence: { candidate_origin: "seed", selection_score: 1 } }),
    "none",
  );
  assert.equal(
    budgetResultKind({
      result_availability: "none",
      terminal_evidence: { candidate_origin: "optimized" },
    }),
    "none",
  );
  assert.equal(
    budgetResultKind({
      result_availability: "evaluated",
      terminal_evidence: { candidate_origin: "seed" },
    }),
    "seed",
  );
  assert.equal(
    budgetResultKind({
      result_availability: "evaluated",
      terminal_evidence: { candidate_origin: "optimized" },
    }),
    "evaluated",
  );
});

test("recovery notifications share an episode across heartbeat and outcome updates", () => {
  const base = {
    optimization_id: "run-1",
    recovery: {
      state: "recovering" as const,
      execution_generation: 2,
      checkpoint_revision: "checkpoint-a",
    },
  };
  assert.equal(
    recoveryEpisode(base),
    recoveryEpisode({
      ...base,
      recovery: { ...base.recovery, state: "recovered", reason: "continued" },
    }),
  );
  assert.notEqual(
    recoveryEpisode(base),
    recoveryEpisode({ ...base, recovery: { ...base.recovery, execution_generation: 3 } }),
  );
  assert.equal(recoveryEpisode({ optimization_id: "run-1", recovery: null }), null);
});

test("unknown recovery states render as unavailable instead of indexing missing copy", () => {
  assert.equal(recoveryDisplayState({ state: "waiting_for_usage" }), "unavailable");
  assert.equal(recoveryDisplayState({ state: "future_state" }), "unavailable");
  assert.equal(recoveryDisplayState({ state: "recovering" }), "recovering");
  assert.equal(recoveryDisplayState({ state: "recovered" }), "recovered");
  assert.equal(recoveryDisplayState(null), "unavailable");
});
