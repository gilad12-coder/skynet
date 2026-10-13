import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdminDashboardTotals } from "@/shared/lib/api";
import {
  failureRows,
  growthSeries,
  programRows,
  runSeries,
  sentryRows,
  sentryView,
  successRate,
} from "./admin-dashboard.ts";

const ZERO: AdminDashboardTotals = {
  signups: 0,
  activated: 0,
  active_users: 0,
  runs_started: 0,
  runs_succeeded: 0,
  runs_failed: 0,
  revenue_cents: 0,
  usage_cents: 0,
  serve_calls: 0,
  serve_errors: 0,
};

const DAY = {
  day: "2026-10-12",
  signups: 3,
  activated: 1,
  active_users: 5,
  runs_succeeded: 4,
  runs_failed: 1,
  runs_other: 2,
};

test("success rate is null on an empty window instead of dividing by zero", () => {
  assert.equal(successRate(ZERO), null);
});

test("success rate counts finished runs only", () => {
  assert.equal(successRate({ ...ZERO, runs_succeeded: 3, runs_failed: 1, runs_started: 9 }), 75);
});

test("daily series keep the day and use the formatter for the label", () => {
  const growth = growthSeries([DAY], (day) => `d:${day}`);
  assert.deepEqual(growth[0], {
    date: "2026-10-12",
    label: "d:2026-10-12",
    signups: 3,
    activated: 1,
    active_users: 5,
  });
  assert.equal(runSeries([DAY], String)[0]?.total, 7);
});

test("failure rows carry a share of all listed failures", () => {
  const rows = failureRows([
    { stage: "worker", error_class: "TimeoutError", count: 3 },
    { stage: "validation", error_class: null, count: 1 },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.id, row.error, row.share]),
    [
      ["worker:TimeoutError", "TimeoutError", 75],
      ["validation:", "", 25],
    ],
  );
});

test("program rows fall back to a short id and compute an error rate", () => {
  const [row] = programRows([
    { optimization_id: "abcdef123456", name: null, owner: null, calls: 8, errors: 2 },
  ]);
  assert.equal(row?.name, "abcdef12");
  assert.equal(row?.owner, "");
  assert.equal(row?.error_rate, 25);
});

test("sentry view distinguishes not connected, unreachable and ready", () => {
  assert.deepEqual(sentryView({ configured: false, available: false, issues: [] }), {
    kind: "not_connected",
  });
  assert.deepEqual(sentryView({ configured: true, available: false, issues: [] }), {
    kind: "unavailable",
  });
  assert.deepEqual(sentryView({ configured: true, available: true, issues: [] }), {
    kind: "ready",
    issues: [],
  });
});

test("sentry rows prefer the short id and keep missing fields empty", () => {
  const [row] = sentryRows([
    {
      id: "42",
      short_id: null,
      title: "ValueError",
      culprit: null,
      level: null,
      project: null,
      count: 5,
      users: 1,
      last_seen: null,
      permalink: null,
    },
  ]);
  assert.equal(row?.issue, "42");
  assert.equal(row?.level, "");
  assert.equal(row?.last_seen, "");
});
