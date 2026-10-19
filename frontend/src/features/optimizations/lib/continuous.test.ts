import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allowanceShare,
  canReview,
  cycleTone,
  enableProblem,
  refreshDelayMs,
  usdTextToCents,
} from "./continuous.ts";
import type { ContinuousCycle, ContinuousPlan } from "@/shared/types/continuous";

const form = {
  permitted: { data: true, models: false, optimizers: false },
  sourceRef: "acme/support/default/train",
  monthlyLimit: "10",
  cycleBudget: "2.50",
};

test("dollar text becomes whole cents and rejects junk", () => {
  assert.equal(usdTextToCents("2.50"), 250);
  assert.equal(usdTextToCents("$10"), 1000);
  assert.equal(usdTextToCents("0"), null);
  assert.equal(usdTextToCents("1.234"), null);
  assert.equal(usdTextToCents("-3"), null);
  assert.equal(usdTextToCents(""), null);
});

test("the enable form mirrors the backend rules", () => {
  assert.equal(enableProblem(form), null);
  assert.equal(
    enableProblem({ ...form, permitted: { data: false, models: false, optimizers: false } }),
    "continuous_tab.form.need_permission",
  );
  assert.equal(enableProblem({ ...form, sourceRef: " " }), "continuous_tab.form.need_source");
  assert.equal(
    enableProblem({
      ...form,
      permitted: { data: false, models: true, optimizers: false },
      sourceRef: "",
    }),
    null,
  );
  assert.equal(enableProblem({ ...form, monthlyLimit: "abc" }), "continuous_tab.form.bad_amount");
  assert.equal(
    enableProblem({ ...form, cycleBudget: "11" }),
    "continuous_tab.form.budget_over_limit",
  );
});

test("allowance share is clamped and a zero limit reads as spent", () => {
  const usage = { month: "2026-10", resets_at: "2026-11-01T00:00:00Z" };
  assert.equal(allowanceShare({ ...usage, limit_cents: 100, committed_cents: 25 }), 0.25);
  assert.equal(allowanceShare({ ...usage, limit_cents: 100, committed_cents: 300 }), 1);
  assert.equal(allowanceShare({ ...usage, limit_cents: 0, committed_cents: 0 }), 1);
});

test("only a validated candidate with a run can be reviewed", () => {
  const cycle = {
    id: "c",
    slot: "s",
    month: "2026-10",
    status: "awaiting_review" as const,
    changes: ["data"],
    detail_code: null,
    detail_params: {},
    snapshot: null,
    optimization_id: "run",
    incumbent_score: 0.5,
    candidate_score: 0.7,
    spent_cents: 10,
    created_at: "2026-10-18T00:00:00Z",
  };
  assert.equal(canReview(cycle), true);
  assert.equal(canReview({ ...cycle, status: "regressed" }), false);
  assert.equal(canReview({ ...cycle, status: "skipped", optimization_id: null }), false);
  assert.equal(cycleTone("skipped"), "muted");
  assert.equal(cycleTone("failed"), "bad");
  assert.equal(cycleTone("regressed"), "warn");
});

test("the tab reloads while a check is due or running, and stops when nothing is pending", () => {
  const now = Date.parse("2026-10-19T04:00:00Z");
  const plan = (patch: Partial<ContinuousPlan>, statuses: ContinuousCycle["status"][] = []) =>
    ({
      status: "active",
      next_check_at: "2026-10-20T05:30:00Z",
      cycles: statuses.map((status) => ({ status })),
      ...patch,
    }) as ContinuousPlan;
  assert.equal(refreshDelayMs(plan({}), now), null);
  assert.equal(refreshDelayMs(plan({}, ["skipped"]), now), null);
  assert.equal(refreshDelayMs(plan({ next_check_at: "2026-10-19T04:00:00Z" }), now), 5_000);
  assert.equal(refreshDelayMs(plan({}, ["checking"]), now), 5_000);
  assert.equal(refreshDelayMs(plan({}, ["optimizing"]), now), 30_000);
  assert.equal(
    refreshDelayMs(plan({ status: "paused", next_check_at: null }, ["skipped"]), now),
    null,
  );
});
